import { describe, it, expect } from "vitest";
import { signToken, verifyToken } from "../kiosk-token";
import {
  ValidationError,
  emailSchema,
  idSchema,
  orgSlugSchema,
  parseOrThrow,
  serviceDateSchema,
} from "../validation";
import { z } from "zod";

const SECRET = "test-secret-a";
const OTHER_SECRET = "test-secret-b";

describe("kiosk token verification", () => {
  it("verifies a token signed with the same secret", async () => {
    const token = await signToken({ orgId: "org-1", view: "board" }, SECRET);
    const payload = await verifyToken(token, SECRET);
    expect(payload).not.toBeNull();
    expect(payload?.orgId).toBe("org-1");
    expect(payload?.view).toBe("board");
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await signToken({ orgId: "org-1" }, OTHER_SECRET);
    expect(await verifyToken(token, SECRET)).toBeNull();
  });

  it("rejects a token whose payload was tampered with", async () => {
    const token = await signToken({ orgId: "org-1" }, SECRET);
    const [header, , signature] = token.split(".");
    const forgedBody = btoa(JSON.stringify({ orgId: "org-2" }))
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    expect(await verifyToken(`${header}.${forgedBody}.${signature}`, SECRET)).toBeNull();
  });

  it("rejects a structurally invalid token (two parts)", async () => {
    expect(await verifyToken("abc.def", SECRET)).toBeNull();
  });

  it("rejects a structurally invalid token (garbage base64)", async () => {
    expect(await verifyToken("!!!.@@@.###", SECRET)).toBeNull();
  });

  it("rejects an empty token", async () => {
    expect(await verifyToken("", SECRET)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const exp = Math.floor(Date.now() / 1000) - 60; // expired a minute ago
    const token = await signToken({ orgId: "org-1", exp }, SECRET);
    expect(await verifyToken(token, SECRET)).toBeNull();
  });

  it("accepts a not-yet-expired token", async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = await signToken({ orgId: "org-1", exp }, SECRET);
    expect(await verifyToken(token, SECRET)).not.toBeNull();
  });
});

describe("validation schemas", () => {
  it("orgSlugSchema accepts valid slugs", () => {
    expect(orgSlugSchema.safeParse("grace-church").success).toBe(true);
    expect(orgSlugSchema.safeParse("abc").success).toBe(true);
  });

  it("orgSlugSchema rejects bad slugs", () => {
    expect(orgSlugSchema.safeParse("ab").success).toBe(false); // too short
    expect(orgSlugSchema.safeParse("Grace-Church").success).toBe(false); // uppercase
    expect(orgSlugSchema.safeParse("has spaces").success).toBe(false);
    expect(orgSlugSchema.safeParse("a".repeat(41)).success).toBe(false); // too long
    expect(orgSlugSchema.safeParse("slug/../etc").success).toBe(false);
  });

  it("emailSchema accepts a valid email and rejects invalid ones", () => {
    expect(emailSchema.safeParse("td@church.org").success).toBe(true);
    expect(emailSchema.safeParse("not-an-email").success).toBe(false);
    expect(emailSchema.safeParse("").success).toBe(false);
    expect(emailSchema.safeParse(`${"a".repeat(250)}@b.co`).success).toBe(false); // oversized
  });

  it("idSchema rejects empty and oversized strings", () => {
    expect(idSchema.safeParse("cuid123").success).toBe(true);
    expect(idSchema.safeParse("").success).toBe(false);
    expect(idSchema.safeParse("x".repeat(65)).success).toBe(false);
    expect(idSchema.safeParse(123).success).toBe(false);
  });

  it("serviceDateSchema only accepts YYYY-MM-DD", () => {
    expect(serviceDateSchema.safeParse("2026-06-09").success).toBe(true);
    expect(serviceDateSchema.safeParse("06/09/2026").success).toBe(false);
    expect(serviceDateSchema.safeParse("2026-6-9").success).toBe(false);
  });
});

describe("parseOrThrow", () => {
  const schema = z.object({ orgId: idSchema, name: z.string().min(1).max(10) });

  it("returns parsed data on success", () => {
    const result = parseOrThrow(schema, { orgId: "org-1", name: "ok" });
    expect(result).toEqual({ orgId: "org-1", name: "ok" });
  });

  it("strips unknown keys (no payload smuggling)", () => {
    const result = parseOrThrow(schema, {
      orgId: "org-1",
      name: "ok",
      isAdmin: true,
    } as unknown);
    expect("isAdmin" in result).toBe(false);
  });

  it("throws a ValidationError with status 400 and a path-prefixed message", () => {
    try {
      parseOrThrow(schema, { orgId: "org-1", name: "" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      const v = err as ValidationError;
      expect(v.status).toBe(400);
      expect(v.message).toContain("name");
    }
  });

  it("throws on non-object input when an object is expected", () => {
    expect(() => parseOrThrow(schema, "a-string")).toThrow(ValidationError);
    expect(() => parseOrThrow(schema, null)).toThrow(ValidationError);
  });
});

// FOLLOW-UP: true cross-org DB isolation tests (e.g. org A reading org B's
// stream destinations) need a D1 test harness via @cloudflare/vitest-pool-workers,
// which is not configured in this repo yet. The org-scoping assertions
// themselves live in each server function (see settings.ts / data.ts patterns).
