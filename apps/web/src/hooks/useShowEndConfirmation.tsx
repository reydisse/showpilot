import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

/** Keep confirmation tied to the show and item that the operator was viewing. */
export function useShowEndConfirmation(scope: string) {
  const pending = useRef<{ scope: string; run: () => void } | null>(null);
  const [openFor, setOpenFor] = useState<string | null>(null);
  useEffect(() => {
    pending.current = null;
    setOpenFor(null);
  }, [scope]);
  const requestEndShow = useCallback((run: () => void) => {
    if (pending.current?.scope === scope) return;
    pending.current = { scope, run };
    setOpenFor(scope);
  }, [scope]);
  const dismiss = () => {
    pending.current = null;
    setOpenFor(null);
  };
  const endShowDialog = (
    <ConfirmDialog
      open={openFor === scope}
      onOpenChange={(open) => { if (!open) dismiss(); }}
      title="End this show?"
      description="Are you sure? This stops the rundown timer and completes the current item for all connected operators."
      confirmLabel="End show"
      cancelLabel="Keep show running"
      onConfirm={() => {
        const action = pending.current;
        dismiss();
        if (action?.scope === scope) action.run();
      }}
    />
  );
  return { requestEndShow, endShowDialog };
}
