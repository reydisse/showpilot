import { describe, expect, it } from "vitest";
import { getDevelopmentTrustedOrigins, isAllowedApiOrigin } from "../auth-origins";

describe("development auth origins", () => {
  it("trusts known dev ports on the configured private LAN host", () => {
    expect(getDevelopmentTrustedOrigins("http://10.128.57.247:3001")).toEqual([
      "http://10.128.57.247:3001",
      "http://10.128.57.247:3000",
      "http://10.128.57.247:5173",
      "http://10.128.57.247:8081",
    ]);
  });

  it("supports loopback and shared development networks", () => {
    expect(getDevelopmentTrustedOrigins("http://localhost:3001")).toContain(
      "http://localhost:8081",
    );
    expect(getDevelopmentTrustedOrigins("http://100.66.184.15:3001")).toContain(
      "http://100.66.184.15:8081",
    );
  });

  it("never expands production or public HTTP origins", () => {
    expect(getDevelopmentTrustedOrigins("https://showpilot.tech")).toEqual([]);
    expect(getDevelopmentTrustedOrigins("http://203.0.113.10:3001")).toEqual([]);
    expect(getDevelopmentTrustedOrigins("not a url")).toEqual([]);
  });
});

describe("credentialed API origins", () => {
  it("allows ShowPilot HTTPS applications to call production", () => {
    expect(
      isAllowedApiOrigin("https://showpilot.tech", "https://showpilot.tech/api/mobile/v1/bootstrap"),
    ).toBe(true);
    expect(
      isAllowedApiOrigin("https://admin.showpilot.tech", "https://showpilot.tech/api/mobile/v1/bootstrap"),
    ).toBe(true);
    expect(
      isAllowedApiOrigin("https://www.showpilot.tech", "https://showpilot.tech/api/auth/get-session"),
    ).toBe(true);
  });

  it("allows private LAN origins only against a private HTTP API", () => {
    expect(
      isAllowedApiOrigin("http://10.128.57.247:8081", "http://10.128.57.247:3001/api/mobile/v1/bootstrap"),
    ).toBe(true);
    expect(
      isAllowedApiOrigin("http://localhost:8081", "http://10.128.57.247:3001/api/auth/sign-in/email"),
    ).toBe(true);
    expect(
      isAllowedApiOrigin("http://10.128.57.247:8081", "https://showpilot.tech/api/mobile/v1/bootstrap"),
    ).toBe(false);
  });

  it("rejects insecure, public, and malformed origins", () => {
    expect(
      isAllowedApiOrigin("http://admin.showpilot.tech", "https://showpilot.tech/api/mobile/v1/bootstrap"),
    ).toBe(false);
    expect(
      isAllowedApiOrigin("http://203.0.113.10:8081", "http://10.128.57.247:3001/api/mobile/v1/bootstrap"),
    ).toBe(false);
    expect(
      isAllowedApiOrigin("https://showpilot.tech.evil.example", "https://showpilot.tech/api/mobile/v1/bootstrap"),
    ).toBe(false);
    expect(isAllowedApiOrigin("not a url", "https://showpilot.tech/api/mobile/v1/bootstrap")).toBe(false);
  });
});
