import { useId, useState } from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import type { CredentialChange } from "@/lib/credential-fields";

export function CredentialSettingInput({ label, configured, placeholder, save }: {
  label: string;
  configured: boolean;
  placeholder?: string;
  save: (change: CredentialChange) => Promise<void>;
}) {
  const id = useId();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  async function submit(change: CredentialChange) {
    if (busy) return;
    setBusy(true); setError(null);
    try { await save(change); setDraft(""); setConfirmClear(false); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The credential could not be saved."); }
    finally { setBusy(false); }
  }
  return <div role="group" aria-label={`${label} credential`} className="min-w-0 space-y-2">
    <p id={`${id}-status`} className="text-xs text-board-muted">{configured ? "Credential saved. Leave this blank to keep it." : "No credential saved."}</p>
    <div className="flex flex-wrap gap-2">
      <input aria-label={label} aria-describedby={`${id}-status`} type="password" autoComplete="new-password" spellCheck={false}
        value={draft} onChange={event => setDraft(event.target.value)} disabled={busy}
        placeholder={configured ? "Enter a replacement" : placeholder}
        className="min-h-11 min-w-0 flex-1 rounded-xl border border-board-border bg-board-bg px-3 text-sm text-board-text placeholder:text-board-muted/50 focus:outline-none focus:border-fire-500" />
      <button type="button" disabled={busy || !draft} onClick={() => { void submit({ action: "replace", value: draft }); }}
        className="min-h-11 rounded-xl border border-board-border px-3 text-sm text-board-text disabled:opacity-50">{busy ? "Saving…" : configured ? "Save replacement" : "Save credential"}</button>
      {configured && <button type="button" disabled={busy} onClick={() => setConfirmClear(true)}
        className="min-h-11 rounded-xl border border-board-border px-3 text-sm text-red-300 disabled:opacity-50">Clear credential</button>}
    </div>
    {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
    <ConfirmDialog open={confirmClear} onOpenChange={open => { if (!busy) setConfirmClear(open); }}
      title={`Clear ${label}?`} description="This connection may stop working until a new credential is saved."
      confirmLabel="Clear credential" loading={busy} onConfirm={() => { void submit({ action: "clear" }); }} />
  </div>;
}
