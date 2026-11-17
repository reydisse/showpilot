import { createMobileErrorReporter } from "./error-reporting";

export function createFailureReporter(deps: {
  orgId: string;
  baseUrl: string;
  fetch: (url: string, init: { method: string; headers: Record<string, string>; credentials: "omit"; body: string }) => Promise<unknown>;
  getCookie: () => string | Promise<string>;
}) {
  return createMobileErrorReporter({ send: async report => {
    await deps.fetch(`${deps.baseUrl}/api/operational-errors/${encodeURIComponent(deps.orgId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: await deps.getCookie() },
      credentials: "omit",
      body: JSON.stringify(report),
    });
  } });
}
