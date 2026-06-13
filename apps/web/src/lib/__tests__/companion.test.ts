import { describe, it, expect } from "vitest";
import { signToken } from "../kiosk-token";
import {
  COMPANION_TOKEN_PREFIX,
  signCompanionToken,
  verifyCompanionToken,
} from "../companion-token";

const SECRET = "companion-secret-a";
const OTHER_SECRET = "companion-secret-b";

describe("companion token verification", () => {
  it("signs a `cmp_`-prefixed token and verifies it with the same secret", async () => {
    const token = await signCompanionToken({ orgId: "org-1", scope: "companion" }, SECRET);
    expect(token.startsWith(COMPANION_TOKEN_PREFIX)).toBe(true);

    const payload = await verifyCompanionToken(token, SECRET);
    expect(payload).not.toBeNull();
    expect(payload?.orgId).toBe("org-1");
    expect(payload?.scope).toBe("companion");
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await signCompanionToken({ orgId: "org-1" }, OTHER_SECRET);
    expect(await verifyCompanionToken(token, SECRET)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const exp = Math.floor(Date.now() / 1000) - 60;
    const token = await signCompanionToken({ orgId: "org-1", exp }, SECRET);
    expect(await verifyCompanionToken(token, SECRET)).toBeNull();
  });

  it("accepts a not-yet-expired token", async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = await signCompanionToken({ orgId: "org-1", exp }, SECRET);
    const payload = await verifyCompanionToken(token, SECRET);
    expect(payload?.orgId).toBe("org-1");
  });

  it("rejects a kiosk-style JWT that lacks the `cmp_` prefix", async () => {
    // A bare JWT signed with the same secret must NOT authenticate as a
    // companion token — the prefix is part of the trust boundary.
    const bareJwt = await signToken({ orgId: "org-1" }, SECRET);
    expect(bareJwt.startsWith(COMPANION_TOKEN_PREFIX)).toBe(false);
    expect(await verifyCompanionToken(bareJwt, SECRET)).toBeNull();
  });

  it("rejects an empty / malformed token", async () => {
    expect(await verifyCompanionToken("", SECRET)).toBeNull();
    expect(await verifyCompanionToken("cmp_not-a-jwt", SECRET)).toBeNull();
    expect(await verifyCompanionToken("cmp_a.b", SECRET)).toBeNull();
  });

  it("isolates orgs: a token forged for another org fails verification", async () => {
    // The org a token controls is the orgId baked into its signed payload.
    // Tampering the payload to point at another org breaks the signature.
    const token = await signCompanionToken({ orgId: "org-a" }, SECRET);
    const jwt = token.slice(COMPANION_TOKEN_PREFIX.length);
    const [header, , signature] = jwt.split(".");
    const forgedBody = btoa(JSON.stringify({ orgId: "org-b" }))
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    const forged = `${COMPANION_TOKEN_PREFIX}${header}.${forgedBody}.${signature}`;
    expect(await verifyCompanionToken(forged, SECRET)).toBeNull();
  });

  it("two different orgs get tokens that each resolve to only their own org", async () => {
    const a = await signCompanionToken({ orgId: "org-a" }, SECRET);
    const b = await signCompanionToken({ orgId: "org-b" }, SECRET);
    expect((await verifyCompanionToken(a, SECRET))?.orgId).toBe("org-a");
    expect((await verifyCompanionToken(b, SECRET))?.orgId).toBe("org-b");
  });
});
