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

/** The next Sunday strictly after today — the common case for a church. */
export function nextSunday(from: Date = new Date()): string {
  const d = new Date(Date.UTC(from.getFullYear(), from.getMonth(), from.getDate()));
  const daysAhead = (7 - d.getUTCDay()) % 7 || 7;
  d.setUTCDate(d.getUTCDate() + daysAhead);
  return d.toISOString().slice(0, 10);
}

export function PlanServiceButton({
  orgId,
  serviceDates,
  onPlanned,
}: {
  orgId: string;
  /** Existing services, newest first — the clone-from options. */
  serviceDates: string[];
  onPlanned: (serviceDate: string) => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(() => nextSunday());
  const [name, setName] = useState("");
  const [startTime, setStartTime] = useState("");
  const [copyFrom, setCopyFrom] = useState(() => serviceDates[0] ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!date) return;
    setBusy(true);
    setError(null);
    try {
      const { createNextService } = await import("@/lib/pm-actions");
      await createNextService({
        data: {
          orgId,
          serviceDate: date,
          ...(copyFrom ? { copyFrom } : {}),
          ...(name.trim() ? { name: name.trim() } : {}),
          ...(startTime ? { startTime } : {}),
        },
      });
      await router.invalidate();
      setOpen(false);
      setName("");
      setStartTime("");
      onPlanned(date);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not plan that service");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded border border-board-border/70 text-board-muted hover:text-board-text hover:border-board-border transition-colors"
      >
        <CalendarPlus className="w-3.5 h-3.5" />
        Plan a service
      </button>

      {/* Rendered in normal flow rather than as an overlay, so it cannot
          cover the countdown or readiness during a live service. */}
      {open && (
        <div className="w-full order-last mt-1 rounded-lg border border-board-border/70 bg-board-card px-4 py-3">
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
                value={copyFrom}
                onChange={(event) => setCopyFrom(event.target.value)}
                className="bg-transparent border border-board-border/70 rounded px-2 py-1 text-xs text-board-text"
              >
                <option value="">Start blank</option>
                {serviceDates.slice(0, 12).map((existing) => (
                  <option key={existing} value={existing}>
                    {new Date(`${existing}T12:00:00`).toLocaleDateString("en-US", {
                      weekday: "short",
                      month: "short",
                      day: "numeric",
                    })}
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
              onClick={() => setOpen(false)}
              className="text-xs px-2.5 py-1.5 rounded-lg text-board-muted hover:text-board-text transition-colors"
            >
              Cancel
            </button>
          </div>

          {error && <p className="text-[11px] text-red-400 mt-2">{error}</p>}
        </div>
      )}
    </>
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
