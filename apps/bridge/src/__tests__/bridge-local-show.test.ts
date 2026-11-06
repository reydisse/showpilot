import http from "node:http";
import dgram from "node:dgram";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, expect, it, vi } from "vitest";
import { sealBridgeSettings } from "@showpilot/shared/bridge-settings";
import type { PreparedLocalShow } from "../local-show-model.js";
const vault = vi.hoisted(() => new Map<string, string>());
vi.mock("../credential-store.js", () => ({
  readCredential: (key: string) => vault.get(key),
  writeCredential: (key: string, value: string) => vault.set(key, value),
  deleteCredential: (key: string) => vault.delete(key),
}));
import { Bridge } from "../bridge.js";
import { LocalShowStore } from "../local-show-store.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vault.clear();
});
function next(socket: WebSocket, type: string) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", handler);
      reject(new Error(`Missing ${type}`));
    }, 8000);
    const handler = (data: WebSocket.RawData) => {
      const message = JSON.parse(String(data));
      if (message.type === type) {
        clearTimeout(timer);
        socket.off("message", handler);
        resolve(message);
      }
    };
    socket.on("message", handler);
  });
}
async function fixture() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "showpilot-local-bridge-"),
  );
  cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  const cache = path.join(directory, "show.json");
  const events: string[] = [];
  let finishSlow: () => void = () => {};
  const equipment = http.createServer((request, response) => {
    events.push(request.url ?? "");
    if (request.url === "/slow") {
      finishSlow = () => {
        events.push("slow-finished");
        response.end("OK");
      };
      return;
    }
    if (request.url === "/local")
      expect(request.headers.authorization).toBe(
        "Bearer private-local-device-token",
      );
    response.end("OK");
  });
  equipment.listen(0, "127.0.0.1");
  await once(equipment, "listening");
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        equipment.close(() => resolve());
        equipment.closeAllConnections();
      }),
  );
  const address = equipment.address();
  if (!address || typeof address === "string")
    throw new Error("No device port");
  const target = `127.0.0.1:${address.port}`;
  const policy = [
    {
      protocol: "http-command" as const,
      host: "127.0.0.1",
      port: address.port,
    },
  ];
  const cloud = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(cloud, "listening");
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of cloud.clients) socket.terminate();
        cloud.close(() => resolve());
      }),
  );
  const cloudAddress = cloud.address();
  if (!cloudAddress || typeof cloudAddress === "string")
    throw new Error("No cloud port");
  const url = `ws://127.0.0.1:${cloudAddress.port}`;
  const keys = new WeakMap<WebSocket, string>();
  let connectionCount = 0;
  cloud.on("connection", (socket, request) => {
    connectionCount++;
    const key = request.headers["x-showpilot-settings-key"];
    if (typeof key !== "string") throw new Error("No settings key");
    keys.set(socket, key);
  });
  const createBridge = () => {
    const bridge = new Bridge({
      url,
      key: "fixture-installation-key",
      reconnect: false,
    });
    bridge.configureLocalShow(new LocalShowStore(cache));
    cleanups.push(() => bridge.stop());
    return bridge;
  };
  const connected = () =>
    new Promise<WebSocket>((resolve) =>
      cloud.once("connection", (socket) => {
        const ready = next(socket, "bridge-status");
        void ready.then(() => resolve(socket));
      }),
    );
  const connectedFirst = connected();
  const bridge = createBridge();
  bridge.start();
  const socket = await connectedFirst;
  const role = async (socket: WebSocket, role: "active" | "standby") => {
    const receipt = next(socket, "bridge-role-applied");
    socket.send(
      JSON.stringify({
        type: "bridge-role",
        role,
        orgId: "fixture-org",
        installationId: "fixture-installation",
        selectionId: crypto.randomUUID(),
        activeInstallation: {
          installationId: "fixture-installation",
          label: "Fixture",
        },
        approvedTargets: policy,
      }),
    );
    await receipt;
  };
  await role(socket, "active");
  const now = Date.now();
  const prepared: PreparedLocalShow = {
    version: 1,
    sessionId: "local-session",
    orgId: "fixture-org",
    installationId: "fixture-installation",
    showId: "fixture-show",
    serviceDate: "2026-11-06",
    title: "Fixture show",
    baseRevision: 4,
    preparedAt: now,
    expiresAt: now + 60_000,
    items: [
      {
        id: "item",
        type: "custom",
        title: "First item",
        duration: 10000,
        status: "upcoming",
        notes: "",
        cue: "",
        assignee: "",
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
        id: "cue",
        label: "Device action",
        deviceId: "device",
        protocol: "http-command",
        target,
        command: "POST /local",
        settings: { authToken: "private-local-device-token" },
      },
    ],
  };
  const prepare = async (
    value: PreparedLocalShow = prepared,
    bindingOrg = "fixture-org",
  ) => {
    const protectedSettings = await sealBridgeSettings(
      keys.get(socket) ?? "",
      {
        orgId: bindingOrg,
        installationId: "fixture-installation",
        protocol: "local-show",
        target: "fixture-show",
      },
      { ...value },
    );
    const receipt = next(socket, "local-show-prepared");
    socket.send(
      JSON.stringify({
        type: "prepare-local-show",
        id: crypto.randomUUID(),
        showId: "fixture-show",
        protectedSettings,
      }),
    );
    return receipt;
  };
  const configure = async (socket: WebSocket) => {
    const protectedSettings = await sealBridgeSettings(
      keys.get(socket) ?? "",
      {
        orgId: "fixture-org",
        installationId: "fixture-installation",
        protocol: "http-command",
        target,
      },
      {},
    );
    const receipt = next(socket, "device-status");
    socket.send(
      JSON.stringify({
        type: "connect-device",
        protocol: "http-command",
        target,
        protectedSettings,
      }),
    );
    expect(await receipt).toMatchObject({ connected: true });
  };
  const command = (socket: WebSocket, id: string, command: string) =>
    socket.send(
      JSON.stringify({
        type: "command",
        id,
        protocol: "http-command",
        target,
        command,
      }),
    );
  const begin = () =>
    bridge.handleLocalShow({
      operation: "begin",
      sessionId: "local-session",
      confirmed: true,
    });
  const device = (owner = bridge, requestId = "fire", expectedSequence = 0) =>
    owner.handleLocalShow({
      operation: "device",
      sessionId: "local-session",
      requestId,
      expectedSequence,
      actionId: "cue",
    });
  const status = (owner = bridge) =>
    owner.handleLocalShow({ operation: "status" });
  return {
    bridge,
    socket,
    cache,
    events,
    prepared,
    policy,
    prepare,
    configure,
    command,
    begin,
    device,
    status,
    role,
    connected,
    createBridge,
    connectionCount: () => connectionCount,
    finishSlow: () => finishSlow(),
  };
}

