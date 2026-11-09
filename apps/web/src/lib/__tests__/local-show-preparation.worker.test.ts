import { env } from "cloudflare:workers";
import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import {
  openTestBridge,
  approveTestBridgeTarget,
  bridgeClientTestRequest,
} from "@/test/bridge-fixtures";
import { timecodeFixture } from "@/test/timecode-fixtures";
import { writeDeviceSettings } from "../device-settings.server";
import { buildLocalShowPreparation } from "../local-show-preparation.server";
import { rundownRelayKey } from "../rundown-relay-key";
import { RUNDOWN_PIN_SETTING_KEY } from "../rundown-pin.server";
import { parsePreparedLocalShow } from "../../../../bridge/src/local-show-model";

afterEach(() => abortAllDurableObjects());

type Bridge = Awaited<ReturnType<typeof openTestBridge>>;
async function prepare(
  stub: Bridge["stub"],
  ...args: Parameters<Bridge["stub"]["prepareLocalShow"]>
) {
  // Normalize Cloudflare's pipelined RPC thenable before attaching assertions.
  return await stub.prepareLocalShow(...args);
}

function next(
  socket: WebSocket,
  type: string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.removeEventListener("message", receive);
      reject(new Error(`Missing ${type}`));
    }, 3000);
    function receive(event: MessageEvent) {
      const message = JSON.parse(String(event.data));
      if (message.type !== type) return;
      clearTimeout(timer);
      socket.removeEventListener("message", receive);
      resolve(message);
    }
    socket.addEventListener("message", receive);
  });
}

