import { useState } from "react";
import { Lock, LockOpen } from "lucide-react";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { getRundownPinCookieName } from "@/lib/rundown-pin";
import { validateRundownPin } from "@/lib/rbac";

export function RundownUnlock({ orgId, pinAccess }: {
  orgId: string;
  pinAccess: "unprotected" | "locked" | "unlocked";
}) {
  const [open, setOpen] = useState(false);
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (pinAccess === "unprotected") return null;

  async function unlock(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !pin.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const result = await validateRundownPin({ data: { orgId, pin } });
      if (!result.ok) {
        setError("Incorrect PIN. Please try again.");
        return;
      }
      const secure = window.location.protocol === "https:" ? "; Secure" : "";
      document.cookie = `${getRundownPinCookieName(orgId)}=${encodeURIComponent(pin.trim())}; Path=/; Max-Age=14400; SameSite=Lax${secure}`;
      // Reload also reconnects the live socket with its new write authority.
      window.location.reload();
    } catch {
      setError("Could not verify the PIN. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return <>
    <button type="button" className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-board-border bg-board-card px-3 text-xs font-semibold text-board-text hover:border-fire-500/40"
      onClick={() => {
        if (pinAccess === "unlocked") {
          document.cookie = `${getRundownPinCookieName(orgId)}=; Path=/; Max-Age=0; SameSite=Lax`;
          window.location.reload();
        } else {
          setError(null);
          setPin("");
          setOpen(true);
        }
      }}>
      {pinAccess === "unlocked" ? <LockOpen className="h-4 w-4" /> : <Lock className="h-4 w-4" />}
      {pinAccess === "unlocked" ? "Lock changes" : "Unlock changes"}
    </button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-sm border-board-border bg-board-card text-board-text">
        <DialogTitle>Unlock changes</DialogTitle>
        <DialogDescription className="text-board-muted">Enter the organization PIN to edit the rundown and use live controls. You can keep viewing without it.</DialogDescription>
        <form onSubmit={unlock} className="space-y-4">
          <label className="block text-sm" htmlFor="rundown-unlock-pin">PIN</label>
          <input id="rundown-unlock-pin" type="password" inputMode="numeric" autoFocus value={pin} onChange={(event) => setPin(event.target.value)}
            className="w-full rounded-xl border border-board-border bg-board-bg px-4 py-3 text-board-text" />
          {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
          <button type="submit" disabled={busy || !pin.trim()} className="w-full rounded-xl bg-fire-500 px-4 py-3 text-sm font-semibold text-white disabled:opacity-50">{busy ? "Checking…" : "Unlock changes"}</button>
        </form>
      </DialogContent>
    </Dialog>
  </>;
}
