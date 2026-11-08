import { useEffect, useState } from "react";
import { useConfirmedWrite } from "@/hooks/useConfirmedWrite";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  saveShowReportNote,
  type ShowReportLane,
  type ShowReportNote,
} from "@/lib/show-report-notes";
import type { ShowReport } from "@/lib/report";
import {
  reportNoteWriteSchema,
  type ReportNoteWriteResult,
} from "@/lib/report-note-write";

type Fields = Pick<ShowReportNote, "summary" | "wins" | "issues" | "followUps">;
type Draft = { fields: Fields; saved: ShowReportNote | null };
export type ReportEditingState = { dirty: boolean; unconfirmed: boolean };
const labels = {
  summary: "Overall summary",
  wins: "What worked",
  issues: "Issues or changes",
  followUps: "Follow-up",
};
const fieldsOf = (note: Fields | null): Fields => ({
  summary: note?.summary ?? "",
  wins: note?.wins ?? "",
  issues: note?.issues ?? "",
  followUps: note?.followUps ?? "",
});
const sameFields = (a: Fields, b: Fields) =>
  (Object.keys(labels) as (keyof Fields)[]).every((key) => a[key] === b[key]);
const roleName = (role: ShowReportLane) =>
  role === "pm" ? "Production Manager" : "Technical Manager";
const action =
  "min-h-11 rounded-lg border border-board-border px-3 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-fire-500 disabled:opacity-40";

