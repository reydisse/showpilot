import { workspaceCopy } from "@showpilot/shared";
import { useTerms as useWorkspaceTerms } from "@/components/workspace/WorkspaceProvider";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  Clock3,
  KeyRound,
  ShieldCheck,
  X,
} from "lucide-react";
import {
  ACCESS_CAPABILITIES,
  GRANTABLE_PERMISSIONS,
  getAccessCapability,
} from "@/lib/access-capabilities";
import {
  grantMemberAccess,
  revokeMemberAccess,
  retryAccessGrantNotification,
  type getAccessManagementSnapshot,
} from "@/lib/access-grants";
import { ROLE_META, normalizeRole } from "@/lib/permissions";
import { getPortableAvatarUrl } from "@/lib/avatar-image";

import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  grantAccessSchema,
  accessWriteResultSchema,
  type AccessWriteResult,
} from "@/lib/access-write-contract";

type AccessSnapshot = Awaited<ReturnType<typeof getAccessManagementSnapshot>>;
type AccessAuthority = AccessSnapshot["authority"];
type ActiveGrant = AccessSnapshot["grants"][number];
export type AccessChange = {
  label: string;
  write: (requestId: string, signal: AbortSignal) => Promise<AccessWriteResult>;
  apply: (result: AccessWriteResult) => void;
};

