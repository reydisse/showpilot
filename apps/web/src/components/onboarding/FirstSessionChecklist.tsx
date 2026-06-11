import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Check, ChevronRight, ListChecks, X } from "lucide-react";
import { track } from "@/lib/analytics";
import {
  getFirstSessionChecklist,
  updateFirstSessionChecklist,
} from "@/lib/onboarding";

// Dismissible post-GO-LIVE checklist for the wizard runner. Renders
// nothing until the server confirms it applies; dismissal and per-item
// completion persist server-side (org/user appSetting).

const ITEMS = [
  { id: "rename-item", label: "Rename a rundown item", to: "/$slug/rundown" },
  { id: "connect-device", label: "Connect a device", to: "/$slug/dashboard/devices" },
  { id: "invite-teammate", label: "Invite a teammate", to: "/$slug/team" },
  { id: "open-board", label: "Open the kiosk / board view", to: "/$slug/board" },
] as const;

export function FirstSessionChecklist({ orgId, slug }: { orgId: string; slug: string }) {
  const [visible, setVisible] = useState(false);
  const [completed, setCompleted] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    getFirstSessionChecklist({ data: { orgId } })
      .then((state) => {
        if (cancelled) return;
        setCompleted(state.completed);
        setVisible(state.show);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  if (!visible) return null;

  const toggle = (id: string) => {
    const next = completed.includes(id)
      ? completed.filter((item) => item !== id)
      : [...completed, id];
    setCompleted(next);
    void updateFirstSessionChecklist({ data: { orgId, completed: next } }).catch(() => {});
    if (next.length === ITEMS.length) {
      track("first_session_checklist_completed", {});
    }
  };

  const dismiss = () => {
    setVisible(false);
    void updateFirstSessionChecklist({ data: { orgId, dismissed: true } }).catch(() => {});
  };

  return (
    <div className="fixed bottom-4 right-4 z-40 w-[calc(100vw-2rem)] max-w-sm rounded-2xl border border-board-border bg-board-card p-4 shadow-2xl">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-semibold text-board-text">
          <ListChecks className="h-4 w-4 text-fire-500" />
          First session checklist
        </div>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss checklist"
          className="rounded p-1 text-board-muted hover:text-board-text"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <ul className="space-y-1">
        {ITEMS.map((item) => {
          const done = completed.includes(item.id);
          return (
            <li key={item.id} className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => toggle(item.id)}
                aria-label={done ? `Mark "${item.label}" not done` : `Mark "${item.label}" done`}
                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition-colors ${
                  done
                    ? "border-green-500/40 bg-green-500/15 text-green-400"
                    : "border-board-border text-transparent hover:border-board-muted"
                }`}
              >
                <Check className="h-3.5 w-3.5" />
              </button>
              <Link
                to={item.to}
                params={{ slug }}
                className={`group flex flex-1 items-center justify-between rounded px-1 py-1 text-sm ${
                  done ? "text-board-muted line-through" : "text-board-text hover:text-fire-400"
                }`}
              >
                {item.label}
                <ChevronRight className="h-3.5 w-3.5 opacity-0 transition-opacity group-hover:opacity-100" />
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
