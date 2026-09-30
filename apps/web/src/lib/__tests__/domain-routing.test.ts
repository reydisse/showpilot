import { describe, expect, it } from "vitest";
import { landingRedirect } from "../domain-routing";

describe("application domain migration", () => {
  it("sends apex homepage visitors to the landing page without losing campaign parameters", () => {
    const response = landingRedirect(new Request("https://showpilot.tech/?utm_source=launch"));
    expect(response?.status).toBe(302);
    expect(response?.headers.get("location")).toBe("https://www.showpilot.tech/?utm_source=launch");
    expect(response?.headers.get("cache-control")).toContain("no-store");
    expect(response?.headers.get("vary")).toBe("User-Agent");
  });

  it("keeps the application and admin homepages separate from marketing", () => {
    for (const origin of ["https://app.showpilot.tech", "https://admin.showpilot.tech", "http://localhost:3000"]) {
      expect(landingRedirect(new Request(origin))).toBeNull();
    }
  });

  it("keeps installed Desktop versions on their trusted native origin", () => {
    for (const version of ["0.1.1", "0.1.2", "0.1.3"]) {
      expect(landingRedirect(new Request("https://showpilot.tech", {
        headers: { "User-Agent": `ShowPilotDesktop/${version}` },
      }))).toBeNull();
    }
  });

  it("preserves old invitations, native companion windows, API clients and payment webhooks", () => {
    for (const path of ["/invite/abc", "/login", "/timer/team", "/team/board", "/team/checkin",
      "/api/auth/get-session", "/api/bridge/team", "/api/stripe/webhook", "/_serverFn/abc"]) {
      expect(landingRedirect(new Request(`https://showpilot.tech${path}`))).toBeNull();
    }
    expect(landingRedirect(new Request("https://showpilot.tech", { method: "POST" }))).toBeNull();
    expect(landingRedirect(new Request("https://showpilot.tech", {
      headers: { Upgrade: "websocket" },
    }))).toBeNull();
  });

  it("handles homepage HEAD requests consistently", () => {
    expect(landingRedirect(new Request("https://showpilot.tech", { method: "HEAD" }))?.status).toBe(302);
  });
});
