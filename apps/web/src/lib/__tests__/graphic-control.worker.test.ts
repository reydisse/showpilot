import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { seedRelayMember } from "@/test/relay-fixtures";
import type { GraphicControlCommand, GraphicControlOperation } from "@showpilot/shared/graphic-control";
const auth = vi.hoisted(() => ({ userId: "", sessionId: "" }));
vi.mock("../auth", () => ({ getAuth: () => ({ api: { getSession: async () => ({ user: { id: auth.userId, name: "Fixture operator", email: "operator@example.test" }, session: { id: auth.sessionId } }) } }) }));
vi.mock("@tanstack/react-start/server", () => ({ getRequestHeaders: () => new Headers() }));
vi.mock("@tanstack/react-start", () => {
  const builder = () => {
    let validate = (value: unknown) => value;
    const chain = {
      middleware: () => chain,
      inputValidator: (fn: typeof validate) => { validate = fn; return chain; },
      handler: (fn: (input: { data: unknown }) => unknown) => async (input: { data: unknown }) => fn({ data: validate(input.data) }),
      server: () => chain,
    };
    return chain;
  };
  return { createServerFn: builder, createMiddleware: builder, createServerOnlyFn: <T>(fn: T): T => fn };
});
import { readGraphicControl, writeGraphicControl } from "../graphic-control.server";
const headers = new Headers();
async function fixture() {
  const member = await seedRelayMember(`gc-${crypto.randomUUID()}`);
  Object.assign(auth, member);
  await env.DB.prepare("UPDATE organization SET cloud_enabled=1 WHERE id=?").bind(member.orgId).run();
  const ids = [crypto.randomUUID(), crypto.randomUUID()];
  for (const id of ids) await env.DB.prepare("INSERT INTO graphic_template(id,orgId,name,title,subtitle,style,createdAt,updatedAt) VALUES(?,?,'Name','Title','Subtitle','{\"fontSize\":72}',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)").bind(id, member.orgId).run();
  const scope = { orgId: member.orgId, userId: member.userId };
  const read = () => readGraphicControl(headers, scope, env.DB);
  const command = (operation: GraphicControlOperation): GraphicControlCommand => ({ ...scope, requestId: crypto.randomUUID(), operation });
  const output = async (kind: "show" | "hide", id = ids[0]) => {
    const state = await read();
    return command({ kind, id, expectedGraphicRevision: state.templates.find(g => g.id === id)!.revision, expectedProgramRevision: state.programRevision, expiresAt: Date.now() + 4500 });
  };
  const send = (value: GraphicControlCommand, mode: "save" | "review" = "save") => writeGraphicControl(headers, value, mode, env.DB);
  return { ...member, scope, ids, read, command, output, send };
}
it("replays explicit output commands without toggling or overwriting a newer command", async () => {
  const f = await fixture(), show = await f.output("show");
  expect((await f.send(show)).snapshot.activeIds).toEqual([f.ids[0]]);
  expect((await f.send(await f.output("hide"))).snapshot.activeIds).toEqual([]);
  const replay = await f.send(show);
  expect(replay.outcome).toBe("applied"); expect(replay.snapshot.activeIds).toEqual([]);
});
it("allows only one command based on a shared program revision", async () => {
  const f = await fixture();
  const a = await f.output("show"), b = await f.output("show", f.ids[1]);
  const results = await Promise.all([f.send(a), f.send(b)]);
  expect(results.map(r => r.outcome).sort()).toEqual(["applied", "conflict"]);
  expect((await f.read()).activeIds).toHaveLength(1);
});
it("expires delayed output and fences requests reviewed before arrival", async () => {
  const f = await fixture(), stale = await f.output("show");
  if (stale.operation.kind === "show") stale.operation.expiresAt = Date.now() - 100;
  expect((await f.send(stale)).outcome).toBe("expired");
  const show = await f.output("show");
  expect((await f.send(show, "review")).outcome).toBe("cancelled");
  expect((await f.send(show)).outcome).toBe("cancelled");
  expect((await f.read()).activeIds).toEqual([]);
  const future = await f.output("show");
  if (future.operation.kind === "show") future.operation.expiresAt += 10000;
  await expect(f.send(future)).rejects.toThrow("Refresh graphics");
});
it("preserves graphic styling and rejects stale same-second edits", async () => {
  const f = await fixture(), state = await f.read(), graphic = state.templates[0];
  const edit = f.command({ kind: "update", id: graphic.id, expectedGraphicRevision: graphic.revision, expectedProgramRevision: state.programRevision, content: { name: "New name", title: "New title", subtitle: "New subtitle" } });
  expect((await f.send(edit)).outcome).toBe("applied");
  expect((await f.send({ ...edit, requestId: crypto.randomUUID() })).outcome).toBe("conflict");
  expect(await env.DB.prepare("SELECT title,style FROM graphic_template WHERE orgId=? AND id=?").bind(f.orgId, graphic.id).first()).toEqual({ title: "New title", style: '{"fontSize":72}' });
});
it("deleting a live graphic preserves other graphics and does not resurrect on retry", async () => {
  const f = await fixture();
  await f.send(await f.output("show")); await f.send(await f.output("show", f.ids[1]));
  const state = await f.read();
  const remove = f.command({ kind: "delete", id: f.ids[0], expectedGraphicRevision: state.templates.find(g => g.id === f.ids[0])!.revision, expectedProgramRevision: state.programRevision });
  expect((await f.send(remove)).snapshot.activeIds).toEqual([f.ids[1]]);
  expect((await f.send(remove)).snapshot.activeIds).toEqual([f.ids[1]]);
  const create = f.command({ kind: "create", content: { name: "Created", title: "Created", subtitle: "" } });
  await f.send(create);
  await env.DB.prepare("DELETE FROM graphic_template WHERE orgId=? AND id=?").bind(f.orgId, create.requestId).run();
  expect((await f.send(create)).snapshot.templates.some(g => g.id === create.requestId)).toBe(false);
});
it("retains tombstone revisions across delete/recreate", async () => {
  const f = await fixture(), old = await f.output("show");
  await env.DB.prepare("DELETE FROM graphic_template WHERE orgId=? AND id=?").bind(f.orgId, f.ids[0]).run();
  await env.DB.prepare("INSERT INTO graphic_template(id,orgId,name,title,subtitle,style,updatedAt) VALUES(?,?,'New','New','','{}',CURRENT_TIMESTAMP)").bind(f.ids[0], f.orgId).run();
  expect((await f.send(old)).outcome).toBe("conflict");
});
it("keeps malformed program state visible and permits reviewed clear only", async () => {
  const f = await fixture();
  await env.DB.prepare("INSERT INTO app_setting(id,orgId,key,value) VALUES(?,?,'active-graphics','broken')").bind(crypto.randomUUID(), f.orgId).run();
  const state = await f.read(); expect(state.unknownProgram).toBe(true);
  expect((await f.send(await f.output("show"))).outcome).toBe("conflict");
  const result = await f.send(f.command({ kind: "clear", expectedProgramRevision: state.programRevision, expiresAt: Date.now() + 4500 }));
  expect(result.outcome).toBe("applied"); expect(result.snapshot.unknownProgram).toBe(false); expect(result.snapshot.activeIds).toEqual([]);
});
it("rejects cross-account, cross-workspace, altered requests and disabled cloud writes", async () => {
  const f = await fixture(), show = await f.output("show");
  await expect(f.send({ ...show, userId: crypto.randomUUID() })).rejects.toThrow("permission changed");
  await expect(f.send({ ...show, orgId: crypto.randomUUID() })).rejects.toThrow("permission changed");
  await f.send(show);
  await expect(f.send({ ...show, operation: { ...show.operation, kind: "hide" } } as GraphicControlCommand)).rejects.toThrow("different graphics change");
  await env.DB.prepare("UPDATE organization SET cloud_enabled=0 WHERE id=?").bind(f.orgId).run();
  expect((await f.read()).cloudEnabled).toBe(false);
  await expect(f.send(await f.output("hide"))).rejects.toThrow("permission changed");
});
it("cancels unsent library work and rejects expired sessions", async () => {
  const f = await fixture(), create = f.command({ kind: "create", content: { name: "Draft", title: "Draft", subtitle: "" } });
  expect((await f.send(create, "review")).outcome).toBe("cancelled");
  expect((await f.send(create)).outcome).toBe("cancelled");
  expect((await f.read()).templates).toHaveLength(2);
  await env.DB.prepare("UPDATE session SET expiresAt='2000-01-01' WHERE id=?").bind(f.sessionId).run();
  await expect(f.read()).rejects.toThrow("permission changed");
});