export function ManagerReportNotes({
  report,
  onNoteChange,
  onEditingChange,
}: {
  report: ShowReport;
  onNoteChange: (note: ShowReportNote | null, lane: ShowReportLane) => void;
  onEditingChange: (state: ReportEditingState) => void;
}) {
  const writable = report.viewer.writableNoteLanes;
  const [lane, setLane] = useState<ShowReportLane>(writable[0] ?? "pm");
  const [drafts, setDrafts] = useState<Record<ShowReportLane, Draft>>(() => {
    const make = (role: ShowReportLane) => {
      const saved =
        report.managerNotes.find(
          (note) => note.userId === report.viewer.userId && note.role === role,
        ) ?? null;
      return { fields: fieldsOf(saved), saved };
    };
    return { pm: make("pm"), tm: make("tm") };
  });
  const write = useConfirmedWrite(
    JSON.stringify([
      report.organization.id,
      report.showId,
      report.viewer.userId,
    ]),
  );
  const [conflict, setConflict] = useState<{
    lane: ShowReportLane;
    result: ReportNoteWriteResult;
  } | null>(null);
  const [notice, setNotice] = useState("");
  const { confirm, ConfirmDialogEl } = useConfirmDialog();
  const dirty = writable.some(
    (role) => !sameFields(drafts[role].fields, fieldsOf(drafts[role].saved)),
  );
  const unconfirmed = write.state.status !== "idle";
  useEffect(() => {
    onEditingChange({ dirty, unconfirmed });
  }, [dirty, unconfirmed, onEditingChange]);
  const current = drafts[lane];
  const locked = unconfirmed || conflict !== null;

  const save = () => {
    if (locked || !writable.includes(lane)) return;
    const captured = { ...current.fields };
    setNotice("");
    void write.start({
      label: "Save manager note",
      write: async (requestId, signal) => {
        const data = reportNoteWriteSchema.parse({
          orgId: report.organization.id,
          showId: report.showId,
          role: lane,
          requestId,
          expectedRevision: current.saved?.revision ?? null,
          ...captured,
        });
        const result = await saveShowReportNote({ data, signal });
        if (
          result.requestId !== requestId ||
          !["applied", "conflict"].includes(result.outcome)
        )
          throw new Error(
            "The note save could not be confirmed. Retry the same save.",
          );
        return result;
      },
      apply: (result) => {
        onNoteChange(result.currentNote, lane);
        const submitted = {
          summary: captured.summary.trim(),
          wins: captured.wins.trim(),
          issues: captured.issues.trim(),
          followUps: captured.followUps.trim(),
        };
        if (
          result.outcome === "conflict" ||
          !result.currentNote ||
          !sameFields(fieldsOf(result.currentNote), submitted)
        ) {
          setConflict({ lane, result });
          return;
        }
        setDrafts((previous) => ({
          ...previous,
          [lane]: {
            fields: fieldsOf(result.currentNote),
            saved: result.currentNote,
          },
        }));
        setNotice(`${roleName(lane)} note saved and included in exports.`);
      },
    });
  };
  const review = async (useSaved: boolean) => {
    if (!conflict) return;
    if (
      useSaved &&
      !(await confirm({
        title: "Replace your draft with the saved note?",
        description:
          "Your unsaved text for this manager role will be discarded. Notes for the other role are kept.",
        confirmLabel: "Use saved note",
        variant: "warning",
      }))
    )
      return;
    const { lane: role, result } = conflict;
    setDrafts((previous) => ({
      ...previous,
      [role]: {
        saved: result.currentNote,
        fields: useSaved ? fieldsOf(result.currentNote) : previous[role].fields,
      },
    }));
    setConflict(null);
    setNotice(
      useSaved
        ? "Saved note loaded."
        : "Your draft is kept. Review it before saving against the version shown above. Another intervening change will still require review.",
    );
  };

  return (
    <section
      className="min-w-0 space-y-4 rounded-xl border border-board-border p-4"
      aria-label="Manager notes"
    >
      <div>
        <h3 className="font-semibold">Manager notes</h3>
        <p className="mt-1 text-sm text-board-muted">
          Optional context from Production and Technical Managers travels with
          the PDF and CSV. Exports include saved notes only.
        </p>
      </div>
      {report.managerNotes.length > 0 ? (
        <div className="grid min-w-0 gap-3 md:grid-cols-2">
          {report.managerNotes.map((note) => (
            <article
              key={note.id}
              className="min-w-0 rounded-lg border border-board-border bg-board-bg/40 p-3"
            >
              <h4 className="break-words text-sm font-semibold">
                {roleName(note.role)} · {note.authorName}
              </h4>
              <NoteFields fields={fieldsOf(note)} />
            </article>
          ))}
        </div>
      ) : (
        <p className="text-sm text-board-muted">
          No Production or Technical Manager notes were submitted for this show.
        </p>
      )}
      {writable.length > 0 && (
        <>
          <div
            role="group"
            aria-label="Manager note role"
            className="flex flex-wrap gap-2"
          >
            {writable.map((role) => (
              <button
                key={role}
                type="button"
                disabled={locked}
                aria-pressed={lane === role}
                onClick={() => {
                  setLane(role);
                  setNotice("");
                }}
                className={`${action} ${lane === role ? "bg-fire-500 text-black" : "text-board-text"}`}
              >
                {roleName(role)} note
                {!sameFields(
                  drafts[role].fields,
                  fieldsOf(drafts[role].saved),
                ) ? (
                  <span className="ml-1">· Unsaved</span>
                ) : null}
              </button>
            ))}
          </div>
          {notice && (
            <p role="status" className="text-sm text-board-muted">
              {notice}
            </p>
          )}
          {write.state.status === "saving" && (
            <p role="status" className="text-sm">
              Confirming note save…
            </p>
          )}
          {write.state.status === "failed" && (
            <div
              role="alert"
              className="space-y-3 rounded-lg border border-amber-400/30 bg-amber-500/5 p-3 text-sm text-amber-200"
            >
              <p>
                The note save was not confirmed and may have completed. Your
                draft is kept. Retry checks the same save without overwriting a
                newer note.
              </p>
              <p>{write.state.message}</p>
              <p>
                Last error{" "}
                <time dateTime={new Date(write.state.at).toISOString()}>
                  {new Date(write.state.at).toLocaleTimeString()}
                </time>
              </p>
              <button className={action} onClick={() => void write.retry()}>
                Retry note save
              </button>
            </div>
          )}
          {conflict && (
            <div
              role="alert"
              className="space-y-3 rounded-lg border border-amber-400/30 bg-amber-500/5 p-3 text-sm"
            >
              <p>
                {conflict.result.outcome === "applied"
                  ? "Your earlier save completed, but the saved note changed again. Your draft is kept below."
                  : "The note changed before your save. Your draft was not applied and is kept below."}
              </p>
              <h4 className="font-semibold">
                Latest saved {roleName(conflict.lane)} note
              </h4>
              {conflict.result.currentNote ? (
                <NoteFields fields={fieldsOf(conflict.result.currentNote)} />
              ) : (
                <p>No note is currently saved for this role.</p>
              )}
              <div className="flex flex-wrap gap-2">
                <button className={action} onClick={() => void review(false)}>
                  Keep my draft for review
                </button>
                <button className={action} onClick={() => void review(true)}>
                  Use saved note
                </button>
              </div>
            </div>
          )}
          <fieldset
            disabled={locked}
            className="grid min-w-0 gap-3 md:grid-cols-2"
          >
            <legend className="sr-only">{roleName(lane)} draft</legend>
            {(Object.keys(labels) as (keyof Fields)[]).map((field) => (
              <label
                key={field}
                className="min-w-0 space-y-1 text-sm text-board-muted"
              >
                {labels[field]}
                <textarea
                  value={current.fields[field]}
                  onChange={(event) => {
                    const value = event.target.value;
                    setDrafts((previous) => ({
                      ...previous,
                      [lane]: {
                        ...previous[lane],
                        fields: { ...previous[lane].fields, [field]: value },
                      },
                    }));
                    setNotice("");
                  }}
                  maxLength={4000}
                  rows={3}
                  className="block min-h-24 w-full min-w-0 resize-y rounded-lg border border-board-border bg-board-bg p-3 text-sm text-board-text focus-visible:outline-2 focus-visible:outline-fire-500 disabled:opacity-60"
                />
              </label>
            ))}
          </fieldset>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-board-muted">
              {dirty
                ? "Unsaved drafts are kept when switching manager roles."
                : "All notes saved."}
            </p>
            <button
              type="button"
              className={`${action} bg-fire-500 text-black`}
              disabled={
                locked || sameFields(current.fields, fieldsOf(current.saved))
              }
              onClick={save}
            >
              Save my notes
            </button>
          </div>
        </>
      )}
      {ConfirmDialogEl}
    </section>
  );
}

function NoteFields({ fields }: { fields: Fields }) {
  return (
    <dl className="mt-2 space-y-2 text-sm">
      {(Object.keys(labels) as (keyof Fields)[]).map((field) =>
        fields[field] ? (
          <div key={field}>
            <dt className="font-medium text-board-muted">{labels[field]}</dt>
            <dd className="whitespace-pre-wrap break-words">{fields[field]}</dd>
          </div>
        ) : null,
      )}
    </dl>
  );
}
