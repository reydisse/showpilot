import { useEffect, useId, useRef, useState } from "react";
import { inviteMember, retryTeamInvitationDelivery } from "@/lib/session";
import type { TeamInvitation } from "@/lib/team-invitation-contract";
import { ASSIGNABLE_ROLES, ROLE_META } from "@/lib/permissions";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";

export type InvitationChange = {
  label: string;
  write: (requestId: string, signal: AbortSignal) => Promise<TeamInvitation>;
  apply: (invitation: TeamInvitation) => void;
};
const control =
  "min-h-11 min-w-11 rounded-lg border border-board-border px-3 py-2 text-sm text-board-text outline-none hover:bg-board-bg focus-visible:ring-2 focus-visible:ring-fire-500 disabled:opacity-40";

export function invitationDeliveryMessage(invitation: TeamInvitation): string {
  if (invitation.status !== "pending")
    return `Invitation ${invitation.status}. No email will be retried.`;
  if (invitation.expiresAt.getTime() <= Date.now())
    return "This invitation has expired. Send again to renew it before sharing the link.";
  switch (invitation.delivery.state) {
    case "accepted":
      return "Email provider accepted this invitation. Waiting for the recipient to join.";
    case "failed":
      return "The invitation exists, but the email was rejected. You can share its link or retry the email.";
    case "uncertain":
      return invitation.delivery.retryable
        ? "Email acceptance is unknown. Retry checks the same email attempt without creating another invitation."
        : "Email acceptance is unknown and its safe retry window has ended. Share the link or explicitly send another email.";
    case "sending":
      return "Email confirmation is pending. Refresh its status before sending again.";
    case "ready":
      return "The invitation exists. Its email has not been confirmed yet.";
    case "unknown":
      return "No email delivery record is available for this invitation. Share its link or send again.";
  }
}

function InvitationExpiry({ value }: { value: Date }) {
  const iso = value.toISOString();
  const [local, setLocal] = useState(iso);
  useEffect(() => {
    setLocal(new Date(iso).toLocaleString());
  }, [iso]);
  return <time dateTime={iso}>{local}</time>;
}

function CopyInvitationLink({ invitation }: { invitation: TeamInvitation }) {
  const [state, setState] = useState<"idle" | "copying" | "copied" | "failed">(
    "idle",
  );
  const attempt = useRef(0);
  useEffect(
    () => () => {
      attempt.current++;
    },
    [],
  );
  const copy = async () => {
    const current = ++attempt.current;
    setState("copying");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        navigator.clipboard.writeText(
          new URL(
            `/invite/${encodeURIComponent(invitation.id)}`,
            window.location.origin,
          ).href,
        ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Clipboard timed out")),
            5_000,
          );
        }),
      ]);
      if (current === attempt.current) setState("copied");
    } catch {
      if (current === attempt.current) setState("failed");
    } finally {
      clearTimeout(timer);
    }
  };
  return (
    <div className="space-y-1">
      <button
        type="button"
        className={control}
        disabled={state === "copying"}
        onClick={() => void copy()}
        aria-label={`Copy invitation link for ${invitation.email}`}
      >
        {state === "copying"
          ? "Copying…"
          : state === "copied"
            ? "Copied"
            : state === "failed"
              ? "Retry copy"
              : "Copy link"}
      </button>
      {state === "failed" && (
        <p role="alert" className="max-w-xs text-xs text-red-400">
          Could not copy the invitation link. Check clipboard permission and
          retry.
        </p>
      )}
    </div>
  );
}

