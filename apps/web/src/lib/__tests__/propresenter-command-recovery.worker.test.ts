import { env } from "cloudflare:workers";
import {
  abortAllDurableObjects,
  evictDurableObject,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import {
  openTestBridge,
  approveTestBridgeTarget,
} from "@/test/bridge-fixtures";
import { seedRelayMember } from "@/test/relay-fixtures";
import { getPrisma } from "../db";

afterEach(() => abortAllDurableObjects());
async function fixture() {
  const orgId = crypto.randomUUID();
  const claim = { ...(await seedRelayMember(orgId)), rundownPin: null };
  const showId = crypto.randomUUID();
  await getPrisma().rundown.create({
    data: {
      id: showId,
      orgId,
      serviceDate: "2026-11-09",
      name: "Slide command fixture",
    },
  });
  for (const [key, value] of [
    ["propresenter-host", "127.0.0.1"],
    ["propresenter-send-cues", "true"],
  ])
    await env.DB.prepare(
      "INSERT INTO app_setting (id,orgId,key,value) VALUES (?,?,?,?)",
    )
      .bind(crypto.randomUUID(), orgId, key, value)
      .run();
  const target = "propresenter:127.0.0.1:50001";
  await approveTestBridgeTarget(orgId, "propresenter", target, {
    apiPort: 1025,
  });
  const bridge = await openTestBridge(orgId);
  const messages: Record<string, unknown>[] = [];
  let outcome: "success" | "unknown" | "old-bridge" = "success";
  bridge.socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    messages.push(message);
    if (message.type === "connect-device")
      bridge.socket.send(
        JSON.stringify({ type: "device-status", target, connected: true }),
      );
    if (message.type === "prepare-propresenter-command")
      bridge.socket.send(
        JSON.stringify({
          type: "command-response",
          id: message.id,
          success: outcome !== "old-bridge",
        }),
      );
    if (message.type === "execute-propresenter-command")
      bridge.socket.send(
        JSON.stringify({
          type: "command-response",
          id: message.id,
          success: outcome === "success",
        }),
      );
  });
  const command = {
    orgId,
    userId: claim.userId,
    showId,
    requestId: crypto.randomUUID(),
    command: "next" as const,
  };
  const call = async (
    input: unknown,
    authority: typeof claim,
    mode: "prepare" | "execute" | "check",
  ) => await bridge.stub.recoverProPresenterCommand(input, authority, mode);
  // Catch deliberate synchronous RPC boundary failures inside the object: the
  // Worker test RPC wrapper otherwise reports them as unhandled before awaiting.
  const boundaryError = async (input: unknown) =>
    runInDurableObject(bridge.stub, async (instance) => {
      try {
        await instance.recoverProPresenterCommand(input, claim, "execute");
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });
  return {
    ...bridge,
    call,
    boundaryError,
    command,
    claim,
    messages,
    outcome: (value: typeof outcome) => {
      outcome = value;
    },
  };
}
it("delivers one relative command and reads its receipt after eviction without another send", async () => {
  const f = await fixture();
  expect((await f.call(f.command, f.claim, "prepare")).status).toBe("prepared");
  expect(
    f.messages.filter((m) => m.type === "execute-propresenter-command"),
  ).toHaveLength(0);
  expect((await f.call(f.command, f.claim, "execute")).status).toBe(
    "confirmed",
  );
  await evictDurableObject(f.stub);
  expect((await f.call(f.command, f.claim, "check")).status).toBe("confirmed");
  expect((await f.call(f.command, f.claim, "execute")).status).toBe(
    "confirmed",
  );
  expect(
    f.messages.filter((m) => m.type === "execute-propresenter-command"),
  ).toHaveLength(1);
  expect(
    f.messages.find((m) => m.type === "connect-device"),
  ).not.toHaveProperty("settings");
  const audit = await env.DB.prepare(
    "SELECT actorUserId FROM bridge_credential_audit WHERE orgId=? AND direction='to-bridge'",
  )
    .bind(f.command.orgId)
    .all();
  expect(audit.results.length).toBeGreaterThanOrEqual(3);
  expect(
    audit.results.every((row) => row.actorUserId === f.command.userId),
  ).toBe(true);
});
it("preserves uncertainty rather than repeating an unacknowledged slide command", async () => {
  const f = await fixture();
  await f.call(f.command, f.claim, "prepare");
  f.outcome("unknown");
  expect((await f.call(f.command, f.claim, "execute")).status).toBe(
    "uncertain",
  );
  await evictDurableObject(f.stub);
  expect((await f.call(f.command, f.claim, "check")).status).toBe("uncertain");
  expect((await f.call(f.command, f.claim, "prepare")).status).toBe(
    "uncertain",
  );
  expect((await f.call(f.command, f.claim, "execute")).status).toBe(
    "uncertain",
  );
  expect(
    f.messages.filter((m) => m.type === "execute-propresenter-command"),
  ).toHaveLength(1);
});
it("rejects a changed command and changed settings instead of retargeting", async () => {
  const f = await fixture();
  await f.call(f.command, f.claim, "prepare");
  await expect(
    f.call({ ...f.command, command: "clear" }, f.claim, "execute"),
  ).rejects.toThrow("original");
  await env.DB.prepare(
    "UPDATE app_setting SET value='other-device' WHERE orgId=? AND key='propresenter-host'",
  )
    .bind(f.command.orgId)
    .run();
  expect((await f.call(f.command, f.claim, "execute")).status).toBe("rejected");
  expect(
    f.messages.filter((m) => m.type === "execute-propresenter-command"),
  ).toHaveLength(0);
});
it("rechecks actor, live permission, session, and show at execution", async () => {
  const f = await fixture();
  await f.call(f.command, f.claim, "prepare");
  expect(await f.boundaryError({ ...f.command, orgId: "other-org" })).toContain(
    "access",
  );
  expect(
    await f.boundaryError({ ...f.command, userId: "other-user" }),
  ).toContain("access");
  await env.DB.prepare("DELETE FROM session WHERE id=?")
    .bind(f.claim.sessionId)
    .run();
  await expect(f.call(f.command, f.claim, "execute")).rejects.toThrow("access");
  expect(
    f.messages.filter((m) => m.type === "execute-propresenter-command"),
  ).toHaveLength(0);
});
it("fails closed for an expired reservation and an unsupported Bridge", async () => {
  const f = await fixture();
  await f.call(f.command, f.claim, "prepare");
  await runInDurableObject(f.stub, async (_instance, state) => {
    const key = `pp-command:${f.command.userId}:${f.command.requestId}`;
    const receipt = await state.storage.get<Record<string, unknown>>(key);
    await state.storage.put(key, { ...receipt, deadline: 0 });
  });
  expect((await f.call(f.command, f.claim, "execute")).status).toBe("rejected");
  f.outcome("old-bridge");
  expect(
    (
      await f.call(
        { ...f.command, requestId: crypto.randomUUID() },
        f.claim,
        "prepare",
      )
    ).status,
  ).toBe("rejected");
  expect(
    f.messages.filter((m) => m.type === "execute-propresenter-command"),
  ).toHaveLength(0);
});