it("prepares over protected cloud transport, controls real HTTP equipment offline, and returns to cloud without replay", async () => {
  const f = await fixture();
  expect(await f.prepare()).toMatchObject({
    success: true,
    sessionId: "local-session",
  });
  expect(fs.readFileSync(f.cache, "utf8")).not.toContain(
    "private-local-device-token",
  );
  const before = await f.status();
  expect(JSON.stringify(before)).not.toContain(f.prepared.actions[0].target);
  expect(JSON.stringify(before)).not.toContain("private-local-device-token");
  const closed = once(f.socket, "close");
  expect(await f.begin()).toMatchObject({
    mode: "active",
    ready: true,
    commandSource: "local",
  });
  await closed;
  expect(await f.device()).toMatchObject({
    results: [{ result: "acknowledged" }],
  });
  await f.device();
  expect(f.events).toEqual(["/local"]);
  await f.bridge.handleLocalShow({
    operation: "transport",
    sessionId: "local-session",
    requestId: "next",
    expectedSequence: 1,
    command: { type: "timer-next" },
  });
  const reconnected = f.connected();
  const finished = await f.bridge.handleLocalShow({
    operation: "finish",
    sessionId: "local-session",
    expectedSequence: 2,
  });
  expect(finished).toMatchObject({
    mode: "finished",
    ready: false,
    timer: { playback: "pause" },
    commandSource: "cloud",
  });
  const socket = await reconnected;
  await f.role(socket, "active");
  await f.configure(socket);
  const acknowledged = next(socket, "command-response");
  f.command(socket, "cloud-command", "POST /cloud");
  expect(await acknowledged).toMatchObject({ success: true });
  expect(f.events).toEqual(["/local", "/cloud"]);
  expect(JSON.stringify(finished)).not.toContain("POST /local");
});

it("waits for an in-flight cloud command and discards queued cloud work before local output", async () => {
  const f = await fixture();
  await f.prepare();
  await f.configure(f.socket);
  f.command(f.socket, "slow", "POST /slow");
  await vi.waitFor(() => expect(f.events).toEqual(["/slow"]));
  f.command(f.socket, "queued", "POST /must-not-run");
  const entering = f.begin();
  expect(await f.status()).toMatchObject({
    commandSource: "entering-local",
    ready: false,
  });
  await expect(f.device()).rejects.toThrow(/switching modes/);
  f.finishSlow();
  await entering;
  await f.device();
  expect(f.events).toEqual(["/slow", "slow-finished", "/local"]);
});

