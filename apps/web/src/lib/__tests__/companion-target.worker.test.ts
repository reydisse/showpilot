import { env } from "cloudflare:workers";
import { abortAllDurableObjects } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { runCompanion, buildCompanionDeps } from "../companion-api";
import { getCompanionSecret } from "../companion";
import { signCompanionToken } from "../companion-token";
import { getActiveRundownRelayTarget } from "../active-rundown-relay";
import { timerStart, timerStop } from "../companion-control";

// Request adapter only; token authentication, D1 and relay commands are real.
vi.mock("@tanstack/react-start/server", () => ({ getRequestHeaders: () => new Headers() }));
vi.mock("@tanstack/react-start", () => {
  const builder = () => {
    const chain = { middleware: () => chain, inputValidator: () => chain, handler: (fn: unknown) => fn, server: () => chain };
    return chain;
  };
  return { createServerFn: builder, createMiddleware: builder, createServerOnlyFn: <T>(fn: T): T => fn };
});
afterEach(() => abortAllDurableObjects());

async function fixture() {
  const orgId = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO organization (id,name,slug,createdAt) VALUES (?,'Companion',?,CURRENT_TIMESTAMP)").bind(orgId, orgId).run();
  const serviceDate = "2026-11-05";
  const a = crypto.randomUUID(), b = crypto.randomUUID();
  for (const showId of [a, b]) await env.DB.prepare("INSERT INTO rundown (id,orgId,serviceDate,name) VALUES (?,?,?,'Companion show')").bind(showId, orgId, serviceDate).run();
  await env.DB.prepare("INSERT INTO app_setting (id,orgId,key,value) VALUES (?,?,'active-show-id',?)").bind(crypto.randomUUID(), orgId, a).run();
  const deps = buildCompanionDeps({ orgId, target: await getActiveRundownRelayTarget(env.DB, orgId) });
  await deps.relayCommand(orgId, "seed", { items: [{ id: "cue", title: "Companion cue", type: "segment", duration: 60000, notes: "", assignee: "", cue: "", status: "upcoming", sortOrder: 0, hardStop: false }] });
  const token = await signCompanionToken({ orgId, orgSlug: orgId, exp: Math.floor(Date.now() / 1000) + 300 }, getCompanionSecret());
  await env.DB.prepare("INSERT INTO companion_token (id,orgId,label,token,createdBy) VALUES (?,?,'Fixture',?,'operator')").bind(crypto.randomUUID(), orgId, token).run();
  const request = (body?: string) => new Request("https://app.showpilot.test/api/v1/companion/timer/start", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body });
  return { orgId, a, b, serviceDate, deps, request };
}

it("returns the target actually used even when the active show changes during a Companion request", async () => {
  const f = await fixture();
  const response = await runCompanion({ request: f.request(), handler: async ({ deps, orgId }) => {
    await env.DB.prepare("UPDATE app_setting SET value=? WHERE orgId=? AND key='active-show-id'").bind(f.b, f.orgId).run();
    return timerStart(deps, orgId);
  } });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ ok: true, showId: f.a, serviceDate: f.serviceDate });
  expect((await f.deps.relayState(f.orgId)).timer.playback).toBe("play");
  expect((await getActiveRundownRelayTarget(env.DB, f.orgId)).showId).toBe(f.b);
  const stop = await runCompanion({ request: f.request(), handler: ({ deps, orgId }) => timerStop(deps, orgId) });
  expect(await stop.json()).toMatchObject({ ok: true, showId: f.b, serviceDate: f.serviceDate });
  expect((await f.deps.relayState(f.orgId)).timer.playback).toBe("play");
});

it("reports resolved targets on validation, handler and execution errors without leaking internals", async () => {
  const f = await fixture();
  const schema = z.object({ enabled: z.boolean() });
  const unused = vi.fn(async () => ({ status: 200, body: { ok: true } }));
  const invalid = await runCompanion({ request: f.request("{}"), schema, handler: unused });
  expect(invalid.status).toBe(400);
  expect(await invalid.json()).toMatchObject({ ok: false, showId: f.a, serviceDate: f.serviceDate });
  expect(unused).not.toHaveBeenCalled();
  const denied = await runCompanion({ request: f.request(), handler: async () => ({ status: 403, body: { ok: false, error: "Feature disabled" } }) });
  expect(denied.status).toBe(403);
  expect(await denied.json()).toMatchObject({ ok: false, showId: f.a, serviceDate: f.serviceDate });
  const failed = await runCompanion({ request: f.request(), handler: async () => { throw new Error("private provider response"); } });
  expect(failed.status).toBe(503);
  expect(await failed.json()).toMatchObject({ ok: false, error: "control_failed", showId: f.a, serviceDate: f.serviceDate });
  const unauthorized = await runCompanion({ request: new Request("https://app.showpilot.test"), handler: unused });
  expect(unauthorized.status).toBe(401);
  expect(await unauthorized.json()).toMatchObject({ showId: null, serviceDate: null });
});
