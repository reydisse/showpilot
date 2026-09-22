import { describe, expect, it } from "vitest";
import { withSecurityHeaders } from "../http-security-headers";

describe("HTTP security headers", () => {
  it("hardens HTTPS responses without changing their body or status", async () => {
    const response = withSecurityHeaders(
      new Request("https://showpilot.tech/login"),
      new Response("ok", { status: 201, headers: { "Cache-Control": "no-store" } }),
    );

    expect(response.status).toBe(201);
    expect(await response.text()).toBe("ok");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Strict-Transport-Security")).toContain("includeSubDomains");
    const contentSecurityPolicy = response.headers.get("Content-Security-Policy");
    expect(contentSecurityPolicy).toContain("object-src 'none'");
    expect(contentSecurityPolicy).toContain("https://fonts.googleapis.com");
    expect(contentSecurityPolicy).toContain("https://fonts.gstatic.com");
    expect(contentSecurityPolicy).toContain("https://static.cloudflareinsights.com");
    expect(response.headers.get("Permissions-Policy")).toContain("camera=()");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
  });

  it("does not advertise HSTS on local HTTP development responses", () => {
    const response = withSecurityHeaders(
      new Request("http://localhost:3000/login"),
      new Response("ok"),
    );
    expect(response.headers.has("Strict-Transport-Security")).toBe(false);
  });

  it("does not reconstruct WebSocket upgrade responses", () => {
    const response = new Response(null);
    Object.defineProperty(response, "webSocket", { value: {} });
    expect(withSecurityHeaders(new Request("https://showpilot.tech/api/chat/org/ws"), response)).toBe(response);
  });
});
