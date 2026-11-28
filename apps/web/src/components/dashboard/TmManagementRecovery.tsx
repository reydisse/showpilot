import { plainFailure } from "@showpilot/shared/ui-feedback";
import { QuietActivity } from "@/components/ui/QuietActivity";
import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import type { TmManagementController } from "@/hooks/useTmManagement";
import type { TmDashboardLayout } from "@/lib/tm-management-contract";
import { RefreshCw, TriangleAlert } from "lucide-react";
import { tmSecondary } from "./tm-a";
const buttonClass = tmSecondary;
const box = "rounded-lg border border-[var(--sa-warn)]/30 bg-[var(--sa-warn)]/[0.06] px-3.5 py-3";
const names: Record<string, string> = {
  overview: "System overview",
  "signal-path": "Stream setup",
  workspace: "Incident workspace",
  operations: "Live operations",
  prep: "Before the service",
  faults: "Incidents",
  "all-clear": "Recorded checks clear",
};
function Order({ layout }: { layout: TmDashboardLayout }) {
  return (
    <>
      <p>Sections: {layout.sections.map((id) => names[id]).join(" → ")}</p>
      <p>Widgets: {layout.main.map((id) => names[id]).join(" → ")}</p>
    </>
  );
}
export function TmManagementRecovery({
  control,
  hideLayout = false,
}: {
  control: TmManagementController;
  /** Arrange mode shows layout status in its own bar. */
  hideLayout?: boolean;
}) {
  const [review, setReview] = useState<{
    current: TmDashboardLayout;
    desired: TmDashboardLayout;
    revision: number;
  } | null>(null);
  return (
    <div className="schedule-a flex flex-col gap-2 break-words text-[13px] text-board-text empty:hidden">
      {control.read.isError && !hideLayout ? (
        <div role="alert" className={`${box} flex flex-wrap items-center gap-3`}>
          <TriangleAlert aria-hidden="true" className="h-4 w-4 shrink-0 text-[var(--sa-warn)]" />
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-[var(--sa-warn)]">{control.read.isFetching ? "Still couldn't load dashboard controls" : "Couldn't load dashboard controls"}</p>
            <p className="text-xs text-[var(--sa-ink-2)]">Incident actions and layout changes are paused. We'll keep trying every 10s.</p>
            <span className="sr-only">{plainFailure(control.read.error.message)}</span>
          </div>
          <button
            className={buttonClass}
            disabled={control.read.isFetching}
            onClick={() => void control.read.refetch()}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${control.read.isFetching ? "animate-spin motion-reduce:animate-none" : ""}`} />
            {control.read.isFetching ? "Trying again…" : "Retry dashboard controls"}
          </button>
        </div>
      ) : null}
      {control.read.data.layoutUnknown ? (
        <p role="alert" className={box}>
          The saved layout could not be read. The default arrangement is shown;
          arranging widgets will replace it.
        </p>
      ) : null}
      {(["incident", "layout"] as const).map((lane) => {
        if (lane === "layout" && hideLayout) return null;
        const item = control.latest(lane);
        if (!item?.attempt) return null;
        const pending = item.status === "pending",
          failed = item.status === "error",
          result = item.result;
        if (result?.outcome === "applied") return null;
        return (
          <div
            key={lane}
            hidden={pending}
            role={failed ? "alert" : "status"}
            className={box}
          >
            <p>
              {item.attempt.label}:{" "}
              {pending
                ? item.attempt.mode === "review"
                  ? <QuietActivity label="Checking the saved result…" />
                  : <QuietActivity label="Saving…" />
                : failed
                  ? item.error?.message
                  : result?.outcome === "conflict"
                    ? "A newer change was found. Your change was not applied."
                    : result?.outcome === "expired"
                      ? "This request expired without applying the change."
                      : "The request was cancelled before it saved."}
            </p>
            {failed ? (
              <div className="flex flex-wrap gap-2 mt-2">
                <button
                  className={buttonClass}
                  onClick={() => control.recover(lane)}
                >
                  Retry {lane} change
                </button>
                <button
                  className={buttonClass}
                  onClick={() => control.recover(lane, "review")}
                >
                  Review {lane} result
                </button>
              </div>
            ) : null}
            {result ? (
              <div className="flex flex-wrap gap-2 mt-2">
                {lane === "layout" &&
                item.attempt.command.operation.kind === "layout" ? (
                  <button
                    className={buttonClass}
                    disabled={control.unavailable}
                    onClick={() => {
                      const op = item.attempt?.command.operation;
                      if (op?.kind === "layout")
                        setReview({
                          desired: op.layout,
                          current: control.read.data.layout,
                          revision: control.read.data.layoutRevision,
                        });
                    }}
                  >
                    Compare layouts
                  </button>
                ) : null}
                <button
                  className={buttonClass}
                  onClick={() => control.dismiss(lane)}
                >
                  {lane === "layout"
                    ? "Use saved layout"
                    : "Continue with current incident"}
                </button>
              </div>
            ) : null}
          </div>
        );
      })}
      {control.read.data.pendingNotifications > 0 ||
      control.notifications.isError ? (
        <div role="status" className={`${box} flex flex-wrap items-center gap-3`}>
          <p role="alert" className="flex-1 font-semibold">Crew alerts could not be sent.</p>
          <button
            className={buttonClass}
            disabled={
              control.notifications.isPending ||
              !control.read.data.canManageIncidents
            }
            onClick={() => control.notifications.mutate()}
           aria-label={control.notifications.isPending
              ? "Retrying notifications…"
              : "Retry notifications"}>
            {control.notifications.isPending
              ? <QuietActivity label="Retrying notifications…" />
              : "Retry notifications"}
          </button>
        </div>
      ) : null}
      <Dialog
        open={review !== null}
        onOpenChange={(open) => {
          if (!open) setReview(null);
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="schedule-a max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-[14px] border-[var(--sa-border-strong)] bg-[var(--sa-surface)] text-board-text sm:max-w-xl"
        >
          <DialogTitle>Review dashboard layout</DialogTitle>
          <DialogDescription>
            Compare the saved arrangement with your retained change before
            saving again.
          </DialogDescription>
          {review ? (
            <>
              <div className="space-y-2 text-sm break-words">
                <h3 className="font-semibold">Saved arrangement</h3>
                <Order layout={review.current} />
                <h3 className="font-semibold">Your arrangement</h3>
                <Order layout={review.desired} />
              </div>
              <div className="flex flex-wrap gap-2">
                <button className={buttonClass} onClick={() => setReview(null)}>
                  Keep my draft
                </button>
                <button
                  className={buttonClass}
                  onClick={() => {
                    control.dismiss("layout");
                    setReview(null);
                  }}
                >
                  Use saved layout
                </button>
                <button
                  className={buttonClass}
                  disabled={control.unavailable}
                  onClick={() => {
                    if (
                      control.send(
                        {
                          kind: "layout",
                          expectedRevision: review.revision,
                          layout: review.desired,
                        },
                        "Arrange dashboard",
                        true,
                      )
                    )
                      setReview(null);
                  }}
                >
                  Save my layout
                </button>
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
