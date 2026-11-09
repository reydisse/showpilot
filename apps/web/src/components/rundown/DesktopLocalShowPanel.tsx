import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { useDesktopLocalShow } from "@/hooks/useDesktopLocalShow";
import { openDesktopLocalShow } from "@/lib/desktop-runtime";
import { prepareLocalShow } from "@/lib/local-show";
import {
  discardDesktopLocalShow,
  downloadLocalShowRecord,
  matchesLocalShow,
  readDesktopLocalShow,
  syncDesktopLocalShow,
  type LocalShowTarget,
} from "@/lib/desktop-local-show";

type Props = LocalShowTarget & {
  slug: string;
  cloudRevision: number;
  cloudReady: boolean;
  canControl: boolean;
  canPrepare: boolean;
};

/** Key by org/show/date at the route boundary so confirmations cannot cross shows. */
export function DesktopLocalShowPanel(props: Props) {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const alive = useRef(true);
  const latest = useRef(props);
  latest.current = props;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const local = useDesktopLocalShow(busy);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { confirm, ConfirmDialogEl } = useConfirmDialog();
  if (!local.desktop) return null;
  const { status } = local;
  const matching = status && matchesLocalShow(status, props) ? status : null;
  const cloudOwned = status?.commandSource === "cloud";
  const canReplace =
    status && ["empty", "prepared", "reconciled"].includes(status.mode);
  const blocked = busy || Boolean(local.error) || Boolean(status?.storageError);
  const run = async (work: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await work();
    } catch (cause) {
      if (alive.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "Local show action failed. Refresh its saved state before retrying.",
        );
    } finally {
      busyRef.current = false;
      if (alive.current) {
        setBusy(false);
        local.refresh();
      }
    }
  };
  const prepare = () =>
    run(async () => {
      if (status && status.mode !== "empty") {
        const approved = await confirm({
          title: "Replace the prepared local show?",
          description:
            "This replaces this computer's saved preparation. Download any synced record you want to keep first.",
          confirmLabel: "Replace preparation",
          variant: "warning",
        });
        if (!approved || !alive.current) return;
      }
      const current = latest.current;
      if (!current.cloudReady || !current.canPrepare)
        throw new Error(
          "Wait for the saved cloud rundown and check your preparation permissions.",
        );
      const before = await readDesktopLocalShow();
      if (!alive.current) return;
      if (
        before.commandSource !== "cloud" ||
        !before.installationId ||
        before.storageError ||
        !["empty", "prepared", "reconciled"].includes(before.mode)
      )
        throw new Error(
          "Finish and review the saved local show before preparing another. This computer must be the active device agent.",
        );
      if (
        status &&
        (status.mode === "empty"
          ? before.mode !== "empty"
          : before.mode === "empty" ||
            status.sessionId !== before.sessionId ||
            status.sequence !== before.sequence ||
            status.mode !== before.mode)
      )
        throw new Error(
          "The saved local show changed. Review its refreshed status before replacing it.",
        );
      const sessionId = crypto.randomUUID();
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          prepareLocalShow({
            data: {
              orgId: current.orgId,
              showId: current.showId,
              serviceDate: current.serviceDate,
              installationId: before.installationId,
              sessionId,
              expectedRevision: current.cloudRevision,
            },
          }),
          new Promise<never>((_, reject) => {
            deadline = setTimeout(
              () =>
                reject(
                  new Error(
                    "Preparation has not been confirmed. Refresh saved status before trying again.",
                  ),
                ),
              20000,
            );
          }),
        ]);
      } finally {
        clearTimeout(deadline);
      }
      const saved = await readDesktopLocalShow();
      if (
        !matchesLocalShow(saved, current) ||
        saved.sessionId !== sessionId ||
        saved.mode !== "prepared"
      )
        throw new Error(
          "This computer did not confirm the prepared show. Refresh its saved status before going offline.",
        );
      if (alive.current)
        setNotice(
          "Saved on this computer. Open local controls when you need to take over.",
        );
    });
  const sync = () =>
    run(async () => {
      if (!matching) return;
      const approved = await confirm({
        title: "Sync saved timer progress?",
        description:
          "Apply this local session only if the cloud rundown still matches its original revision, or confirm a previous successful sync. Device actions will never replay.",
        confirmLabel: "Sync timer progress",
        variant: "warning",
      });
      if (!approved || !alive.current) return;
      const current = latest.current;
      if (!current.canControl || !current.cloudReady)
        throw new Error("Reconnect and unlock rundown control before syncing.");
      const fresh = await readDesktopLocalShow();
      if (!alive.current) return;
      if (
        !matchesLocalShow(fresh, current) ||
        fresh.sessionId !== matching.sessionId ||
        fresh.sequence !== matching.sequence ||
        fresh.mode !== matching.mode
      )
        throw new Error(
          "The local session changed. Review its refreshed record before syncing.",
        );
      const result = await syncDesktopLocalShow(fresh, current);
      if (alive.current)
        setNotice(
          result.kind === "conflict"
            ? `Cloud revision ${result.revision} differs from the saved starting revision ${fresh.baseRevision}. Both versions are preserved. Download the local record to review; the cloud rundown was not replaced.`
            : "Timer progress synced. Device actions were not replayed.",
        );
    });
  const discard = () =>
    run(async () => {
      if (!matching) return;
      const approved = await confirm({
        title: "Discard this local record?",
        description:
          "Keep the cloud rundown and permanently remove this computer's saved preparation and local journal. Download the record first if you need it.",
        confirmLabel: "Discard local record",
        variant: "danger",
      });
      if (!approved || !alive.current) return;
      const fresh = await readDesktopLocalShow();
      if (!alive.current) return;
      if (
        !matchesLocalShow(fresh, latest.current) ||
        fresh.sessionId !== matching.sessionId ||
        fresh.sequence !== matching.sequence ||
        fresh.mode !== matching.mode ||
        fresh.mode === "active"
      )
        throw new Error(
          "The local session changed. Review it before discarding.",
        );
      await discardDesktopLocalShow(fresh);
      if (alive.current)
        setNotice("Local record discarded. The cloud rundown is unchanged.");
    });
  return (
    <section
      aria-label="Local show"
      className="shrink-0 border-b border-board-border bg-board-card px-4 py-3 text-sm text-board-text"
    >
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold">Local show</h2>
          {!status && !local.error && (
            <p>Reading this computer's saved show…</p>
          )}
          {status?.mode === "empty" && (
            <p>
              Prepare this rundown while connected, then run its timer and
              approved device cues locally if the connection drops.
            </p>
          )}
          {matching && (
            <p className="break-words">
              {matching.mode === "active"
                ? "Local control active"
                : matching.mode === "finished"
                  ? "Local session awaiting review"
                  : matching.mode === "reconciled"
                    ? "Local session synced"
                    : "Prepared on this computer"}{" "}
              · {matching.items.length} items · {matching.actions.length} device
              cues
            </p>
          )}
          {status && status.mode !== "empty" && !matching && (
            <p>
              A different show is saved on this computer. Review it before
              replacing the preparation.
            </p>
          )}
        </div>
        <div className="flex max-w-full flex-wrap gap-2">
          {canReplace && (
            <Button
              className="min-h-11 max-w-full h-auto whitespace-normal"
              disabled={
                blocked || !cloudOwned || !props.canPrepare || !props.cloudReady
              }
              onClick={() => void prepare()}
            >
              {busy
                ? "Working…"
                : matching
                  ? "Refresh preparation"
                  : "Prepare this show"}
            </Button>
          )}
          <Button
            variant="outline"
            className="min-h-11 max-w-full h-auto whitespace-normal"
            disabled={busy}
            onClick={() => void run(openDesktopLocalShow)}
          >
            Open local controls
          </Button>
          <Button
            variant="outline"
            className="min-h-11 max-w-full h-auto whitespace-normal"
            disabled={busy}
            onClick={local.refresh}
          >
            Refresh status
          </Button>
        </div>
      </div>
      {canReplace && !props.canPrepare && (
        <p className="mt-2">
          Preparation requires rundown control, device access, and timecode
          access.
        </p>
      )}
      {canReplace && !props.cloudReady && (
        <p className="mt-2">
          Reconnect and wait for rundown changes to finish saving before
          preparing.
        </p>
      )}
      {matching?.mode === "prepared" &&
        matching.expiresAt <= matching.serverTime && (
          <p className="mt-2 text-amber-200">
            Preparation expired. Refresh it while connected before taking local
            control.
          </p>
        )}
      {matching?.mode === "finished" && (
        <div className="mt-3 space-y-2">
          <p>
            Saved starting revision {matching.baseRevision} · Cloud revision{" "}
            {props.cloudRevision}. Sync applies timer progress only. Device cues
            stay in the local record.
          </p>
          {matching.baseRevision !== props.cloudRevision && (
            <p className="text-amber-200">
              The cloud revision changed. A guarded retry can confirm an earlier
              successful sync; otherwise both versions are kept for review.
            </p>
          )}
          <p>
            {matching.results.length} device results ·{" "}
            {
              matching.results.filter(
                (r) =>
                  r.result === "failed" ||
                  r.result === "unknown" ||
                  r.result === "pending" ||
                  r.result === "sent",
              ).length
            }{" "}
            without confirmed success
          </p>
          <Button
            className="min-h-11 max-w-full h-auto whitespace-normal"
            disabled={
              blocked || !cloudOwned || !props.cloudReady || !props.canControl
            }
            onClick={() => void sync()}
          >
            {matching.baseRevision === props.cloudRevision
              ? "Review and sync"
              : "Review and retry saved sync"}
          </Button>
        </div>
      )}
      {matching &&
        (matching.mode === "finished" || matching.mode === "reconciled") && (
          <details className="mt-2">
            <summary className="min-h-11 cursor-pointer py-3 font-medium focus-visible:outline-2">
              Review local rundown and device results
            </summary>
            <p className="mb-2">
              Local timer:{" "}
              {matching.items.find(
                (item) => item.id === matching.timer.currentItemId,
              )?.title ?? "No current item"}{" "}
              · {Math.round(matching.timer.elapsed / 1000)} seconds elapsed ·{" "}
              {matching.timer.playback === "stop" ? "Stopped" : "Held"}
            </p>
            <div className="max-h-64 overflow-y-auto rounded-lg border border-board-border p-3">
              <ul className="space-y-2" aria-label="Local rundown record">
                {matching.items.map((item) => (
                  <li key={item.id} className="flex justify-between gap-3">
                    <span className="min-w-0 break-words">{item.title}</span>
                    <span className="shrink-0">
                      {item.status === "complete"
                        ? "Complete"
                        : item.status === "live"
                          ? "Current"
                          : "Upcoming"}
                    </span>
                  </li>
                ))}
              </ul>
              {matching.results.length > 0 && (
                <ul
                  className="mt-3 space-y-2 border-t border-board-border pt-3"
                  aria-label="Local device results"
                >
                  {matching.results.map((result) => (
                    <li
                      key={result.requestId}
                      className="flex justify-between gap-3"
                    >
                      <span className="min-w-0 break-words">
                        {matching.actions.find(
                          (action) => action.id === result.actionId,
                        )?.label ?? "Device cue"}
                      </span>
                      <span className="shrink-0">
                        {result.result === "acknowledged"
                          ? "Confirmed"
                          : result.result === "sent"
                            ? "Sent, unconfirmed"
                            : result.result === "failed"
                              ? "Failed"
                              : "Unknown"}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </details>
        )}
      {matching && (
        <div className="mt-2 flex flex-wrap gap-2">
          <Button
            variant="outline"
            className="min-h-11 max-w-full h-auto whitespace-normal"
            disabled={busy}
            onClick={() =>
              void run(async () => downloadLocalShowRecord(matching))
            }
          >
            Download local record
          </Button>
          {matching.mode !== "active" && (
            <Button
              variant="outline"
              className="min-h-11 max-w-full h-auto whitespace-normal"
              disabled={blocked || !cloudOwned || !props.canControl}
              onClick={() => void discard()}
            >
              Keep cloud and discard local record
            </Button>
          )}
        </div>
      )}
      {status &&
        status.mode !== "empty" &&
        !matching &&
        status.orgId === props.orgId && (
          <Link
            className="mt-2 inline-flex min-h-11 items-center underline"
            to="/$slug/rundown"
            params={{ slug: props.slug }}
            search={{ show: status.showId, date: status.serviceDate }}
          >
            Review saved show's rundown
          </Link>
        )}
      {(error || local.error || status?.storageError) && (
        <p role="alert" className="mt-2 break-words text-red-300">
          {error || local.error || status?.storageError}
        </p>
      )}
      {notice && (
        <p role="status" className="mt-2 break-words">
          {notice}
        </p>
      )}
      {ConfirmDialogEl}
    </section>
  );
}