function atCommit(change: () => Promise<unknown>): Pick<D1Database, "prepare" | "batch"> {
  let batches = 0;
  return { prepare: sql => env.DB.prepare(sql), batch: async statements => {
    if (++batches === 2) await change();
    return env.DB.batch(statements);
  } };
}
it.each(["session", "membership", "cloud"])("rechecks %s authority in the mutation transaction", async kind => {
  const f = await fixture(), show = await f.output("show");
  const db = atCommit(() => kind === "session"
    ? env.DB.prepare("DELETE FROM session WHERE id=?").bind(f.sessionId).run()
    : kind === "membership" ? env.DB.prepare("UPDATE member SET role='member' WHERE organizationId=? AND userId=?").bind(f.orgId, f.userId).run()
    : env.DB.prepare("UPDATE organization SET cloud_enabled=0 WHERE id=?").bind(f.orgId).run());
  await expect(writeGraphicControl(headers, show, "save", db)).rejects.toThrow("permission changed");
  expect(await env.DB.prepare("SELECT * FROM graphic_control_request WHERE orgId=?").bind(f.orgId).all()).toMatchObject({ results: [] });
  expect(await env.DB.prepare("SELECT * FROM app_setting WHERE orgId=? AND key='active-graphics'").bind(f.orgId).all()).toMatchObject({ results: [] });
});
it("does not let a future revision overwrite a publication arriving during commit", async () => {
  const f = await fixture(), show = await f.output("show");
  if (show.operation.kind === "show") show.operation.expectedProgramRevision++;
  const db = atCommit(() => env.DB.prepare("INSERT INTO app_setting(id,orgId,key,value) VALUES(?,?,'active-graphics',?)").bind(crypto.randomUUID(), f.orgId, JSON.stringify([f.ids[1]])).run());
  expect((await writeGraphicControl(headers, show, "save", db)).outcome).toBe("conflict");
  expect((await f.read()).activeIds).toEqual([f.ids[1]]);
});
it("separates trigger permission from library configuration", async () => {
  const f = await fixture();
  await env.DB.prepare("UPDATE member SET role='pm' WHERE organizationId=? AND userId=?").bind(f.orgId, f.userId).run();
  expect(await f.read()).toMatchObject({ canTrigger: true, canConfigure: false });
  expect((await f.send(await f.output("show"))).outcome).toBe("applied");
  await expect(f.send(f.command({ kind: "create", content: { name: "No", title: "No", subtitle: "" } }))).rejects.toThrow("permission changed");
});
it("reads legacy single-graphic publication and migrates it without losing other graphics", async () => {
  const f = await fixture();
  await env.DB.prepare("INSERT INTO app_setting(id,orgId,key,value) VALUES(?,?,'active-graphic',?)").bind(crypto.randomUUID(), f.orgId, f.ids[1]).run();
  expect((await f.read()).activeIds).toEqual([f.ids[1]]);
  expect((await f.send(await f.output("show"))).snapshot.activeIds).toEqual([f.ids[1], f.ids[0]]);
  expect(await env.DB.prepare("SELECT * FROM app_setting WHERE orgId=? AND key='active-graphic'").bind(f.orgId).first()).toBeNull();
});

