import { useState, useEffect, useCallback, useRef } from "react";
import {
  Play,
  Pause,
  Square,
  SkipForward,
  Plus,
  Trash2,
  ChevronUp,
  ChevronDown,
  Clock,
  FileText,
  Music,
  HandHeart,
  Megaphone,
  Heart,
  Layers,
  AlertCircle,
  X,
} from "lucide-react";
import { useRundown } from "@/hooks/useRundown";
import type { RundownState, ItemType } from "@/types/rundown";

// ─── Constants ────────────────────────────────────────────────

const ITEM_TYPE_CONFIG: Record<
  ItemType,
  { label: string; color: string; bg: string; icon: typeof Layers }
> = {
  segment: { label: "Segment", color: "text-blue-400", bg: "bg-blue-500/15", icon: Layers },
  song: { label: "Song", color: "text-purple-400", bg: "bg-purple-500/15", icon: Music },
  prayer: { label: "Prayer", color: "text-pink-400", bg: "bg-pink-500/15", icon: HandHeart },
  announcement: { label: "Announce", color: "text-yellow-400", bg: "bg-yellow-500/15", icon: Megaphone },
  offering: { label: "Offering", color: "text-green-400", bg: "bg-green-500/15", icon: Heart },
  custom: { label: "Custom", color: "text-gray-400", bg: "bg-gray-500/15", icon: FileText },
};

const ITEM_TYPES: ItemType[] = ["segment", "song", "prayer", "announcement", "offering", "custom"];

// ─── Formatting ───────────────────────────────────────────────

