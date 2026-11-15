import { QuietActivity } from "@/components/ui/QuietActivity";
export function RelaySyncNotice({ error, occurredAt, status, onRetry }: {
  error: string | null;
  occurredAt?: number | null;
  status?: "connecting" | "reconnecting" | "refreshing" | "connected";
  onRetry: () => void;
}) {
  if (!error) return null;
  return <div role="alert" className="flex min-w-0 flex-wrap items-center gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-300">
    <div className="min-w-0 flex-1 basis-40">
      <p>Changes could not be updated.</p>
      {occurredAt != null && null}
      {status === "refreshing" && <QuietActivity label="Refreshing confirmed data…" />}
    </div>
    <button type="button" className="min-h-11 px-3 font-semibold underline disabled:opacity-50" disabled={status === "refreshing"} onClick={onRetry}>Retry</button>
  </div>;
}
