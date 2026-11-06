// Exercise the compiled native sidecar, real OS vault, loopback control and a
// disposable equipment endpoint. No production workspace or hardware is used.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { sealBridgeSettings } from "@showpilot/shared/bridge-settings";
import {
  parseLocalRundownJournal,
  reconcileLocalRundown,
} from "@showpilot/shared/local-rundown";
import { deleteCredential } from "../dist/credential-store.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const triple = spawnSync("rustc", ["--print", "host-tuple"], {
  encoding: "utf8",
}).stdout.trim();
const binary =
  process.argv[2] ??
  join(
    root,
    `apps/desktop/src-tauri/binaries/showpilot-bridge-${triple}${process.platform === "win32" ? ".exe" : ""}`,
  );
const directory = mkdtempSync(join(tmpdir(), "showpilot-compiled-local-"));
const token = randomBytes(32).toString("hex");
const password = `fixture-${randomBytes(24).toString("hex")}`;
let commands = 0;
let holdDeviceReply = false;
let active;
const waitFor = async (predicate, label) => {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};
const next = (socket, type) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", handler);
      reject(new Error(`Missing ${type}`));
    }, 10000);
    const handler = (data) => {
      const value = JSON.parse(String(data));
      if (value.type === type) {
        clearTimeout(timer);
        socket.off("message", handler);
        resolve(value);
      }
    };
    socket.on("message", handler);
  });
