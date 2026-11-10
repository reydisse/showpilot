import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Download, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ReadFailureNotice } from "@/components/layout/ReadFailureNotice";
import { useOperatorRead } from "@/hooks/useOperatorRead";
import { listRundownDates } from "@/lib/rundown";
import { exportShowReport } from "@/lib/report";
import { formatServicePickerLabel } from "@/lib/service-picker";
import {
  REPORT_EXPORT_SECTIONS,
  type ReportExportSection,
} from "@/lib/settings-export";
import {
  createSettingsReportFile,
  type ReportFileFormat,
} from "@/lib/settings-report-file";
import { withOperationTimeout } from "@/lib/operation-timeout";

type ExportState =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "error"; at: number };

export function ShowReportExport({
  orgId,
  slug,
  disabled = false,
}: {
  orgId: string;
  slug: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [showId, setShowId] = useState<string | null>(null);
  const [format, setFormat] = useState<ReportFileFormat>("json");
  const [sections, setSections] = useState<ReportExportSection[]>(
    REPORT_EXPORT_SECTIONS.map(([value]) => value),
  );
  const [state, setState] = useState<ExportState>({ kind: "idle" });
  const [downloadName, setDownloadName] = useState<string | null>(null);
  const active = useRef<AbortController | null>(null);
  const selectId = useId();
  const read = useCallback(
    (signal: AbortSignal) => listRundownDates({ data: { orgId }, signal }),
    [orgId],
  );
  const shows = useOperatorRead<Awaited<ReturnType<typeof listRundownDates>>>({
    key: orgId,
    initialValue: [],
    read,
    enabled: open,
    pauseWhenHidden: false,
    errorMessage:
      "Available shows could not be loaded. Retry to choose a show.",
  });
  const selectedShow =
    showId === null
      ? shows.value[0]
      : shows.value.find((show) => show.showId === showId);
  const pending = state.kind === "pending";
  useEffect(
    () => () => {
      active.current?.abort();
      active.current = null;
    },
    [],
  );

  function changeOpen(next: boolean) {
    if (!next) {
      active.current?.abort();
      active.current = null;
      setState((previous) =>
        previous.kind === "pending" ? { kind: "idle" } : previous,
      );
    }
    setOpen(next);
  }

  async function download() {
    if (!selectedShow || sections.length === 0 || active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setState({ kind: "pending" });
    setDownloadName(null);
    try {
      const blob = await withOperationTimeout(
        (async () => {
          const report = await exportShowReport({
            data: {
              orgId,
              serviceDate: selectedShow.date,
              showId: selectedShow.showId,
            },
            signal: controller.signal,
          });
          controller.signal.throwIfAborted();
          return createSettingsReportFile({ report, sections, format });
        })(),
        10_000,
        "The export timed out.",
      );
      if (active.current !== controller || controller.signal.aborted) return;
      const filename = `${slug}-show-report-${selectedShow.date}-${selectedShow.showId}.${format}`;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      try {
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
      } finally {
        link.remove();
        // Give the browser time to consume the object URL before releasing it.
        setTimeout(() => URL.revokeObjectURL(url), 1_000);
      }
      setDownloadName(filename);
      setState({ kind: "idle" });
      changeOpen(false);
    } catch {
      if (active.current === controller)
        setState({ kind: "error", at: Date.now() });
    } finally {
      controller.abort();
      if (active.current === controller) active.current = null;
    }
  }

  return (
    <div className="rounded-xl border border-board-border bg-board-card p-4">
      <Dialog open={open} onOpenChange={changeOpen}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium text-board-text">
              Export show data
            </p>
            <p className="text-xs text-board-muted">
              Select a saved show, file format, and sections to download.
            </p>
          </div>
          <DialogTrigger asChild>
            <Button
              type="button"
              variant="outline"
              disabled={disabled}
              className="min-h-11"
            >
              <Download />
              Export show data
            </Button>
          </DialogTrigger>
        </div>
        <DialogContent
          showCloseButton={false}
          className="max-h-[90dvh] overflow-y-auto bg-board-card text-board-text sm:max-w-xl"
        >
          <DialogHeader className="pr-12 text-left">
            <DialogTitle>Export show data</DialogTitle>
            <DialogDescription>
              Choose a saved show by its name and date. Only the selected
              sections are included.
            </DialogDescription>
          </DialogHeader>
          <Button
            type="button"
            variant="ghost"
            aria-label="Close export dialog"
            className="absolute right-2 top-2 min-h-11 min-w-11"
            onClick={() => changeOpen(false)}
          >
            <X />
          </Button>
          <ReadFailureNotice
            error={shows.error}
            refreshing={shows.refreshing}
            retry={shows.retry}
            label="Retry loading shows"
          />
          {shows.confirmedAt === null && !shows.error ? (
            <p role="status">Loading available shows…</p>
          ) : null}
          {shows.confirmedAt !== null &&
          shows.value.length === 0 &&
          !shows.error ? (
            <p role="status">
              No saved shows with rundown items are available to export.
            </p>
          ) : null}
          {shows.value.length > 0 ? (
            <div className="space-y-2">
              <label htmlFor={selectId} className="text-sm font-medium">
                Show and date
              </label>
              <select
                id={selectId}
                value={selectedShow?.showId ?? ""}
                disabled={pending}
                onChange={(event) => {
                  setShowId(event.target.value);
                  setState({ kind: "idle" });
                }}
                className="min-h-11 w-full rounded-lg border border-board-border bg-board-bg px-3 text-sm focus-visible:outline-2 focus-visible:outline-fire-500"
              >
                {!selectedShow ? (
                  <option value="" disabled>
                    Choose an available show
                  </option>
                ) : null}
                {shows.value.map((show) => (
                  <option key={show.showId} value={show.showId}>
                    {formatServicePickerLabel({
                      name: show.name,
                      serviceDate: show.date,
                      scheduledStartTime: show.scheduledStartTime,
                    })}{" "}
                    ({show.itemCount} items)
                  </option>
                ))}
              </select>
              {!selectedShow ? (
                <p role="status" className="text-sm text-amber-200">
                  The previously selected show is no longer available. Choose
                  another show.
                </p>
              ) : null}
            </div>
          ) : null}
          <fieldset disabled={pending} className="space-y-2">
            <legend className="text-sm font-medium">File format</legend>
            <div className="flex flex-wrap gap-2">
              {(
                [
                  ["json", "JSON"],
                  ["csv", "CSV"],
                  ["xlsx", "Excel"],
                ] as const
              ).map(([value, label]) => (
                <label
                  key={value}
                  className="flex min-h-11 flex-1 cursor-pointer items-center gap-2 rounded-lg border border-board-border px-3"
                >
                  <input
                    type="radio"
                    name={`${selectId}-format`}
                    value={value}
                    checked={format === value}
                    onChange={() => {
                      setFormat(value);
                      setState({ kind: "idle" });
                    }}
                  />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset disabled={pending} className="space-y-2">
            <legend className="text-sm font-medium">Include sections</legend>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {REPORT_EXPORT_SECTIONS.map(([value, label]) => (
                <label
                  key={value}
                  className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border border-board-border px-3"
                >
                  <input
                    type="checkbox"
                    checked={sections.includes(value)}
                    onChange={(event) => {
                      setSections((previous) =>
                        event.target.checked
                          ? [...previous, value]
                          : previous.filter((section) => section !== value),
                      );
                      setState({ kind: "idle" });
                    }}
                  />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>
          {sections.length === 0 ? (
            <p role="status" className="text-sm">
              Select at least one section to download.
            </p>
          ) : null}
          {state.kind === "error" ? (
            <p role="alert" className="text-sm text-amber-200">
              The export could not be prepared. Your selections are kept. Retry
              the download.{" "}
              <time dateTime={new Date(state.at).toISOString()}>
                {new Date(state.at).toLocaleTimeString()}
              </time>
            </p>
          ) : null}
          <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={() => changeOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              className="min-h-11"
              disabled={
                pending ||
                !selectedShow ||
                sections.length === 0 ||
                shows.confirmedAt === null ||
                shows.error !== null
              }
              onClick={() => void download()}
            >
              {pending
                ? "Preparing download…"
                : state.kind === "error"
                  ? "Retry download"
                  : "Download"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      {downloadName ? (
        <p role="status" className="mt-3 break-words text-sm text-board-muted">
          Download started: {downloadName}
        </p>
      ) : null}
    </div>
  );
}
