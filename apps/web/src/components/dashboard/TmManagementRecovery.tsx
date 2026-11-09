import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import type { TmManagementController } from "@/hooks/useTmManagement";
import type { TmDashboardLayout } from "@/lib/tm-management-contract";
const buttonClass =
  "min-h-11 min-w-11 px-3 rounded-lg border border-board-border text-sm disabled:opacity-50";
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
}: {
  control: TmManagementController;
}) {
  const [review, setReview] = useState<{
    current: TmDashboardLayout;
    desired: TmDashboardLayout;
    revision: number;
  } | null>(null);
  return (
    <div className="px-3 sm:px-6 space-y-2 text-sm break-words">
      {control.read.isError ? (
        <div role="alert" className="py-2">
          <p>{control.read.error.message}</p>
          <button
            className={buttonClass}
            disabled={control.read.isFetching}
            onClick={() => void control.read.refetch()}
          >
            Retry dashboard controls
          </button>
        </div>
      ) : null}
      {control.read.data.layoutUnknown ? (
        <p role="alert">
          The saved layout could not be read. The default arrangement is shown;
          arranging widgets will replace it.
        </p>
      ) : null}
      {(["incident", "layout"] as const).map((lane) => {
        const item = control.latest(lane);
        if (!item?.attempt) return null;
        const pending = item.status === "pending",
          failed = item.status === "error",
          result = item.result;
        if (result?.outcome === "applied") return null;
        return (
          <div
            key={lane}
            role={failed ? "alert" : "status"}
            className="py-2 border-b border-board-border"
          >
            <p>
              {item.attempt.label}:{" "}
              {pending
                ? item.attempt.mode === "review"
                  ? "Checking the saved result…"
                  : "Saving…"
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
        <div role="status" className="py-2">
          <p>
            Incident changes are saved. {control.read.data.pendingNotifications}{" "}
            notification deliveries still need confirmation.
          </p>
          {control.notifications.isError ? (
            <p role="alert">{control.notifications.error.message}</p>
          ) : null}
          <button
            className={buttonClass}
            disabled={
              control.notifications.isPending ||
              !control.read.data.canManageIncidents
            }
            onClick={() => control.notifications.mutate()}
          >
            {control.notifications.isPending
              ? "Retrying notifications…"
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
          className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl"
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
