import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import { seedRelayMember } from "@/test/relay-fixtures";
import type { DestinationControlCommand, DestinationControlOperation } from "@showpilot/shared/destination-control";
const auth = vi.hoisted(() => ({ userId: "", sessionId: "" }));
vi.mock("../auth", () => ({ getAuth: () => ({ api: { getSession: async () => ({ user: { id: auth.userId, name: "Fixture operator", email: "operator@example.test" }, session: { id: auth.sessionId } }) } }) }));
vi.mock("@tanstack/react-start/server", () => ({ getRequestHeaders: () => new Headers() }));
vi.mock("@tanstack/react-start", () => {
  const builder = () => {
    let validate = (data: unknown) => data;
    const chain = { middleware: () => chain, inputValidator: (fn: typeof validate) => { validate = fn; return chain; }, handler: (fn: (input: { data: unknown }) => unknown) => (input: { data: unknown }) => fn({ data: validate(input.data) }), server: () => chain };
    return chain;
  };
  return { createServerFn: builder, createMiddleware: builder, createServerOnlyFn: <T>(fn: T): T => fn };
});
import { readDestinationControl, writeDestinationControl } from "../destination-control.server";
import { CredentialVault } from "../credential-vault.server";
import { runStreamOutputCommand } from "../stream-output-command.server";
const headers = new Headers();
const fields = { name: "Fixture", platform: "custom", rtmpUrl: "rtmp://fixture.invalid/live", streamKey: "private-fixture-key" };
const bindings = { account: env.CLOUDFLARE_ACCOUNT_ID, token: env.CLOUDFLARE_STREAM_API_TOKEN };
afterEach(() => { vi.restoreAllMocks(); env.CLOUDFLARE_ACCOUNT_ID = bindings.account; env.CLOUDFLARE_STREAM_API_TOKEN = bindings.token; });
async function fixture() {
  const member = await seedRelayMember(`dc-${crypto.randomUUID()}`); Object.assign(auth, member);
  const scope = { orgId: member.orgId, userId: member.userId };
  const command = (operation: DestinationControlOperation): DestinationControlCommand => ({ ...scope, requestId: crypto.randomUUID(), operation });
  const send = (value: DestinationControlCommand, mode: "save" | "review" = "save") => writeDestinationControl(headers, value, mode);
  const read = () => readDestinationControl(headers, scope);
  const created = await send(command({ kind: "create", fields })); expect(created.outcome).toBe("applied");
  const id = created.destinationId;
  const output = async (kind: "select" | "disable" | "delete") => command({ kind, id, expectedRevision: (await read()).destinations.find(d => d.id === id)!.revision, expiresAt: Date.now() + 4500 });
  return { ...member, scope, id, command, send, read, output };
}
it("stores encrypted credentials and hash-only receipts, and never returns a stream key", async () => {
  const f = await fixture(), state = await f.read();
  expect(state.destinations[0]).toMatchObject({ selected: false, hasStreamKey: true, status: "none" });
  expect(JSON.stringify(state)).not.toContain(fields.streamKey); expect(state.destinations[0]).not.toHaveProperty("streamKey");
  expect(await env.DB.prepare("SELECT streamKey FROM stream_destination WHERE orgId=? AND id=?").bind(f.orgId, f.id).first("streamKey")).toMatch(/^spenc:/);
  expect(JSON.stringify((await env.DB.prepare("SELECT * FROM destination_control_request WHERE orgId=?").bind(f.orgId).all()).results)).not.toContain(fields.streamKey);
});
it("recovers repeated creation without duplicates or resurrection", async () => {
  const f = await fixture(), create = f.command({ kind: "create", fields });
  const [one, two] = await Promise.all([f.send(create), f.send(create)]);
  expect(one.destinationId).toBe(two.destinationId); expect(one.outcome).toBe("applied");
  await env.DB.prepare("DELETE FROM stream_destination WHERE orgId=? AND id=?").bind(f.orgId, one.destinationId).run();
  expect((await f.send(create)).outcome).toBe("applied"); expect((await f.read()).destinations).toHaveLength(1);
  await expect(f.send({ ...create, operation: { kind: "create", fields: { ...fields, streamKey: "changed" } } })).rejects.toThrow("different destination changes");
});
it("retains blank keys, rejects stale edits and preserves newer metadata on replay", async () => {
  const f = await fixture(), revision = (await f.read()).destinations[0].revision;
  const edit = f.command({ kind: "update", id: f.id, expectedRevision: revision, fields: { ...fields, name: "First", streamKey: "" } });
  expect((await f.send(edit)).outcome).toBe("applied");
  expect((await f.send({ ...edit, requestId: crypto.randomUUID() })).outcome).toBe("conflict");
  await env.DB.prepare("UPDATE stream_destination SET name='Newer' WHERE orgId=? AND id=?").bind(f.orgId, f.id).run();
  expect((await f.send(edit)).outcome).toBe("applied"); expect((await f.read()).destinations[0].name).toBe("Newer");
});
it("selection does not start a broadcast and replay does not undo a later deselection", async () => {
  const f = await fixture(), network = vi.spyOn(globalThis, "fetch");
  const select = await f.output("select"); expect((await f.send(select)).outcome).toBe("applied");
  expect((await f.read()).destinations[0]).toMatchObject({ selected: true, status: "none" });
  expect((await f.send(await f.output("disable"))).outcome).toBe("applied");
  expect((await f.send(select)).outcome).toBe("applied"); expect((await f.read()).destinations[0].selected).toBe(false);
  expect(network).not.toHaveBeenCalled();
});
it("expires unsent selection, rejects stale delete, and retains tombstones", async () => {
  const f = await fixture(), select = await f.output("select");
  if (select.operation.kind === "select") select.operation.expiresAt = Date.now() - 100;
  expect((await f.send(select)).outcome).toBe("expired");
  const remove = await f.output("delete");
  await env.DB.prepare("DELETE FROM stream_destination WHERE orgId=? AND id=?").bind(f.orgId, f.id).run();
  await env.DB.prepare("INSERT INTO stream_destination(id,orgId,name,platform,rtmpUrl,streamKey,enabled) VALUES(?,?,'New','custom','rtmp://fixture.invalid/live','new',0)").bind(f.id, f.orgId).run();
  expect((await f.send(remove)).outcome).toBe("conflict");
});
it("review fences a command arriving later without sending it", async () => {
  const f = await fixture(), remove = await f.output("delete");
  expect((await f.send(remove, "review")).outcome).toBe("cancelled");
  expect((await f.send(remove)).outcome).toBe("cancelled"); expect((await f.read()).destinations).toHaveLength(1);
});
it("review cancels an in-preparation save before its atomic write", async () => {
  const f = await fixture(), edit = f.command({ kind: "update", id: f.id, expectedRevision: (await f.read()).destinations[0].revision, fields: { ...fields, name: "Must not apply", streamKey: "replacement" } });
  const encrypt = CredentialVault.prototype.encrypt;
  vi.spyOn(CredentialVault.prototype, "encrypt").mockImplementationOnce(async function(this: CredentialVault, scope, plaintext) {
    expect((await f.send(edit, "review")).outcome).toBe("cancelled");
    return encrypt.call(this, scope, plaintext);
  });
  expect((await f.send(edit)).outcome).toBe("cancelled"); expect((await f.read()).destinations[0].name).toBe("Fixture");
});
it("checks authority at the actual save, after credential preparation", async () => {
  const f = await fixture(), create = f.command({ kind: "create", fields });
  const encrypt = CredentialVault.prototype.encrypt;
  vi.spyOn(CredentialVault.prototype, "encrypt").mockImplementationOnce(async function(this: CredentialVault, scope, plaintext) {
    await env.DB.prepare("UPDATE member SET role='member' WHERE organizationId=? AND userId=?").bind(f.orgId, f.userId).run();
    return encrypt.call(this, scope, plaintext);
  });
  expect((await f.send(create)).outcome).toBe("unconfirmed");
  expect(await env.DB.prepare("SELECT COUNT(*) FROM stream_destination WHERE orgId=?").bind(f.orgId).first("COUNT(*)")).toBe(1);
  await expect(f.read()).rejects.toThrow("permission changed");
});
it("rechecks output admission atomically without sending a provider mutation", async () => {
  const f = await fixture();
  await expect(runStreamOutputCommand({ orgId: f.orgId, actorId: f.userId, requestId: crypto.randomUUID(), destinationId: f.id, action: "delete", commitGuard: { sql: "0", values: [] } })).rejects.toThrow();
  expect((await f.read()).destinations).toHaveLength(1);
});
async function connectedFixture() {
  const f = await fixture(), inputId = crypto.randomUUID();
  env.CLOUDFLARE_ACCOUNT_ID = "fixture-account"; env.CLOUDFLARE_STREAM_API_TOKEN = "fixture-token";
  await env.DB.prepare("INSERT INTO live_input(id,orgId,name,cfInputId) VALUES(?,?,'Input','fixture-input')").bind(inputId, f.orgId).run();
  await env.DB.prepare("UPDATE stream_destination SET enabled=1,cfOutputId='fixture-output',liveInputId=? WHERE orgId=? AND id=?").bind(inputId, f.orgId, f.id).run();
  return f;
}
it("shows actual provider status and reports failed status reads as unknown", async () => {
  const f = await connectedFixture();
  const network = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ result: [{ uid: "fixture-output", enabled: false }] }));
  expect((await f.read()).destinations[0]).toMatchObject({ selected: true, status: "disabled" });
  network.mockRejectedValue(new Error("private-provider-diagnostic"));
  const state = await f.read(); expect(state.destinations[0].status).toBe("unknown"); expect(JSON.stringify(state)).not.toContain("private-provider-diagnostic");
});
it("reconciles a lost delete reply with the same command and review does not repeat provider calls", async () => {
  const f = await connectedFixture(); let exists = true, loseReply = true;
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, options) => {
    if (options?.method === "DELETE") { exists = false; if (loseReply) { loseReply = false; throw new Error("Lost provider reply"); } return new Response(null, { status: 404 }); }
    return Response.json({ result: exists ? [{ uid: "fixture-output", enabled: true }] : [] });
  });
  const remove = await f.output("delete"); expect((await f.send(remove)).outcome).toBe("unconfirmed");
  const count = network.mock.calls.length;
  expect((await f.send(remove, "review")).outcome).toBe("unconfirmed"); expect(network).toHaveBeenCalledTimes(count);
  expect((await f.send(remove)).outcome).toBe("applied"); expect((await f.read()).destinations).toHaveLength(0);
});
it("never overwrites a newer output command when reviewing an older uncertain result", async () => {
  const f = await connectedFixture();
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, options) => {
    if (options?.method === "DELETE") throw new Error("Unavailable");
    return Response.json({ result: [{ uid: "fixture-output", enabled: true }] });
  });
  const stop = await f.output("disable"); expect((await f.send(stop)).outcome).toBe("unconfirmed");
  network.mockResolvedValue(Response.json({ success: true }));
  await runStreamOutputCommand({ orgId: f.orgId, actorId: f.userId, requestId: crypto.randomUUID(), destinationId: f.id, action: "stop" });
  expect((await f.send(stop, "review")).outcome).toBe("superseded");
  const calls = network.mock.calls.length; expect((await f.send(stop)).outcome).toBe("superseded"); expect(network).toHaveBeenCalledTimes(calls);
});
it("rejects wrong accounts, foreign workspaces and expired sessions", async () => {
  const f = await fixture(), remove = await f.output("delete");
  await expect(f.send({ ...remove, userId: "other" })).rejects.toThrow("permission changed");
  await expect(f.send({ ...remove, orgId: "other" })).rejects.toThrow("permission changed");
  await env.DB.prepare("UPDATE session SET expiresAt='2000-01-01' WHERE id=?").bind(f.sessionId).run();
  await expect(f.send(remove)).rejects.toThrow("permission changed");
});

