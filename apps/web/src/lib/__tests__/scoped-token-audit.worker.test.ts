import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { createKioskToken, revokeKioskToken } from "../kiosk";
import { createCompanionToken, revokeCompanionToken } from "../companion";
vi.mock("@tanstack/react-start/server", () => ({ getRequestHeaders: () => new Headers() }));
vi.mock("@tanstack/react-start", () => {
  const builder = () => { const chain = { inputValidator: () => chain, handler: (fn: unknown) => fn }; return chain; };
  return { createServerFn: builder };
});
vi.mock("../auth", () => ({ getAuth: () => ({ api: { getSession: async () => ({ user: { id: "actor" } }) } }) }));
vi.mock("../plan-limits", () => ({ requirePlanFeature: async () => {} }));
vi.mock("../db", () => ({ getPrisma: () => ({
  member: { findFirst: async () => ({ role: "owner" }) },
  organization: { findUnique: async () => ({ slug: "fixture" }) },
  ...Object.fromEntries(["kiosk", "companion"].map(kind => [kind + "Token", {
    create: async () => ({ id: kind + "-id" }),
    findUnique: async () => ({ orgId: "org" }),
    update: async () => ({ id: kind + "-id", revokedAt: new Date() }),
  }])),
}) }));
it.each(["kiosk", "companion"] as const)("audits %s creation and revocation without credentials", async kind => {
  const create = kind === "kiosk" ? createKioskToken : createCompanionToken;
  const revoke = kind === "kiosk" ? revokeKioskToken : revokeCompanionToken;
  const result = await (create as any)({ data: { orgId: "org", label: "secret label", view: "timer", expiresInDays: null } });
  await (revoke as any)({ data: { tokenId: result.id } });
  const rows = await env.DB.prepare("SELECT * FROM scoped_token_audit WHERE tokenId = ? ORDER BY action").bind(result.id).all();
  expect(rows.results).toHaveLength(2);
  expect(rows.results).toEqual(["created", "revoked"].map(action => ({ id: expect.any(String), orgId: "org", tokenId: result.id, kind, action, actorUserId: "actor", createdAt: expect.any(Number) })));
  expect(JSON.stringify(rows.results)).not.toContain(result.token);
  expect(JSON.stringify(rows.results)).not.toContain("secret label");
});
