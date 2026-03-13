import { createFileRoute } from "@tanstack/react-router";
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
  ChevronLeft,
  ChevronRight,
  Clock,
  Music,
  Heart,
  Megaphone,
  Gift,
  Layers,
  RotateCcw,
  Send,
  Copy,
  Check,
  MessageSquare,
  X,
  Monitor,
} from "lucide-react";
import { getRundownState, saveRundownItems } from "@/lib/rundown";
import { getTodayDateString } from "@/lib/utils";

type ItemType = "segment" | "song" | "prayer" | "announcement" | "offering" | "custom";
type ItemStatus = "upcoming" | "live" | "complete";

interface RundownItem {
  id: string;
  title: string;
  type: ItemType;
  duration: number;
  notes: string;
  assignee: string;
  cue: string;
  status: ItemStatus;
  sortOrder: number;
  hardStop: boolean;
}

interface TimerState {
  playback: "stop" | "play" | "pause";
  currentItemId: string | null;
  elapsed: number;
  startedAt: number | null;
}

const TYPE_CONFIG: Record<ItemType, { label: string; icon: React.ElementType; color: string }> = {
  segment: { label: "Segment", icon: Layers, color: "bg-blue-500/15 text-blue-400 border-blue-500/25" },
  song: { label: "Song", icon: Music, color: "bg-purple-500/15 text-purple-400 border-purple-500/25" },
  prayer: { label: "Prayer", icon: Heart, color: "bg-pink-500/15 text-pink-400 border-pink-500/25" },
  announcement: { label: "Announce", icon: Megaphone, color: "bg-yellow-500/15 text-yellow-400 border-yellow-500/25" },
  offering: { label: "Offering", icon: Gift, color: "bg-green-500/15 text-green-400 border-green-500/25" },
  custom: { label: "Custom", icon: Layers, color: "bg-board-border text-board-muted border-board-border" },
};