function formatDate(value: string) {
  return new Date(`${value}T00:00:00Z`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function dutyWeekLabel(authority: AccessAuthority) {
  const end = new Date(`${authority.weekEndExclusive}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() - 1);
  return `${formatDate(authority.weekStart)} – ${formatDate(end.toISOString().slice(0, 10))}`;
}

function grantEndLabel(expiresOn: string) {
  const end = new Date(`${expiresOn}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() - 1);
  return formatDate(end.toISOString().slice(0, 10));
}

export function AccessManagementTab({
  orgId,
  currentUserId,
  authority,
  members,
  grants,
  notices,
  disabled,
  change,
  onDirtyChange,
}: AccessSnapshot & {
  orgId: string;
  disabled: boolean;
  change: (change: AccessChange) => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const workspaceTerms = useWorkspaceTerms();
  const { confirm, ConfirmDialogEl } = useConfirmDialog();
  const grantButton = useRef<HTMLButtonElement>(null);
  const eligibleMembers = useMemo(
    () => members.filter((member) => member.userId !== currentUserId),
    [currentUserId, members],
  );
  const [showGrantForm, setShowGrantForm] = useState(false);
  const [hasDraft, setHasDraft] = useState(false);
  const [reviewedWeek, setReviewedWeek] = useState(authority);
  const [userId, setUserId] = useState(eligibleMembers[0]?.userId ?? "");
  const [capability, setCapability] = useState<string>(
    ACCESS_CAPABILITIES[0].id,
  );
  const [customPermissions, setCustomPermissions] = useState<string[]>([]);
  const [duration, setDuration] = useState<"this-week" | "until-revoked">(
    "this-week",
  );
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [resultMessage, setResultMessage] = useState("");
  useEffect(() => {
    onDirtyChange(hasDraft);
  }, [hasDraft, onDirtyChange]);

  const grantsByMember = useMemo(() => {
    const grouped = new Map<string, ActiveGrant[]>();
    for (const grant of grants) {
      const current = grouped.get(grant.userId) ?? [];
      current.push(grant);
      grouped.set(grant.userId, current);
    }
    return grouped;
  }, [grants]);

  const closeForm = () => {
    setShowGrantForm(false);
    requestAnimationFrame(() => grantButton.current?.focus());
  };
  const resetForm = () => {
    closeForm();
    setHasDraft(false);
    setCapability(ACCESS_CAPABILITIES[0].id);
    setCustomPermissions([]);
    setDuration("this-week");
    setReason("");
    setError("");
  };
  const openForm = () => {
    if (!hasDraft) {
      setUserId(eligibleMembers[0]?.userId ?? "");
      setReviewedWeek(authority);
      setHasDraft(true);
    }
    setShowGrantForm(true);
  };
  const recordResult = (result: AccessWriteResult) => {
    const status =
      result.kind === "revoke"
        ? "Access revoked."
        : result.state === "active"
          ? "Access granted."
          : "The original grant was saved, but it is no longer active. Retrying did not restore it.";
    setResultMessage(
      `${status} ${result.notification === "pending" ? "The member notification is pending. Retry it below." : result.notification === "superseded" ? "An outdated notification was skipped." : "The member notification was created."}`,
    );
  };
  const submitGrant = (event: React.FormEvent) => {
    event.preventDefault();
    if (disabled) return;
    const parsed = grantAccessSchema.safeParse({
      orgId,
      userId,
      capability,
      permissions: capability === "custom" ? customPermissions : [],
      duration,
      reason,
      expectedWeekStart: reviewedWeek.weekStart,
    });
    if (!parsed.success) {
      setError(
        "Choose a member, capability and valid permissions before granting access.",
      );
      return;
    }
    setError("");
    change({
      label: "Grant operational access",
      write: async (requestId, signal) =>
        accessWriteResultSchema.parse(
          await grantMemberAccess({
            data: { ...parsed.data, requestId },
            signal,
          }),
        ),
      apply: (result) => {
        recordResult(result);
        resetForm();
      },
    });
  };
  const revoke = async (grant: ActiveGrant) => {
    if (
      disabled ||
      !(await confirm({
        title: "Revoke access?",
        description: `${members.find((member) => member.userId === grant.userId)?.user.name ?? "This member"} will lose ${getAccessCapability(grant.capability)?.label ?? "custom operational"} access.`,
        confirmLabel: "Revoke access",
      }))
    )
      return;
    const data = {
      orgId,
      grantId: grant.id,
      expectedWeekStart: authority.weekStart,
    };
    change({
      label: "Revoke operational access",
      write: async (requestId, signal) =>
        accessWriteResultSchema.parse(
          await revokeMemberAccess({ data: { ...data, requestId }, signal }),
        ),
      apply: recordResult,
    });
  };
  const discard = async () => {
    if (
      disabled ||
      !(await confirm({
        title: "Discard access draft?",
        description: "Your unsaved access choices will be removed.",
        confirmLabel: "Discard draft",
      }))
    )
      return;
    resetForm();
  };

  if (!authority.canManage) return null;

  return (
    <div className="space-y-5">
      {ConfirmDialogEl}
      {resultMessage && (
        <p
          role="status"
          className="rounded-lg border border-board-border p-3 text-sm text-board-text"
        >
          {resultMessage}
        </p>
      )}
      {notices.length > 0 && (
        <section
          aria-label="Pending access notifications"
          className="space-y-2 rounded-xl border border-amber-500/30 p-3"
        >
          <h3 className="text-sm font-medium text-board-text">
            Access saved, member notifications pending
          </h3>
          {notices.map((notice) => (
            <div
              key={notice.requestId}
              className="flex flex-wrap items-center gap-3"
            >
              <p className="min-w-0 flex-1 text-sm text-board-muted">
                {notice.message}
              </p>
              <button
                type="button"
                disabled={disabled}
                className="min-h-11 rounded-lg border border-board-border px-3 text-sm focus-visible:ring-2 focus-visible:ring-fire-500 disabled:opacity-40"
                onClick={() =>
                  change({
                    label: "Retry access notification",
                    write: async (_requestId, signal) =>
                      accessWriteResultSchema.parse(
                        await retryAccessGrantNotification({
                          data: { orgId, requestId: notice.requestId },
                          signal,
                        }),
                      ),
                    apply: recordResult,
                  })
                }
              >
                Retry notification
              </button>
            </div>
          ))}
        </section>
      )}
      <div className="rounded-xl border border-cyan-500/20 bg-cyan-500/5 p-4">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-cyan-500/15 text-cyan-300">
            {authority.kind === "permanent" ? (
              <ShieldCheck className="h-4 w-4" />
            ) : (
              <Clock3 className="h-4 w-4" />
            )}
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-board-text">
              {authority.kind === "permanent"
                ? "Permanent access authority"
                : "On-duty TM authority"}
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-board-muted">
              {authority.kind === "permanent"
                ? "Owners and Admins can grant weekly or ongoing operational access at any time."
                : `You can grant and revoke operational access for this duty week: ${dutyWeekLabel(authority)}.`}
            </p>
          </div>
        </div>
      </div>

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-300"
        >
          {error}
        </div>
      ) : null}

      {showGrantForm ? (
        <form
          onSubmit={submitGrant}
          className="space-y-4 rounded-xl border border-board-border bg-board-card p-4"
        >
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-board-text">
                Grant operational access
              </h3>
              <p className="mt-0.5 text-xs text-board-muted">
                The member keeps their base role.
              </p>
            </div>
            <button
              type="button"
              onClick={closeForm}
              className="min-h-11 min-w-11 rounded-lg p-2 text-board-muted focus-visible:ring-2 focus-visible:ring-fire-500 hover:bg-board-border hover:text-board-text"
              aria-label="Close grant form"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <fieldset
            disabled={disabled}
            className="space-y-4 disabled:opacity-60"
          >
            {reviewedWeek.weekStart !== authority.weekStart && (
              <p role="alert" className="text-sm text-amber-300">
                The duty week changed. This draft still applies to{" "}
                {dutyWeekLabel(reviewedWeek)}. Discard it and review a new grant
                for the current week.
              </p>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="space-y-1.5 text-xs font-medium text-board-muted">
                Member
                <span className="relative block">
                  <select
                    value={userId}
                    onChange={(event) => setUserId(event.target.value)}
                    className="w-full appearance-none rounded-lg border border-board-border bg-board-bg px-3 py-2.5 pr-9 text-sm text-board-text min-h-11 outline-none focus-visible:ring-2 focus-visible:ring-fire-500"
                  >
                    {eligibleMembers.map((member) => (
                      <option key={member.userId} value={member.userId}>
                        {member.user.name} ·{" "}
                        {ROLE_META[normalizeRole(member.role) ?? "member"]
                          ?.label ?? member.role}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-board-muted" />
                </span>
              </label>

              <label className="space-y-1.5 text-xs font-medium text-board-muted">
                Capability
                <span className="relative block">
                  <select
                    value={capability}
                    onChange={(event) => setCapability(event.target.value)}
                    className="w-full appearance-none rounded-lg border border-board-border bg-board-bg px-3 py-2.5 pr-9 text-sm text-board-text min-h-11 outline-none focus-visible:ring-2 focus-visible:ring-fire-500"
                  >
                    {ACCESS_CAPABILITIES.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.label}
                      </option>
                    ))}
                    <option value="custom">Custom permissions…</option>
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-board-muted" />
                </span>
              </label>
            </div>

            <p className="rounded-lg bg-board-bg px-3 py-2 text-xs leading-relaxed text-board-muted">
              {capability === "custom"
                ? "Choose only the controls this person needs."
                : getAccessCapability(capability)?.description}
            </p>

            {capability === "custom" ? (
              <fieldset className="rounded-xl border border-board-border bg-board-bg/40 p-3">
                <legend className="px-1 text-xs font-medium text-board-muted">
                  Individual permissions
                </legend>
                <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {GRANTABLE_PERMISSIONS.map((permission) => {
                    const checked = customPermissions.includes(permission);
                    const label = permission
                      .split(":")
                      .map((part) => part.replaceAll("_", " "))
                      .join(" · ");
                    return (
                      <label
                        key={permission}
                        className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-xs capitalize ${checked ? "border-fire-500/45 bg-fire-500/10 text-board-text" : "border-board-border text-board-muted"}`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() =>
                            setCustomPermissions((items) =>
                              checked
                                ? items.filter((item) => item !== permission)
                                : [...items, permission],
                            )
                          }
                          className="accent-amber-500"
                        />
                        {label}
                      </label>
                    );
                  })}
                </div>
              </fieldset>
            ) : null}

            {authority.kind === "permanent" ? (
              <fieldset className="space-y-2">
                <legend className="text-xs font-medium text-board-muted">
                  Duration
                </legend>
                <div className="grid gap-2 sm:grid-cols-2">
                  {(
                    [
                      [
                        "this-week",
                        `This week · ${dutyWeekLabel(reviewedWeek)}`,
                      ],
                      ["until-revoked", "Until manually revoked"],
                    ] as const
                  ).map(([value, label]) => (
                    <label
                      key={value}
                      className={`flex min-h-[44px] cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-xs ${duration === value ? "border-fire-500/45 bg-fire-500/10 text-board-text" : "border-board-border text-board-muted"}`}
                    >
                      <input
                        type="radio"
                        name="duration"
                        value={value}
                        checked={duration === value}
                        onChange={() => setDuration(value)}
                        className="accent-amber-500"
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </fieldset>
            ) : null}

            <label className="block space-y-1.5 text-xs font-medium text-board-muted">
              Reason{" "}
              <span className="font-normal text-board-muted/60">
                (optional)
              </span>
              <input
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                maxLength={240}
                placeholder={workspaceCopy(
                  "e.g. Covering rundown for Sunday service",
                  workspaceTerms,
                )}
                className="w-full rounded-lg border border-board-border bg-board-bg px-3 py-2.5 text-sm text-board-text placeholder:text-board-muted/50 min-h-11 outline-none focus-visible:ring-2 focus-visible:ring-fire-500"
              />
            </label>

            <div className="flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={() => void discard()}
                className="min-h-11 rounded-lg px-4 text-sm text-red-300 focus-visible:ring-2 focus-visible:ring-fire-500"
              >
                Discard draft
              </button>
              <button
                type="button"
                onClick={closeForm}
                className="min-h-11 rounded-lg px-4 text-xs font-medium text-board-muted hover:bg-board-border/50 hover:text-board-text"
              >
                Keep draft
              </button>
              <button
                type="submit"
                disabled={
                  disabled ||
                  !userId ||
                  (capability === "custom" && customPermissions.length === 0)
                }
                className="min-h-11 rounded-lg bg-gradient-to-br from-amber-400 to-amber-600 px-4 text-xs font-semibold text-black disabled:opacity-50"
              >
                Grant access
              </button>
            </div>
          </fieldset>
        </form>
      ) : (
        <button
          ref={grantButton}
          onClick={openForm}
          disabled={disabled || eligibleMembers.length === 0}
          className="inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-gradient-to-br from-amber-400 to-amber-600 px-4 text-sm font-semibold text-black transition hover:shadow-lg hover:shadow-amber-500/20 disabled:opacity-50"
        >
          <KeyRound className="h-4 w-4" />
          {hasDraft ? "Resume access draft" : "Grant access"}
        </button>
      )}

      <div>
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-xs font-medium uppercase tracking-widest text-board-muted">
            Active grants
          </h3>
          <span className="text-xs tabular-nums text-board-muted">
            {grants.length}
          </span>
        </div>

        <div className="space-y-3">
          {members.map((member) => {
            const memberGrants = grantsByMember.get(member.userId) ?? [];
            if (memberGrants.length === 0) return null;
            const avatarUrl = getPortableAvatarUrl(member.user.image);
            return (
              <div
                key={member.userId}
                className="rounded-xl border border-board-border bg-board-card p-3"
              >
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-board-border text-sm font-semibold text-fire-400">
                    {avatarUrl ? (
                      <img
                        src={avatarUrl}
                        alt=""
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      member.user.name.charAt(0)
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-board-text">
                      {member.user.name}
                    </p>
                    <p className="truncate text-xs text-board-muted">
                      {member.user.email}
                    </p>
                  </div>
                </div>

                <div className="mt-3 space-y-2">
                  {memberGrants.map((grant) => {
                    const definition = getAccessCapability(grant.capability);
                    return (
                      <div
                        key={grant.id}
                        className="flex flex-col gap-2 rounded-lg border border-board-border/70 bg-board-bg/60 px-3 py-2.5 sm:flex-row sm:items-center"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <Check className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                            <p className="truncate text-xs font-medium text-board-text">
                              {definition?.label ??
                                (grant.capability === "custom"
                                  ? "Custom operational access"
                                  : grant.capability)}
                            </p>
                          </div>
                          <p className="mt-1 text-xs text-board-muted">
                            {grant.expiresOn
                              ? `Active through ${grantEndLabel(grant.expiresOn)}`
                              : "Active until revoked"}{" "}
                            · granted by {grant.grantedBy.name}
                          </p>
                          {grant.reason ? (
                            <p className="mt-1 break-words text-xs text-board-muted/80">
                              {grant.reason}
                            </p>
                          ) : null}
                        </div>
                        {grant.canRevoke ? (
                          <button
                            onClick={() => void revoke(grant)}
                            disabled={disabled}
                            className="min-h-11 shrink-0 rounded-lg border border-red-500/20 px-3 text-xs font-medium text-red-300 hover:bg-red-500/10 focus-visible:ring-2 focus-visible:ring-fire-500 disabled:opacity-50"
                          >
                            Revoke
                          </button>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}

          {grants.length === 0 ? (
            <div className="rounded-xl border border-dashed border-board-border px-4 py-10 text-center">
              <KeyRound className="mx-auto h-6 w-6 text-board-muted/50" />
              <p className="mt-3 text-sm font-medium text-board-text">
                No custom access is active
              </p>
              <p className="mt-1 text-xs text-board-muted">
                Members are using only their normal role permissions.
              </p>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