it("recovers an active local session without reconnecting cloud or repeating device actions", async () => {
  const f = await fixture();
  await f.prepare();
  await f.begin();
  await f.device();
  f.bridge.stop();
  const restarted = f.createBridge();
  restarted.start();
  expect(await f.status(restarted)).toMatchObject({
    mode: "active",
    ready: false,
    commandSource: "local-held",
    results: [{ result: "acknowledged" }],
  });
  await restarted.handleLocalShow({
    operation: "begin",
    sessionId: "local-session",
    confirmed: true,
  });
  await f.device(restarted);
  expect(f.events).toEqual(["/local"]);
  expect(f.connectionCount()).toBe(1);
  await f.device(restarted, "another", 1);
  expect(f.events).toEqual(["/local", "/local"]);
});

it("rejects wrong encryption scope, unapproved targets, and plaintext preparation", async () => {
  const f = await fixture();
  expect(await f.prepare(f.prepared, "other-org")).toMatchObject({
    success: false,
  });
  const unapproved = {
    ...f.prepared,
    approvedTargets: [{ ...f.policy[0], port: 12345 }],
    actions: [{ ...f.prepared.actions[0], target: "127.0.0.1:12345" }],
  };
  expect(await f.prepare(unapproved)).toMatchObject({
    success: false,
    error: expect.stringContaining("unapproved"),
  });
  const receipt = next(f.socket, "local-show-prepared");
  f.socket.send(
    JSON.stringify({
      type: "prepare-local-show",
      id: "plaintext",
      showId: "fixture-show",
      protectedSettings: f.prepared,
    }),
  );
  expect(await receipt).toMatchObject({ success: false });
  expect(await f.status()).toMatchObject({ mode: "empty" });
  expect(f.events).toEqual([]);
});

it.each(["standby", "policy", "revoked"] as const)(
  "persists known %s revocation before offline use",
  async (reason) => {
    const f = await fixture();
    await f.prepare();
    if (reason === "standby") await f.role(f.socket, "standby");
    else if (reason === "policy") {
      const applied = next(f.socket, "bridge-policy-applied");
      f.socket.send(
        JSON.stringify({
          type: "bridge-policy",
          policyId: "revoked",
          approvedTargets: [],
        }),
      );
      await applied;
    } else {
      f.socket.close(4403, "Credential revoked");
      await vi.waitFor(async () =>
        expect(await f.status()).toMatchObject({ mode: "empty" }),
      );
    }
    expect(await f.status()).toMatchObject({ mode: "empty" });
    await expect(f.begin()).rejects.toThrow(/changed/);
    f.bridge.stop();
    const restarted = f.createBridge();
    expect(await f.status(restarted)).toMatchObject({ mode: "empty" });
    expect(f.events).toEqual([]);
  },
);

it("reports an unacknowledged UDP command as sent and preserves that outcome across restart", async () => {
  const f = await fixture();
  const receiver = dgram.createSocket("udp4");
  receiver.bind(0, "127.0.0.1");
  await once(receiver, "listening");
  cleanups.push(
    () => new Promise<void>((resolve) => receiver.close(() => resolve())),
  );
  const endpoint = {
    protocol: "udp" as const,
    host: "127.0.0.1",
    port: receiver.address().port,
  };
  const applied = next(f.socket, "bridge-policy-applied");
  f.socket.send(
    JSON.stringify({
      type: "bridge-policy",
      policyId: "udp-policy",
      approvedTargets: [endpoint],
    }),
  );
  await applied;
  const prepared = {
    ...f.prepared,
    approvedTargets: [endpoint],
    actions: [
      {
        ...f.prepared.actions[0],
        protocol: "udp" as const,
        target: `127.0.0.1:${endpoint.port}`,
        command: "010203",
        settings: {},
      },
    ],
  };
  expect(await f.prepare(prepared)).toMatchObject({ success: true });
  await f.begin();
  const received = once(receiver, "message");
  expect(await f.device()).toMatchObject({ results: [{ result: "sent" }] });
  expect((await received)[0]).toEqual(Buffer.from([1, 2, 3]));
  f.bridge.stop();
  expect(await f.status(f.createBridge())).toMatchObject({
    results: [{ result: "sent" }],
  });
});
