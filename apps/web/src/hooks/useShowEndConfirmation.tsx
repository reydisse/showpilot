import { useCallback, useEffect, useState } from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

type ShowTarget = { orgId: string; serviceDate: string; showId?: string | null };

/** Item advances keep the dialog open; confirmation uses the current callback. */
export function useShowEndConfirmation(
  target: ShowTarget,
  endShow: () => void,
  disabledReason?: string,
) {
  const scope = JSON.stringify([target.orgId, target.showId ? ["show", target.showId] : ["date", target.serviceDate]]);
  const [openFor, setOpenFor] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (openFor !== null && openFor !== scope) {
      setOpenFor(null);
      setNotice("Show changed, confirmation cancelled. Review the current show before ending it.");
    }
  }, [openFor, scope]);
  const requestEndShow = useCallback(() => {
    if (disabledReason) return;
    setNotice(null);
    setOpenFor(scope);
  }, [scope, disabledReason]);
  const endShowDialog = (
    <>
      {notice && <p role="status" className="px-4 py-2 text-sm text-amber-300">{notice}</p>}
      <ConfirmDialog
        open={openFor === scope}
        onOpenChange={(open) => { if (!open) setOpenFor(null); }}
        title="End this show?"
        description={disabledReason ?? "Are you sure? This stops the rundown timer and completes the current item for all connected operators."}
        confirmLabel="End show"
        cancelLabel="Keep show running"
        confirmDisabled={Boolean(disabledReason)}
        onConfirm={() => {
          if (openFor !== scope || disabledReason) return;
          setOpenFor(null);
          endShow();
        }}
      />
    </>
  );
  return { requestEndShow, endShowDialog };
}
