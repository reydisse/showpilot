import { useEffect, useRef, useState } from "react";
import { Settings2, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  useScheduleProvider,
  type ProviderDraft,
} from "@/hooks/useScheduleProvider";
import {
  scheduleProviderConfigSchema,
  scheduleProviderLabel,
  scheduleProviderSchema,
  type ScheduleProviderSnapshot,
} from "@/lib/schedule-provider-contract";

const control =
  "min-h-11 w-full min-w-0 rounded-xl border border-board-border bg-board-bg px-3 py-2.5 text-sm text-board-text focus-visible:outline-2 focus-visible:outline-fire-500";
const button =
  "min-h-11 rounded-xl border border-board-border px-4 py-2 text-sm focus-visible:outline-2 focus-visible:outline-fire-500 disabled:opacity-50";
type Editor = ReturnType<typeof useScheduleProvider>;
export function ScheduleProviderControl({
  orgId,
  userId,
  refresh,
  workspaceSettingsLink,
}: {
  orgId: string;
  userId: string;
  refresh: () => Promise<void>;
  workspaceSettingsLink: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const editor = useScheduleProvider({ orgId, userId }, open, refresh);
  const attention =
    editor.attempt?.kind === "failed" ||
    (editor.attempt?.kind === "confirmed" &&
      (editor.attempt.result.outcome !== "applied" ||
        editor.attempt.refresh.kind === "failed"));
  return (
    <div className="flex min-w-0 flex-col items-start gap-1">
      <button
        type="button"
        className={`${button} inline-flex items-center gap-2`}
        ref={opener}
        onClick={() => setOpen(true)}
      >
        <Settings2 className="h-4 w-4" />
        Manage source
      </button>
      {!open && (attention || editor.pending) && (
        <span role="status" className="max-w-64 text-xs text-board-muted">
          {editor.pending
            ? "Checking scheduling source…"
            : "Scheduling source needs attention. Open Manage source."}
        </span>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          showCloseButton={false}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            opener.current?.focus();
          }}
          className="flex max-h-[calc(100dvh-2rem)] min-w-0 flex-col gap-0 overflow-hidden border-board-border bg-board-card p-0 text-board-text sm:max-w-md"
        >
          <header className="flex shrink-0 items-start gap-3 border-b border-board-border p-4">
            <div className="min-w-0 flex-1">
              <DialogTitle>Scheduling source</DialogTitle>
              <DialogDescription className="mt-1 text-xs text-board-muted">
                Choose where this workspace manages its crew schedule.
              </DialogDescription>
            </div>
            <button
              type="button"
              aria-label="Close Scheduling source"
              className={`${button} min-w-11 shrink-0 px-2`}
              onClick={() => setOpen(false)}
            >
              <X className="mx-auto h-4 w-4" />
            </button>
          </header>
          <div className="min-h-0 space-y-4 overflow-y-auto p-4">
            {editor.readFailed && (
              <Notice
                at={editor.snapshot.errorUpdatedAt}
                retry={() => void editor.snapshot.refetch()}
                disabled={editor.snapshot.isFetching}
              >
                The saved scheduling source could not be checked. Your draft is
                kept.
              </Notice>
            )}
            {editor.snapshot.isFetching && (
              <p role="status" className="text-sm text-board-muted">
                Checking saved source…
              </p>
            )}
            {editor.attempt?.kind === "failed" && (
              <Notice at={editor.attempt.at} retry={editor.retry}>
                The save was not confirmed and may have completed. Retry checks
                the same change without replacing a newer source.
              </Notice>
            )}
            {editor.attempt?.kind === "confirmed" &&
              editor.attempt.refresh.kind === "failed" && (
                <Notice
                  at={editor.attempt.refresh.at}
                  retry={editor.retryRefresh}
                >
                  The source change was checked, but the Schedule view could not
                  refresh. Retry refreshes the view without saving again.
                </Notice>
              )}
            {editor.attempt?.kind === "confirmed" &&
              editor.attempt.refresh.kind === "pending" && (
                <p role="status" className="text-sm text-board-muted">
                  Source checked. Refreshing Schedule…
                </p>
              )}
            {editor.snapshot.data && (
              <ProviderForm
                editor={editor}
                saved={editor.snapshot.data}
                workspaceSettingsLink={workspaceSettingsLink}
              />
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
function Notice({
  at,
  retry,
  disabled,
  children,
}: {
  at: number;
  retry: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      role="alert"
      className="space-y-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
    >
      <p>{children}</p>
      <p className="text-xs text-board-muted">
        Last issue:{" "}
        <time dateTime={new Date(at).toISOString()}>
          {new Date(at).toLocaleTimeString()}
        </time>
      </p>
      <button
        type="button"
        className={button}
        onClick={retry}
        disabled={disabled}
      >
        {disabled ? "Retrying…" : "Retry"}
      </button>
    </div>
  );
}
function ProviderForm({
  editor,
  saved,
  workspaceSettingsLink,
}: {
  editor: Editor;
  saved: ScheduleProviderSnapshot;
  workspaceSettingsLink: React.ReactNode;
}) {
  const [draft, setDraft] = useState<ProviderDraft>(
    () => editor.draft ?? saved.config,
  );
  const [validation, setValidation] = useState<string | null>(null);
  useEffect(() => {
    if (!editor.draft) setDraft(saved.config);
  }, [editor.draft, saved.config]);
  const update = (value: Partial<ProviderDraft>) => {
    const next = { ...draft, ...value };
    setDraft(next);
    editor.setDraft(next);
    setValidation(null);
  };
  const parsed = scheduleProviderConfigSchema.safeParse({
    provider: draft.provider,
    url: draft.provider === "native" ? "" : draft.url,
    label: draft.provider === "other" ? draft.label : "",
  });
  const matches =
    parsed.success &&
    JSON.stringify(parsed.data) === JSON.stringify(saved.config);
  const conflict =
    editor.attempt?.kind === "confirmed" &&
    editor.attempt.result.outcome !== "applied";
  return (
    <form
      className="space-y-4"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (!parsed.success) {
          setValidation(
            parsed.error.issues[0]?.message ?? "Check the scheduling source.",
          );
          return;
        }
        editor.save(parsed.data);
      }}
    >
      {conflict && (
        <div
          role="status"
          className="space-y-2 rounded-xl border border-amber-500/40 p-3 text-sm"
        >
          <p>
            A newer source is saved. Your draft is kept below. Review it before
            saving again.
          </p>
          <p className="break-words">
            Saved source: {scheduleProviderLabel(saved.config)}
            {saved.config.url ? ` · ${saved.config.url}` : ""}
          </p>
          <button
            type="button"
            className={button}
            disabled={editor.locked}
            onClick={() => {
              editor.useSaved();
              setDraft(saved.config);
              setValidation(null);
            }}
          >
            Use saved source
          </button>
        </div>
      )}
      <fieldset
        disabled={editor.pending || editor.uncertain}
        className="min-w-0 space-y-4"
      >
        <label className="block text-xs text-board-muted">
          <span className="mb-1.5 block">Source</span>
          <select
            className={control}
            value={draft.provider}
            onChange={(event) =>
              update({
                provider: scheduleProviderSchema.parse(event.target.value),
              })
            }
          >
            <option value="native">ShowPilot</option>
            <option value="planning-center">Planning Center</option>
            <option value="faithteams">Faith Teams</option>
            <option value="other">Another platform</option>
          </select>
        </label>
        {draft.provider === "other" && (
          <label className="block text-xs text-board-muted">
            <span className="mb-1.5 block">Platform name</span>
            <input
              maxLength={80}
              className={control}
              value={draft.label}
              onChange={(event) => update({ label: event.target.value })}
            />
          </label>
        )}
        {draft.provider !== "native" ? (
          <label className="block text-xs text-board-muted">
            <span className="mb-1.5 block">Scheduling workspace URL</span>
            <input
              type="url"
              maxLength={500}
              className={control}
              value={draft.url}
              aria-invalid={Boolean(validation)}
              aria-describedby={validation ? "provider-validation" : undefined}
              onChange={(event) => update({ url: event.target.value })}
            />
          </label>
        ) : (
          <p className="text-sm text-board-muted">
            ShowPilot sends secure invitation links to roster contacts when you
            assign them.
          </p>
        )}
      </fieldset>
      <div className="text-xs text-board-muted">{workspaceSettingsLink}</div>
      {validation && (
        <p
          id="provider-validation"
          role="alert"
          className="text-sm text-red-400"
        >
          {validation}
        </p>
      )}
      {matches &&
      editor.attempt?.kind === "confirmed" &&
      editor.attempt.result.outcome === "applied" &&
      editor.attempt.refresh.kind === "done" ? (
        <p role="status" className="text-sm text-board-muted">
          Source saved.
        </p>
      ) : (
        <button
          type="submit"
          disabled={editor.locked || matches}
          className={`${button} w-full bg-fire-500 font-semibold text-black`}
        >
          {editor.attempt?.kind === "pending"
            ? "Saving source…"
            : conflict
              ? "Save reviewed source"
              : "Save source"}
        </button>
      )}
      <p className="text-xs text-board-muted">
        Your draft stays here if you close this panel or switch pages.
      </p>
    </form>
  );
}
