import { DateTimePicker } from "@/components/ui/date-time-picker";
import { plainFailure } from "@showpilot/shared/ui-feedback";
import { QuietActivity } from "@/components/ui/QuietActivity";
import { useEffect, useState } from "react";
import { Plus, X } from "lucide-react";
import { ModalAContent, modalCancel, modalDanger, modalFooter, modalHint, modalPrimary } from "@/components/schedule/modal-a";
import {
  Dialog,
} from "@/components/ui/dialog";
import { useAssignmentWork } from "@/hooks/useAssignmentWork";
import {
  assignmentFieldsSchema,
  type AssignmentSnapshot,
} from "@/lib/schedule-assignment-contract";
import { reminderMessage } from "@/lib/schedule-reminder-contract";
import { formatTimeInput } from "@/lib/utils";
import { getDeviceTimeZone } from "@/hooks/useDeviceTimeZone";
import { getAssignmentCallTime } from "@/lib/assignment-call-time";
import type { useConfirmDialog } from "@/components/ui/confirm-dialog";

const control =
  "min-h-11 w-full min-w-0 rounded-xl border border-board-border bg-board-bg px-3 py-2 text-sm text-board-text";
const button =
  "min-h-11 rounded-xl border border-board-border px-4 py-2 text-sm disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-fire-500";
type Row = {
  key: string;
  role: string;
  crewMemberId: string;
  callTime: string;
  notes: string;
};
type Draft = {
  department: string;
  rows: Row[];
  base: AssignmentSnapshot | null;
  timeZone: string;
};
type Target =
  | { kind: "create" | "team"; showId: string; serviceDate: string }
  | { kind: "edit" | "delete"; id: string };
