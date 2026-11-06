import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { approveBridgeTarget, authorizeBridgeTarget, listBridgeTargets, removeBridgeTarget } from "../bridge-targets.server";
import { ensureBridgeTestOrg } from "@/test/bridge-fixtures";
const endpoint = { host: "venue.local", port: 4455, protocol: "obs" as const };
const actor = { source: "operator" as const, actorUserId: "operator" };
const request = { type: "connect-device", protocol: "obs", target: "venue.local:4455", settings: { password: "fixture-private-password" } };
async function org() {
  const orgId = `allowlist-${crypto.randomUUID()}`;
  await ensureBridgeTestOrg(orgId);
  return orgId;
}
async function approve(orgId: string, port = 4455, protocol: "obs" | "propresenter" = "obs") {
  await approveBridgeTarget(env.DB, { orgId, label: "Venue", endpoint: { ...endpoint, port, protocol }, actorUserId: "admin" });
}

describe("authoritative Bridge destination allowlist", () => {
  it("denies by default, scopes approvals to org/host/port/protocol, and records safe rejection metadata", async () => {
    const first = await org(); const second = await org();
    await expect(authorizeBridgeTarget(env.DB, first, request, actor)).rejects.toThrow("not approved");
    await approve(first);
    await expect(authorizeBridgeTarget(env.DB, first, request, actor)).resolves.toEqual([endpoint]);
    for (const [orgId, input] of [[second, request], [first, { ...request, target: "other.local:4455" }], [first, { ...request, target: "venue.local:4456" }], [first, { ...request, protocol: "tcp-command" }]] as const) {
      await expect(authorizeBridgeTarget(env.DB, orgId, input, actor)).rejects.toThrow("not approved");
    }
    const audit = await env.DB.prepare("SELECT * FROM bridge_target_audit WHERE orgId = ? AND action = 'rejected'").bind(first).all();
    expect(audit.results).toHaveLength(4);
    expect(audit.results[0]).toMatchObject({ actorUserId: "operator", reason: "unapproved-target", host: "venue.local", port: 4455, protocol: "obs" });
    expect(JSON.stringify(audit)).not.toContain("fixture-private-password");
  });

  it("requires approval for both ProPresenter ports", async () => {
    const orgId = await org();
    const pp = { type: "connect-device", protocol: "propresenter", target: "propresenter:venue.local:50001", settings: {} };
    await approve(orgId, 50001, "propresenter");
    await expect(authorizeBridgeTarget(env.DB, orgId, pp, actor)).rejects.toThrow("not approved");
    await approve(orgId, 1025, "propresenter");
    expect(await authorizeBridgeTarget(env.DB, orgId, pp, actor)).toHaveLength(2);
  });

  it("deduplicates approval, prevents cross-org deletion, and revokes permission immediately", async () => {
    const first = await org(); const second = await org();
    await approve(first); await approve(first);
    const targets = await listBridgeTargets(env.DB, first);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ ...endpoint, label: "Venue", approvedByUserId: "admin" });
    await expect(removeBridgeTarget(env.DB, { orgId: second, id: targets[0].id, actorUserId: "other-admin" })).rejects.toThrow("no longer exists");
    await removeBridgeTarget(env.DB, { orgId: first, id: targets[0].id, actorUserId: "admin" });
    await expect(authorizeBridgeTarget(env.DB, first, request, actor)).rejects.toThrow("not approved");
    expect(await listBridgeTargets(env.DB, first)).toEqual([]);
    expect((await env.DB.prepare("SELECT * FROM bridge_target_audit WHERE orgId = ? AND action = 'removed'").bind(second).all()).results).toEqual([]);
  });

  it("never logs raw credential-bearing input when parsing fails", async () => {
    const orgId = await org();
    const bad = { ...request, target: "http://user:fixture-url-secret@venue.local", command: "fixture-command-secret" };
    await expect(authorizeBridgeTarget(env.DB, orgId, bad, actor)).rejects.toThrow("valid Bridge host");
    const audit = await env.DB.prepare("SELECT * FROM bridge_target_audit WHERE orgId = ?").bind(orgId).all();
    expect(audit.results).toHaveLength(1);
    expect(audit.results[0]).toMatchObject({ host: null, port: null, protocol: null, reason: "invalid-target" });
    expect(JSON.stringify(audit)).not.toMatch(/fixture-(url|command)-secret/);
  });

  it("records connection attribution without storing settings or command bodies", async () => {
    const orgId = await org();
    await approve(orgId);
    await authorizeBridgeTarget(env.DB, orgId, request, actor);
    await authorizeBridgeTarget(env.DB, orgId, request, { source: "automation", actorUserId: "armed-by", executionId: "show-cue-run" });
    const audit = await env.DB.prepare("SELECT actorUserId, source, executionId, host, port, protocol FROM bridge_target_audit WHERE orgId = ? AND action = 'connection-requested' ORDER BY rowid").bind(orgId).all();
    expect(audit.results).toEqual([
      { actorUserId: "operator", source: "operator", executionId: null, ...endpoint },
      { actorUserId: "armed-by", source: "automation", executionId: "show-cue-run", ...endpoint },
    ]);
  });
});
