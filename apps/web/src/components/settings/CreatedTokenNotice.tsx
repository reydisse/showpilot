import { useState } from "react";

/** The creation response stays in component memory only until dismissed. */
export function CreatedTokenNotice({ label, token, onDismiss }: { label: string; token: string; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function copy() {
    try { await navigator.clipboard.writeText(token); setCopied(true); setError(null); }
    catch { setError("Copy failed. Select and copy the token below before dismissing it."); }
  }
  return <section aria-label="New access token" className="my-4 min-w-0 space-y-3 rounded-xl border border-fire-500/50 bg-board-card p-4">
    <p className="text-sm font-semibold text-board-text">Copy the token for {label} now</p>
    <p className="text-xs text-board-muted">This is the only time it will be shown. Save it in your device before dismissing it or leaving this page.</p>
    <textarea aria-label="New token" readOnly value={token} className="min-h-24 w-full min-w-0 rounded-lg border border-board-border bg-board-bg p-3 font-mono text-xs text-board-text" />
    {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
    <div className="flex flex-wrap gap-2">
      <button type="button" onClick={() => { void copy(); }} className="min-h-11 rounded-lg border border-board-border px-3 text-sm text-board-text">{copied ? "Copied" : "Copy new token"}</button>
      <button type="button" onClick={onDismiss} className="min-h-11 rounded-lg border border-board-border px-3 text-sm text-board-text">Dismiss token</button>
    </div>
  </section>;
}
