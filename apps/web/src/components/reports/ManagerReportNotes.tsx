import { plainFailure } from "@showpilot/shared/ui-feedback";
import { QuietActivity } from "@/components/ui/QuietActivity";
import { useEffect, useState } from "react";
import { AlertTriangle, Check, NotebookPen, Pencil } from "lucide-react";
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
const secondary =
  "inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-[var(--sa-border-strong,#34343a)] bg-[var(--sa-surface-2,#1a1a1d)] px-3 text-[13px] font-medium text-board-text hover:bg-[var(--sa-surface-3,#222226)] focus-visible:outline-2 focus-visible:outline-fire-500 disabled:opacity-40 max-lg:min-h-11";

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
  const [editingLane, setEditingLane] = useState<ShowReportLane | null>(null);
  const locked = unconfirmed || conflict !== null;

  const saveLane = (lane: ShowReportLane) => {
    const current = drafts[lane];
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
            "This change needs attention.",
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
        setEditingLane((open) => (open === lane ? null : open));
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

  const ownSaved = (role: ShowReportLane) => drafts[role].saved;
  const startEdit = (role: ShowReportLane) => { if (locked) return; setLane(role); setEditingLane(role); setNotice(""); };
  const discard = (role: ShowReportLane) => {
    setDrafts((previous) => ({ ...previous, [role]: { ...previous[role], fields: fieldsOf(previous[role].saved) } }));
    if (ownSaved(role)) setEditingLane(null);
    setNotice("");
  };
  const savedAt = (note: ShowReportNote) => new Date(note.updatedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

  return (
    <section className="flex min-w-0 flex-col gap-3" aria-label="Manager notes">
      <div className="flex flex-col gap-1">
        <h3 className="flex items-center gap-2 text-[15px] font-semibold text-board-text"><NotebookPen aria-hidden="true" className="h-4 w-4 text-[var(--sa-ink-3,#8e8e98)]" strokeWidth={1.75} />Manager notes</h3>
        <p className="text-[13px] leading-[1.55] text-[var(--sa-ink-2,#a8a8b3)]">Each note belongs to the person who wrote it. You can edit only your own; other notes are read-only. Exports include saved notes only.</p>
      </div>
      {report.managerNotes.length === 0 ? <p className="text-[13px] text-[var(--sa-ink-2,#a8a8b3)]">No Production or Technical Manager notes were submitted for this show.</p> : null}
      {notice && <p role="status" className="text-[13px] text-[var(--sa-ok,#3ecf8e)]">{notice}</p>}
      {(["pm", "tm"] as const).map((role) => {
        const own = writable.includes(role);
        const others = report.managerNotes.filter((note) => note.role === role && !(own && note.userId === report.viewer.userId));
        const mine = own ? ownSaved(role) : null;
        const roleDirty = own && !sameFields(drafts[role].fields, fieldsOf(drafts[role].saved));
        // An unsaved draft, an unconfirmed save or a conflict always stays on screen.
        const editing = own && (editingLane === role || !mine || roleDirty || (lane === role && (unconfirmed || conflict?.lane === role)));
        return (
          <section key={role} role="group" aria-label={`${roleName(role)} note`} className="flex min-w-0 flex-col gap-3 rounded-xl border border-[var(--sa-border,#242428)] p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="flex items-center gap-2 text-[13px] font-semibold text-board-text">{roleName(role)} note{own ? <span className="rounded bg-[var(--sa-surface-3,#222226)] px-1.5 py-0.5 text-xs font-normal text-[var(--sa-ink-2,#a8a8b3)]">Your note</span> : null}</h4>
              {own && !editing ? <button type="button" disabled={locked} onClick={() => startEdit(role)} className={secondary}><Pencil aria-hidden="true" className="h-3.5 w-3.5" />Edit my note</button> : null}
            </div>
            {others.map((note) => (
              <div key={note.id} className="flex min-w-0 flex-col gap-2">
                <p className="text-xs text-[var(--sa-ink-3,#8e8e98)]">{note.authorName} · Saved — <span className="tabular-nums">{savedAt(note)}</span></p>
                <NoteFields fields={fieldsOf(note)} />
              </div>
            ))}
            {own && !editing && mine ? (
              <div className="flex min-w-0 flex-col gap-2">
                <p className="text-xs text-[var(--sa-ink-3,#8e8e98)]">{mine.authorName} · Saved — <span className="tabular-nums">{savedAt(mine)}</span></p>
                <NoteFields fields={fieldsOf(mine)} />
              </div>
            ) : null}
            {!own && others.length === 0 ? <p className="text-xs text-[var(--sa-ink-3,#8e8e98)]">Not submitted · Exports will skip it</p> : null}
            {editing ? (
              <>
                <p className="text-xs text-[var(--sa-ink-3,#8e8e98)]">{mine?.authorName ?? "You"} · {mine ? <>Saved — <span className="tabular-nums">{savedAt(mine)}</span></> : "Not saved yet"}</p>
                {lane === role && write.state.status === "failed" && (
                  <div role="alert" className="flex flex-col gap-2 rounded-lg border border-[var(--sa-danger,#f87171)]/30 bg-[var(--sa-danger,#f87171)]/[0.07] p-3 text-[13px] text-board-text">
                    <p className="flex items-center gap-2"><AlertTriangle aria-hidden="true" className="h-4 w-4 shrink-0 text-[var(--sa-danger,#f87171)]" />Couldn't save your note. It's still here — check your connection and save again.</p>
                    <p className="text-[var(--sa-ink-2,#a8a8b3)]">{plainFailure((write.state.message) ?? "")}</p>
                    <button type="button" className={`${secondary} self-start`} onClick={() => void write.retry()}>Retry note save</button>
                  </div>
                )}
                {conflict?.lane === role && (
                  <div role="alert" className="flex flex-col gap-3 rounded-lg border border-[var(--sa-warn,#f5b84a)]/30 bg-[var(--sa-warn,#f5b84a)]/[0.07] p-3 text-[13px] text-board-text">
                    <p>{conflict.result.outcome === "applied"
                      ? "Your earlier save completed, but the saved note changed again. Your draft is kept below."
                      : "The note changed before your save. Your draft was not applied and is kept below."}</p>
                    <h5 className="font-semibold">Latest saved {roleName(conflict.lane)} note</h5>
                    {conflict.result.currentNote ? <NoteFields fields={fieldsOf(conflict.result.currentNote)} /> : <p>No note is currently saved for this role.</p>}
                    <div className="flex flex-wrap gap-2">
                      <button type="button" className={secondary} onClick={() => void review(false)}>Keep my draft for review</button>
                      <button type="button" className={secondary} onClick={() => void review(true)}>Use saved note</button>
                    </div>
                  </div>
                )}
                <fieldset disabled={locked} className="grid min-w-0 gap-3 md:grid-cols-2">
                  <legend className="sr-only">{roleName(role)} draft</legend>
                  {(Object.keys(labels) as (keyof Fields)[]).map((field) => (
                    <label key={field} className="flex min-w-0 flex-col gap-1.5 text-[13px] font-medium text-board-text">
                      {labels[field]}
                      <textarea
                        value={drafts[role].fields[field]}
                        onFocus={() => setLane(role)}
                        onChange={(event) => {
                          const value = event.target.value;
                          setLane(role);
                          setDrafts((previous) => ({ ...previous, [role]: { ...previous[role], fields: { ...previous[role].fields, [field]: value } } }));
                          setNotice("");
                        }}
                        maxLength={4000}
                        rows={3}
                        placeholder={field === "summary" ? "" : "Optional"}
                        className="block min-h-[76px] w-full min-w-0 resize-y rounded-lg border border-[var(--sa-border-strong,#34343a)] bg-board-bg px-3 py-2.5 text-base font-normal text-board-text outline-none placeholder:text-[var(--sa-ink-3,#8e8e98)] focus:border-fire-500 disabled:opacity-60 lg:text-[13px]"
                      />
                    </label>
                  ))}
                </fieldset>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className={`flex items-center gap-2 text-[13px] ${lane === role && write.state.status === "failed" ? "text-[var(--sa-danger,#f87171)]" : roleDirty ? "text-[var(--sa-warn,#f5b84a)]" : "text-[var(--sa-ink-2,#a8a8b3)]"}`}>
                    {lane === role && write.state.status === "saving" ? <QuietActivity label="Saving…" />
                      : lane === role && write.state.status === "failed" ? <><AlertTriangle aria-hidden="true" className="h-3.5 w-3.5" />Not saved</>
                      : roleDirty ? <><span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />Unsaved changes</>
                      : mine ? <><Check aria-hidden="true" className="h-3.5 w-3.5" />All notes saved</> : null}
                  </p>
                  <div className="flex items-center gap-2">
                    {roleDirty || mine ? <button type="button" disabled={locked} onClick={() => discard(role)} className="inline-flex min-h-9 items-center rounded-lg px-3 text-[13px] font-medium text-[var(--sa-ink-2,#a8a8b3)] hover:bg-[var(--sa-surface-2,#1a1a1d)] hover:text-board-text disabled:opacity-40 max-lg:min-h-11">{roleDirty ? "Discard" : "Done"}</button> : null}
                    <button
                      type="button"
                      className="inline-flex min-h-9 min-w-[104px] items-center justify-center rounded-lg bg-fire-500 px-3.5 text-[13px] font-semibold text-[#1a1300] hover:bg-fire-400 disabled:opacity-40 max-lg:min-h-11"
                      disabled={locked || sameFields(drafts[role].fields, fieldsOf(drafts[role].saved))}
                      onClick={() => { setLane(role); saveLane(role); }}
                    >
                      {lane === role && write.state.status === "saving" ? "Saving…" : lane === role && write.state.status === "failed" ? "Save again" : "Save my note"}
                    </button>
                  </div>
                </div>
              </>
            ) : null}
          </section>
        );
      })}
      {ConfirmDialogEl}
    </section>
  );
}

function NoteFields({ fields }: { fields: Fields }) {
  return (
    <dl className="grid min-w-0 gap-x-6 gap-y-3 sm:grid-cols-2">
      {(Object.keys(labels) as (keyof Fields)[]).map((field) =>
        fields[field] ? (
          <div key={field} className="min-w-0">
            <dt className="text-xs font-medium uppercase tracking-[0.07em] text-[var(--sa-ink-3,#8e8e98)]">{labels[field]}</dt>
            <dd className="mt-1 whitespace-pre-wrap break-words text-[13px] text-board-text">{fields[field]}</dd>
          </div>
        ) : null,
      )}
    </dl>
  );
}