async function fixture(itemCount = 2) {
  const orgId = crypto.randomUUID();
  const showId = crypto.randomUUID();
  const timecode = await timecodeFixture(orgId, showId);
  const bridge = await openTestBridge(orgId);
  const claim = { ...timecode.authority, rundownPin: null };
  const rundown = env.RUNDOWN_RELAY.getByName(
    rundownRelayKey(orgId, timecode.target.serviceDate, "", showId),
  );
  const url = new URL(timecode.url("/command"));
  url.searchParams.set("access", "control");
  const command = (body: unknown) =>
    rundown.fetch(url, { method: "POST", body: JSON.stringify(body) });
  const seed = await command({
    action: "seed",
    payload: {
      items: Array.from({ length: itemCount }, (_, sortOrder) => ({
        id: `item-${sortOrder}`,
        title: `Segment ${sortOrder + 1}`,
        type: "segment",
        duration: 60000,
        notes: "Venue rehearsal notes",
        assignee: "Operator",
        cue: "",
        status: "upcoming",
        sortOrder,
        hardStop: false,
      })),
    },
  });
  expect(seed.status).toBe(200);
  const { revision } = await seed.json<{ revision: number }>();
  const input = {
    ...timecode.target,
    installationId: bridge.credential.installationId,
    sessionId: crypto.randomUUID(),
    expectedRevision: revision,
  };
  const device = { orgId, id: crypto.randomUUID(), adapterType: "obs" };
  const settings = await writeDeviceSettings(
    env.CREDENTIAL_ENCRYPTION_KEYS,
    device,
    JSON.stringify({
      host: "10.0.0.8",
      port: 4455,
      password: "fixture-private-password",
    }),
  );
  await env.DB.prepare(
    `INSERT INTO device (id,orgId,name,category,adapterType,settings,enabled,createdAt,updatedAt)
    VALUES (?,?,'Venue OBS','streaming','obs',?,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
  )
    .bind(device.id, orgId, settings)
    .run();
  await approveTestBridgeTarget(orgId, "obs", "10.0.0.8:4455");
  const cue = {
    id: "obs-cue",
    triggerTimecode: { hours: 0, minutes: 0, seconds: 1, frames: 0 },
    action: "device-action",
    targetDeviceId: device.id,
    targetActionId: "start_streaming",
    payload: {},
    label: "Start venue stream",
    toleranceFrames: 2,
  };
  const add = async (payload: unknown) => {
    const response = await timecode.stub.fetch(timecode.url("/command"), {
      method: "POST",
      body: JSON.stringify({ action: "add-event", payload }),
    });
    expect(response.status).toBe(200);
    await response.arrayBuffer();
  };
  await add(cue);
  return {
    ...bridge,
    orgId,
    showId,
    input,
    claim,
    device,
    command,
    timecode,
    cue,
    add,
  };
}

it("prepares a 100-item live show with encrypted device settings and returns only a confirmed receipt", async () => {
  const test = await fixture(100);
  await test.add({ ...test.cue, id: "disabled-cue", enabled: false });
  await test.add({
    ...test.cue,
    id: "cloud-only-cue",
    action: "stage-message",
    payload: { message: "Cloud only" },
  });
  const clientResponse = await test.stub.fetch(
    await bridgeClientTestRequest(test.orgId),
  );
  if (!clientResponse.webSocket) throw new Error("Missing client socket");
  const client = clientResponse.webSocket;
  const ready = next(client, "bridge-status");
  client.accept();
  await ready;
  const publicMessages: unknown[] = [];
  client.addEventListener("message", (event) =>
    publicMessages.push(JSON.parse(String(event.data))),
  );
  const expiry = Date.now() + 3600_000;
  await env.DB.prepare(
    "UPDATE bridge_credential SET expiresAt=? WHERE id=? AND orgId=?",
  )
    .bind(expiry, test.credential.credentialId, test.orgId)
    .run();
  const wire = next(test.socket, "prepare-local-show");
  const request = prepare(test.stub, test.input, test.claim);
  const message = await wire;
  expect(Object.keys(message).sort()).toEqual([
    "id",
    "protectedSettings",
    "showId",
    "type",
  ]);
  expect(JSON.stringify(message)).not.toMatch(
    /fixture-private|10\.0\.0\.8|password|Segment/,
  );
  const pack = parsePreparedLocalShow(
    await test.recipient.open(message.protectedSettings, {
      orgId: test.orgId,
      installationId: test.credential.installationId,
      protocol: "local-show",
      target: test.showId,
    }),
  );
  expect(pack).toMatchObject({
    ...test.timecode.target,
    sessionId: test.input.sessionId,
    baseRevision: test.input.expectedRevision,
    expiresAt: expiry,
  });
  expect(pack.items).toHaveLength(100);
  expect(pack.timer.playback).toBe("stop");
  expect(pack.actions).toHaveLength(1);
  expect(pack.actions[0]).toMatchObject({
    id: "obs-cue",
    deviceId: test.device.id,
    protocol: "obs",
    settings: { password: "fixture-private-password" },
  });
  expect(pack.approvedTargets).toEqual([
    { protocol: "obs", host: "10.0.0.8", port: 4455 },
  ]);
  test.socket.send(
    JSON.stringify({
      type: "local-show-prepared",
      id: message.id,
      sessionId: pack.sessionId,
      success: true,
    }),
  );
  const receipt = await request;
  expect({ ...receipt }).toEqual({
    sessionId: pack.sessionId,
    baseRevision: pack.baseRevision,
    preparedAt: pack.preparedAt,
    expiresAt: expiry,
    actionCount: 1,
  });
  expect(JSON.stringify(publicMessages)).not.toMatch(
    /fixture-private|protectedSettings|prepare-local-show|local-show-prepared/,
  );
  const audit = await env.DB.prepare(
    "SELECT * FROM bridge_credential_audit WHERE orgId=?",
  )
    .bind(test.orgId)
    .all();
  expect(audit.results).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ action: "prepare-local-show" }),
      expect.objectContaining({ action: "local-show-prepared" }),
    ]),
  );
  expect(JSON.stringify(audit)).not.toContain("fixture-private");
});

it("rejects stale revisions and wrong organization, show, date, or installation without sending a preparation", async () => {
  const test = await fixture();
  const traffic: unknown[] = [];
  test.socket.addEventListener("message", (event) =>
    traffic.push(JSON.parse(String(event.data))),
  );
  for (const input of [
    { ...test.input, expectedRevision: test.input.expectedRevision + 1 },
    { ...test.input, showId: crypto.randomUUID() },
    { ...test.input, serviceDate: "2026-11-07" },
    { ...test.input, installationId: crypto.randomUUID() },
  ])
    await expect(prepare(test.stub, input, test.claim)).rejects.toThrow();
  // The Worker test plugin reports pre-await RPC throws as unhandled. Exercise
  // this immediate boundary in the actual object, with its rejection observed.
  await runInDurableObject(test.stub, async (instance) => {
    await expect(
      instance.prepareLocalShow(
        { ...test.input, orgId: crypto.randomUUID() },
        test.claim,
      ),
    ).rejects.toThrow(/workspace does not match/);
  });
  expect(traffic).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: "prepare-local-show" }),
    ]),
  );
});

it.each(["expired-session", "removed-member", "pin-required"])(
  "checks current operator authority: %s",
  async (reason) => {
    const test = await fixture();
    if (reason === "expired-session")
      await env.DB.prepare(
        "UPDATE session SET expiresAt='2000-01-01' WHERE id=?",
      )
        .bind(test.claim.sessionId)
        .run();
    if (reason === "removed-member")
      await env.DB.prepare(
        "DELETE FROM member WHERE organizationId=? AND userId=?",
      )
        .bind(test.orgId, test.claim.userId)
        .run();
    if (reason === "pin-required") {
      await env.DB.prepare(
        "UPDATE member SET role='tm' WHERE organizationId=? AND userId=?",
      )
        .bind(test.orgId, test.claim.userId)
        .run();
      await env.DB.prepare(
        "INSERT INTO app_setting (id,orgId,key,value) VALUES (?,?,?,?)",
      )
        .bind(
          crypto.randomUUID(),
          test.orgId,
          RUNDOWN_PIN_SETTING_KEY,
          "pbkdf2-sha256:210000:MDEyMzQ1Njc4OWFiY2RlZg:dn1Cq81hnTfBlkh2maxSEZ3GzIkOQC9w2mVohTIJ_uo",
        )
        .run();
    }
    await expect(prepare(test.stub, test.input, test.claim)).rejects.toThrow(
      /current rundown control/,
    );
  },
);

it.each(["disabled", "foreign", "unapproved"])(
  "will not cache an unavailable device: %s",
  async (reason) => {
    const test = await fixture();
    if (reason === "disabled")
      await env.DB.prepare("UPDATE device SET enabled=0 WHERE id=? AND orgId=?")
        .bind(test.device.id, test.orgId)
        .run();
    if (reason === "foreign") {
      const other = await timecodeFixture();
      await env.DB.prepare("UPDATE device SET orgId=? WHERE id=? AND orgId=?")
        .bind(other.orgId, test.device.id, test.orgId)
        .run();
    }
    if (reason === "unapproved")
      await env.DB.prepare("DELETE FROM bridge_target_allowlist WHERE orgId=?")
        .bind(test.orgId)
        .run();
    await expect(prepare(test.stub, test.input, test.claim)).rejects.toThrow();
  },
);

it("ignores forged standby and wrong-session receipts while the selected Bridge can still acknowledge", async () => {
  const test = await fixture();
  const standby = await openTestBridge(test.orgId);
  const wire = next(test.socket, "prepare-local-show");
  let completed = false;
  const request = prepare(test.stub, test.input, test.claim).then((receipt) => {
    completed = true;
    return receipt;
  });
  const message = await wire;
  standby.socket.send(
    JSON.stringify({
      type: "local-show-prepared",
      id: message.id,
      sessionId: test.input.sessionId,
      success: true,
    }),
  );
  test.socket.send(
    JSON.stringify({
      type: "local-show-prepared",
      id: message.id,
      sessionId: "wrong-session",
      success: true,
    }),
  );
  const clientResponse = await test.stub.fetch(
    await bridgeClientTestRequest(test.orgId),
  );
  if (!clientResponse.webSocket) throw new Error("Missing client socket");
  const client = clientResponse.webSocket;
  const ready = next(client, "bridge-status");
  client.accept();
  await ready;
  // Same-socket status follows the forged receipt in the ownership queue.
  const barrier = next(client, "device-status");
  test.socket.send(
    JSON.stringify({
      type: "device-status",
      target: "10.0.0.8:4455",
      connected: false,
    }),
  );
  await barrier;
  expect(completed).toBe(false);
  test.socket.send(
    JSON.stringify({
      type: "local-show-prepared",
      id: message.id,
      sessionId: test.input.sessionId,
      success: true,
    }),
  );
  expect((await request).sessionId).toBe(test.input.sessionId);
});

it.each(["disconnect", "native-failure"])(
  "settles pending preparation on %s without leaking native errors",
  async (reason) => {
    const test = await fixture();
    const wire = next(test.socket, "prepare-local-show");
    const request = prepare(test.stub, test.input, test.claim);
    const rejected = expect(request).rejects.toThrow(
      reason === "disconnect" ? /disconnected/ : /could not save/,
    );
    const message = await wire;
    if (reason === "disconnect") test.socket.close(1000, "Fixture disconnect");
    else
      test.socket.send(
        JSON.stringify({
          type: "local-show-prepared",
          id: message.id,
          success: false,
          error: "private-password-in-native-error",
        }),
      );
    await rejected;
  },
);

it("uses the last confirmed live timer state and rejects a later revision", async () => {
  const test = await fixture();
  const started = await test.command({
    action: "timer-start",
    payload: { itemId: "item-0" },
  });
  expect(started.status).toBe(200);
  const { revision } = await started.json<{ revision: number }>();
  await expect(
    buildLocalShowPreparation(env, test.input, test.claim),
  ).rejects.toThrow(/rundown changed/);
  const pack = parsePreparedLocalShow(
    await buildLocalShowPreparation(
      env,
      { ...test.input, expectedRevision: revision },
      test.claim,
    ),
  );
  expect(pack.timer).toMatchObject({
    playback: "play",
    currentItemId: "item-0",
    startedAt: expect.any(Number),
  });
});

it("rejects a pending receipt when the selected venue computer changes", async () => {
  const test = await fixture();
  const standby = await openTestBridge(test.orgId);
  const wire = next(test.socket, "prepare-local-show");
  const request = prepare(test.stub, test.input, test.claim);
  const rejected = expect(request).rejects.toThrow(/Active Bridge changed/);
  const message = await wire;
  await test.stub.selectInstallation({
    orgId: test.orgId,
    installationId: standby.credential.installationId,
    expectedActiveInstallationId: test.credential.installationId,
    actorUserId: test.claim.userId,
  });
  test.socket.send(
    JSON.stringify({
      type: "local-show-prepared",
      id: message.id,
      sessionId: test.input.sessionId,
      success: true,
    }),
  );
  await rejected;
});

it("rejects an expired Bridge credential before delivering private preparation data", async () => {
  const test = await fixture();
  await env.DB.prepare(
    "UPDATE bridge_credential SET expiresAt=? WHERE id=? AND orgId=?",
  )
    .bind(Date.now() - 1, test.credential.credentialId, test.orgId)
    .run();
  await expect(prepare(test.stub, test.input, test.claim)).rejects.toThrow(
    /credential expired or was revoked/,
  );
});

it("fails oversized preparations before sending an envelope", async () => {
  const test = await fixture(100);
  const response = await test.command({
    action: "seed",
    payload: {
      force: true,
      items: Array.from({ length: 100 }, (_, sortOrder) => ({
        id: `item-${sortOrder}`,
        title: `Segment ${sortOrder}`,
        type: "segment",
        duration: 60000,
        notes: "x".repeat(3000),
        assignee: "Operator",
        cue: "",
        status: "upcoming",
        sortOrder,
        hardStop: false,
      })),
    },
  });
  expect(response.status).toBe(200);
  const { revision } = await response.json<{ revision: number }>();
  await expect(
    prepare(
      test.stub,
      { ...test.input, expectedRevision: revision },
      test.claim,
    ),
  ).rejects.toThrow(/200 KB transfer limit/);
});

it("times out unconfirmed storage so an old Bridge cannot leave preparation pending forever", async () => {
  const test = await fixture();
  await expect(prepare(test.stub, test.input, test.claim)).rejects.toThrow(
    /did not confirm saving/,
  );
}, 15000);

it("requires device access even when the operator already controls rundown and timecode", async () => {
  const test = await fixture();
  await env.DB.prepare(
    "UPDATE member SET role='pm' WHERE organizationId=? AND userId=?",
  )
    .bind(test.orgId, test.claim.userId)
    .run();
  await expect(prepare(test.stub, test.input, test.claim)).rejects.toThrow(
    /device access/,
  );
});

it("rechecks operator authority after resolving private device settings", async () => {
  const test = await fixture();
  // Revoke membership during the actual device-approval audit, after the first
  // authority check. Delivery must still require the operator's current access.
  await env.DB.prepare(
    `CREATE TRIGGER revoke_during_local_preparation AFTER INSERT ON bridge_target_audit
    WHEN NEW.action='connection-requested' BEGIN
      DELETE FROM member WHERE organizationId=NEW.orgId AND userId=NEW.actorUserId;
    END`,
  ).run();
  try {
    await expect(prepare(test.stub, test.input, test.claim)).rejects.toThrow(
      /current rundown control/,
    );
  } finally {
    await env.DB.prepare("DROP TRIGGER revoke_during_local_preparation").run();
  }
});