const equipment = http.createServer((request, response) => {
  if (
    request.method === "POST" &&
    request.url === "/cue" &&
    request.headers.authorization === `Bearer ${password}`
  ) {
    commands++;
    if (!holdDeviceReply) response.end("OK");
  } else {
    response.writeHead(403);
    response.end();
  }
});
equipment.listen(0, "127.0.0.1");
await once(equipment, "listening");
const devicePort = equipment.address().port;
const policy = [
  { protocol: "http-command", host: "127.0.0.1", port: devicePort },
];
const cloud = new WebSocketServer({ port: 0, host: "127.0.0.1" });
await once(cloud, "listening");
const connections = [];
cloud.on("connection", (socket, request) => {
  const connected = {
    socket,
    key: request.headers["x-showpilot-settings-key"],
    ready: false,
  };
  connections.push(connected);
  void next(socket, "bridge-role-applied").then(() => {
    connected.ready = true;
  });
  socket.send(
    JSON.stringify({
      type: "bridge-role",
      role: "active",
      orgId: "fixture-org",
      installationId: "fixture-installation",
      selectionId: "fixture-selection",
      activeInstallation: {
        installationId: "fixture-installation",
        label: "Fixture venue",
      },
      approvedTargets: policy,
    }),
  );
});
const spawnEngine = () =>
  spawn(binary, ["--desktop", "--no-open"], {
    env: {
      ...process.env,
      SHOWPILOT_SITE_URL: "https://fixture.invalid",
      SHOWPILOT_ORG: "fixture",
      SHOWPILOT_BRIDGE_KEY: "sp_fixture_local_probe",
      SHOWPILOT_BRIDGE_URL: `ws://127.0.0.1:${cloud.address().port}`,
      SHOWPILOT_PARENT_PID: String(process.pid),
      SHOWPILOT_LOCAL_CONTROL_TOKEN: token,
      SHOWPILOT_LOCAL_SHOW_DIRECTORY: directory,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
const assertExclusiveOwner = async () => {
  const contender = spawnEngine();
  let output = "";
  const collect = (chunk) => {
    output += String(chunk);
  };
  contender.stdout.on("data", collect);
  contender.stderr.on("data", collect);
  try {
    await waitFor(() => {
      assert.ok(
        !output.includes("[bridge-local-control]"),
        "A second engine opened the same local journal while the first owner was alive",
      );
      return contender.exitCode !== null || contender.signalCode !== null;
    }, "exclusive local engine ownership");
    assert.notEqual(contender.exitCode, 0);
    assert.match(output, /Another local device engine still owns/);
    assert.ok(!output.includes(token) && !output.includes(password));
    assert.equal(active.exitCode, null);
    assert.equal(active.signalCode, null);
  } finally {
    if (contender.exitCode === null && contender.signalCode === null) {
      const exited = once(contender, "exit");
      contender.kill("SIGKILL");
      await exited;
    }
  }
};
const start = async () => {
  const child = spawnEngine();
  let port;
  let leaked = false;
  const inspect = (line) => {
    if (line.includes(password) || line.includes(token)) leaked = true;
  };
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    inspect(line);
    const match = /^\[bridge-local-control\] (\d+)$/.exec(line);
    if (match) port = Number(match[1]);
  });
  const errors = createInterface({ input: child.stderr });
  errors.on("line", inspect);
  active = child;
  await waitFor(() => {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error("Compiled local engine exited during startup");
    return port;
  }, "native local control");
  const request = async (body) => {
    const response = await fetch(`http://127.0.0.1:${port}/local-show`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(16000),
    });
    const value = await response.json();
    assert.equal(response.status, 200);
    assert.equal(value.ok, true);
    assert.equal(leaked, false);
    assert.equal(JSON.stringify(value).includes(password), false);
    assert.equal(JSON.stringify(value).includes(token), false);
    return value.result;
  };
  return request;
};
const stop = async (signal = "SIGTERM") => {
  if (!active) return;
  const child = active;
  active = null;
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.kill(signal);
    await exited;
  }
};
try {
  let request = await start();
  await waitFor(() => connections[0]?.ready, "active Bridge selection");
  await assertExclusiveOwner();
  const now = Date.now();
  const prepared = {
    version: 1,
    sessionId: "fixture-session",
    orgId: "fixture-org",
    installationId: "fixture-installation",
    showId: "fixture-show",
    serviceDate: "2026-11-06",
    title: "Compiled local fixture",
    baseRevision: 7,
    preparedAt: now,
    expiresAt: now + 60000,
    items: [
      {
        id: "first",
        title: "First item",
        type: "custom",
        duration: 60000,
        status: "upcoming",
        notes: "",
        assignee: "",
        cue: "",
      },
    ],
    timer: {
      playback: "stop",
      currentItemId: null,
      elapsed: 0,
      startedAt: null,
      pausedAt: null,
      mode: "count-down",
    },
    approvedTargets: policy,
    actions: [
      {
        id: "device-cue",
        label: "Fixture device",
        deviceId: "fixture-device",
        protocol: "http-command",
        target: `127.0.0.1:${devicePort}`,
        command: "POST /cue",
        settings: { authToken: password },
      },
    ],
  };
  const protectedSettings = await sealBridgeSettings(
    connections[0].key,
    {
      orgId: "fixture-org",
      installationId: "fixture-installation",
      protocol: "local-show",
      target: "fixture-show",
    },
    prepared,
  );
  const preparedAck = next(connections[0].socket, "local-show-prepared");
  connections[0].socket.send(
    JSON.stringify({
      type: "prepare-local-show",
      id: "prepare",
      showId: "fixture-show",
      protectedSettings,
    }),
  );
  assert.equal((await preparedAck).success, true);
  assert.equal((await request({ operation: "status" })).mode, "prepared");
  await request({
    operation: "begin",
    sessionId: "fixture-session",
    confirmed: true,
  });
  await request({
    operation: "transport",
    sessionId: "fixture-session",
    requestId: "next",
    expectedSequence: 0,
    action: "timer-next",
  });
  const action = {
    operation: "device",
    sessionId: "fixture-session",
    requestId: "fire",
    expectedSequence: 1,
    actionId: "device-cue",
  };
  await request(action);
  await request(action);
  assert.equal(commands, 1);
  await assertExclusiveOwner();
  assert.equal((await request({ operation: "status" })).sequence, 2);
  for (const file of readdirSync(directory).filter((file) =>
    file.endsWith(".json"),
  ))
    assert.equal(
      readFileSync(join(directory, file), "utf8").includes(password),
      false,
    );
  // Persist a second device receipt, then kill the owner after equipment saw
  // the request but before its acknowledgement. Recovery must never replay it.
  holdDeviceReply = true;
  const uncertainAction = {
    ...action,
    requestId: "uncertain-fire",
    expectedSequence: 2,
  };
  const uncertainReply = request(uncertainAction).then(
    () => "unexpected-success",
    () => "connection-lost",
  );
  await waitFor(() => commands === 2, "pending device delivery");
  const pending = await request({ operation: "status" });
  assert.equal(pending.sequence, 3);
  assert.equal(pending.results.at(-1).result, "pending");
  await assertExclusiveOwner();
  // Force termination: no JS exit handler can release the ownership lock.
  await stop("SIGKILL");
  assert.equal(await uncertainReply, "connection-lost");
  equipment.closeAllConnections();
  holdDeviceReply = false;
  request = await start();
  assert.equal(connections.length, 1);
  const held = await request({ operation: "status" });
  assert.equal(held.commandSource, "local-held");
  assert.equal(held.ready, false);
  assert.equal(held.sequence, 3);
  assert.equal(held.results.at(-1).result, "unknown");
  await request({
    operation: "begin",
    sessionId: "fixture-session",
    confirmed: true,
  });
  await request(action);
  const unknown = await request(uncertainAction);
  assert.equal(unknown.results.at(-1).result, "unknown");
  assert.equal(commands, 2);
  const finished = await request({
    operation: "finish",
    sessionId: "fixture-session",
    expectedSequence: 3,
  });
  assert.equal(finished.mode, "finished");
  assert.equal(finished.timer.playback, "pause");
  const journal = parseLocalRundownJournal(finished.journal, Date.now());
  assert.ok(journal);
  assert.equal(journal.operations.length, 1);
  assert.equal(
    reconcileLocalRundown(
      prepared,
      {
        orgId: prepared.orgId,
        showId: prepared.showId,
        serviceDate: prepared.serviceDate,
        revision: 7,
      },
      journal,
    ).ok,
    true,
  );
  await waitFor(() => connections[1]?.ready, "cloud handoff");
  assert.equal(commands, 2);
  console.log(
    "Compiled local show: encrypted preparation, native loopback, real OS vault, equipment dispatch, duplicate suppression, exclusive engine ownership, forced-crash recovery with unknown device receipts, and cloud handoff passed.",
  );
} finally {
  await stop();
  for (const socket of cloud.clients) socket.terminate();
  await new Promise((resolve) => cloud.close(resolve));
  equipment.closeAllConnections();
  await new Promise((resolve) => equipment.close(resolve));
  for (const file of readdirSync(directory).filter((file) =>
    file.endsWith(".json"),
  )) {
    const saved = JSON.parse(readFileSync(join(directory, file), "utf8"));
    if (typeof saved.keyReference === "string")
      deleteCredential(saved.keyReference);
  }
  rmSync(directory, { recursive: true, force: true });
}
