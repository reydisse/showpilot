import { useRef } from "react";
import { FileUp, Upload, CheckCircle2, AlertTriangle } from "lucide-react";
import { isPlanLimitError } from "@/components/ui/upgrade-prompt";
import { CsvImportError, useCsvImport } from "@/hooks/useCsvImport";

function Failure({ error }: { error: unknown }) {
  return (
    <div role="alert" className="space-y-1 text-sm text-red-300">
      <p>
        {error instanceof Error
          ? error.message
          : "This operation could not be confirmed."}
      </p>
      {error instanceof CsvImportError && (
        <p className="text-xs">
          Failed at {new Date(error.occurredAt).toLocaleTimeString()}
        </p>
      )}
    </div>
  );
}
export function CsvImportSection({
  orgId,
  userId,
  openBilling,
}: {
  orgId: string;
  userId: string;
  openBilling: () => void;
}) {
  const control = useCsvImport({ orgId, userId }),
    { csv, fileName } = control.draft;
  const input = useRef<HTMLInputElement>(null),
    current = control.current,
    file = control.fileCurrent;
  const outcome = current?.result?.outcome,
    summary =
      current?.result?.outcome === "applied" ? current.result.summary : null;
  const action =
    "inline-flex min-h-11 min-w-11 max-w-full items-center justify-center gap-2 rounded-lg border border-board-border px-4 py-2 text-sm text-board-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-fire-500 disabled:opacity-50";
  const locked = control.unresolved || control.fileBusy;
  return (
    <div>
      <div className="mb-6">
        <h1 className="text-lg font-semibold text-board-text font-[family-name:var(--font-display)]">
          Import People
        </h1>
        <p className="mt-0.5 text-sm text-board-muted">
          Add crew profiles from a CSV. This does not send invitations or grant
          sign-in access.
        </p>
      </div>
      <div className="space-y-4">
        <div className="rounded-xl border border-board-border bg-board-card p-4">
          <p className="text-xs leading-relaxed text-board-muted">
            Expected columns:{" "}
            <code className="text-board-text">name, email, role</code> (role is
            optional). Planning Center exports with{" "}
            <code className="text-board-text">First Name</code> /{" "}
            <code className="text-board-text">Last Name</code> columns work too.
            Up to 500 rows and 512 KB; people whose email is already on the
            roster are skipped. Your plan's roster limit still applies.
          </p>
        </div>
        {control.access.isPending && (
          <p role="status" className="text-sm text-board-muted">
            Checking import access…
          </p>
        )}
        {control.access.isError && (
          <div className="space-y-2 rounded-xl border border-red-500/25 p-3">
            <Failure error={control.access.error} />
            <button
              type="button"
              className={action}
              disabled={control.access.isFetching}
              onClick={() => void control.access.refetch()}
            >
              Retry import access
            </button>
          </div>
        )}
        <label
          htmlFor="crew-csv"
          className="block text-sm font-medium text-board-text"
        >
          Crew CSV
        </label>
        <textarea
          id="crew-csv"
          value={csv}
          disabled={locked}
          onChange={(event) => control.changeText(event.target.value)}
          placeholder={
            "name,email,role\nJane Smith,jane@example.com,Camera 1\nMike Jones,mike@example.com,Audio"
          }
          rows={8}
          spellCheck={false}
          className="w-full resize-y rounded-xl border border-board-border bg-board-card px-4 py-3 font-mono text-sm text-board-text outline-none placeholder:text-board-muted/40 focus:border-fire-500/50 focus:ring-1 focus:ring-fire-500/20 disabled:opacity-60"
        />
        <div className="flex flex-wrap items-center gap-3">
          <input
            ref={input}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            aria-label="Choose crew CSV file"
            disabled={locked}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) control.chooseFile(file);
              event.target.value = "";
            }}
          />
          <button
            type="button"
            disabled={locked}
            onClick={() => input.current?.click()}
            className={action}
          >
            <FileUp className="h-4 w-4 shrink-0" />
            <span className="min-w-0 break-all">
              {fileName ?? "Upload .csv"}
            </span>
          </button>
          <button
            type="button"
            disabled={!control.canImport}
            onClick={() => void control.send()}
            className={`${action} bg-fire-500 font-semibold text-black`}
          >
            <Upload className="h-4 w-4" />
            {control.pending
              ? current?.attempt?.mode === "review"
                ? "Reviewing..."
                : "Importing..."
              : "Import"}
          </button>
        </div>
        {control.validationError && (
          <p role="alert" className="text-sm text-red-300">
            {control.validationError}
          </p>
        )}
        {control.fileBusy && (
          <div className="space-y-2">
            <p role="status" className="break-all text-sm text-board-muted">
              Reading {file?.attempt?.file.name}…
            </p>
            <button
              type="button"
              className={action}
              onClick={control.clearFile}
            >
              Cancel file read
            </button>
          </div>
        )}
        {file?.status === "error" && file.attempt && (
          <div className="space-y-2 rounded-xl border border-red-500/25 p-3">
            <Failure error={file.error} />
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={action}
                onClick={() => {
                  if (file.attempt) control.chooseFile(file.attempt.file);
                }}
              >
                Retry file
              </button>
              <button
                type="button"
                className={action}
                onClick={control.clearFile}
              >
                Keep current CSV
              </button>
            </div>
          </div>
        )}
        {current?.attempt && (
          <section
            aria-label="CSV import status"
            className="space-y-3 rounded-xl border border-board-border bg-board-card p-4"
          >
            <p className="break-all text-sm font-semibold text-board-text">
              {current.attempt.fileName ?? "Pasted CSV"}
            </p>
            {control.pending ? (
              <p role="status" className="text-sm text-board-muted">
                {current.attempt.mode === "review"
                  ? "Checking the original import…"
                  : "Waiting for import confirmation…"}
              </p>
            ) : current.status === "error" ? (
              <>
                <Failure error={current.error} />
                <p className="text-sm text-board-muted">
                  Your CSV is kept. Retry recovers the original import result.
                  Review cancels the import if it has not been applied.
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={action}
                    onClick={() => void control.recover()}
                  >
                    Retry import
                  </button>
                  <button
                    type="button"
                    className={action}
                    onClick={() => void control.recover("review")}
                  >
                    Review import result
                  </button>
                </div>
              </>
            ) : outcome && outcome !== "applied" ? (
              <>
                <p role="alert" className="text-sm text-amber-300">
                  {outcome === "cancelled"
                    ? "The undelivered import was cancelled. No crew profiles were added."
                    : outcome === "expired"
                      ? "The import request expired without adding crew profiles."
                      : "Your plan changed before the import arrived. No crew profiles were added."}{" "}
                  Your CSV is kept.
                </p>
                <button
                  type="button"
                  className={action}
                  onClick={control.dismiss}
                >
                  Continue editing CSV
                </button>
              </>
            ) : null}
            {summary && (
              <>
                <div
                  role="status"
                  className="flex flex-wrap items-center gap-3 text-sm"
                >
                  <span className="inline-flex items-center gap-1.5 text-green-400">
                    <CheckCircle2 className="h-4 w-4" />
                    {summary.imported} imported
                  </span>
                  {summary.skipped > 0 && (
                    <span className="text-board-muted">
                      {summary.skipped} skipped (already on roster)
                    </span>
                  )}
                  {summary.errors.length > 0 && (
                    <span className="inline-flex items-center gap-1.5 text-yellow-400">
                      <AlertTriangle className="h-4 w-4" />
                      {summary.errors.length} error
                      {summary.errors.length === 1 ? "" : "s"}
                    </span>
                  )}
                </div>
                {summary.errors.length > 0 && (
                  <ul className="max-h-48 space-y-1 overflow-auto">
                    {summary.errors.map((error, index) => (
                      <li
                        key={`${error.line}-${index}`}
                        className="text-xs text-board-muted"
                      >
                        <span className="font-mono text-yellow-400/80">
                          line {error.line}
                        </span>{" "}
                        — {error.message}
                      </li>
                    ))}
                  </ul>
                )}
                {summary.errors.some((error) =>
                  isPlanLimitError(error.message),
                ) && (
                  <button
                    type="button"
                    className={action}
                    onClick={openBilling}
                  >
                    View plans
                  </button>
                )}
              </>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