it("enforces the cue-control safety switch before preparing or executing", async () => {
  const f = await fixture();
  await env.DB.prepare(
    "UPDATE app_setting SET value='false' WHERE orgId=? AND key='propresenter-send-cues'",
  )
    .bind(f.command.orgId)
    .run();
  await expect(f.call(f.command, f.claim, "prepare")).rejects.toThrow(
    "Send cues",
  );
  expect(f.messages.filter((m) => m.type === "connect-device")).toHaveLength(0);
  await env.DB.prepare(
    "UPDATE app_setting SET value='true' WHERE orgId=? AND key='propresenter-send-cues'",
  )
    .bind(f.command.orgId)
    .run();
  expect((await f.call(f.command, f.claim, "prepare")).status).toBe("prepared");
  expect(f.messages.find((m) => m.type === "connect-device")).toMatchObject({
    target: "propresenter:127.0.0.1:50001",
    protocol: "propresenter",
  });
  await env.DB.prepare(
    "UPDATE app_setting SET value='false' WHERE orgId=? AND key='propresenter-send-cues'",
  )
    .bind(f.command.orgId)
    .run();
  expect((await f.call(f.command, f.claim, "execute")).status).toBe("rejected");
  expect(
    f.messages.filter((m) => m.type === "execute-propresenter-command"),
  ).toHaveLength(0);
});
