import { browserErrorSchema, safeErrorName, type BrowserErrorReport } from "./operational-errors";

export interface BrowserErrorNotice { occurredAt: number }

/** Call only within an authenticated org shell. Never send messages, stacks or page URLs. */
export function installBrowserErrorReporting(orgId: string, onError: (notice: BrowserErrorNotice) => void): () => void {
  const seen = new Map<string, number>();
  const pending = new Set<AbortController>();
  let windowStarted = 0, reports = 0, disposed = false;
  const submit = (report: BrowserErrorReport) => {
    if (disposed) return;
    const now = Date.now();
    if (now - windowStarted >= 60_000) { reports = 0; windowStarted = now; seen.clear(); }
    const key = JSON.stringify(report);
    if (reports >= 5 || now - (seen.get(key) ?? -Infinity) < 60_000) return;
    reports++; seen.set(key, now);
    onError({ occurredAt: now });
    const controller = new AbortController(); pending.add(controller);
    const timeout = setTimeout(() => controller.abort(), 3000);
    // Swallow only the diagnostic request's failure; it must not recursively report itself.
    void Promise.resolve().then(() => {
      if (disposed || controller.signal.aborted) return;
      return fetch(`/api/operational-errors/${encodeURIComponent(orgId)}`, {
      method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(report), signal: controller.signal,
      });
    }).catch(() => undefined).finally(() => { clearTimeout(timeout); pending.delete(controller); });
  };
  const error = (event: ErrorEvent) => {
    const report: BrowserErrorReport = { code: "browser_error", errorName: safeErrorName(event.error) };
    try {
      const url = new URL(event.filename);
      if (url.origin === window.location.origin && /^\/assets\/[A-Za-z0-9_$.-]+\.js$/.test(url.pathname)) {
        const details = browserErrorSchema.safeParse({ ...report, asset: url.pathname.slice("/assets/".length), line: event.lineno, column: event.colno });
        if (details.success) { submit(details.data); return; }
      }
    } catch { /* Inline/extension/cross-origin errors deliberately omit their source. */ }
    submit(report);
  };
  const rejection = (event: PromiseRejectionEvent) => submit({ code: "browser_rejection", errorName: safeErrorName(event.reason) });
  window.addEventListener("error", error);
  window.addEventListener("unhandledrejection", rejection);
  return () => {
    disposed = true;
    window.removeEventListener("error", error); window.removeEventListener("unhandledrejection", rejection);
    for (const controller of pending) controller.abort();
    pending.clear(); seen.clear();
  };
}