function formatDuration(ms: number): string {
  const negative = ms < 0;
  const abs = Math.abs(ms);
  const totalSeconds = Math.floor(abs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const prefix = negative ? "-" : "";
  if (hours > 0) {
    return `${prefix}${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
  }
  return `${prefix}${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function parseDurationInput(value: string): number {
  // Accept formats: "5" (minutes), "5:30" (mm:ss), "1:05:30" (h:mm:ss)
  const parts = value.split(":").map((p) => parseInt(p, 10) || 0);
  if (parts.length === 1) return parts[0] * 60 * 1000;
  if (parts.length === 2) return (parts[0] * 60 + parts[1]) * 1000;
  return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
}

// ─── Add Item Form ────────────────────────────────────────────

function AddItemForm({
  onAdd,
  onCancel,
}: {
  onAdd: (item: { title: string; type: ItemType; duration: number; notes: string; assignee: string; cue: string; hardStop: boolean }) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState("");
  const [type, setType] = useState<ItemType>("segment");
  const [durationStr, setDurationStr] = useState("5:00");
  const [notes, setNotes] = useState("");
  const [assignee, setAssignee] = useState("");
  const [cue, setCue] = useState("");
  const [hardStop, setHardStop] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    onAdd({
      title: title.trim(),
      type,
      duration: parseDurationInput(durationStr),
      notes: notes.trim(),
      assignee: assignee.trim(),
      cue: cue.trim(),
      hardStop,
    });
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-xl border border-fire-500/30 bg-board-card p-4 space-y-3"
    >
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-board-muted uppercase tracking-wider">
          New Item
        </span>
        <button
          type="button"
          onClick={onCancel}
          className="p-1 rounded hover:bg-board-bg text-board-muted hover:text-board-text transition-colors"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Title */}
      <input
        ref={titleRef}
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Item title"
        className="w-full px-3 py-2 rounded-lg bg-board-bg border border-board-border text-sm text-board-text placeholder:text-board-muted/40 focus:outline-none focus:border-fire-500/50 transition-colors"
      />

      {/* Type selector */}
      <div className="flex flex-wrap gap-1.5">
        {ITEM_TYPES.map((t) => {
          const cfg = ITEM_TYPE_CONFIG[t];
          const selected = type === t;
          return (
            <button
              key={t}
              type="button"
              onClick={() => setType(t)}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                selected
                  ? `${cfg.bg} ${cfg.color} ring-1 ring-current/30`
                  : "bg-board-bg text-board-muted hover:text-board-text"
              }`}
            >
              <cfg.icon className="w-3 h-3" />
              {cfg.label}
            </button>
          );
        })}
      </div>

      {/* Duration + Assignee row */}
      <div className="flex gap-2">
        <div className="flex-1">
          <label className="text-[10px] text-board-muted uppercase tracking-wider mb-1 block">
            Duration
          </label>
          <input
            type="text"
            value={durationStr}
            onChange={(e) => setDurationStr(e.target.value)}
            placeholder="5:00"
            className="w-full px-3 py-1.5 rounded-lg bg-board-bg border border-board-border text-sm text-board-text tabular-nums placeholder:text-board-muted/40 focus:outline-none focus:border-fire-500/50 transition-colors"
          />
        </div>
        <div className="flex-1">
          <label className="text-[10px] text-board-muted uppercase tracking-wider mb-1 block">
            Assignee
          </label>
          <input
            type="text"
            value={assignee}
            onChange={(e) => setAssignee(e.target.value)}
            placeholder="Optional"
            className="w-full px-3 py-1.5 rounded-lg bg-board-bg border border-board-border text-sm text-board-text placeholder:text-board-muted/40 focus:outline-none focus:border-fire-500/50 transition-colors"
          />
        </div>
      </div>

      {/* Cue + Notes row */}
      <div className="flex gap-2">
        <div className="flex-1">
          <label className="text-[10px] text-board-muted uppercase tracking-wider mb-1 block">
            Cue
          </label>
          <input
            type="text"
            value={cue}
            onChange={(e) => setCue(e.target.value)}
            placeholder="Optional"
            className="w-full px-3 py-1.5 rounded-lg bg-board-bg border border-board-border text-sm text-board-text placeholder:text-board-muted/40 focus:outline-none focus:border-fire-500/50 transition-colors"
          />
        </div>
        <div className="flex-1">
          <label className="text-[10px] text-board-muted uppercase tracking-wider mb-1 block">
            Notes
          </label>
          <input
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Optional"
            className="w-full px-3 py-1.5 rounded-lg bg-board-bg border border-board-border text-sm text-board-text placeholder:text-board-muted/40 focus:outline-none focus:border-fire-500/50 transition-colors"
          />
        </div>
      </div>

      {/* Hard stop + Submit */}
      <div className="flex items-center justify-between pt-1">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={hardStop}
            onChange={(e) => setHardStop(e.target.checked)}
            className="w-3.5 h-3.5 rounded border-board-border bg-board-bg accent-fire-500"
          />
          <span className="text-xs text-board-muted">Hard stop</span>
        </label>
        <button
          type="submit"
          disabled={!title.trim()}
          className="px-4 py-1.5 rounded-lg bg-fire-500 text-white text-xs font-medium disabled:opacity-40 hover:bg-fire-500/90 transition-colors"
        >
          Add Item
        </button>
      </div>
    </form>
  );
}

// ─── Rundown Item Row ─────────────────────────────────────────

function RundownItemRow({
  item,
  index,
  totalItems,
  isLive,
  isPlaying: _isPlaying,
  onStart,
  onMoveUp,
  onMoveDown,
  onRemove,
  onToggleNotes,
  showNotes,
  reorderDisabled,
}: {
  item: RundownState["items"][number];
  index: number;
  totalItems: number;
  isLive: boolean;
  isPlaying: boolean;
  onStart: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
  onToggleNotes: () => void;
  showNotes: boolean;
  reorderDisabled: boolean;
}) {
  const cfg = ITEM_TYPE_CONFIG[item.type];
  const isComplete = item.status === "complete";

  return (
    <div
      className={`group rounded-lg border transition-colors ${
        isLive
          ? "bg-fire-500/8 border-fire-500/25 shadow-[0_0_12px_rgba(255,193,7,0.06)]"
          : isComplete
            ? "bg-board-card/30 border-board-border/30"
            : "bg-board-card/50 border-board-border/50 hover:border-board-border"
      }`}
    >
      <div className="flex items-center gap-3 px-3 py-2.5">
        {/* Reorder controls */}
        <div className={`flex flex-col gap-0.5 shrink-0 ${reorderDisabled ? "opacity-20 pointer-events-none" : ""}`}>
          <button
            onClick={onMoveUp}
            disabled={index === 0 || reorderDisabled}
            className="p-0.5 rounded text-board-muted hover:text-board-text disabled:opacity-20 disabled:pointer-events-none transition-colors"
            title="Move up"
          >
            <ChevronUp className="w-3 h-3" />
          </button>
          <button
            onClick={onMoveDown}
            disabled={index === totalItems - 1 || reorderDisabled}
            className="p-0.5 rounded text-board-muted hover:text-board-text disabled:opacity-20 disabled:pointer-events-none transition-colors"
            title="Move down"
          >
            <ChevronDown className="w-3 h-3" />
          </button>
        </div>

        {/* Status dot */}
        <div
          className={`w-2 h-2 rounded-full shrink-0 ${
            isLive
              ? "bg-fire-500 shadow-[0_0_6px_rgba(255,193,7,0.5)]"
              : isComplete
                ? "bg-green-500/50"
                : "bg-board-border"
          }`}
        />

        {/* Type badge */}
        <div
          className={`flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-medium uppercase tracking-wider shrink-0 ${cfg.bg} ${cfg.color}`}
        >
          <cfg.icon className="w-2.5 h-2.5" />
          {cfg.label}
        </div>

        {/* Title */}
        <div className="flex-1 min-w-0">
          <p
            className={`text-sm font-medium truncate ${
              isLive
                ? "text-fire-500"
                : isComplete
                  ? "text-board-muted line-through"
                  : "text-board-text/80"
            }`}
          >
            {item.title}
          </p>
          {item.cue && (
            <p className="text-[10px] text-board-muted/60 font-mono truncate mt-0.5">
              CUE: {item.cue}
            </p>
          )}
        </div>

        {/* Duration */}
        <div className="text-right shrink-0">
          <p className="text-xs text-board-muted tabular-nums flex items-center gap-1">
            <Clock className="w-2.5 h-2.5" />
            {formatDuration(item.duration)}
          </p>
          {item.hardStop && (
            <p className="text-[9px] text-red-400/70 uppercase tracking-wider mt-0.5">
              Hard Stop
            </p>
          )}
        </div>

        {/* Assignee */}
        {item.assignee && (
          <span className="text-[10px] text-board-muted bg-board-bg px-2 py-0.5 rounded-full shrink-0 max-w-[80px] truncate">
            {item.assignee}
          </span>
        )}

        {/* Actions */}
        <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
          {item.notes && (
            <button
              onClick={onToggleNotes}
              className={`p-1 rounded transition-colors ${
                showNotes
                  ? "text-fire-500 bg-fire-500/10"
                  : "text-board-muted hover:text-board-text"
              }`}
              title="Toggle notes"
            >
              <FileText className="w-3.5 h-3.5" />
            </button>
          )}
          {!isLive && (
            <button
              onClick={onStart}
              className="p-1 rounded text-green-400 hover:bg-green-500/10 transition-colors"
              title="Start this item"
            >
              <Play className="w-3.5 h-3.5 fill-current" />
            </button>
          )}
          <button
            onClick={onRemove}
            className="p-1 rounded text-board-muted hover:text-red-400 hover:bg-red-500/10 transition-colors"
            title="Remove item"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Live accent bar */}
        {isLive && <div className="w-1 h-8 rounded-full bg-fire-500 shrink-0" />}
      </div>

      {/* Notes expansion */}
      {showNotes && item.notes && (
        <div className="px-3 pb-2.5 pt-0">
          <div className="pl-[52px] text-xs text-board-muted/70 bg-board-bg/50 rounded-md px-3 py-2 leading-relaxed">
            {item.notes}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── RundownPanel ─────────────────────────────────────────────

interface RundownPanelProps {
  orgId: string;
  serviceDate: string;
  initialState?: RundownState;
}

export function RundownPanel({ orgId, serviceDate, initialState }: RundownPanelProps) {
  const {
    items,
    timer,
    displayTime,
    isOvertime,
    currentItem,
    nextItem,
    addItem,
    removeItem,
    reorderItems,
    start,
    pause,
    stop,
    next,
    setTimerMode,
  } = useRundown({ orgId, serviceDate, initialState });

  const [showAddForm, setShowAddForm] = useState(false);
  const [expandedNotes, setExpandedNotes] = useState<Set<string>>(new Set());

  const isPlaying = timer.playback === "play";
  const isPaused = timer.playback === "pause";
  const isStopped = timer.playback === "stop";
  const isLive = isPlaying || isPaused;

  // ─── Keyboard shortcuts ─────────────────────────────────────

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger shortcuts when typing in inputs
      const target = e.target as HTMLElement;
      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable
      ) {
        return;
      }

      switch (e.code) {
        case "Space": {
          e.preventDefault();
          if (isPlaying) {
            pause();
          } else if (isPaused && timer.currentItemId) {
            // Resume — restart the same item from elapsed position
            start(timer.currentItemId);
          } else if (isStopped && items.length > 0) {
            start(items[0].id);
          }
          break;
        }
        case "KeyN": {
          e.preventDefault();
          next();
          break;
        }
        case "KeyS": {
          if (!e.metaKey && !e.ctrlKey) {
            e.preventDefault();
            stop();
          }
          break;
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isPlaying, isPaused, isStopped, timer.currentItemId, items, start, pause, stop, next]);

  const toggleNotes = useCallback((id: string) => {
    setExpandedNotes((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const handleAdd = useCallback(
    (item: { title: string; type: ItemType; duration: number; notes: string; assignee: string; cue: string; hardStop: boolean }) => {
      addItem(item);
      setShowAddForm(false);
    },
    [addItem],
  );

  return (
    <div className="flex flex-col h-full">
      {/* ─── Timer Display ──────────────────────────────────── */}
      <div
        className={`p-5 rounded-xl border shrink-0 mb-4 ${
          isOvertime
            ? "bg-red-500/5 border-red-500/20"
            : isLive
              ? "bg-board-card border-fire-500/20"
              : "bg-board-card border-board-border"
        }`}
      >
        {/* Playback status */}
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            {isPlaying ? (
              <Play className="w-3.5 h-3.5 text-green-400 fill-green-400" />
            ) : isPaused ? (
              <Pause className="w-3.5 h-3.5 text-yellow-400" />
            ) : (
              <Square className="w-3.5 h-3.5 text-board-muted" />
            )}
            <span className="text-[11px] font-medium text-board-muted uppercase tracking-widest">
              {isPlaying ? "Playing" : isPaused ? "Paused" : "Stopped"}
            </span>
          </div>

          {/* Timer mode toggle */}
          <button
            onClick={() =>
              setTimerMode(
                timer.mode === "count-down"
                  ? "count-up"
                  : timer.mode === "count-up"
                    ? "clock"
                    : "count-down"
              )
            }
            className="text-[10px] text-board-muted hover:text-board-text uppercase tracking-wider px-2 py-0.5 rounded bg-board-bg border border-board-border transition-colors"
          >
            {timer.mode === "count-down" ? "Countdown" : timer.mode === "count-up" ? "Count Up" : "Clock"}
          </button>
        </div>

        {/* Time display */}
        <p
          className={`text-6xl font-semibold tabular-nums tracking-tight ${
            isOvertime ? "text-red-400" : isLive ? "text-board-text" : "text-board-muted"
          }`}
        >
          {isStopped ? "--:--" : formatDuration(displayTime)}
        </p>

        {/* Overtime warning */}
        {isOvertime && (
          <div className="flex items-center gap-1.5 mt-2">
            <AlertCircle className="w-3.5 h-3.5 text-red-400" />
            <span className="text-xs text-red-400 font-medium uppercase tracking-wider">
              Overtime
            </span>
          </div>
        )}

        {/* Current item info */}
        {currentItem && (
          <div className="mt-3 pt-3 border-t border-board-border/40">
            <p className="text-sm font-medium text-board-text truncate">
              {currentItem.title}
            </p>
            <p className="text-xs text-board-muted mt-0.5">
              Duration: {formatDuration(currentItem.duration)}
              {currentItem.assignee && ` \u00b7 ${currentItem.assignee}`}
            </p>
          </div>
        )}

        {/* Next item preview */}
        {nextItem && (
          <p className="text-xs text-board-muted mt-2">
            Next:{" "}
            <span className="text-board-text/70">{nextItem.title}</span>
            <span className="text-board-muted/50 ml-1">
              ({formatDuration(nextItem.duration)})
            </span>
          </p>
        )}

        {/* Timer controls */}
        <div className="flex items-center gap-2 mt-4">
          {isPlaying ? (
            <button
              onClick={pause}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-yellow-500/15 text-yellow-400 text-xs font-medium hover:bg-yellow-500/25 transition-colors"
            >
              <Pause className="w-3.5 h-3.5" />
              Pause
            </button>
          ) : (
            <button
              onClick={() => {
                if (isPaused && timer.currentItemId) {
                  start(timer.currentItemId);
                } else if (items.length > 0) {
                  start(items[0].id);
                }
              }}
              disabled={items.length === 0}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-green-500/15 text-green-400 text-xs font-medium hover:bg-green-500/25 disabled:opacity-40 disabled:pointer-events-none transition-colors"
            >
              <Play className="w-3.5 h-3.5 fill-current" />
              {isPaused ? "Resume" : "Play"}
            </button>
          )}
          <button
            onClick={stop}
            disabled={isStopped}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-board-bg text-board-muted text-xs font-medium hover:text-board-text disabled:opacity-40 disabled:pointer-events-none border border-board-border transition-colors"
          >
            <Square className="w-3.5 h-3.5" />
            Stop
          </button>
          <button
            onClick={next}
            disabled={!nextItem}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-board-bg text-board-muted text-xs font-medium hover:text-board-text disabled:opacity-40 disabled:pointer-events-none border border-board-border transition-colors"
          >
            <SkipForward className="w-3.5 h-3.5" />
            Next
          </button>
        </div>

        {/* Keyboard shortcuts hint */}
        <p className="text-[10px] text-board-muted/40 mt-2.5">
          Space: play/pause &middot; N: next &middot; S: stop
        </p>
      </div>

      {/* ─── Runsheet Header ────────────────────────────────── */}
      <div className="flex items-center justify-between mb-3 shrink-0">
        <h2 className="text-[11px] font-medium text-board-muted uppercase tracking-widest">
          Rundown
        </h2>
        <span className="text-[10px] text-board-muted/50 tabular-nums">
          {items.length} item{items.length !== 1 ? "s" : ""}
          {items.length > 0 && (
            <> &middot; {formatDuration(items.reduce((sum, i) => sum + i.duration, 0))} total</>
          )}
        </span>
      </div>

      {/* ─── Runsheet Items ─────────────────────────────────── */}
      <div className="flex-1 min-h-0 overflow-auto hide-scrollbar space-y-1.5 pr-1">
        {items.length === 0 && !showAddForm ? (
          <div className="flex flex-col items-center justify-center gap-3 py-12">
            <Layers className="w-6 h-6 text-board-muted/30" />
            <p className="text-sm text-board-muted text-center">
              No items in the rundown
            </p>
            <button
              onClick={() => setShowAddForm(true)}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-fire-500/15 text-fire-500 text-xs font-medium hover:bg-fire-500/25 transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              Add First Item
            </button>
          </div>
        ) : (
          <>
            {items.map((item, index) => (
              <RundownItemRow
                key={item.id}
                item={item}
                index={index}
                totalItems={items.length}
                isLive={item.id === timer.currentItemId}
                isPlaying={isPlaying}
                onStart={() => start(item.id)}
                onMoveUp={() => reorderItems(index, index - 1)}
                onMoveDown={() => reorderItems(index, index + 1)}
                onRemove={() => removeItem(item.id)}
                onToggleNotes={() => toggleNotes(item.id)}
                showNotes={expandedNotes.has(item.id)}
                reorderDisabled={isLive}
              />
            ))}
          </>
        )}

        {/* Add item form / button */}
        {showAddForm ? (
          <div className="pt-1">
            <AddItemForm
              onAdd={handleAdd}
              onCancel={() => setShowAddForm(false)}
            />
          </div>
        ) : items.length > 0 ? (
          <button
            onClick={() => setShowAddForm(true)}
            className="w-full flex items-center justify-center gap-1.5 py-2.5 rounded-lg border border-dashed border-board-border/50 text-xs text-board-muted hover:text-board-text hover:border-board-border transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            Add Item
          </button>
        ) : null}
      </div>
    </div>
  );
}
