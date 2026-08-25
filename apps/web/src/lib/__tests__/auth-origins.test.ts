import { describe, expect, it } from "vitest";
import { getDevelopmentTrustedOrigins } from "../auth-origins";

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
