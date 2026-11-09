import { TeamInvitations, type InvitationChange } from "@/components/admin/TeamInvitations";
import { createFileRoute, useBlocker } from "@tanstack/react-router";
import { RouteError } from "@/components/ui/RouteRecovery";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { ReadFailureNotice } from "@/components/layout/ReadFailureNotice";
import { ConfirmedWriteNotice } from "@/components/layout/ConfirmedWriteNotice";
import { useOperatorRead } from "@/hooks/useOperatorRead";
import { useConfirmedWrite } from "@/hooks/useConfirmedWrite";
import { PageSkeleton } from "@/components/ui/Skeleton";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  Users,
  Shield,
  Trash2,
  KeyRound,
  Flag,
} from "lucide-react";
import { getCrewMembers } from "@/lib/data";
import {
  getOrgMembers,
  getOrgInvitations,
  updateMemberRole,
  removeMember,
  cancelInvitation,
} from "@/lib/session";
import { ROLE_META, ASSIGNABLE_ROLES } from "@/lib/permissions";
import { hasEffectivePermission, hasPermission } from "@/lib/app-permissions";
import { getAccessManagementSnapshot } from "@/lib/access-grants";
import { MemberTable } from "@/components/admin/MemberTable";
import { AccessManagementTab } from "@/components/admin/AccessManagementTab";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  closeContentReport,
  getContentReports,
  type ContentReportItem,
} from "@/lib/content-moderation";

async function loadTeam(
  orgId: string,
  canManageMembers: boolean,
  canViewCrew: boolean,
  signal: AbortSignal,
  access?: Awaited<ReturnType<typeof getAccessManagementSnapshot>>,
) {
  const [
    orgMembers,
    invitations,
    crewMembers,
    contentReports,
    accessManagement,
  ] = await Promise.all([
    canManageMembers
      ? getOrgMembers({ data: { orgId }, signal })
      : Promise.resolve([]),
    canManageMembers
      ? getOrgInvitations({ data: { orgId }, signal })
      : Promise.resolve([]),
    canViewCrew
      ? getCrewMembers({ data: { orgId }, signal })
      : Promise.resolve([]),
    canManageMembers
      ? getContentReports({ data: { orgId }, signal })
      : Promise.resolve([]),
    access
      ? Promise.resolve(access)
      : getAccessManagementSnapshot({ data: { orgId }, signal }),
  ]);
  return {
    orgMembers,
    invitations,
    crewMembers,
    contentReports,
    accessManagement,
    orgId,
    canManageMembers,
    canViewCrew,
  };
}

export const Route = createFileRoute("/$slug/team")({
  pendingComponent: () => <PageSkeleton />,
  errorComponent: RouteError,
  loader: async ({ context, abortController }) => {
    const { withPermission } = await import("@/lib/route-permissions");
    const access = await getAccessManagementSnapshot({
      data: { orgId: context.orgId },
      signal: abortController.signal,
    });
    if (!access.authority.canManage)
      await withPermission(
        context.role,
        ["settings:members", "checkin:access"],
        context.slug,
        context.orgId,
      );
    return loadTeam(
      context.orgId,
      hasPermission(context.role, "settings:members"),
      hasEffectivePermission(
        context.role,
        context.grantedPermissions,
        "checkin:access",
      ),
      abortController.signal,
      access,
    );
  },
  component: TeamPage,
});

type TeamInitial = Awaited<ReturnType<typeof loadTeam>>;
type OrgMember = TeamInitial["orgMembers"][number];
type PendingInvitation = TeamInitial["invitations"][number];
type Tab = "members" | "access" | "crew" | "moderation";
type TeamChange<T> = {
  label: string;
  write: (requestId: string, signal: AbortSignal) => Promise<T>;
  apply?: (result: T) => void;
};
const controlClass =
  "min-h-11 min-w-11 rounded-lg border border-board-border px-3 py-2 text-sm font-medium text-board-text outline-none hover:bg-board-bg focus-visible:ring-2 focus-visible:ring-fire-500 disabled:opacity-40";

function TeamPage() {
  const initial = Route.useLoaderData();
  return <TeamWorkspace key={initial.orgId} initial={initial} />;
}