/** The parent owns the pending write so exact Retry survives tabs and form close. */
export function TeamInvitations({
  orgId,
  invitations,
  disabled,
  change,
  refresh,
  onDirtyChange,
  cancel,
}: {
  orgId: string;
  invitations: TeamInvitation[];
  disabled: boolean;
  change: (change: InvitationChange) => void;
  refresh: () => void;
  onDirtyChange: (dirty: boolean) => void;
  cancel?: (invitation: TeamInvitation) => void;
}) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [receipt, setReceipt] = useState<TeamInvitation | null>(null);
  const prefix = useId();
  const dirty = !!email.trim() || role !== "member";
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  const { confirm, ConfirmDialogEl } = useConfirmDialog();
  const submitted = (result: TeamInvitation) => {
    setReceipt(result);
    setEmail("");
    setRole("member");
  };
  const retry = (invitation: TeamInvitation) => {
    const deliveryId = invitation.delivery.id;
    if (disabled || !deliveryId || !invitation.delivery.retryable) return;
    change({
      label: `Retry invitation email for ${invitation.email}`,
      write: (_requestId, signal) =>
        retryTeamInvitationDelivery({
          data: { orgId, invitationId: invitation.id, deliveryId },
          signal,
        }),
      apply: setReceipt,
    });
  };
  const sendAgain = async (invitation: TeamInvitation) => {
    if (disabled || !invitation.role || invitation.delivery.state === "sending")
      return;
    if (
      !(await confirm({
        title: "Send another invitation email?",
        description: `Send another email to ${invitation.email} using the same invitation link? They may already have received a previous email. This also renews the invitation for 48 hours.`,
        confirmLabel: "Send again",
        variant: "warning",
      }))
    )
      return;
    change({
      label: `Send another invitation email to ${invitation.email}`,
      write: (requestId, signal) =>
        inviteMember({
          data: {
            orgId,
            email: invitation.email,
            role: invitation.role ?? "member",
            requestId,
            resend: {
              invitationId: invitation.id,
              previousDeliveryId: invitation.delivery.id,
            },
          },
          signal,
        }),
      apply: setReceipt,
    });
  };
  return (
    <div className="space-y-4">
      {ConfirmDialogEl}
      <button
        type="button"
        className={control}
        onClick={() => setOpen((value) => !value)}
      >
        {open
          ? "Close invitation form"
          : dirty
            ? "Resume invitation"
            : "Invite Member"}
      </button>
      <form
        hidden={!open}
        className="space-y-3 rounded-xl border border-board-border bg-board-card p-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (disabled) return;
          const draft = { email: email.trim(), role, orgId };
          change({
            label: `Invite ${draft.email}`,
            write: (requestId, signal) =>
              inviteMember({ data: { ...draft, requestId }, signal }),
            apply: submitted,
          });
        }}
      >
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(10rem,auto)]">
          <div className="min-w-0 space-y-1">
            <label
              htmlFor={`${prefix}-email`}
              className="text-sm text-board-muted"
            >
              Member email
            </label>
            <input
              id={`${prefix}-email`}
              className={`${control} w-full bg-board-bg`}
              type="email"
              autoComplete="email"
              maxLength={254}
              required
              value={email}
              disabled={disabled}
              onChange={(event) => {
                setEmail(event.target.value);
                setReceipt(null);
              }}
            />
          </div>
          <div className="min-w-0 space-y-1">
            <label
              htmlFor={`${prefix}-role`}
              className="text-sm text-board-muted"
            >
              Invitation role
            </label>
            <select
              id={`${prefix}-role`}
              className={`${control} w-full bg-board-bg`}
              value={role}
              disabled={disabled}
              onChange={(event) => setRole(event.target.value)}
            >
              {ASSIGNABLE_ROLES.map((value) => (
                <option key={value} value={value}>
                  {ROLE_META[value].label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <button
          type="submit"
          className={`${control} bg-fire-500 text-black`}
          disabled={disabled || !email.trim()}
        >
          Create invitation
        </button>
        <p className="text-xs text-board-muted">
          The invitation and its email status appear below. Closing this form
          keeps your draft.
        </p>
      </form>
      {receipt && (
        <p
          role="status"
          className="rounded-lg border border-board-border p-3 text-sm text-board-text"
        >
          Last request confirmed for {receipt.email}.{" "}
          {receipt.status === "pending"
            ? "See pending invitations below for current email status."
            : `Invitation ${receipt.status}.`}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-board-muted">
          Pending invitations
        </h2>
        <button
          type="button"
          className={control}
          disabled={disabled}
          onClick={refresh}
        >
          Refresh invitations
        </button>
      </div>
      {invitations.map((invitation) => (
        <article
          key={invitation.id}
          aria-label={`Invitation for ${invitation.email}`}
          className="space-y-3 rounded-xl border border-board-border bg-board-card p-3"
        >
          <div className="min-w-0">
            <p className="break-words text-sm font-medium text-board-text">
              {invitation.email}
            </p>
            <p className="text-xs text-board-muted">
              {Object.entries(ROLE_META).find(
                ([key]) => key === invitation.role,
              )?.[1].label ?? invitation.role}{" "}
              · expires <InvitationExpiry value={invitation.expiresAt} />
            </p>
          </div>
          <p className="text-sm text-board-muted">
            {invitationDeliveryMessage(invitation)}
          </p>
          <div className="flex flex-wrap items-start gap-2">
            <CopyInvitationLink invitation={invitation} />
            {invitation.delivery.retryable && (
              <button
                type="button"
                className={control}
                disabled={disabled}
                onClick={() => retry(invitation)}
              >
                Retry email
              </button>
            )}
            <button
              type="button"
              className={control}
              disabled={
                disabled ||
                invitation.delivery.state === "sending" ||
                !invitation.role
              }
              onClick={() => void sendAgain(invitation)}
            >
              Send again
            </button>
            {cancel && (
              <button
                type="button"
                className={control}
                disabled={disabled}
                onClick={() => cancel(invitation)}
                aria-label={`Cancel invitation for ${invitation.email}`}
              >
                Cancel invitation
              </button>
            )}
          </div>
        </article>
      ))}
    </div>
  );
}
