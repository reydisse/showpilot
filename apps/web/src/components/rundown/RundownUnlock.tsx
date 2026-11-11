import { Button } from "@/components/ui/button";
import { useState } from "react";
import { Lock, LockOpen } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { getRundownPinCookieName } from "@/lib/rundown-pin";
import { useRundownPinVerification } from "@/hooks/useRundownPinVerification";

export function RundownUnlock({
  orgId,
  pinAccess,
}: {
  orgId: string;
  pinAccess: "unprotected" | "locked" | "unlocked";
}) {
  const [open, setOpen] = useState(false);
  const {
    pin,
    state,
    submitting: busy,
    verify,
    changePin,
    reset,
  } = useRundownPinVerification(orgId, async () => {
    // Reconnect the current live socket with its new write authority.
    window.location.reload();
  });
  if (pinAccess === "unprotected") return null;

  return (
    <>
      <Button
        variant="ghost"
        type="button"
        className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-board-border bg-board-card px-3 text-xs font-semibold text-board-text hover:border-fire-500/40"
        onClick={() => {
          if (pinAccess === "unlocked") {
            document.cookie = `${getRundownPinCookieName(orgId)}=; Path=/; Max-Age=0; SameSite=Lax`;
            window.location.reload();
          } else {
            reset();
            setOpen(true);
          }
        }}
      >
        {pinAccess === "unlocked" ? (
          <LockOpen className="h-4 w-4" />
        ) : (
          <Lock className="h-4 w-4" />
        )}
        {pinAccess === "unlocked" ? "Lock changes" : "Unlock changes"}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!value) reset();
          setOpen(value);
        }}
      >
        <DialogContent className="w-[calc(100%-2rem)] max-w-sm max-h-[calc(100dvh-2rem)] overflow-y-auto border-board-border bg-board-card text-board-text [&>[data-slot=dialog-close]]:size-11 [&>[data-slot=dialog-close]]:top-1 [&>[data-slot=dialog-close]]:right-1 [&>[data-slot=dialog-close]]:flex [&>[data-slot=dialog-close]]:items-center [&>[data-slot=dialog-close]]:justify-center">
          <DialogTitle className="pr-8">Unlock changes</DialogTitle>
          <DialogDescription className="text-board-muted">
            Enter the organization PIN to edit the rundown and use live
            controls. You can keep viewing without it.
          </DialogDescription>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void verify();
            }}
            className="space-y-4"
          >
            <label className="block text-sm" htmlFor="rundown-unlock-pin">
              PIN
            </label>
            <input
              id="rundown-unlock-pin"
              type="password"
              inputMode="numeric"
              autoFocus
              value={pin}
              onChange={(event) => changePin(event.target.value)}
              className="w-full rounded-xl border border-board-border bg-board-bg px-4 py-3 text-board-text"
            />
            {state.status === "error" && (
              <div role="alert" className="text-sm text-red-400">
                <p>{state.message}</p>
                <time
                  dateTime={new Date(state.occurredAt).toISOString()}
                  className="mt-1 block text-xs"
                >
                  Last attempt:{" "}
                  {new Date(state.occurredAt).toLocaleTimeString()}
                </time>
              </div>
            )}
            <Button
              variant="ghost"
              type="submit"
              disabled={busy || !pin.trim()}
              className="min-h-11 w-full rounded-xl bg-fire-500 px-4 py-3 text-sm font-semibold text-black disabled:opacity-50"
            >
              {busy
                ? "Checking…"
                : state.status === "error"
                  ? "Retry verification"
                  : "Unlock changes"}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