export function TeamWorkspace({ initial }: { initial: TeamInitial }) {
  // Router invalidation by the Access/Crew editors provides a new initial
  // snapshot. Reset that read, but keep an unfinished Team command across tabs.
  const readTeam = useCallback(
    (signal: AbortSignal) =>
      loadTeam(
        initial.orgId,
        initial.canManageMembers,
        initial.canViewCrew,
        signal,
      ),
    [initial],
  );
  const read = useOperatorRead({
    key: initial.orgId,
    initialValue: initial,
    read: readTeam,
    errorMessage:
      "Could not refresh the team. Previously confirmed details are shown. Retry before making another change.",
  });
  const {
    orgMembers,
    invitations,
    crewMembers,
    orgId,
    canManageMembers,
    canViewCrew,
    accessManagement,
    contentReports,
  } = read.value;
  const writes = useConfirmedWrite(orgId);
  const locked = writes.state.status !== "idle";
  const [invitationDirty, setInvitationDirty] = useState(false);
  const [crewDirty, setCrewDirty] = useState(false);
  const [accessDirty, setAccessDirty] = useState(false);
  const disabled = locked || read.refreshing || !!read.error;
  const [reviewing, setReviewing] = useState(false);
  const { confirm, ConfirmDialogEl } = useConfirmDialog();
  const blocker = useBlocker({
    shouldBlockFn: () => locked || invitationDirty || crewDirty || accessDirty,
    enableBeforeUnload: locked || invitationDirty || crewDirty || accessDirty,
    withResolver: true,
  });
  useEffect(() => {
    if (!locked && !invitationDirty && !crewDirty && !accessDirty && blocker.status === "blocked") blocker.proceed();
  }, [locked, invitationDirty, crewDirty, accessDirty, blocker]);
  const startChange = <T,>(change: TeamChange<T>) =>
    writes.start({
      ...change,
      apply: result => { change.apply?.(result); read.invalidate(); },
      finish: async (_result, signal) => {
        const refreshed = await read.refresh();
        signal.throwIfAborted();
        if (!refreshed)
          throw new Error(
            "The change was saved, but the team could not be refreshed. Retry refresh without repeating the change.",
          );
      },
    });
  const reviewStored = async () => {
    if (reviewing || writes.state.status !== "failed") return;
    if (
      !(await confirm({
        title: "Review stored team?",
        description:
          "The previous request may already have saved. Refresh the team before making another change. A request still in progress may finish later.",
        confirmLabel: "Review team",
        variant: "warning",
      }))
    )
      return;
    setReviewing(true);
    if (await read.refresh()) writes.discard();
    setReviewing(false);
  };
  const [activeTab, setActiveTab] = useState<Tab>(() =>
    accessManagement.authority.kind === "on-duty-tm"
      ? "access"
      : canManageMembers
        ? "members"
        : accessManagement.authority.canManage
          ? "access"
          : "crew",
  );
  const tabs: {
    id: Tab;
    label: string;
    count: number;
    icon: React.ReactNode;
  }[] = [];
  if (canManageMembers)
    tabs.push({
      id: "members",
      label: "Workspace members",
      count: orgMembers.length,
      icon: <Shield className="size-4" />,
    });
  if (accessManagement.authority.canManage)
    tabs.push({
      id: "access",
      label: "Access grants",
      count: accessManagement.grants.length,
      icon: <KeyRound className="size-4" />,
    });
  if (canViewCrew)
    tabs.push({
      id: "crew",
      label: "Crew roster",
      count: crewMembers.length,
      icon: <Users className="size-4" />,
    });
  if (canManageMembers)
    tabs.push({
      id: "moderation",
      label: "Content reports",
      count: contentReports.length,
      icon: <Flag className="size-4" />,
    });
  const visibleTab =
    tabs.find((tab) => tab.id === activeTab)?.id ?? tabs[0]?.id;
  const tabPrefix = useId();
  const tabList = useRef<HTMLDivElement>(null);
  const changeRole = (member: OrgMember, role: string) => {
    if (disabled || member.role === role) return;
    void startChange({
      label: `Change role for ${member.user.name}`,
      write: (requestId, signal) =>
        updateMemberRole({
          data: {
            orgId,
            memberId: member.id,
            role,
            expectedRevision: member.managementRevision,
            requestId,
          },
          signal,
        }),
    });
  };
  const remove = async (member: OrgMember) => {
    if (
      disabled ||
      !(await confirm({
        title: "Remove member?",
        description: `Remove ${member.user.name} (${member.user.email}) from this organization? They will lose access to its data.`,
        confirmLabel: "Remove member",
      }))
    )
      return;
    await startChange({
      label: `Remove ${member.user.name}`,
      write: (requestId, signal) =>
        removeMember({
          data: {
            orgId,
            memberIdOrEmail: member.id,
            expectedRevision: member.managementRevision,
            requestId,
          },
          signal,
        }),
    });
  };
  const cancel = async (invitation: PendingInvitation) => {
    if (
      disabled ||
      !(await confirm({
        title: "Cancel invitation?",
        description: `Cancel the invitation for ${invitation.email}? They will no longer be able to join with this invitation.`,
        confirmLabel: "Cancel invitation",
        cancelLabel: "Keep invitation",
      }))
    )
      return;
    await startChange({
      label: `Cancel invitation for ${invitation.email}`,
      write: (requestId, signal) =>
        cancelInvitation({
          data: { invitationId: invitation.id, requestId },
          signal,
        }),
    });
  };
  const closeReport = async (
    report: ContentReportItem,
    status: "resolved" | "dismissed",
  ) => {
    const label = status === "resolved" ? "Resolve report" : "Dismiss report";
    if (
      disabled ||
      !(await confirm({
        title: `${label}?`,
        description: `${label} from ${report.reporterName} about ${report.targetAuthorName ?? "reported content"}? This records your decision and closes the report.`,
        confirmLabel: label,
        variant: "warning",
      }))
    )
      return;
    await startChange({
      label,
      write: (requestId, signal) =>
        closeContentReport({
          data: { orgId, reportId: report.id, status, requestId },
          signal,
        }),
    });
  };
  return (
    <div className="mx-auto min-h-0 w-full max-w-4xl space-y-4 p-4 sm:p-6">
      <h1 className="text-2xl font-bold text-board-text">Team</h1>
      <p className="text-sm text-board-muted">Manage workspace access and crew profiles. Assignments and attendance are in Schedule and Crew Check-in.</p>
      {ConfirmDialogEl}
      <ConfirmedWriteNotice
        collectionLabel="team"
        state={writes.state}
        retry={() => void writes.retry()}
        review={() => void reviewStored()}
        reviewing={reviewing}
      />
      <ReadFailureNotice
        error={read.error}
        refreshing={read.refreshing}
        retry={read.retry}
        label="Retry team"
      />
      {read.refreshing && (
        <p role="status" className="text-sm text-board-muted">
          Refreshing team… Previously confirmed details are shown.
        </p>
      )}
      <div
        ref={tabList}
        role="tablist"
        aria-label="Team sections"
        className="flex gap-1 overflow-x-auto border-b border-board-border"
        onKeyDown={(event) => {
          if (
            !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) ||
            tabs.length === 0
          )
            return;
          event.preventDefault();
          const current = tabs.findIndex((tab) => tab.id === visibleTab);
          const index =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? tabs.length - 1
                : (current +
                    (event.key === "ArrowRight" ? 1 : -1) +
                    tabs.length) %
                  tabs.length;
          const next = tabs[index];
          if (!next) return;
          setActiveTab(next.id);
          tabList.current
            ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
            [index]?.focus();
        }}
      >
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`${tabPrefix}-${tab.id}`}
            aria-controls={`${tabPrefix}-${tab.id}-panel`}
            aria-selected={visibleTab === tab.id}
            tabIndex={visibleTab === tab.id ? 0 : -1}
            onClick={() => setActiveTab(tab.id)}
            className={`${controlClass} flex shrink-0 items-center gap-2 rounded-b-none border-0 border-b-2 ${visibleTab === tab.id ? "border-fire-500 text-fire-500" : "border-transparent text-board-muted"}`}
          >
            {tab.icon}
            {tab.label}
            <span className="rounded-full bg-board-border px-2 text-xs tabular-nums">
              {tab.count}
            </span>
          </button>
        ))}
      </div>
      {tabs.map((tab) => (
        <section
          key={tab.id}
          role="tabpanel"
          id={`${tabPrefix}-${tab.id}-panel`}
          aria-labelledby={`${tabPrefix}-${tab.id}`}
          hidden={visibleTab !== tab.id}
          tabIndex={0}
          className="rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-fire-500"
        >
          <p className="mb-4 text-sm text-board-muted">{tab.id === "members"
            ? "People who can sign in to this workspace. Invitations and roles control their access."
            : tab.id === "access"
              ? "Extra permissions for workspace members, limited by date or ongoing."
              : tab.id === "crew"
                ? "Production profiles for assignments, badges and check-in. A crew profile does not grant workspace sign-in access."
                : "Reports about chat messages and other member content. Show reports and handoff notes are in Reports & Notes."}</p>
          {tab.id === "members" ? (
            <MembersTab
              members={orgMembers}
              invitations={invitations}
              orgId={orgId}
              disabled={disabled}
              refresh={read.invalidate}
              invitationChange={change => void startChange(change)}
              invitationDirty={setInvitationDirty}
              changeRole={changeRole}
              remove={(member) => void remove(member)}
              cancel={(invitation) => void cancel(invitation)}
            />
          ) : tab.id === "moderation" ? (
            <ModerationTab
              reports={contentReports}
              disabled={disabled}
              close={(report, status) => void closeReport(report, status)}
            />
          ) : tab.id === "access" ? (
            <AccessManagementTab
              orgId={orgId}
              currentUserId={accessManagement.currentUserId}
              authority={accessManagement.authority}
              members={accessManagement.members}
              grants={accessManagement.grants}
              notices={accessManagement.notices}
              disabled={disabled}
              change={change => void startChange(change)}
              onDirtyChange={setAccessDirty}
            />
          ) : tab.id === "crew" ? (
            <MemberTable
              members={crewMembers}
              orgId={orgId}
              canManage={canManageMembers}
              disabled={disabled}
              change={change => void startChange(change)}
              onDirtyChange={setCrewDirty}
            />
          ) : null}
        </section>
      ))}
      <Dialog
        open={blocker.status === "blocked"}
        onOpenChange={(open) => {
          if (!open && blocker.status === "blocked") blocker.reset();
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="border-board-border bg-board-card text-board-text"
        >
          <DialogTitle>Leave Team?</DialogTitle>
          <DialogDescription>
            Leaving discards your unsaved drafts and retry controls. An unconfirmed change may still complete. Review the team when you return.
          </DialogDescription>
          <div className="flex flex-wrap gap-2">
            <button
              className={controlClass}
              onClick={() => blocker.status === "blocked" && blocker.reset()}
            >
              Stay
            </button>
            <button
              className={controlClass}
              onClick={() => blocker.status === "blocked" && blocker.proceed()}
            >
              Leave Team
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ModerationTab({
  reports,
  disabled,
  close,
}: {
  reports: ContentReportItem[];
  disabled: boolean;
  close: (report: ContentReportItem, status: "resolved" | "dismissed") => void;
}) {
  if (!reports.length)
    return (
      <div className="rounded-xl border border-dashed border-board-border px-4 py-12 text-center">
        <Flag className="mx-auto size-6 text-board-muted" />
        <p className="mt-3 text-sm font-medium text-board-text">
          No open content reports
        </p>
        <p className="mt-1 text-xs text-board-muted">
          New reports from chat and incident discussions appear here.
        </p>
      </div>
    );
  return (
    <div className="space-y-3">
      {reports.map((report) => (
        <article
          key={report.id}
          className="rounded-xl border border-board-border bg-board-card p-4"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-sm font-semibold capitalize text-board-text">
                {report.reason} · {report.targetType.replace("-", " ")}
              </p>
              <p className="mt-1 text-xs text-board-muted">
                Reported by {report.reporterName}
                {report.targetAuthorName
                  ? ` · content by ${report.targetAuthorName}`
                  : ""}{" "}
                · <TeamDate value={report.createdAt} includeTime />
              </p>
            </div>
            <span className="rounded-full border border-amber-500/25 bg-amber-500/10 px-2 py-1 text-xs font-semibold uppercase text-amber-300">
              {report.status === "reviewing" ? "Reviewing" : "Open"}
            </span>
          </div>
          {report.details && (
            <p className="mt-3 whitespace-pre-wrap break-words rounded-lg bg-board-bg px-3 py-2 text-sm leading-5 text-board-muted">
              {report.details}
            </p>
          )}
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <button
              disabled={disabled}
              onClick={() => close(report, "dismissed")}
              className={controlClass}
            >
              Dismiss
            </button>
            <button
              disabled={disabled}
              onClick={() => close(report, "resolved")}
              className={`${controlClass} bg-fire-500 text-black`}
            >
              Mark resolved
            </button>
          </div>
        </article>
      ))}
    </div>
  );
}

function MembersTab({ members, invitations, orgId, disabled, refresh, invitationChange, invitationDirty, changeRole, remove, cancel }: {
  members: OrgMember[]; invitations: PendingInvitation[]; orgId: string; disabled: boolean;
  refresh: () => void; invitationChange: (change: InvitationChange) => void; invitationDirty: (dirty: boolean) => void;
  changeRole: (member: OrgMember, role: string) => void; remove: (member: OrgMember) => void; cancel: (invitation: PendingInvitation) => void;
}) {
  return (<div className="space-y-6">
    <TeamInvitations orgId={orgId} invitations={invitations} disabled={disabled} refresh={refresh} change={invitationChange} onDirtyChange={invitationDirty} cancel={cancel} />
      <div>
        <h2 className="mb-3 text-sm font-medium text-board-muted">
          {members.length} Member{members.length === 1 ? "" : "s"}
        </h2>
        <div className="space-y-2">
          {members.map((member) => (
            <OrgMemberRow
              key={member.id}
              member={member}
              disabled={disabled}
              onRoleChange={(role) => changeRole(member, role)}
              onRemove={() => remove(member)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function OrgMemberRow({
  member,
  disabled,
  onRoleChange,
  onRemove,
}: {
  member: OrgMember;
  disabled: boolean;
  onRoleChange: (role: string) => void;
  onRemove: () => void;
}) {
  const owner = member.role
    .split(",")
    .map((role) => role.trim())
    .includes("owner");
  const roleLabel =
    Object.entries(ROLE_META).find(([role]) => role === member.role)?.[1]
      .label ?? member.role;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-board-border bg-board-card p-3">
      <div className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-full bg-fire-500/15 text-sm font-semibold text-fire-400">
        {member.user.image ? (
          <img
            src={member.user.image}
            alt=""
            className="size-full object-cover"
          />
        ) : (
          member.user.name.charAt(0)
        )}
      </div>
      <div className="min-w-0 flex-1 basis-40">
        <p className="break-words text-sm font-medium text-board-text">
          {member.user.name}
        </p>
        <p className="break-words text-xs text-board-muted">
          {member.user.email}
        </p>
      </div>
      {owner ? (
        <span className="text-sm font-medium text-fire-400">{roleLabel}</span>
      ) : (
        <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
          <select
            aria-label={`Role for ${member.user.name}`}
            value={member.role}
            disabled={disabled}
            onChange={(event) => onRoleChange(event.target.value)}
            className={`${controlClass} max-w-full bg-board-bg`}
          >
            {!ASSIGNABLE_ROLES.some((role) => role === member.role) && (
              <option value={member.role}>{roleLabel}</option>
            )}
            {ASSIGNABLE_ROLES.map((role) => (
              <option key={role} value={role}>
                {ROLE_META[role].label}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={onRemove}
            disabled={disabled}
            aria-label={`Remove ${member.user.name}`}
            className={`${controlClass} text-red-400`}
          >
            <Trash2 className="size-4" />
          </button>
        </div>
      )}
    </div>
  );
}

// Server and browser locales can differ. Hydrate the same ISO value first,
// then present the date in the operator's locale and time zone.
function TeamDate({
  value,
  includeTime = false,
}: {
  value: string | Date;
  includeTime?: boolean;
}) {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  const date = new Date(value);
  return (
    <time dateTime={date.toISOString()}>
      {hydrated
        ? includeTime
          ? date.toLocaleString()
          : date.toLocaleDateString()
        : includeTime
          ? date.toISOString()
          : date.toISOString().slice(0, 10)}
    </time>
  );
}
