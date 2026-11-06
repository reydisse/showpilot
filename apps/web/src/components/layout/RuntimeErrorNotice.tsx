import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { installBrowserErrorReporting } from "@/lib/browser-error-reporting";

export function RuntimeErrorNotice({ orgId }: { orgId: string }) {
  const [lastError, setLastError] = useState<{ orgId: string; occurredAt: number } | null>(null);
  useEffect(() => installBrowserErrorReporting(orgId, notice => setLastError({ orgId, ...notice })), [orgId]);
  if (lastError?.orgId !== orgId) return null;
  return <div role="alert" className="flex shrink-0 flex-wrap items-center gap-3 border-b border-red-400/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
    <p className="min-w-0 flex-1">An unexpected error occurred. Review the current state before retrying the action. <time dateTime={new Date(lastError.occurredAt).toISOString()} className="whitespace-nowrap">{new Date(lastError.occurredAt).toLocaleTimeString()}</time></p>
    <Button type="button" variant="ghost" className="min-h-11 min-w-11 text-red-200" onClick={() => setLastError(null)}>Dismiss error</Button>
  </div>;
}
