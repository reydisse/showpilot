import { env } from "cloudflare:workers";
import { abortAllDurableObjects } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getActiveRundownRelayTarget } from "../active-rundown-relay";
import { buildCompanionDeps } from "../companion-api";
import { runTmControl } from "../tm-operations";

vi.mock("@tanstack/react-start/server", () => ({ getRequestHeaders: () => new Headers() }));
vi.mock("@tanstack/react-start", () => {
  const builder = () => {
    let validate = (data: unknown) => data;
    const chain = {
      middleware: () => chain,
      inputValidator: (validator: typeof validate) => { validate = validator; return chain; },
      handler: (handler: (input: unknown) => unknown) => async (input: { data: unknown }) => handler({ data: validate(input.data) }),
      server: () => chain,
    };
    return chain;
  };
  return { createServerFn: builder, createMiddleware: builder, createServerOnlyFn: <T>(fn: T): T => fn };
});
vi.mock("../org-access", async (original) => ({
  ...await original<typeof import("../org-access")>(),
  assertOrgPermission: async () => ({ user: { id: "test-operator", name: "Operator" }, access: { role: "owner", grantedPermissions: [] } }),
}));

afterEach(async () => { await abortAllDurableObjects(); });

describe("technical dashboard show confirmation", () => {
  it("rejects a changed active show and pins a confirmed command to the reviewed room", async () => {
    const orgId = "tm-confirm-show";
    const serviceDate = "2026-09-30";
    await env.DB.prepare("INSERT INTO organization (id, name, slug, createdAt) VALUES (?, 'TM test', ?, CURRENT_TIMESTAMP)").bind(orgId, orgId).run();
    for (const showId of ["tm-show-a", "tm-show-b"]) {
      await env.DB.prepare(`INSERT INTO rundown (id, orgId, serviceDate, name, location, status, createdAt, updatedAt)
        VALUES (?, ?, ?, 'Test', 'Room', 'draft', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`).bind(showId, orgId, serviceDate).run();
    }
    await env.DB.prepare("INSERT INTO app_setting (id, orgId, key, value) VALUES ('tm-active', ?, 'active-show-id', 'tm-show-a')").bind(orgId).run();
    const targetA = await getActiveRundownRelayTarget(env.DB, orgId);
    const depsA = buildCompanionDeps({ orgId, target: targetA });
    const item = (id: string) => ({ id, title: id, type: "segment", duration: 60000, status: "upcoming", sortOrder: 0, notes: "", assignee: "", cue: "", hardStop: false });
    await depsA.relayCommand(orgId, "seed", { items: [item("a")] });
    await depsA.relayCommand(orgId, "timer-start", { itemId: "a" });
    await env.DB.prepare("UPDATE app_setting SET value = 'tm-show-b' WHERE orgId = ? AND key = 'active-show-id'").bind(orgId).run();
    const targetB = await getActiveRundownRelayTarget(env.DB, orgId);
    const depsB = buildCompanionDeps({ orgId, target: targetB });
    await depsB.relayCommand(orgId, "seed", { items: [item("b")] });
    await depsB.relayCommand(orgId, "timer-start", { itemId: "b" });

    await expect(runTmControl({ data: { orgId, action: "timer-stop", target: { showId: targetA.showId, serviceDate } } })).rejects.toThrow("Active show changed");
    expect((await depsA.relayState(orgId)).timer.playback).toBe("play");
    expect((await depsB.relayState(orgId)).timer.playback).toBe("play");

    // Even if the pointer moves after validation, a pinned command cannot stop the new room.
    await depsA.relayCommand(orgId, "timer-stop");
    expect((await depsA.relayState(orgId)).timer.playback).toBe("stop");
    expect((await depsB.relayState(orgId)).timer.playback).toBe("play");
    await expect(depsA.relayCommand("another-org", "timer-stop")).rejects.toThrow("organization mismatch");
    await expect(depsB.relayCommand(orgId, "reset")).rejects.toThrow("Rundown command failed");
    await expect(runTmControl({ data: { orgId, action: "timer-stop", target: { showId: targetB.showId, serviceDate } } })).resolves.toEqual({ ok: true, action: "timer-stop" });
    expect((await depsB.relayState(orgId)).timer.playback).toBe("stop");
  });
});
