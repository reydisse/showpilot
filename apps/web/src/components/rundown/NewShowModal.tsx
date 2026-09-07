import { useState, type FormEvent } from "react";
import { X } from "lucide-react";

export interface NewShowInput {
  serviceDate: string;
  name: string;
  startTime: string;
  location: string;
  copyCurrent: boolean;
}

interface NewShowModalProps {
  currentDate: string;
  currentStartTime: string;
  canCopyCurrent: boolean;
  onCreate: (input: NewShowInput) => Promise<void>;
  onClose: () => void;
}

const FORM_CONTROL =
  "w-full rounded-xl border border-board-border bg-board-bg px-3 py-2.5 text-sm text-board-text outline-none focus:border-fire-500/50";

function nextStartTime(value: string): string {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return "10:00";
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return "10:00";
  const next = Math.min(hours * 60 + minutes + 60, 23 * 60 + 59);
  return `${String(Math.floor(next / 60)).padStart(2, "0")}:${String(next % 60).padStart(2, "0")}`;
}

export function NewShowModal({
  currentDate,
  currentStartTime,
  canCopyCurrent,
  onCreate,
  onClose,
}: NewShowModalProps) {
  const [serviceDate, setServiceDate] = useState(currentDate);
  const [name, setName] = useState("");
  const [startTime, setStartTime] = useState(() => nextStartTime(currentStartTime));
  const [location, setLocation] = useState("");
  const [copyCurrent, setCopyCurrent] = useState(canCopyCurrent);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await onCreate({
        serviceDate,
        name: name.trim(),
        startTime,
        location: location.trim(),
        copyCurrent,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create this show.");
    } finally {
      setPending(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-md"
      onMouseDown={(event) => {
        if (!pending && event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-show-title"
        className="w-full max-w-md rounded-2xl border border-board-border bg-board-card p-5 shadow-2xl"
      >
        <div className="mb-5 flex items-center justify-between">
          <div>
            <h2 id="new-show-title" className="text-base font-semibold text-board-text">
              New show
            </h2>
            <p className="mt-1 text-xs text-board-muted">
              Add another show without leaving the rundown.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            className="rounded-lg p-2 text-board-muted hover:bg-board-border disabled:opacity-50"
            aria-label="Close new show"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <label className="block text-xs text-board-muted">
            <span className="mb-1.5 block">Show name</span>
            <input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Evening service, rehearsal, conference session..."
              maxLength={120}
              className={FORM_CONTROL}
            />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block text-xs text-board-muted">
              <span className="mb-1.5 block">Date</span>
              <input
                type="date"
                required
                value={serviceDate}
                onChange={(event) => setServiceDate(event.target.value)}
                className={FORM_CONTROL}
              />
            </label>
            <label className="block text-xs text-board-muted">
              <span className="mb-1.5 block">Start time</span>
              <input
                type="time"
                required
                value={startTime}
                onChange={(event) => setStartTime(event.target.value)}
                className={FORM_CONTROL}
              />
            </label>
          </div>

          <label className="block text-xs text-board-muted">
            <span className="mb-1.5 block">Venue or location</span>
            <input
              value={location}
              onChange={(event) => setLocation(event.target.value)}
              placeholder="Main auditorium, Studio A..."
              maxLength={240}
              className={FORM_CONTROL}
            />
          </label>

          <label className={`flex items-center gap-2 text-xs ${canCopyCurrent ? "text-board-text" : "text-board-muted"}`}>
            <input
              type="checkbox"
              checked={copyCurrent}
              onChange={(event) => setCopyCurrent(event.target.checked)}
              disabled={!canCopyCurrent}
              className="accent-fire-500"
            />
            Copy the current rundown into this show
          </label>

          {error ? (
            <p role="alert" className="text-xs leading-relaxed text-red-300">
              {error}
            </p>
          ) : null}

          <div className="flex gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={pending}
              className="flex-1 rounded-xl border border-board-border px-4 py-2.5 text-sm text-board-muted hover:bg-board-border disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              disabled={pending || !serviceDate || !startTime}
              className="flex-1 rounded-xl bg-fire-500 px-4 py-2.5 text-sm font-semibold text-black disabled:opacity-50"
            >
              {pending ? "Creating..." : "Create show"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
