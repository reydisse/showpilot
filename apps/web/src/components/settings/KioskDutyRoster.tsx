import { useState } from "react";
import {
  useDutyRoster,
  useDutyRosterDrafts,
  weekDraft,
  type DutyWeekDraft,
} from "@/hooks/useDutyRoster";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { Button } from "@/components/ui/button";
import { DutyRosterFeedback } from "./DutyRosterFeedback";
import type { DutyRosterCommand } from "@/lib/duty-roster-contract";
function sunday(value: string) {
  const d = new Date(`${value}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d.toISOString().slice(0, 10);
}
const inputClass =
  "min-h-11 w-full min-w-0 rounded-lg border border-board-border bg-board-bg px-3 text-sm text-board-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fire-500";
export function KioskDutyRoster({
  orgId,
  userId,
}: {
  orgId: string;
  userId: string;
}) {
  const drafts = useDutyRosterDrafts(
      orgId,
      userId,
      sunday(new Date().toISOString().slice(0, 10)),
    ),
    week = drafts.state.week;
  const roster = useDutyRoster(orgId, userId, week),
    snapshot = roster.read.data;
  const { confirm, ConfirmDialogEl } = useConfirmDialog();
  const [confirming, setConfirming] = useState(false),
    [showRoles, setShowRoles] = useState(false);
  const locked = Boolean(roster.unfinished) || confirming,
    disabled = locked || !snapshot || roster.read.isError;
  const draft =
    drafts.state.weeks[week] ?? (snapshot ? weekDraft(snapshot) : null);
  const stale = Boolean(
    snapshot &&
    draft &&
    (snapshot.rolesRevision !== draft.rolesRevision ||
      snapshot.weekRevision !== draft.weekRevision),
  );
  const choose = (change: (draft: DutyWeekDraft) => DutyWeekDraft) => {
    if (!draft || disabled) return;
    drafts.update((previous) => ({
      ...previous,
      weeks: { ...previous.weeks, [week]: change(draft) },
    }));
  };
  const scope = () => ({
    orgId,
    requestId: crypto.randomUUID(),
    weekStart: week,
    rolesRevision: snapshot?.rolesRevision ?? 0,
  });
  const guarded = async (
    command: DutyRosterCommand,
    title: string,
    description: string,
    label: string,
  ) => {
    if (disabled) return;
    setConfirming(true);
    const accepted = await confirm({
      title,
      description,
      confirmLabel: label,
      variant: "warning",
    });
    setConfirming(false);
    if (accepted) roster.send(command);
  };
  const save = () => {
    if (!snapshot || !draft || disabled || stale) return;
    const command: DutyRosterCommand = {
      ...scope(),
      action: "save-week",
      rolesRevision: draft.rolesRevision,
      weekRevision: draft.weekRevision,
      tech: snapshot.roles.flatMap((role) =>
        draft.tech[role.id]
          ? [{ roleId: role.id, userId: draft.tech[role.id] }]
          : [],
      ),
      pmUserId: draft.pmUserId,
    };
    const replaces =
      Boolean(snapshot.pmUserId && snapshot.pmUserId !== draft.pmUserId) ||
      snapshot.roles.some(
        (role) =>
          snapshot.tech[role.id] &&
          snapshot.tech[role.id] !== draft.tech[role.id],
      );
    if (replaces)
      void guarded(
        command,
        "Replace duty assignments?",
        `This changes assigned people for the week of ${week}. Affected members receive an assignment notification.`,
        "Save assignments",
      );
    else roster.send(command);
  };
  const memberName = (id: string | null | undefined) =>
    snapshot?.members.find((member) => member.id === id)?.name ??
    (id ? "Unavailable member" : "Unassigned");
  const hasInvalidMember = Boolean(
    snapshot &&
    draft &&
    [draft.pmUserId, ...Object.values(draft.tech)].some(
      (id) => id && !snapshot.members.some((member) => member.id === id),
    ),
  );
  const assignment = (
    label: string,
    value: string,
    onChange: (value: string) => void,
    saved: string | null | undefined,
  ) => (
    <label className="block min-w-0 space-y-1 text-sm text-board-text">
      <span>{label}</span>
      <select
        aria-label={`${label} assignment`}
        className={inputClass}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">Unassigned</option>
        {value && !snapshot?.members.some((member) => member.id === value) ? (
          <option value={value}>Unavailable member — choose again</option>
        ) : null}
        {snapshot?.members.map((member) => (
          <option key={member.id} value={member.id}>
            {member.name}
          </option>
        ))}
      </select>
      {(saved ?? "") !== value ? (
        <span className="block text-xs text-board-muted">
          Currently saved: {memberName(saved)}
        </span>
      ) : null}
    </label>
  );
  const roleDraft = drafts.state.role;
  return (
    <section aria-label="On-duty roster" className="space-y-4">
      {ConfirmDialogEl}
      <div className="flex flex-col gap-3 rounded-xl border border-board-border bg-board-card p-4 sm:flex-row sm:items-end">
        <label className="min-w-0 flex-1 space-y-1 text-sm text-board-text">
          <span>Week starting Sunday</span>
          <input
            type="date"
            aria-label="Roster week starting Sunday"
            className={inputClass}
            value={week}
            onChange={(event) => {
              if (event.target.value)
                drafts.update((previous) => ({
                  ...previous,
                  week: sunday(event.target.value),
                }));
            }}
          />
        </label>
        <Button
          className="min-h-11"
          onClick={save}
          disabled={disabled || stale || hasInvalidMember}
        >
          Save Week
        </Button>
      </div>
      <DutyRosterFeedback roster={roster} />
      {!snapshot && !roster.read.isError ? (
        <p role="status" className="text-sm text-board-muted">
          Loading roster week…
        </p>
      ) : null}
      {snapshot && draft ? (
        <>
          {stale ? (
            <div role="alert" className="space-y-2 text-sm text-amber-200">
              <p>
                The saved roster changed. Your selections are kept; current
                saved names are shown under changed selections.
              </p>
              <Button
                variant="outline"
                className="min-h-11 h-auto whitespace-normal"
                disabled={disabled}
                onClick={async () => {
                  if (
                    await confirm({
                      title: "Use the current roster for review?",
                      description:
                        "Keep your selections for existing roles. Deleted roles are removed from your draft; new roles keep their current assignments. Review all names before saving.",
                      confirmLabel: "Review current roster",
                      variant: "warning",
                    })
                  )
                    drafts.update((previous) => ({
                      ...previous,
                      weeks: {
                        ...previous.weeks,
                        [week]: {
                          ...weekDraft(snapshot),
                          pmUserId: draft.pmUserId,
                          tech: Object.fromEntries(
                            snapshot.roles.map((role) => [
                              role.id,
                              Object.hasOwn(draft.tech, role.id)
                                ? draft.tech[role.id]
                                : (snapshot.tech[role.id] ?? ""),
                            ]),
                          ),
                        },
                      },
                    }));
                }}
              >
                Review current roster
              </Button>
            </div>
          ) : null}
          <div className="space-y-4 rounded-xl border border-board-border bg-board-card p-4">
            {snapshot.roles.map((role) => (
              <div key={role.id}>
                {assignment(
                  role.name,
                  draft.tech[role.id] ?? "",
                  (value) =>
                    choose((previous) => ({
                      ...previous,
                      tech: { ...previous.tech, [role.id]: value },
                    })),
                  snapshot.tech[role.id],
                )}
              </div>
            ))}
            {assignment(
              "Production Manager",
              draft.pmUserId ?? "",
              (value) =>
                choose((previous) => ({
                  ...previous,
                  pmUserId: value || null,
                })),
              snapshot.pmUserId,
            )}
          </div>
          {!snapshot.roles.length ? (
            <div className="space-y-2 text-sm text-board-muted">
              <p>
                No technical roster roles are defined yet. The Production
                Manager assignment is available above.
              </p>
              <Button
                className="min-h-11 h-auto whitespace-normal"
                disabled={disabled}
                onClick={() =>
                  roster.send({ ...scope(), action: "seed-roles" })
                }
              >
                Add default roles (TM, Audio, Cam 1/2, Pro, Stream)
              </Button>
            </div>
          ) : null}
          <div className="space-y-3 rounded-xl border border-board-border bg-board-card p-4">
            <Button
              variant="outline"
              className="min-h-11"
              onClick={() => setShowRoles((value) => !value)}
              aria-expanded={showRoles}
            >
              Manage roles ({snapshot.roles.length})
            </Button>
            {showRoles ? (
              <>
                <ul className="space-y-2">
                  {snapshot.roles.map((role) => (
                    <li
                      key={role.id}
                      className="flex flex-wrap items-center justify-between gap-2"
                    >
                      <span className="min-w-0 break-words text-sm text-board-text">
                        {role.name} ({role.short})
                      </span>
                      <Button
                        variant="outline"
                        className="min-h-11"
                        aria-label={`Delete ${role.short} roster role`}
                        disabled={disabled}
                        onClick={() =>
                          void guarded(
                            {
                              ...scope(),
                              action: "delete-role",
                              roleId: role.id,
                              roleRevision: role.revision,
                            },
                            `Delete ${role.name}?`,
                            "This removes the role and its assignments in every saved week. Affected members will be notified. Other duty roles and organization members are kept.",
                            "Delete role",
                          )
                        }
                      >
                        Delete role
                      </Button>
                    </li>
                  ))}
                </ul>
                <form
                  className="space-y-3"
                  aria-label="New duty role"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (
                      !disabled &&
                      roleDraft.code.trim() &&
                      roleDraft.name.trim() &&
                      roleDraft.short.trim()
                    )
                      roster.send({
                        ...scope(),
                        action: "create-role",
                        code: roleDraft.code
                          .trim()
                          .toLowerCase()
                          .replace(/\s+/g, "-"),
                        name: roleDraft.name.trim(),
                        short: roleDraft.short.trim(),
                      });
                  }}
                >
                  {(["code", "name", "short"] as const).map((field) => (
                    <label
                      key={field}
                      className="block space-y-1 text-sm text-board-text"
                    >
                      <span>
                        {field === "code"
                          ? "Role code"
                          : field === "name"
                            ? "Role name"
                            : "Short label"}
                      </span>
                      <input
                        className={inputClass}
                        required
                        maxLength={
                          field === "code" ? 50 : field === "name" ? 200 : 10
                        }
                        value={roleDraft[field]}
                        disabled={disabled}
                        onChange={(event) =>
                          drafts.update((previous) => ({
                            ...previous,
                            role: {
                              ...previous.role,
                              [field]: event.target.value,
                            },
                          }))
                        }
                      />
                    </label>
                  ))}
                  <Button
                    className="min-h-11"
                    type="submit"
                    disabled={
                      disabled ||
                      !roleDraft.code.trim() ||
                      !roleDraft.name.trim() ||
                      !roleDraft.short.trim()
                    }
                  >
                    Add role
                  </Button>
                </form>
              </>
            ) : null}
          </div>
        </>
      ) : null}
    </section>
  );
}