it("legacy native saves acknowledge their receipt with destination revision triggers enabled", async () => {
  const f = await fixture(), before = (await f.read()).destinations[0];
  const key = await env.DB.prepare("SELECT streamKey FROM stream_destination WHERE orgId=? AND id=?").bind(f.orgId, f.id).first("streamKey");
  const { handleMobileApi } = await import("../mobile-api.server");
  const response = await handleMobileApi(new Request(`https://app.showpilot.tech/api/mobile/v1/streaming/destinations/${f.id}?orgId=${f.orgId}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...fields, name: "Legacy saved name", streamKey: "", requestId: crypto.randomUUID() }) }), { DB: env.DB });
  expect(response?.status).toBe(200);
  expect(await response?.json()).toMatchObject({ ok: true, id: f.id });
  const after = (await f.read()).destinations[0];
  expect(after.name).toBe("Legacy saved name"); expect(after.revision).toBeGreaterThan(before.revision);
  expect(await env.DB.prepare("SELECT streamKey FROM stream_destination WHERE orgId=? AND id=?").bind(f.orgId, f.id).first("streamKey")).toBe(key);
});

it("legacy native selection, disable and deletion acknowledge correctly without provider activity", async () => {
  const f = await fixture(), network = vi.spyOn(globalThis, "fetch");
  const { handleMobileApi } = await import("../mobile-api.server");
  for (const enabled of [true, false]) {
    const response = await handleMobileApi(new Request(`https://app.showpilot.tech/api/mobile/v1/streaming/destinations/${f.id}?orgId=${f.orgId}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "toggle", enabled, requestId: crypto.randomUUID() }) }), { DB: env.DB });
    expect(response?.status).toBe(200); expect(await response?.json()).toMatchObject({ ok: true });
    expect((await f.read()).destinations[0]).toMatchObject({ selected: enabled, status: "none" });
  }
  const requestId = crypto.randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await handleMobileApi(new Request(`https://app.showpilot.tech/api/mobile/v1/streaming/destinations/${f.id}?orgId=${f.orgId}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "remove", requestId }) }), { DB: env.DB });
    expect(response?.status).toBe(200); expect(await response?.json()).toMatchObject({ ok: true });
  }
  expect((await f.read()).destinations).toEqual([]); expect(network).not.toHaveBeenCalled();
});

it("legacy native edits reject a foreign destination without changing it", async () => {
  const foreign = await fixture(), f = await fixture();
  const { handleMobileApi } = await import("../mobile-api.server");
  const response = await handleMobileApi(new Request(`https://app.showpilot.tech/api/mobile/v1/streaming/destinations/${foreign.id}?orgId=${f.orgId}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...fields, name: "Must not change", streamKey: "", requestId: crypto.randomUUID() }) }), { DB: env.DB });
  expect(response?.status).toBe(404);
  expect(await env.DB.prepare("SELECT name FROM stream_destination WHERE orgId=? AND id=?").bind(foreign.orgId, foreign.id).first("name")).toBe("Fixture");
});