type Crew = { id: string; name: string; role: string; email: string };
function emptyRow(): Row {
  return {
    key: crypto.randomUUID(),
    role: "",
    crewMemberId: "",
    callTime: "",
    notes: "",
  };
}
function blank(department: string): Draft {
  return {
    department,
    rows: [emptyRow()],
    base: null,
    timeZone: getDeviceTimeZone(),
  };
}
function fromSnapshot(
  snapshot: AssignmentSnapshot,
  timeZone: string,
  venueTimeZone: string,
): Draft {
  return {
    department: snapshot.department,
    base: snapshot,
    timeZone,
    rows: [
      {
        key: snapshot.id,
        role: snapshot.role,
        crewMemberId: snapshot.crewMemberId ?? "",
        notes: snapshot.notes,
        callTime: snapshot.callTime
          ? formatTimeInput(
              getAssignmentCallTime({
                serviceDate: snapshot.serviceDate,
                callTime: snapshot.callTime,
                timeZone: venueTimeZone,
              }),
              timeZone,
            )
          : "",
      },
    ],
  };
}
export function AssignmentEditor({
  orgId,
  userId,
  target,
  departments,
  initialDepartment = "Production",
  crew,
  venueTimeZone,
  confirm,
  onClose,
  onSaved,
  context,
}: {
  orgId: string;
  userId: string;
  /** Show name and date for the modal subtitle, e.g. "Traditional Service · Sun 22 Nov". */
  context?: string;
  target: Target;
  departments: string[];
  initialDepartment?: string;
  crew: Crew[];
  venueTimeZone: string;
  confirm: ReturnType<typeof useConfirmDialog>["confirm"];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [opener] = useState(() =>
    typeof document !== "undefined" &&
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  const assignmentId = "id" in target ? target.id : undefined;
  const editorId =
    "id" in target
      ? `${target.kind}:${target.id}`
      : `${target.kind}:${target.showId}:${target.serviceDate}`;
  const [initial] = useState(() =>
    assignmentId ? null : blank(initialDepartment),
  );
  const work = useAssignmentWork<Draft>(
    { orgId, userId, editorId },
    initial,
    assignmentId,
    onSaved,
  );
  const [error, setError] = useState("");
  const current = work.snapshot.data;
  useEffect(() => {
    if (current && !work.draft && !work.attempt)
      work.setDraft(
        (value) =>
          value ?? fromSnapshot(current, getDeviceTimeZone(), venueTimeZone),
      );
  }, [current, work.draft, work.attempt, venueTimeZone]);
  const draft = work.draft;
  const readBlocked =
    !!assignmentId &&
    (work.snapshot.isFetching || work.snapshot.isError || !current);
  const locked = work.pending || !!work.attempt || readBlocked;
  const positionField = (row: Row | undefined, index: number) => row ? (
    <label className="block min-w-0">
      {target.kind === "team" ? null : <span>Position</span>}
      <input
        aria-label={target.kind === "team" ? `Position ${index + 1}` : undefined}
        className={control}
        value={row.role}
        maxLength={120}
        required
        onChange={(event) => updateRow(row.key, { role: event.target.value })}
      />
    </label>
  ) : null;
  const title = {
    create: "Add position",
    team: "Build a team",
    edit: "Edit assignment",
    delete: "Remove assignment?",
  }[target.kind];
  const updateRow = (key: string, changes: Partial<Row>) =>
    work.setDraft((value) =>
      value
        ? {
            ...value,
            rows: value.rows.map((row) =>
              row.key === key ? { ...row, ...changes } : row,
            ),
          }
        : value,
    );
  const submit = async () => {
    if (locked || !draft) return;
    setError("");
    if (target.kind === "delete") {
      if (draft.base)
        work.submit([
          {
            kind: "delete",
            id: target.id,
            expectedRevision: draft.base.revision,
          },
        ]);
      return;
    }
    if (
      target.kind === "edit" &&
      draft.base?.status === "confirmed" &&
      draft.rows[0].crewMemberId !== (draft.base.crewMemberId ?? "")
    ) {
      if (
        !(await confirm({
          title: "Replace confirmed crew member?",
          description: `This clears the confirmed response for ${draft.base.role}.`,
          confirmLabel: "Replace person",
        }))
      )
        return;
    }
    try {
      const operations = draft.rows.map((row) => {
        const fields = assignmentFieldsSchema.parse({
          showId: "showId" in target ? target.showId : draft.base?.showId,
          serviceDate:
            "serviceDate" in target
              ? target.serviceDate
              : draft.base?.serviceDate,
          role: row.role,
          department: draft.department,
          crewMemberId: row.crewMemberId || null,
          callTime: row.callTime,
          notes: row.notes,
          timeZone: draft.timeZone,
        });
        if (target.kind === "edit" && draft.base)
          return {
            kind: "edit" as const,
            id: target.id,
            expectedRevision: draft.base.revision,
            fields,
          };
        return { kind: "create" as const, fields };
      });
      if (!work.submit(operations)) setError("This assignment draft changed. Review it and save again.");
    } catch {
      setError(
        "Enter a position and department for every row, and check the call times.",
      );
    }
  };
  const results = work.attempt?.results ?? [];
  const allApplied =
    results.length > 0 &&
    results.every((result) => result?.outcome === "applied");
  const needsReview = results.some(
    (result) => result && result.outcome !== "applied",
  );
  const review = () => {
    setError("");
    if (target.kind === "create" || target.kind === "team") {
      // Successful rows already exist. A reviewed new request only includes
      // rows rejected by the database, never the earlier successful creates.
      const remaining =
        draft?.rows.filter(
          (_row, index) => results[index]?.outcome === "conflict",
        ) ?? [];
      work.review(
        remaining.length && draft
          ? { ...draft, rows: remaining }
          : blank(initialDepartment),
      );
    } else {
      const latest = results[0]?.snapshot;
      work.review(
        latest
          ? needsReview && draft
            ? { ...draft, base: latest }
            : fromSnapshot(
                latest,
                draft?.timeZone ?? getDeviceTimeZone(),
                venueTimeZone,
              )
          : null,
      );
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <ModalAContent
        title={title}
        closeLabel="Close assignment"
        onClose={onClose}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (opener?.isConnected) opener.focus();
        }}
        description={target.kind === "delete"
          ? "Removal deletes this position and its invitation. This cannot be undone."
          : target.kind === "team"
            ? "Add several positions at once and invite everyone together."
            : context ?? "Your draft is kept when you close this window or leave Schedule."}
      >
        <div className="space-y-4">
          {assignmentId && !work.attempt && (
            <>
              {work.snapshot.isFetching && (
                <QuietActivity label="Loading current assignment…" />
              )}
              {work.snapshot.isError && (
                <div role="alert" className="space-y-2">
                  <p>Could not load the assignment. Your draft is kept.</p>
                  <button
                    className={button}
                    onClick={() => void work.snapshot.refetch()}
                  >
                    Retry loading
                  </button>
                </div>
              )}
              {work.snapshot.isSuccess && !current && (
                <p role="status">
                  This assignment was removed or is no longer available.
                </p>
              )}
            </>
          )}
          {draft && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
              className="space-y-4"
            >
              <fieldset
                disabled={locked}
                className="min-w-0 space-y-4 disabled:opacity-70"
              >
                {draft.base && (
                  <div className="rounded-xl border border-board-border p-3 text-sm">
                    <p className="break-words font-medium">{draft.base.role}</p>
                    <p>
                      Response:{" "}
                      {draft.base.crewMemberId
                        ? draft.base.status === "assigned"
                          ? "Awaiting response"
                          : draft.base.status
                        : "Open position"}
                    </p>
                    {draft.base.responseNote && (
                      <p className="mt-2 whitespace-pre-wrap break-words">
                        {draft.base.responseNote}
                      </p>
                    )}
                  </div>
                )}
                {target.kind !== "delete" && (
                  <>
                    <div className={target.kind === "team" ? "" : "grid min-w-0 gap-3 sm:grid-cols-2"}>
                    <label className="block min-w-0">
                      <span>
                        {target.kind === "team"
                          ? "Team name"
                          : "Department"}
                      </span>
                      <input
                        className={control}
                        list="assignment-departments"
                        value={draft.department}
                        maxLength={80}
                        required
                        onChange={(event) =>
                          work.setDraft((value) =>
                            value
                              ? { ...value, department: event.target.value }
                              : value,
                          )
                        }
                      />
                      <datalist id="assignment-departments">
                        {departments.map((name) => (
                          <option key={name} value={name} />
                        ))}
                      </datalist>
                      {target.kind === "team" ? <span className={modalHint}>Saved so you can reuse it on the next show.</span> : null}
                    </label>
                    {target.kind !== "team" ? positionField(draft.rows[0], 0) : null}
                    </div>
                    {target.kind === "team" ? <div aria-hidden="true" className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_28px] gap-2 text-xs font-medium text-[var(--sa-ink-2)]"><span>Position</span><span>Person</span><span /></div> : null}
                    {draft.rows.map((row, index) => (
                      <div
                        key={row.key}
                        className={target.kind === "team" ? "sp-row -mt-2 grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)_28px] items-center gap-2" : "min-w-0 space-y-4"}
                      >
                        {target.kind === "team" ? positionField(row, index) : null}
                        <label className="block min-w-0">
                          {target.kind === "team" ? null : <span>Person</span>}
                          <select
                            aria-label={target.kind === "team" ? `Person ${index + 1}` : "Person"}
                            className={control}
                            value={row.crewMemberId}
                            onChange={(event) => {
                              const person = crew.find(
                                (person) => person.id === event.target.value,
                              );
                              updateRow(row.key, {
                                crewMemberId: event.target.value,
                                role: row.role || person?.role || "",
                              });
                            }}
                          >
                            <option value="">
                              Open — nobody assigned
                            </option>
                            {crew.map((person) => (
                              <option key={person.id} value={person.id}>
                                {person.name}
                                {person.email ? "" : " (no email)"}
                              </option>
                            ))}
                          </select>
                          {target.kind === "team" ? null : <span className={modalHint}>Pick someone from your roster, or leave it open and assign later.</span>}
                        </label>
                        {target.kind === "team" && draft.rows.length > 1 ? (
                          <button
                            type="button"
                            aria-label={`Remove position ${index + 1}`}
                            className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--sa-ink-3)] hover:bg-[var(--sa-surface-2)] hover:text-board-text"
                            onClick={() =>
                              work.setDraft((value) =>
                                value
                                  ? { ...value, rows: value.rows.filter((item) => item.key !== row.key) }
                                  : value,
                              )
                            }
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        ) : target.kind === "team" ? <span /> : null}
                        {row.crewMemberId &&
                          !crew.find((person) => person.id === row.crewMemberId)
                            ?.email && (
                            <p className="col-span-full text-xs text-amber-300">
                              This contact needs an email address to receive an
                              invitation.
                            </p>
                          )}
                        {target.kind !== "team" && (
                          <>
                            <label className="block">
                              <span>Call time</span>
                              <DateTimePicker
                                kind="time"
                                className={control}
                                value={row.callTime}
                                onValueChange={(value) =>
                                  updateRow(row.key, {
                                    callTime: value,
                                  })
                                }
                              />
                            </label>
                            <p className="-mt-2.5 text-xs text-[var(--sa-ink-3)]">
                              Leave blank to use the show's crew call. Set it only if this position arrives at a different time. Times use {draft.timeZone}.
                            </p>
                            <label className="block">
                              <span>Note for this person (optional)</span>
                              <textarea
                                rows={3}
                                placeholder="Bring your own headset; camera 3 is on the balcony."
                                className={control}
                                maxLength={500}
                                value={row.notes}
                                onChange={(event) =>
                                  updateRow(row.key, {
                                    notes: event.target.value,
                                  })
                                }
                              />
                            </label>
                          </>
                        )}
                      </div>
                    ))}
                    {target.kind === "team" && draft.rows.length < 50 && (
                      <button
                        type="button"
                        className="-mt-1 inline-flex h-7 items-center gap-1.5 self-start rounded-md px-2.5 text-xs font-medium text-[var(--sa-ink-2)] hover:bg-[var(--sa-surface-2)] hover:text-board-text"
                        onClick={() =>
                          work.setDraft((value) =>
                            value
                              ? { ...value, rows: [...value.rows, emptyRow()] }
                              : value,
                          )
                        }
                      >
                        <Plus className="h-3.5 w-3.5" />
                        Add row
                      </button>
                    )}
                  </>
                )}
              </fieldset>
              {error && (
                <p role="alert" className="text-sm text-red-300">
                  {plainFailure(error)}
                </p>
              )}
              {!work.attempt && (
                <div className={modalFooter}>
                  <button type="button" className={modalCancel} onClick={onClose}>Cancel</button>
                  <button
                    type="submit"
                    disabled={locked}
                    className={target.kind === "delete" ? modalDanger : modalPrimary}
                  >
                    {target.kind === "delete"
                      ? "Remove assignment"
                      : target.kind === "edit"
                        ? "Save assignment"
                        : target.kind === "team"
                          ? `Add team & invite ${draft.rows.filter(row => row.crewMemberId).length}`
                          : "Add position"}
                  </button>
                </div>
              )}
            </form>
          )}
          {work.attempt && (
            <div className="space-y-3 rounded-xl border border-board-border p-3 text-sm">
              {work.pending && (
                <p role="status">
                  {work.attempt.pending
                    ? <QuietActivity label="Checking assignment saves…" />
                    : ""}
                </p>
              )}
              {!work.attempt.pending &&
                results.map((result, index) => (
                  <div
                    key={work.attempt!.commands[index].requestId}
                    role={result ? "status" : "alert"}
                    className="space-y-1 break-words"
                  >
                    <p>
                      {target.kind === "team"
                        ? `${draft?.rows[index]?.role || `Position ${index + 1}`}: `
                        : ""}
                      {!result
                        ? "Your changes need attention."
                        : result.outcome === "conflict"
                          ? "The assignment or show changed before this save. Review the latest details."
                          : result.outcome === "superseded"
                            ? "This save was received earlier. Newer changes are now saved; they were kept."
                            : target.kind === "delete"
                              ? "Assignment removed."
                              : "Assignment saved."}
                    </p>
                    {result?.invitation && (
                      <p>{reminderMessage(result.invitation)}</p>
                    )}
                    {result?.outcome !== "applied" && result?.snapshot && (
                      <p className="text-board-muted">
                        Latest: {result.snapshot.role} ·{" "}
                        {result.snapshot.department} · {result.snapshot.status}
                        {result.snapshot.notes
                          ? ` · ${result.snapshot.notes}`
                          : ""}
                      </p>
                    )}
                  </div>
                ))}
              {!work.pending && work.canRetry && (
                <button className={button} onClick={work.retry}>
                  Retry unconfirmed saves or invitations
                </button>
              )}
              {work.attempt.refresh === "failed" && (
                <div role="alert">
                  <p>
                    Schedule could not be updated.
                  </p>
                  <button
                    className={`${button} mt-2`}
                    onClick={work.retryRefresh}
                  >
                    Retry refresh
                  </button>
                </div>
              )}
              {!work.pending &&
                !work.uncertain &&
                work.attempt.refresh === "done" &&
                (needsReview ||
                  (allApplied &&
                    !work.canRetry &&
                    target.kind !== "delete")) && (
                  <button className={button} onClick={review}>
                    {needsReview
                      ? "Review latest details"
                      : target.kind === "edit"
                        ? "Edit latest details"
                        : "Add more positions"}
                  </button>
                )}
            </div>
          )}
        </div>
      </ModalAContent>
    </Dialog>
  );
}