it("legacy native edits report the actual graphic change with revision triggers enabled", async () => {
  const f = await fixture();
  const { handleMobileApi } = await import("../mobile-api.server");
  const response = await handleMobileApi(new Request(
    `https://app.showpilot.tech/api/mobile/v1/graphics/${f.ids[0]}?orgId=${f.orgId}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Legacy name", title: "Legacy title", subtitle: "Kept" }) },
  ), { DB: env.DB });
  expect(await env.DB.prepare("SELECT title,style FROM graphic_template WHERE orgId=? AND id=?").bind(f.orgId, f.ids[0]).first()).toEqual({ title: "Legacy title", style: '{"fontSize":72}' });
  expect((await f.read()).templates.find(g => g.id === f.ids[0])?.revision).toBe(2);
  expect(response?.status).toBe(200);
  expect(await response?.json()).toEqual({ ok: true });
});

it.each(["missing", "foreign"])("legacy native edits reject a %s graphic without changing other organizations", async kind => {
  const foreign = await fixture(), f = await fixture();
  const { handleMobileApi } = await import("../mobile-api.server");
  const id = kind === "foreign" ? foreign.ids[0] : crypto.randomUUID();
  const response = await handleMobileApi(new Request(
    `https://app.showpilot.tech/api/mobile/v1/graphics/${id}?orgId=${f.orgId}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "No", title: "Must not write", subtitle: "" }) },
  ), { DB: env.DB });
  expect(response?.status).toBe(404);
  expect(await env.DB.prepare("SELECT title FROM graphic_template WHERE orgId=? AND id=?").bind(foreign.orgId, foreign.ids[0]).first()).toEqual({ title: "Title" });
});
