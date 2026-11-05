export function RelaySyncNotice({ error, onRetry }: { error: string | null; onRetry: () => void }) {
  if (!error) return null;
  return <div role="alert" className="flex items-center gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-300">
    <p className="flex-1">Live changes could not refresh. {error}</p>
    <button type="button" className="min-h-11 px-3 font-semibold underline" onClick={onRetry}>Retry</button>
  </div>;
}
