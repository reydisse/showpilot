import { workspaceCopy } from "@showpilot/shared";
import { useTerms as useWorkspaceTerms } from "@/components/workspace/WorkspaceProvider";
/**
 * Plan a service, from the dashboard.
 *
 * The dashboard is where a production manager *decides* to plan; the
 * rundown editor is where they do the detail work. Until now the
 * decision had no home — you had to open the rundown, step to a date,
 * and come back. This puts the four things that make a service exist
 * (when, what it is called, when it starts, what it is based on) in one
 * place, then drops you on that service.
 */

import { ShowCreationForm } from "@/components/shows/ShowCreationForm";
import { getDeviceTimeZone } from "@/hooks/useDeviceTimeZone";
import { useRouter } from "@tanstack/react-router";
import { CalendarPlus } from "lucide-react";

/** The next Sunday strictly after today — the common case for a church. */
export function nextSunday(from: Date = new Date()): string {
  const d = new Date(
    Date.UTC(from.getFullYear(), from.getMonth(), from.getDate()),
  );
  const daysAhead = (7 - d.getUTCDay()) % 7 || 7;
  d.setUTCDate(d.getUTCDate() + daysAhead);
  return d.toISOString().slice(0, 10);
}

/**
 * The trigger and the panel are separate so the header row can be a
 * single non-wrapping scroller: the button rides inside it, the panel
 * renders full width beneath. Open state therefore lives with the
 * caller.
 */
export function PlanServiceButton({
  open,
  onToggle,
}: {
  open: boolean;
  onToggle: () => void;
}) {
  const workspaceTerms = useWorkspaceTerms();
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="inline-flex min-h-11 shrink-0 items-center gap-1.5 text-xs px-2.5 py-1.5 rounded border border-board-border/70 text-board-muted hover:text-board-text hover:border-board-border transition-colors"
    >
      <CalendarPlus className="w-3.5 h-3.5" />
      {workspaceCopy("\n      Plan a service\n    ", workspaceTerms)}
    </button>
  );
}

export function PlanServicePanel({
  orgId,
  userId,
  shows,
  onPlanned,
  onClose,
}: {
  orgId: string;
  userId: string;
  shows: Array<{ id: string; serviceDate: string; name: string }>;
  onPlanned: (showId: string, serviceDate: string) => void | Promise<void>;
  onClose: () => void;
}) {
  const router = useRouter();
  return (
    <div className="rounded-lg border border-board-border bg-board-card px-4 py-3 max-w-2xl max-h-[70dvh] overflow-y-auto">
      <ShowCreationForm
        scope={{ orgId, userId, entry: "dashboard-plan" }}
        shows={shows.slice(0, 12)}
        onClose={onClose}
        initial={{
          serviceDate: nextSunday(),
          name: "",
          startTime: "",
          callTime: "",
          location: "",
          timeZone: getDeviceTimeZone(),
          source: shows[0] ? { kind: "show", ...shows[0] } : { kind: "blank" },
        }}
        onCreated={async (result, signal) => {
          await router.invalidate();
          signal.throwIfAborted();
          if (router.state.matches.some((match) => match.status === "error"))
            throw new Error(
              "The show was created, but the dashboard could not refresh.",
            );
          await onPlanned(result.showId, result.serviceDate);
          signal.throwIfAborted();
          onClose();
        }}
      />
    </div>
  );
}
