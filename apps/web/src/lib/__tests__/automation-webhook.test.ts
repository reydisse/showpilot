import { afterEach, expect, it, vi } from "vitest";
import { isPublicIpAddress } from "../../../../../packages/shared/src/automation-webhook-url";
import { assertAutomationWebhookResolvesPublic } from "../automation-webhook.server";
afterEach(() => vi.unstubAllGlobals());
it.each(["8.8.8.8","2606:4700::1111","::ffff:8.8.8.8"])("public %s", ip => expect(isPublicIpAddress(ip)).toBe(true));
it.each(["0.0.0.1","10.0.0.1","100.64.0.1","127.0.0.1","169.254.0.1","172.16.0.1","192.0.0.1","192.0.2.1","192.168.0.1","198.18.0.1","198.51.100.1","203.0.113.1","240.0.0.1","255.255.255.255","::","::1","fe80::1","fc00::1","ff00::1","2001:db8::1","::ffff:127.0.0.1"])("reserved %s", ip => expect(isPublicIpAddress(ip)).toBe(false));
it.each(["public","mixed","rebound","empty","http","invalid","network"])("DNS %s", async mode => {
 vi.stubGlobal("fetch",vi.fn(async (url) => {
 if(mode === "network") throw new Error("offline");
 if(mode === "http") return new Response(null,{status:503});
 if(mode === "invalid") return new Response("invalid");
 const ipv6 = String(url).endsWith("AAAA");
 return Response.json({Status:0,Answer:mode === "empty"?[]:[{type:ipv6?28:1,data:mode === "rebound"?"127.0.0.1":mode === "mixed" && ipv6?"::1":ipv6?"2606:4700::1111":"8.8.8.8"}]});
 }));
 const result = assertAutomationWebhookResolvesPublic("https://example.com");
 if(mode === "public") await expect(result).resolves.toBeUndefined(); else await expect(result).rejects.toThrow();
});
it("skips DNS for literals", async () => { const fetch=vi.fn();vi.stubGlobal("fetch",fetch);await assertAutomationWebhookResolvesPublic("https://8.8.8.8");expect(fetch).not.toHaveBeenCalled(); });
