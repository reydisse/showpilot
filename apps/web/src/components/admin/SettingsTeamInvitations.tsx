import { useCallback, useEffect, useState } from "react";
import { getOrgInvitations } from "@/lib/session";
import type { TeamInvitation } from "@/lib/team-invitation-contract";
import { useConfirmedWrite } from "@/hooks/useConfirmedWrite";
import { useOperatorRead } from "@/hooks/useOperatorRead";
import { ConfirmedWriteNotice } from "@/components/layout/ConfirmedWriteNotice";
import { ReadFailureNotice } from "@/components/layout/ReadFailureNotice";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { TeamInvitations, type InvitationChange } from "./TeamInvitations";

export function SettingsTeamInvitations({
  orgId,
  onDirtyChange,
}: {
  orgId: string;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const load = useCallback(
    (signal: AbortSignal) => getOrgInvitations({ data: { orgId }, signal }),
    [orgId],
  );
  const read = useOperatorRead<TeamInvitation[]>({
    key: orgId,
    initialValue: [],
    read: load,
    errorMessage:
      "Could not load invitation status. Retry before sending another invitation.",
  });
  const writes = useConfirmedWrite(orgId);
  const [draft, setDraft] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const locked = writes.state.status !== "idle";
  useEffect(() => {
    onDirtyChange(draft || locked);
  }, [draft, locked, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  const { confirm, ConfirmDialogEl } = useConfirmDialog();
  const change = (request: InvitationChange) => {
    void writes.start({
      ...request,
      apply: (result) => {
        request.apply(result);
        read.invalidate();
      },
      finish: async (_result, signal) => {
        const refreshed = await read.refresh();
        signal.throwIfAborted();
        if (!refreshed)
          throw new Error(
            "The invitation was saved, but its list could not be refreshed. Retry refresh without sending another email.",
          );
      },
    });
  };
  const review = async () => {
    if (reviewing || writes.state.status !== "failed") return;
    if (
      !(await confirm({
        title: "Review stored invitations?",
        description:
          "The previous request may have saved. Refresh invitations before discarding its exact retry. A running request may still finish later.",
        confirmLabel: "Review invitations",
        variant: "warning",
      }))
    )
      return;
    setReviewing(true);
    if (await read.refresh()) writes.discard();
    setReviewing(false);
  };
  return (
    <div className="mb-5 space-y-3">
      {ConfirmDialogEl}
      <ConfirmedWriteNotice
        collectionLabel="team"
        state={writes.state}
        retry={() => void writes.retry()}
        review={() => void review()}
        reviewing={reviewing}
      />
      <ReadFailureNotice
        error={read.error}
        refreshing={read.refreshing}
        retry={read.retry}
        label="Retry invitations"
      />
      {read.refreshing && (
        <p role="status" className="text-sm text-board-muted">
          Refreshing invitations…
        </p>
      )}
      <TeamInvitations
        orgId={orgId}
        invitations={read.value}
        disabled={
          locked || read.refreshing || !!read.error || read.confirmedAt === null
        }
        refresh={read.retry}
        change={change}
        onDirtyChange={setDraft}
      />
    </div>
  );
}
