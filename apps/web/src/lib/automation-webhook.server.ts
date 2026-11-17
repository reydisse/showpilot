import { isPublicIpAddress } from "../../../../packages/shared/src/automation-webhook-url";

export async function assertAutomationWebhookResolvesPublic(url: string, signal?: AbortSignal): Promise<void> {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  if (host.includes(":") || /^[\d.]+$/.test(host)) {
    if (!isPublicIpAddress(host)) throw new Error("Custom webhook address must be public.");
    return;
  }
  try {
    const answers = await Promise.all(["A", "AAAA"].map(async type => {
      const response = await globalThis.fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`, { headers: { Accept: "application/dns-json" }, signal });
      if (!response.ok) throw new Error();
      const data = await response.json() as { Status?: number; Answer?: { type: number; data: string }[] };
      if (!data || data.Status !== 0 || (data.Answer !== undefined && !Array.isArray(data.Answer))) throw new Error();
      return (data.Answer ?? []).filter(answer => answer.type === 1 || answer.type === 28).map(answer => answer.data);
    }));
    const addresses = answers.flat();
    if (!addresses.length || addresses.some(address => typeof address !== "string" || !isPublicIpAddress(address))) throw new Error();
  } catch {
    throw new Error("Custom webhook DNS resolution failed or returned a non-public address.");
  }
}
