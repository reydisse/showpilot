import { Button } from "@/components/ui/button";
import { useState } from "react";
import { Trash2 } from "lucide-react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

export function DeleteSavedTemplateButton({ name, onDelete }: { name: string; onDelete: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return <div className="shrink-0">
    <Button variant="ghost" type="button" disabled={busy} onClick={() => setOpen(true)} aria-label={`Delete ${name} template`} className="flex min-h-11 min-w-11 items-center justify-center rounded text-board-muted hover:text-red-400 disabled:opacity-50"><Trash2 className="h-4 w-4" /></Button>
    {busy && <span role="status" className="text-xs text-board-muted">Deleting…</span>}
    {error && <p role="alert" className="max-w-48 text-xs text-red-400">{error}</p>}
    <ConfirmDialog open={open} onOpenChange={setOpen} title={`Delete ${name}?`} description="This permanently deletes the saved template. Rundowns already created from it remain available." confirmLabel="Delete template" onConfirm={() => {
      setBusy(true); setError("");
      void onDelete().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Could not delete this template. Try again.")).finally(() => setBusy(false));
    }} />
  </div>;
}
