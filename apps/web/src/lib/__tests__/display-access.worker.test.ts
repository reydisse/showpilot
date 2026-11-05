import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { authenticateDisplayRequest, displayCookieName, DISPLAY_PASS_LIFETIME_MS, issueDisplayPass } from "../display-access.server";
import { signToken } from "../kiosk-token";

const secret = "display-fixture-signing-secret";
const orgId = "display-fixture-org";
function request(token?: string) { return new Request("https://app.example/timer/venue", { headers: token ? { "x-showpilot-display-pass": token } : {} }); }

describe("scoped display credentials", () => {
  it("requires a signed, unexpired pass for the exact organization and display surface", async () => {
    const issued = await issueDisplayPass(orgId, "timer", secret);
    expect(await authenticateDisplayRequest(env.DB, request(issued.token), orgId, "timer", secret)).toEqual(issued.authority);
    expect(await authenticateDisplayRequest(env.DB, request(), orgId, "timer", secret)).toBeNull();
    expect(await authenticateDisplayRequest(env.DB, request(issued.token), "other-org", "timer", secret)).toBeNull();
    expect(await authenticateDisplayRequest(env.DB, request(issued.token), orgId, "overlay", secret)).toBeNull();
    expect(await authenticateDisplayRequest(env.DB, request(issued.token), orgId, "timer", "wrong-secret")).toBeNull();
    expect(await authenticateDisplayRequest(env.DB, request(issued.token), orgId, "timer", undefined)).toBeNull();
    expect(await authenticateDisplayRequest(env.DB, request(issued.token), orgId, "timer", secret, issued.authority.expiresAt)).toBeNull();
  });

  it("accepts a scope-specific cookie and never confuses two open organizations or displays", async () => {
    const timer = await issueDisplayPass(orgId, "timer", secret);
    const overlay = await issueDisplayPass(orgId, "overlay", secret);
    const headers = { cookie: `${displayCookieName(orgId, "timer")}=${timer.token}; ${displayCookieName(orgId, "overlay")}=${overlay.token}` };
    const req = new Request("https://app.example/api/rundown/org/ws?display=1", { headers });
    expect(await authenticateDisplayRequest(env.DB, req, orgId, "timer", secret)).toEqual(timer.authority);
    expect(await authenticateDisplayRequest(env.DB, req, orgId, "overlay", secret)).toEqual(overlay.authority);
    expect(await authenticateDisplayRequest(env.DB, req, "other-org", "timer", secret)).toBeNull();
    expect(await authenticateDisplayRequest(env.DB, new Request(`${req.url}&displayPass=invalid`, { headers }), orgId, "timer", secret)).toBeNull();
  });

  it("rejects valid signatures with malformed or overly broad claims", async () => {
    const iat = Math.floor(Date.now() / 1000);
    const base = { purpose: "showpilot-display-v1", orgId, surface: "timer", iat, exp: iat + 300 };
    for (const change of [
      { exp: "tomorrow" }, { exp: null }, { exp: iat }, { iat: iat + 60 }, { surface: "board" },
      { exp: iat + DISPLAY_PASS_LIFETIME_MS / 1000 + 1 }, { purpose: "some-other-capability" },
    ]) {
      const token = await signToken({ ...base, ...change }, secret);
      expect(await authenticateDisplayRequest(env.DB, request(token), orgId, "timer", secret)).toBeNull();
    }
    await expect(issueDisplayPass(orgId, "timer", "")).rejects.toThrow("unavailable");
  });

  it("requires an active matching kiosk record, including its view, expiration, and revocation", async () => {
    await env.DB.prepare("INSERT INTO organization (id, name, slug, createdAt) VALUES (?, 'Display fixture', ?, CURRENT_TIMESTAMP)").bind(orgId, orgId).run();
    const now = Date.now();
    const token = await signToken({ orgId, orgSlug: orgId, view: "timer", iat: Math.floor(now / 1000) }, secret);
    expect(await authenticateDisplayRequest(env.DB, request(token), orgId, "timer", secret)).toBeNull();
    await env.DB.prepare("INSERT INTO kiosk_token (id, orgId, label, view, token, createdBy) VALUES ('display-kiosk-fixture', ?, 'Fixture', 'timer', ?, 'fixture-owner')").bind(orgId, token).run();
    expect(await authenticateDisplayRequest(env.DB, request(token), orgId, "timer", secret, now)).toEqual({ orgId, surface: "timer", expiresAt: now + DISPLAY_PASS_LIFETIME_MS });
    expect(await authenticateDisplayRequest(env.DB, request(token), orgId, "overlay", secret)).toBeNull();
    await env.DB.prepare("UPDATE kiosk_token SET expiresAt = ? WHERE id = 'display-kiosk-fixture' AND orgId = ?").bind(new Date(now - 1000).toISOString(), orgId).run();
    expect(await authenticateDisplayRequest(env.DB, request(token), orgId, "timer", secret)).toBeNull();
    await env.DB.prepare("UPDATE kiosk_token SET expiresAt = NULL, revokedAt = CURRENT_TIMESTAMP WHERE id = 'display-kiosk-fixture' AND orgId = ?").bind(orgId).run();
    expect(await authenticateDisplayRequest(env.DB, request(token), orgId, "timer", secret)).toBeNull();
  });
});
