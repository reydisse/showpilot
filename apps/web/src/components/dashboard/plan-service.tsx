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

import { useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { CalendarPlus } from "lucide-react";
import { formatServicePickerLabel } from "@/lib/service-picker";

/** The next Sunday strictly after today — the common case for a church. */
export function nextSunday(from: Date = new Date()): string {
  const d = new Date(Date.UTC(from.getFullYear(), from.getMonth(), from.getDate()));
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
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="inline-flex shrink-0 items-center gap-1.5 text-xs px-2.5 py-1.5 rounded border border-board-border/70 text-board-muted hover:text-board-text hover:border-board-border transition-colors"
    >
      <CalendarPlus className="w-3.5 h-3.5" />
      Plan a service
    </button>
  );
}

export function PlanServicePanel({
  orgId,
  shows,
  onPlanned,
  onClose,
}: {
  orgId: string;
  /** Existing shows, newest first — the clone-from options. */
  shows: Array<{ id: string; serviceDate: string; name: string }>;
  onPlanned: (showId: string, serviceDate: string) => void;
  onClose: () => void;
}) {
  const router = useRouter();
  const [date, setDate] = useState(() => nextSunday());
  const [name, setName] = useState("");
  const [startTime, setStartTime] = useState("");
  const [copyFromShowId, setCopyFromShowId] = useState(() => shows[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!date) return;
    setBusy(true);
    setError(null);
    try {
      const { createNextService } = await import("@/lib/pm-actions");
      const created = await createNextService({
        data: {
          orgId,
          serviceDate: date,
          ...(copyFromShowId
            ? {
                copyFromShowId,
                copyFrom: shows.find((show) => show.id === copyFromShowId)?.serviceDate,
              }
            : {}),
          ...(name.trim() ? { name: name.trim() } : {}),
          ...(startTime ? { startTime } : {}),
        },
      });
      await router.invalidate();
      setName("");
      setStartTime("");
      onClose();
      onPlanned(created.showId, date);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not plan that service");
    } finally {
      setBusy(false);
    }
  }

  // Normal flow rather than an overlay, so it cannot cover the countdown
  // or readiness during a live service.
  return (
    <div className="rounded-lg border border-board-border/70 bg-board-card px-4 py-3">
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Date" htmlFor="plan-date">
              <input
                id="plan-date"
                type="date"
                value={date}
                onChange={(event) => setDate(event.target.value)}
                className="bg-transparent border border-board-border/70 rounded px-2 py-1 text-xs text-board-text"
              />
            </Field>

            <Field label="Name" htmlFor="plan-name">
              <input
                id="plan-name"
                type="text"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Regular service"
                maxLength={120}
                className="bg-transparent border border-board-border/70 rounded px-2 py-1 text-xs text-board-text w-[170px] placeholder:text-board-muted/50"
              />
            </Field>

            <Field label="Starts" htmlFor="plan-start">
              <input
                id="plan-start"
                type="time"
                value={startTime}
                onChange={(event) => setStartTime(event.target.value)}
                style={{ colorScheme: "dark" }}
                className="bg-transparent border border-board-border/70 rounded px-2 py-1 text-xs text-board-text tabular-nums"
              />
            </Field>

            <Field label="Based on" htmlFor="plan-copy">
              <select
                id="plan-copy"
                value={copyFromShowId}
                onChange={(event) => setCopyFromShowId(event.target.value)}
                className="bg-transparent border border-board-border/70 rounded px-2 py-1 text-xs text-board-text"
              >
                <option value="">Start blank</option>
                {shows.slice(0, 12).map((existing) => (
                  <option key={existing.id} value={existing.id}>
                    {formatServicePickerLabel(existing)}
                  </option>
                ))}
              </select>
            </Field>

            <button
              type="button"
              onClick={() => void submit()}
              disabled={busy || !date}
              className="text-xs px-3 py-1.5 rounded-lg bg-fire-500/15 border border-fire-500/30 text-fire-400 hover:bg-fire-500/25 disabled:opacity-50 transition-colors"
            >
              {busy ? "Planning…" : "Create"}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="text-xs px-2.5 py-1.5 rounded-lg text-board-muted hover:text-board-text transition-colors"
            >
              Cancel
            </button>
          </div>

      {error && <p className="text-[11px] text-red-400 mt-2">{error}</p>}
    </div>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label
        htmlFor={htmlFor}
        className="block text-[10px] uppercase tracking-[0.12em] text-board-muted mb-1"
      >
        {label}
      </label>
      {children}
    </div>
  );
}