function formatDuration(ms: number): string {
  const negative = ms < 0;
  const abs = Math.abs(ms);
  const totalSeconds = Math.floor(abs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const prefix = negative ? "-" : "";
  if (hours > 0) return `${prefix}${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
  return `${prefix}${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function parseDurationInput(str: string): number {
  const parts = str.split(":").map(Number);
  if (parts.length === 2) return (parts[0] * 60 + parts[1]) * 1000;
  if (parts.length === 1) return parts[0] * 60 * 1000;
  return 300000;
}

function shiftDate(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T12:00:00");
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatDisplayDate(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

export const Route = createFileRoute("/$slug/rundown")({
  loader: async ({ context }) => {
    const today = getTodayDateString();
    const state = await getRundownState({ data: { orgId: context.orgId, serviceDate: today } });
    return { orgId: context.orgId, slug: context.slug, today, initialItems: state.items };
  },
  component: RundownPage,
});

function RundownPage() {
  const { orgId, slug, today, initialItems } = Route.useLoaderData();
  const [serviceDate, setServiceDate] = useState(today);
  const [items, setItems] = useState<RundownItem[]>(initialItems);
  const [timer, setTimer] = useState<TimerState>({
    playback: "stop", currentItemId: null, elapsed: 0, startedAt: null,
  });
  const [showAddForm, setShowAddForm] = useState(false);
  const [displayTime, setDisplayTime] = useState(0);
  const [message, setMessage] = useState("");
  const [activeMessage, setActiveMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const rafRef = useRef<number>(0);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auto-save items on change (debounced)
  const persistItems = useCallback((newItems: RundownItem[]) => {
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(() => {
      saveRundownItems({ data: { orgId, serviceDate, items: newItems } }).catch(() => {});
    }, 1000);
  }, [orgId, serviceDate]);

  const updateItems = useCallback((updater: (prev: RundownItem[]) => RundownItem[]) => {
    setItems((prev) => {
      const next = updater(prev);
      persistItems(next);
      return next;
    });
  }, [persistItems]);

  // Load rundown for new date
  const loadDate = async (date: string) => {
    setLoading(true);
    try {
      const state = await getRundownState({ data: { orgId, serviceDate: date } });
      setItems(state.items);
      // Reset timer when switching dates
      setTimer({ playback: "stop", currentItemId: null, elapsed: 0, startedAt: null });
      setDisplayTime(0);
    } catch {
      // Keep current
    }
    setLoading(false);
  };

  const handleDateChange = (days: number) => {
    const newDate = shiftDate(serviceDate, days);
    setServiceDate(newDate);
    loadDate(newDate);
  };

  // Timer animation frame
  useEffect(() => {
    const tick = () => {
      if (timer.playback === "play" && timer.startedAt) {
        setDisplayTime(timer.elapsed + (Date.now() - timer.startedAt));
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [timer.playback, timer.startedAt, timer.elapsed]);

  const currentItem = items.find((i) => i.id === timer.currentItemId);
  const remaining = currentItem ? currentItem.duration - displayTime : 0;
  const isOvertime = remaining < 0;

  const handleStart = useCallback((itemId: string) => {
    updateItems((prev) =>
      prev.map((i) =>
        i.status === "live" ? { ...i, status: "complete" as ItemStatus } :
        i.id === itemId ? { ...i, status: "live" as ItemStatus } : i
      )
    );
    setTimer({ playback: "play", currentItemId: itemId, elapsed: 0, startedAt: Date.now() });
    setDisplayTime(0);
  }, [updateItems]);

  const handlePause = useCallback(() => {
    if (timer.playback === "play" && timer.startedAt) {
      const newElapsed = timer.elapsed + (Date.now() - timer.startedAt);
      setTimer({ ...timer, playback: "pause", elapsed: newElapsed, startedAt: null });
      setDisplayTime(newElapsed);
    }
  }, [timer]);

  const handleResume = useCallback(() => {
    if (timer.playback === "pause") {
      setTimer({ ...timer, playback: "play", startedAt: Date.now() });
    }
  }, [timer]);

  const handleStop = useCallback(() => {
    updateItems((prev) =>
      prev.map((i) =>
        i.id === timer.currentItemId ? { ...i, status: "complete" as ItemStatus } : i
      )
    );
    setTimer({ playback: "stop", currentItemId: null, elapsed: 0, startedAt: null });
    setDisplayTime(0);
  }, [timer.currentItemId, updateItems]);

  const handleNext = useCallback(() => {
    const currentIdx = items.findIndex((i) => i.id === timer.currentItemId);
    if (currentIdx >= 0) {
      updateItems((prev) =>
        prev.map((i, idx) =>
          idx === currentIdx ? { ...i, status: "complete" as ItemStatus } : i
        )
      );
    }
    const nextItem = items.find((_, i) => i > currentIdx && items[i].status !== "complete");
    if (nextItem) {
      handleStart(nextItem.id);
    } else {
      handleStop();
    }
  }, [items, timer.currentItemId, handleStart, handleStop, updateItems]);

  const handleReset = useCallback(() => {
    updateItems((prev) => prev.map((i) => ({ ...i, status: "upcoming" as ItemStatus })));
    setTimer({ playback: "stop", currentItemId: null, elapsed: 0, startedAt: null });
    setDisplayTime(0);
  }, [updateItems]);

  const handleAddItem = (title: string, type: ItemType, durationStr: string, assignee: string, notes: string) => {
    const item: RundownItem = {
      id: crypto.randomUUID(),
      title, type,
      duration: parseDurationInput(durationStr),
      notes, assignee,
      cue: "",
      status: "upcoming",
      sortOrder: items.length,
      hardStop: false,
    };
    updateItems((prev) => [...prev, item]);
    setShowAddForm(false);
  };

  const handleRemoveItem = (id: string) => {
    if (timer.currentItemId === id) handleStop();
    updateItems((prev) => prev.filter((i) => i.id !== id));
  };

  const handleMoveItem = (id: string, direction: "up" | "down") => {
    updateItems((prev) => {
      const idx = prev.findIndex((i) => i.id === id);
      if (idx < 0) return prev;
      const newIdx = direction === "up" ? idx - 1 : idx + 1;
      if (newIdx < 0 || newIdx >= prev.length) return prev;
      const copy = [...prev];
      [copy[idx], copy[newIdx]] = [copy[newIdx], copy[idx]];
      return copy.map((i, sortOrder) => ({ ...i, sortOrder }));
    });
  };

  const handleSendMessage = () => {
    if (message.trim()) {
      setActiveMessage(message.trim());
      setMessage("");
    }
  };

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === "INPUT" || (e.target as HTMLElement).tagName === "TEXTAREA") return;
      if (e.key === " ") {
        e.preventDefault();
        if (timer.playback === "play") handlePause();
        else if (timer.playback === "pause") handleResume();
        else if (items.length > 0) {
          const first = items.find((i) => i.status !== "complete");
          if (first) handleStart(first.id);
        }
      }
      if (e.key === "n" || e.key === "N") handleNext();
      if (e.key === "s" || e.key === "S") handleStop();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [timer, items, handlePause, handleResume, handleStart, handleNext, handleStop]);

  const nextItem = items.find((i) => {
    const currentIdx = items.findIndex((item) => item.id === timer.currentItemId);
    return items.indexOf(i) > currentIdx && i.status !== "complete";
  });

  const totalDuration = items.reduce((sum, i) => sum + i.duration, 0);
  const completedDuration = items
    .filter((i) => i.status === "complete")
    .reduce((sum, i) => sum + i.duration, 0);

  const timerUrl = typeof window !== "undefined"
    ? `${window.location.origin}/timer/${slug}`
    : `/timer/${slug}`;

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="shrink-0 sticky top-0 z-10 bg-board-bg/80 backdrop-blur-xl border-b border-board-border px-6 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div>
              <h1 className="text-lg font-semibold text-board-text font-[family-name:var(--font-display)]">
                Rundown
              </h1>
              <p className="text-xs text-board-muted mt-0.5">
                {items.length} items · {formatDuration(totalDuration)} total
              </p>
            </div>
            {/* Date switcher */}
            <div className="flex items-center gap-1 ml-4">
              <button
                onClick={() => handleDateChange(-1)}
                className="p-1.5 rounded-lg text-board-muted hover:text-board-text hover:bg-board-border/50 transition-colors"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button
                onClick={() => { setServiceDate(today); loadDate(today); }}
                className="px-3 py-1 rounded-lg text-xs font-medium text-board-text hover:bg-board-border/50 transition-colors tabular-nums"
              >
                {formatDisplayDate(serviceDate)}
              </button>
              <button
                onClick={() => handleDateChange(1)}
                className="p-1.5 rounded-lg text-board-muted hover:text-board-text hover:bg-board-border/50 transition-colors"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* Timer kiosk link */}
            <button
              onClick={() => {
                navigator.clipboard.writeText(timerUrl);
                setCopiedUrl(true);
                setTimeout(() => setCopiedUrl(false), 2000);
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-board-muted hover:text-board-text hover:bg-board-border/50 text-xs font-medium transition-colors"
              title="Copy timer kiosk URL"
            >
              <Monitor className="w-3 h-3" />
              Kiosk
              {copiedUrl ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
            </button>
            <button
              onClick={handleReset}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-board-muted hover:text-board-text hover:bg-board-border/50 text-xs font-medium transition-colors"
            >
              <RotateCcw className="w-3 h-3" />
              Reset
            </button>
            <button
              onClick={() => setShowAddForm(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-fire-500 text-white text-xs font-medium hover:bg-fire-600 transition-colors"
            >
              <Plus className="w-3 h-3" />
              Add Item
            </button>
          </div>
        </div>
      </div>

      {/* Message bar */}
      {activeMessage && (
        <div className="shrink-0 bg-amber-500/10 border-b border-amber-500/20 px-6 py-2.5 flex items-center gap-3">
          <MessageSquare className="w-4 h-4 text-amber-400 shrink-0" />
          <p className="text-sm font-medium text-amber-300 flex-1">{activeMessage}</p>
          <button
            onClick={() => setActiveMessage("")}
            className="p-1 rounded text-amber-400 hover:text-amber-200 transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {loading ? (
        <div className="flex-1 flex items-center justify-center text-board-muted text-sm">
          Loading rundown...
        </div>
      ) : (
        <div className="flex-1 overflow-hidden flex gap-6 px-6 py-5 max-w-[1400px] mx-auto w-full">
          {/* Left: Timer + Controls + Message */}
          <div className="w-[360px] shrink-0 flex flex-col gap-4">
            {/* Timer */}
            <div className={`p-6 rounded-xl border ${isOvertime ? "bg-red-500/5 border-red-500/20" : "bg-board-card border-board-border"}`}>
              <div className="flex items-center gap-2 mb-2">
                {timer.playback === "play" ? (
                  <Play className="w-3.5 h-3.5 text-green-400 fill-green-400" />
                ) : timer.playback === "pause" ? (
                  <Pause className="w-3.5 h-3.5 text-yellow-400" />
                ) : (
                  <Square className="w-3.5 h-3.5 text-board-muted" />
                )}
                <span className="text-[11px] font-medium text-board-muted uppercase tracking-widest">
                  {timer.playback === "stop" ? "Stopped" : timer.playback === "play" ? "Playing" : "Paused"}
                </span>
                {isOvertime && (
                  <span className="text-[10px] font-bold text-red-400 uppercase tracking-wider ml-auto">Overtime</span>
                )}
              </div>

              <p className={`text-6xl font-semibold tabular-nums tracking-tight ${isOvertime ? "text-red-400" : "text-board-text"}`}>
                {currentItem ? formatDuration(remaining) : "--:--"}
              </p>

              {/* Progress bar */}
              {currentItem && (
                <div className="mt-3 h-1.5 rounded-full bg-board-border overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${isOvertime ? "bg-red-500" : "bg-fire-500"}`}
                    style={{ width: `${Math.min(100, (displayTime / currentItem.duration) * 100)}%` }}
                  />
                </div>
              )}

              {currentItem && (
                <div className="mt-3 pt-3 border-t border-board-border/40">
                  <p className="text-sm font-medium text-board-text truncate">{currentItem.title}</p>
                  <p className="text-xs text-board-muted mt-0.5">
                    Duration: {formatDuration(currentItem.duration)}
                    {currentItem.assignee && ` · ${currentItem.assignee}`}
                  </p>
                </div>
              )}

              {nextItem && (
                <p className="text-xs text-board-muted mt-2">
                  Next: <span className="text-board-text/70">{nextItem.title}</span>
                  <span className="text-board-muted/50 ml-1">({formatDuration(nextItem.duration)})</span>
                </p>
              )}
            </div>

            {/* Timer controls */}
            <div className="flex gap-2">
              {timer.playback === "play" ? (
                <button onClick={handlePause} className="flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-yellow-500/15 text-yellow-400 border border-yellow-500/25 font-medium text-sm hover:bg-yellow-500/25 transition-colors">
                  <Pause className="w-4 h-4" /> Pause
                </button>
              ) : timer.playback === "pause" ? (
                <button onClick={handleResume} className="flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-green-500/15 text-green-400 border border-green-500/25 font-medium text-sm hover:bg-green-500/25 transition-colors">
                  <Play className="w-4 h-4" /> Resume
                </button>
              ) : (
                <button
                  onClick={() => { const first = items.find((i) => i.status !== "complete"); if (first) handleStart(first.id); }}
                  disabled={items.length === 0}
                  className="flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-green-500/15 text-green-400 border border-green-500/25 font-medium text-sm hover:bg-green-500/25 transition-colors disabled:opacity-40"
                >
                  <Play className="w-4 h-4" /> Start
                </button>
              )}
              <button onClick={handleNext} disabled={timer.playback === "stop"} className="flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-board-card border border-board-border text-board-text font-medium text-sm hover:bg-board-border/50 transition-colors disabled:opacity-40">
                <SkipForward className="w-4 h-4" />
              </button>
              <button onClick={handleStop} disabled={timer.playback === "stop"} className="flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 font-medium text-sm hover:bg-red-500/20 transition-colors disabled:opacity-40">
                <Square className="w-4 h-4" />
              </button>
            </div>

            {/* Send message to stage */}
            <div className="rounded-xl border border-board-border bg-board-card p-4">
              <p className="text-[10px] font-medium text-board-muted/50 uppercase tracking-widest mb-2">
                Stage Message
              </p>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSendMessage()}
                  placeholder="Message to stage display..."
                  className="flex-1 px-3 py-2 rounded-lg bg-board-bg border border-board-border text-sm text-board-text placeholder:text-board-muted/40 focus:outline-none focus:border-fire-500/50 transition-colors"
                />
                <button
                  onClick={handleSendMessage}
                  disabled={!message.trim()}
                  className="p-2 rounded-lg bg-amber-500/15 text-amber-400 hover:bg-amber-500/25 disabled:opacity-40 transition-colors"
                >
                  <Send className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Shortcuts */}
            <div className="rounded-xl border border-board-border bg-board-card/50 p-4">
              <p className="text-[10px] font-medium text-board-muted/50 uppercase tracking-widest mb-2">Shortcuts</p>
              <div className="space-y-1 text-xs text-board-muted">
                <div className="flex justify-between"><span>Play / Pause</span><kbd className="px-1.5 py-0.5 rounded bg-board-bg border border-board-border text-[10px] font-mono">Space</kbd></div>
                <div className="flex justify-between"><span>Next item</span><kbd className="px-1.5 py-0.5 rounded bg-board-bg border border-board-border text-[10px] font-mono">N</kbd></div>
                <div className="flex justify-between"><span>Stop</span><kbd className="px-1.5 py-0.5 rounded bg-board-bg border border-board-border text-[10px] font-mono">S</kbd></div>
              </div>
            </div>
          </div>

          {/* Right: Runsheet */}
          <div className="flex-1 min-w-0 flex flex-col">
            <div className="flex items-center justify-between mb-3 shrink-0">
              <h2 className="text-[11px] font-medium text-board-muted uppercase tracking-widest">
                Runsheet ({items.length} items)
              </h2>
              {completedDuration > 0 && (
                <span className="text-[10px] text-board-muted tabular-nums">
                  {formatDuration(completedDuration)} / {formatDuration(totalDuration)} elapsed
                </span>
              )}
            </div>

            {items.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center gap-3">
                <Clock className="w-10 h-10 text-board-muted/20" />
                <p className="text-sm text-board-muted">No items in the rundown</p>
                <p className="text-xs text-board-muted/50">Click "Add Item" to build your runsheet</p>
              </div>
            ) : (
              <div className="space-y-1.5 overflow-auto flex-1 hide-scrollbar pr-1">
                {items.map((item, idx) => {
                  const isCurrent = item.id === timer.currentItemId;
                  const config = TYPE_CONFIG[item.type];
                  const Icon = config.icon;
                  const isLive = timer.playback !== "stop";

                  return (
                    <div
                      key={item.id}
                      className={`flex items-center gap-3 px-4 py-3 rounded-lg border transition-colors ${
                        isCurrent
                          ? "bg-fire-500/8 border-fire-500/25"
                          : item.status === "complete"
                            ? "bg-board-card/30 border-board-border/30 opacity-60"
                            : "bg-board-card/50 border-board-border/50 hover:border-board-border"
                      }`}
                    >
                      <div className={`w-2 h-2 rounded-full shrink-0 ${
                        item.status === "live" ? "bg-fire-500 animate-pulse" :
                        item.status === "complete" ? "bg-green-500" : "bg-board-muted/30"
                      }`} />

                      <span className={`text-[10px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded border shrink-0 ${config.color}`}>
                        <Icon className="w-3 h-3 inline -mt-0.5 mr-0.5" />
                        {config.label}
                      </span>

                      <div className="flex-1 min-w-0">
                        <p className={`text-sm font-medium truncate ${isCurrent ? "text-fire-500" : item.status === "complete" ? "text-board-muted line-through" : "text-board-text/80"}`}>
                          {item.title || "Untitled"}
                        </p>
                        <div className="flex items-center gap-2 mt-0.5">
                          {item.assignee && <span className="text-[10px] text-board-muted/60 truncate">{item.assignee}</span>}
                          {item.notes && <span className="text-[10px] text-board-muted/40 truncate">{item.notes}</span>}
                        </div>
                      </div>

                      <div className="text-right shrink-0">
                        <p className="text-xs text-board-muted tabular-nums">
                          <Clock className="w-2.5 h-2.5 inline mr-0.5 -mt-px" />
                          {formatDuration(item.duration)}
                        </p>
                      </div>

                      <div className="flex items-center gap-0.5 shrink-0">
                        {!isCurrent && item.status !== "complete" && (
                          <button onClick={() => handleStart(item.id)} className="p-1 rounded text-board-muted hover:text-green-400 transition-colors" title="Start this item">
                            <Play className="w-3 h-3" />
                          </button>
                        )}
                        {!isLive && (
                          <>
                            <button onClick={() => handleMoveItem(item.id, "up")} disabled={idx === 0} className="p-1 rounded text-board-muted hover:text-board-text transition-colors disabled:opacity-30">
                              <ChevronUp className="w-3 h-3" />
                            </button>
                            <button onClick={() => handleMoveItem(item.id, "down")} disabled={idx === items.length - 1} className="p-1 rounded text-board-muted hover:text-board-text transition-colors disabled:opacity-30">
                              <ChevronDown className="w-3 h-3" />
                            </button>
                            <button onClick={() => handleRemoveItem(item.id)} className="p-1 rounded text-board-muted hover:text-red-400 transition-colors">
                              <Trash2 className="w-3 h-3" />
                            </button>
                          </>
                        )}
                      </div>

                      {isCurrent && <div className="w-1 h-8 rounded-full bg-fire-500 shrink-0" />}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {showAddForm && <AddItemModal onAdd={handleAddItem} onClose={() => setShowAddForm(false)} />}
    </div>
  );
}

function AddItemModal({
  onAdd,
  onClose,
}: {
  onAdd: (title: string, type: ItemType, duration: string, assignee: string, notes: string) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState("");
  const [type, setType] = useState<ItemType>("segment");
  const [duration, setDuration] = useState("5:00");
  const [assignee, setAssignee] = useState("");
  const [notes, setNotes] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    onAdd(title.trim(), type, duration, assignee.trim(), notes.trim());
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-board-card border border-board-border rounded-2xl p-6 w-full max-w-md mx-4 shadow-2xl">
        <h2 className="text-lg font-semibold text-board-text mb-5">Add Rundown Item</h2>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm text-board-muted mb-1.5">Type</label>
            <div className="grid grid-cols-3 gap-2">
              {(Object.keys(TYPE_CONFIG) as ItemType[]).map((t) => {
                const config = TYPE_CONFIG[t];
                const Icon = config.icon;
                return (
                  <button key={t} type="button" onClick={() => setType(t)}
                    className={`flex items-center gap-1.5 px-2.5 py-2 rounded-lg text-xs font-medium border transition-colors ${type === t ? "bg-fire-500/15 text-fire-500 border-fire-500/25" : "text-board-muted border-board-border hover:border-board-muted/50"}`}>
                    <Icon className="w-3 h-3" />{config.label}
                  </button>
                );
              })}
            </div>
          </div>
          <div>
            <label className="block text-sm text-board-muted mb-1.5">Title</label>
            <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Worship Set" autoFocus
              className="w-full px-4 py-2.5 rounded-xl bg-board-bg border border-board-border text-board-text placeholder:text-board-muted/50 focus:outline-none focus:border-fire-500 transition-colors text-sm" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm text-board-muted mb-1.5">Duration (mm:ss)</label>
              <input type="text" value={duration} onChange={(e) => setDuration(e.target.value)} placeholder="5:00"
                className="w-full px-4 py-2.5 rounded-xl bg-board-bg border border-board-border text-board-text placeholder:text-board-muted/50 focus:outline-none focus:border-fire-500 transition-colors text-sm font-mono" />
            </div>
            <div>
              <label className="block text-sm text-board-muted mb-1.5">Assignee</label>
              <input type="text" value={assignee} onChange={(e) => setAssignee(e.target.value)} placeholder="e.g. Pastor James"
                className="w-full px-4 py-2.5 rounded-xl bg-board-bg border border-board-border text-board-text placeholder:text-board-muted/50 focus:outline-none focus:border-fire-500 transition-colors text-sm" />
            </div>
          </div>
          <div>
            <label className="block text-sm text-board-muted mb-1.5">Notes</label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Production notes..."  rows={2}
              className="w-full px-4 py-2.5 rounded-xl bg-board-bg border border-board-border text-board-text placeholder:text-board-muted/50 focus:outline-none focus:border-fire-500 transition-colors text-sm resize-none" />
          </div>
          <div className="flex gap-3 pt-2">
            <button type="button" onClick={onClose} className="flex-1 px-4 py-2.5 rounded-xl border border-board-border text-board-muted hover:bg-board-border transition-colors">Cancel</button>
            <button type="submit" disabled={!title.trim()} className="flex-1 px-4 py-2.5 rounded-xl bg-fire-500 text-white font-semibold hover:bg-fire-600 disabled:opacity-50 transition-colors">Add</button>
          </div>
        </form>
      </div>
    </div>
  );
}
