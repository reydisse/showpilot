const safeNames = ["Error", "TypeError", "SyntaxError", "RangeError", "ReferenceError", "URIError", "AggregateError", "AbortError"] as const;
export type SafeMobileErrorName = (typeof safeNames)[number] | "Unknown";

export function safeMobileErrorName(error: unknown): SafeMobileErrorName {
  try {
    const name = error instanceof Error ? error.name : "Unknown";
    return safeNames.includes(name as (typeof safeNames)[number]) ? name as SafeMobileErrorName : "Unknown";
  } catch { return "Unknown"; }
}

export type MobileErrorReport = {
  code: "browser_error" | "browser_rejection";
  errorName: SafeMobileErrorName;
};

export function createMobileErrorReporter(deps: {
  send: (report: MobileErrorReport) => Promise<void>;
  now?: () => number;
}): { reportError(error: unknown): void; reportRejection(reason: unknown): void } {
  const seen = new Map<string, number>();
  let windowStarted = 0, reports = 0;
  const submit = (report: MobileErrorReport): void => {
    try {
      const now = (deps.now ?? Date.now)();
      if (now - windowStarted >= 60_000) { reports = 0; windowStarted = now; seen.clear(); }
      const key = JSON.stringify(report);
      if (reports >= 5 || now - (seen.get(key) ?? -Infinity) < 60_000) return;
      reports++; seen.set(key, now);
      void Promise.resolve().then(() => deps.send(report)).catch(() => undefined);
    } catch { /* Diagnostic failures must never escape or report themselves. */ }
  };
  return {
    reportError: (error) => submit({ code: "browser_error", errorName: safeMobileErrorName(error) }),
    reportRejection: (reason) => submit({ code: "browser_rejection", errorName: safeMobileErrorName(reason) }),
  };
}
