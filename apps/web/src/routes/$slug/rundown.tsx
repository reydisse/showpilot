import { createFileRoute } from "@tanstack/react-router";
import { PageSkeleton } from "@/components/ui/Skeleton";
import { useState, useEffect, useCallback, useRef } from "react";
import {
  Play,
  Pause,
  Square,
  SkipForward,
  SkipBack,
  Plus,
  Minus,
  Pencil,
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
  FolderOpen,
  Save,
  Calendar,
  FileText,
  Tv,
  Wifi,
  WifiOff,
} from "lucide-react";
import {
  getRundownState,
  saveRundownItems,
  saveRundownTimer,
  saveRundownMessage,
  saveProPresenterSlide,
  sendProPresenterCommand,
  listSavedRundowns,
  saveRundownTemplate,
  loadSavedRundown,
  deleteSavedRundown,
  listRundownDates,
} from "@/lib/rundown";
import type { SavedRundownMeta, PPSlidePayload } from "@/lib/rundown";
import type { NativeTimerState } from "@/types/rundown";
import { getTodayDateString } from "@/lib/utils";
import { useProPresenter } from "@/hooks/useProPresenter";
import { getOrgSettings } from "@/lib/settings";
import { useRundownSync } from "@/hooks/useRundownSync";

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

/** Parse duration for item creation — bare number = minutes (e.g. "5" → 5 min) */
function parseDurationInput(str: string): number {
  const trimmed = str.trim();
  if (!trimmed) return 300000;
  const parts = trimmed.split(":").map(Number);
  if (parts.length === 3 && parts.every((n) => !isNaN(n))) return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
  if (parts.length === 2 && parts.every((n) => !isNaN(n))) return (parts[0] * 60 + parts[1]) * 1000;
  if (parts.length === 1 && !isNaN(parts[0])) return parts[0] * 60 * 1000;
  return 300000;
}

/** Parse time adjustment — bare number = seconds (e.g. "30" → 30s), colon = m:ss */
function parseAdjustInput(str: string): number {
  const trimmed = str.trim();
  if (!trimmed) return 0;
  const parts = trimmed.split(":").map(Number);
  if (parts.length === 2 && parts.every((n) => !isNaN(n))) return (parts[0] * 60 + parts[1]) * 1000;
  if (parts.length === 1 && !isNaN(parts[0])) return parts[0] * 1000;
  return 0;
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

function formatOffset(deltaMs: number): string {
  if (Math.abs(deltaMs) < 1000) return "";
  const negative = deltaMs < 0;
  const abs = Math.abs(deltaMs);
  const totalSeconds = Math.floor(abs / 1000);
  if (totalSeconds < 60) return `${negative ? "-" : "+"}${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (seconds === 0) return `${negative ? "-" : "+"}${minutes}m`;
  return `${negative ? "-" : "+"}${minutes}m${seconds}s`;
}

/** Build a NativeTimerState from local state for DB persistence */
function buildNativeTimer(
  playback: "stop" | "play" | "pause",
  currentItemId: string | null,
  elapsed: number,
  startedAt: number | null,
  mode: "count-down" | "count-up" | "clock" = "count-down",
): NativeTimerState {
  return {
    playback,
    currentItemId,
    elapsed,
    startedAt,
    pausedAt: playback === "pause" ? Date.now() : null,
    mode,
    serverTime: Date.now(),
  };
}

export const Route = createFileRoute("/$slug/rundown")({
  pendingComponent: () => <PageSkeleton />,
  loader: async ({ context }) => {
    const today = getTodayDateString();
    const [state, settings] = await Promise.all([
      getRundownState({ data: { orgId: context.orgId, serviceDate: today } }),
      getOrgSettings({ data: { orgId: context.orgId } }),
    ]);
    return { orgId: context.orgId, slug: context.slug, today, initialState: state, settings };
  },
  component: RundownPage,
});

function RundownPage() {
  const { orgId, slug, today, initialState, settings } = Route.useLoaderData();
  const [serviceDate, setServiceDate] = useState(today);
  const defaultCountdownMinutes = Number(settings["default-countdown-minutes"] || "5") || 5;
  const defaultItemDuration = `${defaultCountdownMinutes}:00`;
  const defaultTimerModeSetting = settings["default-timer-mode"] || "countdown";
  const overtimeBehavior = settings["overtime-behavior"] || "flash";
  const defaultTimerMode =
    defaultTimerModeSetting === "countup"
      ? "count-up"
      : defaultTimerModeSetting === "clock"
        ? "clock"
        : "count-down";

  // Real-time sync via RundownRelay Durable Object
  const {
    items: syncedItems,
    timer: syncedTimer,
    connected: syncConnected,
    hydrated: syncHydrated,
    ppPreviewSlide: syncedPpSlide,
    sendCommand,
    seedState,
  } = useRundownSync(orgId);

  // Local state — source of truth for rendering
  const [items, setItems] = useState<RundownItem[]>(initialState.items as RundownItem[]);
  const [timer, setTimer] = useState<{
    playback: "stop" | "play" | "pause";
    currentItemId: string | null;
    elapsed: number;
    startedAt: number | null;
    mode: "count-down" | "count-up" | "clock";
  }>({
    playback: initialState.timer.playback,
    currentItemId: initialState.timer.currentItemId,
    elapsed: initialState.timer.elapsed,
    startedAt: initialState.timer.startedAt,
    mode: initialState.timer.mode,
  });

  // Seed DO when we first connect and it's empty — push current items to DO
  // so all other devices get them via broadcast.
  // IMPORTANT: wait for hydrated=true so we know the DO has actually responded,
  // not just that the WS connected (syncedItems would still be [] before hydrate).
  const hasSeededRef = useRef(false);
  // Track which date we last seeded for — reset when date changes
  const seededDateRef = useRef(serviceDate);
  useEffect(() => {
    if (seededDateRef.current !== serviceDate) {
      hasSeededRef.current = false;
      seededDateRef.current = serviceDate;
    }
  }, [serviceDate]);
  useEffect(() => {
    if (!syncHydrated) return; // Wait for actual DO response
    if (hasSeededRef.current) return; // Only seed once per date
    // If DO is empty but we have local items (from DB), seed the DO
    if (syncedItems.length === 0 && items.length > 0) {
      hasSeededRef.current = true;
      seedState(items as RundownItem[], {
        playback: timer.playback,
        currentItemId: timer.currentItemId,
        elapsed: timer.elapsed,
        startedAt: timer.startedAt,
        pausedAt: null,
        mode: "count-down",
      });
    } else if (syncedItems.length > 0) {
      // DO already has items — no need to seed
      hasSeededRef.current = true;
    }
  }, [syncHydrated, syncedItems.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const [showAddForm, setShowAddForm] = useState(false);
  const [editingItem, setEditingItem] = useState<RundownItem | null>(null);
  const [showLoadModal, setShowLoadModal] = useState(false);
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [message, setMessage] = useState("");
  const [activeMessage, setActiveMessage] = useState("");
  const [messagePriority, setMessagePriority] = useState(false);
  const [loading, setLoading] = useState(false);

  // Sync: accept DO state as source of truth, but ONLY after hydration.
  // Skip during date loads — loadDate() sets items directly and we don't
  // want stale DO broadcasts to overwrite the freshly loaded date.
  const loadingRef = useRef(false);
  loadingRef.current = loading;
  useEffect(() => {
    if (!syncHydrated) return;
    if (loadingRef.current) return; // Date load in progress — don't overwrite
    setItems(syncedItems as RundownItem[]);
    setTimer({
      playback: syncedTimer.playback,
      currentItemId: syncedTimer.currentItemId,
      elapsed: syncedTimer.elapsed,
      startedAt: syncedTimer.startedAt,
      mode: syncedTimer.mode,
    });
  }, [syncHydrated, syncedItems, syncedTimer]);

  const [copiedUrl, setCopiedUrl] = useState(false);
  const [customAdjust, setCustomAdjust] = useState("1:00");
  const [progressReset, setProgressReset] = useState(false);
  const [ppEnabled, setPpEnabled] = useState(false);
  const [ppHost, setPpHost] = useState("");
  const [ppPort, setPpPort] = useState(50001);
  const [ppPassword, setPpPassword] = useState("");
  const [ppApiPort, setPpApiPort] = useState(0);
  const [ppCuesEnabled, setPpCuesEnabled] = useState(false);
  const [ppCmdError, setPpCmdError] = useState("");
  const [ppCurrentSlide, setPpCurrentSlide] = useState<PPSlidePayload | null>(null);
  const rafRef = useRef<number>(0);
  const prevItemIdRef = useRef<string | null>(null);
  const saveItemsTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const timerRef = useRef(timer);
  const itemsRef = useRef(items);
  const progressResetRef = useRef(false);

  // Load PP settings from org config
  useEffect(() => {
    getOrgSettings({ data: { orgId } }).then((settings) => {
      const host = settings["propresenter-host"] || "";
      const port = parseInt(settings["propresenter-port"] || "50001", 10);
      const pwd = settings["propresenter-password"] || "";
      const apiPort = parseInt(settings["propresenter-api-port"] || "0", 10);
      const cues = settings["propresenter-send-cues"] === "true";
      setPpHost(host);
      setPpPort(port);
      setPpPassword(pwd);
      setPpApiPort(apiPort);
      setPpCuesEnabled(cues);
    }).catch(() => {});
  }, [orgId]);

  // PP slide preview — direct ProPresenter connection updates local preview only.
  const handlePPSlideChange = useCallback((slide: import("@/lib/propresenter-client").PPSlideData | null) => {
    if (!slide || !slide.text) {
      setPpCurrentSlide(null);
      return;
    }
    const trimmedText = slide.text.trim();
    if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(trimmedText)) return;
    if (/^[\d:.\-\s]+$/.test(trimmedText)) return;
    if (trimmedText.length < 3) return;
    const payload: PPSlidePayload = {
      text: slide.text,
      notes: slide.notes,
      presentationName: slide.presentationName,
      isScripture: slide.isScripture,
      updatedAt: Date.now(),
    };
    setPpCurrentSlide(payload);
  }, []);

  // ProPresenter direct connection (works on local network / dev only)
  const pp = useProPresenter({
    host: ppHost,
    port: ppPort,
    apiPort: ppApiPort || undefined,
    password: ppPassword,
    enabled: ppEnabled,
    onSlideChange: handlePPSlideChange,
  });

  // Use gateway bridge slide (from DO) as primary, direct connection as fallback
  const activePpSlide: PPSlidePayload | null = syncedPpSlide ?? ppCurrentSlide;

  // When streaming is enabled, keep kiosk synced to the active slide.
  useEffect(() => {
    if (!ppEnabled) return;
    saveProPresenterSlide({ data: { orgId, serviceDate, slide: activePpSlide ?? null } }).catch(() => {});
  }, [activePpSlide, ppEnabled, orgId, serviceDate]);

  // PP is "connected" if gateway bridge is sending slides OR direct connection works
  const ppIsConnected = syncedPpSlide !== null || pp.status === "connected";
  const ppSource = syncedPpSlide !== null ? "bridge" : pp.status === "connected" ? "direct" : null;

  const togglePP = useCallback(() => {
    if (ppEnabled) {
      setPpEnabled(false);
      setPpCurrentSlide(null);
      saveProPresenterSlide({ data: { orgId, serviceDate, slide: null } }).catch((e) => console.warn("[SP] PP slide clear failed:", e));
    } else {
      setPpEnabled(true);
    }
  }, [ppEnabled, orgId, serviceDate]);

  const showOnKiosk = useCallback(() => {
    const slide = syncedPpSlide ?? ppCurrentSlide;
    if (!slide) return;
    saveProPresenterSlide({ data: { orgId, serviceDate, slide } }).catch((e) => console.warn("[SP] PP slide persist failed:", e));
  }, [orgId, serviceDate, ppCurrentSlide, syncedPpSlide]);

  // Persist timer to DB immediately (not debounced — kiosk needs it fast)
  const persistTimer = useCallback((
    playback: "stop" | "play" | "pause",
    currentItemId: string | null,
    elapsed: number,
    startedAt: number | null,
    mode?: "count-down" | "count-up" | "clock",
  ) => {
    const native = buildNativeTimer(playback, currentItemId, elapsed, startedAt, mode ?? timerRef.current.mode);
    saveRundownTimer({ data: { orgId, serviceDate, timer: native } }).catch((e) => console.warn("[SP] Timer persist failed:", e));
  }, [orgId, serviceDate]);

  // Auto-save items on change (debounced)
  const persistItems = useCallback((newItems: RundownItem[]) => {
    if (saveItemsTimeoutRef.current) clearTimeout(saveItemsTimeoutRef.current);
    saveItemsTimeoutRef.current = setTimeout(() => {
      saveRundownItems({ data: { orgId, serviceDate, items: newItems } }).catch((e) => console.warn("[SP] Items persist failed:", e));
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
      setItems(state.items as RundownItem[]);
      setTimer({
        playback: state.timer.playback,
        currentItemId: state.timer.currentItemId,
        elapsed: state.timer.elapsed,
        startedAt: state.timer.startedAt,
      });
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

  // Keep refs in sync for RAF access
  timerRef.current = timer;
  itemsRef.current = items;
  progressResetRef.current = progressReset;

  // RAF: unconditionally tick `now` every frame for smooth timer + progress bar
  useEffect(() => {
    let running = true;
    const tick = () => {
      if (!running) return;
      const n = Date.now();
      setNow(n);

      // Direct DOM update for progress bars — sole owner of width
      const t = timerRef.current;
      const ci = t.currentItemId ? itemsRef.current.find((i) => i.id === t.currentItemId) : null;
      const bars = [
        document.getElementById("rundown-progress-fill"),
        document.getElementById("rundown-item-progress"),
      ];
      for (const bar of bars) {
        if (!bar) continue;
        if (progressResetRef.current) {
          bar.style.transition = "width 0.3s ease-out";
          bar.style.width = "0%";
        } else {
          bar.style.transition = "none";
          if (ci && ci.duration > 0) {
            const el = t.playback === "play" && t.startedAt
              ? t.elapsed + (n - t.startedAt)
              : t.elapsed;
            const pct = Math.min(100, (el / ci.duration) * 100);
            bar.style.width = `${pct}%`;
          }
        }
      }

      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { running = false; cancelAnimationFrame(rafRef.current); };
  }, []);

  // Compute elapsed inline from `now` — drives both countdown and progress bar
  const currentItem = items.find((i) => i.id === timer.currentItemId);
  const elapsed = timer.playback === "play" && timer.startedAt
    ? timer.elapsed + (now - timer.startedAt)
    : timer.elapsed;
  const remaining = currentItem ? currentItem.duration - elapsed : 0;
  const isOvertime = remaining < 0 && overtimeBehavior !== "stop";
  const isWarning = !isOvertime && remaining <= 120000; // ≤2 minutes

  // Detect item change for progress bar reset animation
  // progressReset=true → animate shrink to 0, then after 350ms start filling
  useEffect(() => {
    if (timer.currentItemId && timer.currentItemId !== prevItemIdRef.current) {
      setProgressReset(true);
      const t = setTimeout(() => setProgressReset(false), 350);
      prevItemIdRef.current = timer.currentItemId;
      return () => clearTimeout(t);
    }
    prevItemIdRef.current = timer.currentItemId;
  }, [timer.currentItemId]);

  const handleStart = useCallback((itemId: string) => {
    // Optimistic local update
    setItems((prev) =>
      prev.map((i) =>
        i.status === "live" ? { ...i, status: "complete" as ItemStatus } :
        i.id === itemId ? { ...i, status: "live" as ItemStatus } : i
      )
    );
    const startNow = Date.now();
     setTimer({ playback: "play", currentItemId: itemId, elapsed: 0, startedAt: startNow, mode: timer.mode });
    // Sync to DO + persist to DB
    sendCommand("timer-start", { itemId });
    persistTimer("play", itemId, 0, startNow);
  }, [sendCommand, persistTimer]);

  const handlePause = useCallback(() => {
    if (timer.playback === "play" && timer.startedAt) {
      const newElapsed = timer.elapsed + (Date.now() - timer.startedAt);
       setTimer({ ...timer, playback: "pause", elapsed: newElapsed, startedAt: null });
      sendCommand("timer-pause");
      persistTimer("pause", timer.currentItemId, newElapsed, null);
    }
  }, [timer, sendCommand, persistTimer]);

  const handleResume = useCallback(() => {
    if (timer.playback === "pause") {
      const resumeNow = Date.now();
       setTimer({ ...timer, playback: "play", startedAt: resumeNow });
      sendCommand("timer-resume");
      persistTimer("play", timer.currentItemId, timer.elapsed, resumeNow);
    }
  }, [timer, sendCommand, persistTimer]);

  const handleStop = useCallback(() => {
    setItems((prev) =>
      prev.map((i) =>
        i.id === timer.currentItemId ? { ...i, status: "complete" as ItemStatus } : i
      )
    );
     setTimer({ playback: "stop", currentItemId: null, elapsed: 0, startedAt: null, mode: timer.mode });
    sendCommand("timer-stop");
    persistTimer("stop", null, 0, null, resetTimer.mode);
  }, [timer.currentItemId, sendCommand, persistTimer]);

  const handleNext = useCallback(() => {
    // Local optimistic update
    const currentIdx = items.findIndex((i) => i.id === timer.currentItemId);
    if (currentIdx >= 0) {
      setItems((prev) =>
        prev.map((i, idx) =>
          idx === currentIdx ? { ...i, status: "complete" as ItemStatus } : i
        )
      );
    }
    const nextItem = items.find((_, i) => i > currentIdx && items[i].status !== "complete");
    if (nextItem) {
      setItems((prev) =>
        prev.map((i) =>
          i.id === nextItem.id ? { ...i, status: "live" as ItemStatus } : i
        )
      );
      const startNow = Date.now();
       setTimer({ playback: "play", currentItemId: nextItem.id, elapsed: 0, startedAt: startNow, mode: timer.mode });
      persistTimer("play", nextItem.id, 0, startNow);
    } else {
       setTimer({ playback: "stop", currentItemId: null, elapsed: 0, startedAt: null, mode: timer.mode });
      persistTimer("stop", null, 0, null);
    }
    // Single DO command — DO handles the advance logic
    sendCommand("timer-next");
  }, [items, timer.currentItemId, sendCommand, persistTimer]);

  const handlePrev = useCallback(() => {
    const currentIdx = items.findIndex((i) => i.id === timer.currentItemId);
    if (currentIdx > 0) {
      const prevItem = items[currentIdx - 1];
      // Local optimistic update — reset current to upcoming, start previous
      setItems((prev) =>
        prev.map((i, idx) =>
          idx === currentIdx ? { ...i, status: "upcoming" as ItemStatus } :
          i.id === prevItem.id ? { ...i, status: "live" as ItemStatus } : i
        )
      );
      const startNow = Date.now();
       setTimer({ playback: "play", currentItemId: prevItem.id, elapsed: 0, startedAt: startNow, mode: timer.mode });
      sendCommand("timer-prev");
      persistTimer("play", prevItem.id, 0, startNow);
    }
  }, [items, timer.currentItemId, sendCommand, persistTimer]);

  const handleReset = useCallback(() => {
    updateItems((prev) => prev.map((i) => ({ ...i, status: "upcoming" as ItemStatus })));
     setTimer({ playback: "stop", currentItemId: null, elapsed: 0, startedAt: null, mode: timer.mode });
    sendCommand("reset");
    persistTimer("stop", null, 0, null);
  }, [updateItems, sendCommand, persistTimer]);

  // Add or subtract time from the running timer (like OnTime's +/- buttons)
  // Positive deltaMs = add time (reduce elapsed, giving more remaining)
  // Negative deltaMs = subtract time (increase elapsed, giving less remaining)
  const handleAdjustTime = useCallback((deltaMs: number) => {
    if (timer.playback === "stop") return;

    if (timer.playback === "play" && timer.startedAt) {
      const currentElapsed = timer.elapsed + (Date.now() - timer.startedAt);
      const newElapsed = currentElapsed - deltaMs; // Allow negative = extra time added
      const adjustNow = Date.now();
      setTimer({ ...timer, elapsed: newElapsed, startedAt: adjustNow });
      persistTimer("play", timer.currentItemId, newElapsed, adjustNow);
    } else if (timer.playback === "pause") {
      const newElapsed = timer.elapsed - deltaMs;
      setTimer({ ...timer, elapsed: newElapsed });
      persistTimer("pause", timer.currentItemId, newElapsed, null);
    }
    // Sync to DO → broadcasts to all clients and kiosk
    sendCommand("timer-adjust", { deltaMs });
  }, [timer, persistTimer, sendCommand]);

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
    sendCommand("add-item", item as unknown as Record<string, unknown>);
    updateItems((prev) => [...prev, item]);
    setShowAddForm(false);
  };

  const handleRemoveItem = (id: string) => {
    if (timer.currentItemId === id) handleStop();
    sendCommand("remove-item", { id });
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
      const reordered = copy.map((i, sortOrder) => ({ ...i, sortOrder }));
      sendCommand("reorder", { order: reordered.map((i) => i.id) });
      return reordered;
    });
  };

  const handleEditItem = (id: string, title: string, type: ItemType, durationStr: string, assignee: string, notes: string) => {
    const updates = { title, type, duration: parseDurationInput(durationStr), assignee, notes };
    sendCommand("update-item", { id, updates });
    updateItems((prev) =>
      prev.map((i) =>
        i.id === id ? { ...i, ...updates } : i
      )
    );
    setEditingItem(null);
  };

  // Load items into current date (from a previous date or saved template)
  const handleLoadItems = useCallback((loadedItems: RundownItem[]) => {
    const fresh = loadedItems.map((item, idx) => ({
      ...item,
      id: crypto.randomUUID(),
      status: "upcoming" as ItemStatus,
      sortOrder: idx,
    }));
    const resetTimer = { playback: "stop" as const, currentItemId: null, elapsed: 0, startedAt: null, pausedAt: null, mode: defaultTimerMode as "count-down" | "count-up" | "clock" };
    setItems(fresh);
    setTimer(resetTimer);
    // Seed DO with loaded items so all devices get them
    sendCommand("seed", { items: fresh, timer: resetTimer, force: true });
    persistItems(fresh);
    persistTimer("stop", null, 0, null);
    setShowLoadModal(false);
  }, [sendCommand, persistItems, persistTimer, defaultTimerMode]);

  const handleSaveTemplate = useCallback(async (name: string) => {
    await saveRundownTemplate({ data: { orgId, name, items } });
    setShowSaveModal(false);
  }, [orgId, items]);

  const handleSendMessage = () => {
    if (message.trim()) {
      setActiveMessage(message.trim());
      // Encode priority flag into message string for kiosk
      const encoded = messagePriority ? `!!PRIORITY!!${message.trim()}` : message.trim();
      saveRundownMessage({ data: { orgId, serviceDate, message: encoded } }).catch((e) => console.warn("[SP] Message persist failed:", e));
    }
  };

  const handleClearMessage = () => {
    setActiveMessage("");
    setMessagePriority(false);
    saveRundownMessage({ data: { orgId, serviceDate, message: "" } }).catch((e) => console.warn("[SP] Message clear failed:", e));
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
      if (e.key === "p" || e.key === "P") handlePrev();
      if (e.key === "s" || e.key === "S") handleStop();
      if (e.key === "+" || e.key === "=") handleAdjustTime(60_000);
      if (e.key === "-" || e.key === "_") handleAdjustTime(-60_000);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [timer, items, handlePause, handleResume, handleStart, handleNext, handlePrev, handleStop, handleAdjustTime]);

  const nextItem = items.find((i) => {
    const currentIdx = items.findIndex((item) => item.id === timer.currentItemId);
    return items.indexOf(i) > currentIdx && i.status !== "complete";
  });

  const totalDuration = items.reduce((sum, i) => sum + i.duration, 0);
  const completedDuration = items
    .filter((i) => i.status === "complete")
    .reduce((sum, i) => sum + i.duration, 0);

  const remainingDuration = totalDuration - completedDuration;

  const timerUrl = typeof window !== "undefined"
    ? `${window.location.origin}/timer/${slug}`
    : `/timer/${slug}`;

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="shrink-0 sticky top-0 z-10 bg-board-bg/80 backdrop-blur-xl border-b border-board-border px-4 md:px-6 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-3 md:gap-4">
            <div>
              <h1 className="text-base md:text-lg font-semibold text-board-text font-[family-name:var(--font-display)]">
                Rundown
              </h1>
              <p className="text-[10px] md:text-xs text-board-muted mt-0.5">
                {items.length} items · {formatDuration(totalDuration)} total
              </p>
            </div>
            {/* Date switcher */}
            <div className="flex items-center gap-1 ml-2 md:ml-4">
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
          <div className="flex flex-wrap items-center gap-1.5 md:gap-2">
            {/* Timer kiosk link */}
            <button
              onClick={() => {
                navigator.clipboard.writeText(timerUrl);
                setCopiedUrl(true);
                setTimeout(() => setCopiedUrl(false), 2000);
              }}
              className="hidden md:flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-board-muted hover:text-board-text hover:bg-board-border/50 text-xs font-medium transition-colors min-h-[44px] md:min-h-0"
              title="Copy timer kiosk URL"
            >
              <Monitor className="w-3 h-3" />
              Kiosk
              {copiedUrl ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
            </button>
            <button
              onClick={() => setShowLoadModal(true)}
              className="flex items-center gap-1.5 px-3 py-2 md:py-1.5 rounded-lg text-board-muted hover:text-board-text hover:bg-board-border/50 text-xs font-medium transition-colors min-h-[44px] md:min-h-0"
              title="Load from previous date or saved template"
            >
              <FolderOpen className="w-3 h-3" />
              Load
            </button>
            <button
              onClick={() => setShowSaveModal(true)}
              disabled={items.length === 0}
              className="hidden md:flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-board-muted hover:text-board-text hover:bg-board-border/50 text-xs font-medium transition-colors disabled:opacity-40"
              title="Save as reusable template"
            >
              <Save className="w-3 h-3" />
              Save
            </button>
            <button
              onClick={handleReset}
              className="hidden md:flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-board-muted hover:text-board-text hover:bg-board-border/50 text-xs font-medium transition-colors"
            >
              <RotateCcw className="w-3 h-3" />
              Reset
            </button>
            <button
              onClick={() => setShowAddForm(true)}
              className="flex items-center gap-1.5 px-3 py-2 md:py-1.5 rounded-lg bg-fire-500 text-white text-xs font-medium hover:bg-fire-600 transition-colors min-h-[44px] md:min-h-0"
            >
              <Plus className="w-3 h-3" />
              Add
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
            onClick={handleClearMessage}
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
        <div className="flex-1 overflow-hidden flex flex-col md:flex-row gap-4 md:gap-6 px-4 md:px-6 py-4 md:py-5 max-w-[1400px] mx-auto w-full">
          {/* Left: Timer + Controls + Message */}
          <div className="w-full md:w-[360px] shrink-0 flex flex-col gap-4 overflow-y-auto hide-scrollbar">
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
                  <span className="text-[10px] font-bold text-red-400 uppercase tracking-wider ml-auto animate-pulse">Overtime</span>
                )}
              </div>

              <p className={`text-6xl font-semibold tabular-nums tracking-tight ${isOvertime ? "text-red-400" : "text-board-text"}`}>
                {currentItem
                  ? timer.mode === "clock"
                    ? new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
                    : timer.mode === "count-down"
                    ? remaining < 0
                      ? overtimeBehavior === "stop"
                        ? "00:00"
                        : formatDuration(remaining)
                      : formatDuration(remaining)
                    : formatDuration(elapsed)
                  : "--:--"}
              </p>

              {/* Progress bar — resets smoothly on item change */}
              {currentItem && (
                <div className="mt-3 h-1.5 rounded-full bg-board-border overflow-hidden">
                  <div
                    id="rundown-progress-fill"
                    className={`h-full rounded-full ${isOvertime ? "bg-red-500" : isWarning ? "bg-yellow-500" : "bg-white"}`}
                    style={{ width: "0%" }}
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
              <button onClick={handlePrev} disabled={timer.playback === "stop"} className="flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-board-card border border-board-border text-board-text font-medium text-sm hover:bg-board-border/50 transition-colors disabled:opacity-40" title="Previous item">
                <SkipBack className="w-4 h-4" />
              </button>
              <button onClick={handleNext} disabled={timer.playback === "stop"} className="flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-board-card border border-board-border text-board-text font-medium text-sm hover:bg-board-border/50 transition-colors disabled:opacity-40" title="Next item">
                <SkipForward className="w-4 h-4" />
              </button>
              <button onClick={handleStop} disabled={timer.playback === "stop"} className="flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 font-medium text-sm hover:bg-red-500/20 transition-colors disabled:opacity-40">
                <Square className="w-4 h-4" />
              </button>
            </div>

            {/* Add / Subtract time (OnTime-style) */}
            <div className="rounded-xl border border-board-border bg-board-card p-3">
              <p className="text-[10px] font-medium text-board-muted/50 uppercase tracking-widest mb-2">
                Adjust Time
              </p>
              {/* Preset buttons */}
              <div className="flex gap-1.5 mb-2">
                <button
                  onClick={() => handleAdjustTime(-60_000)}
                  disabled={timer.playback === "stop"}
                  className="flex-1 flex items-center justify-center gap-1 px-2 py-2 rounded-lg bg-board-bg border border-board-border text-board-text font-medium text-[11px] hover:bg-board-border/50 transition-colors disabled:opacity-40"
                >
                  <Minus className="w-3 h-3" /> 1m
                </button>
                <button
                  onClick={() => handleAdjustTime(-15_000)}
                  disabled={timer.playback === "stop"}
                  className="flex-1 flex items-center justify-center gap-1 px-2 py-2 rounded-lg bg-board-bg border border-board-border text-board-text font-medium text-[11px] hover:bg-board-border/50 transition-colors disabled:opacity-40"
                >
                  <Minus className="w-3 h-3" /> 15s
                </button>
                <button
                  onClick={() => handleAdjustTime(15_000)}
                  disabled={timer.playback === "stop"}
                  className="flex-1 flex items-center justify-center gap-1 px-2 py-2 rounded-lg bg-board-bg border border-board-border text-board-text font-medium text-[11px] hover:bg-board-border/50 transition-colors disabled:opacity-40"
                >
                  <Plus className="w-3 h-3" /> 15s
                </button>
                <button
                  onClick={() => handleAdjustTime(60_000)}
                  disabled={timer.playback === "stop"}
                  className="flex-1 flex items-center justify-center gap-1 px-2 py-2 rounded-lg bg-board-bg border border-board-border text-board-text font-medium text-[11px] hover:bg-board-border/50 transition-colors disabled:opacity-40"
                >
                  <Plus className="w-3 h-3" /> 1m
                </button>
              </div>
              {/* Custom time input */}
              <div className="flex gap-1.5">
                <button
                  onClick={() => handleAdjustTime(-parseAdjustInput(customAdjust))}
                  disabled={timer.playback === "stop" || parseAdjustInput(customAdjust) === 0}
                  className="px-3 py-1.5 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-xs font-medium hover:bg-red-500/20 transition-colors disabled:opacity-40"
                  title="Subtract custom time"
                >
                  <Minus className="w-3.5 h-3.5" />
                </button>
                <input
                  type="text"
                  value={customAdjust}
                  onChange={(e) => setCustomAdjust(e.target.value)}
                  placeholder="secs or m:ss"
                  className="flex-1 px-3 py-1.5 rounded-lg bg-board-bg border border-board-border text-xs text-board-text text-center font-mono placeholder:text-board-muted/40 focus:outline-none focus:border-fire-500/50 transition-colors"
                />
                <button
                  onClick={() => handleAdjustTime(parseAdjustInput(customAdjust))}
                  disabled={timer.playback === "stop" || parseAdjustInput(customAdjust) === 0}
                  className="px-3 py-1.5 rounded-lg bg-green-500/10 border border-green-500/20 text-green-400 text-xs font-medium hover:bg-green-500/20 transition-colors disabled:opacity-40"
                  title="Add custom time"
                >
                  <Plus className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* Send message to stage */}
            <div className="rounded-xl border border-board-border bg-board-card p-4">
              <div className="flex items-center justify-between mb-2">
                <p className="text-[10px] font-medium text-board-muted/50 uppercase tracking-widest">
                  Stage Message
                </p>
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={messagePriority}
                    onChange={(e) => setMessagePriority(e.target.checked)}
                    className="w-3 h-3 rounded border-board-border accent-amber-500"
                  />
                  <span className={`text-[10px] font-medium uppercase tracking-wider ${messagePriority ? "text-amber-400" : "text-board-muted/50"}`}>
                    Priority
                  </span>
                </label>
              </div>
              {messagePriority && (
                <p className="text-[10px] text-amber-400/60 mb-2">
                  Message shown large, timer shown small on kiosk
                </p>
              )}
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
                  className={`p-2 rounded-lg transition-colors disabled:opacity-40 ${messagePriority ? "bg-amber-500/25 text-amber-300 hover:bg-amber-500/35" : "bg-amber-500/15 text-amber-400 hover:bg-amber-500/25"}`}
                >
                  <Send className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* ProPresenter Slide Feed */}
            {(ppHost || syncedPpSlide) && (
              <div className={`rounded-xl border p-4 transition-colors ${ppEnabled ? "border-purple-500/30 bg-purple-500/5" : "border-board-border bg-board-card"}`}>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <Tv className="w-3.5 h-3.5 text-purple-400" />
                    <p className="text-[10px] font-medium text-board-muted/50 uppercase tracking-widest">
                      ProPresenter
                    </p>
                  </div>
                    <button
                      onClick={togglePP}
                      className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[10px] font-medium uppercase tracking-wider transition-colors ${
                        ppEnabled
                          ? "bg-purple-500/20 text-purple-300 hover:bg-purple-500/30"
                        : "bg-board-bg text-board-muted hover:bg-board-border"
                    }`}
                    >
                      {ppEnabled ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
                      {ppEnabled ? "Streaming" : "Off"}
                    </button>
                    <button
                      onClick={showOnKiosk}
                      disabled={!activePpSlide?.text}
                      className="px-2.5 py-1 rounded-md text-[10px] font-medium uppercase tracking-wider transition-colors disabled:opacity-40 bg-board-bg text-board-muted hover:bg-board-border hover:text-board-text"
                    >
                      Show on kiosk
                    </button>
                  </div>

                {ppEnabled && (
                  <>
                    {/* Connection status */}
                    <div className="flex items-center gap-2 mb-2">
                      <div className={`w-2 h-2 rounded-full ${
                        ppIsConnected ? "bg-green-500 shadow-[0_0_4px_rgba(34,197,94,0.5)]" :
                        pp.status === "connecting" ? "bg-amber-500 animate-pulse" :
                        pp.status === "error" ? "bg-red-500" : "bg-gray-500"
                      }`} />
                      <span className="text-[10px] text-board-muted">
                        {ppSource === "bridge" ? "Connected via Gateway Bridge" :
                         ppSource === "direct" ? `Connected to ${ppHost}` :
                         pp.status === "connecting" ? "Connecting..." :
                         pp.status === "error" ? "Cannot reach PP directly — use Gateway Bridge" : "Waiting for Gateway Bridge..."}
                      </span>
                    </div>

                    {/* PP Control Buttons */}
                    {ppIsConnected && (
                      ppCuesEnabled && ppApiPort ? (
                        <div className="mb-2">
                          <div className="flex items-center gap-1.5">
                            <button
                              onClick={() => {
                                setPpCmdError("");
                                sendProPresenterCommand({ data: { host: ppHost, port: ppApiPort, command: "previous" } })
                                  .then(r => { if (!r.ok) setPpCmdError(r.error || "Failed"); })
                                  .catch(e => setPpCmdError(String(e)));
                              }}
                              className="flex items-center gap-1 px-2 py-1 rounded-md bg-board-bg border border-board-border text-[10px] font-medium text-board-muted hover:bg-board-border hover:text-board-text transition-colors"
                              title="Previous slide"
                            >
                              <SkipBack className="w-3 h-3" />
                              Prev
                            </button>
                            <button
                              onClick={() => {
                                setPpCmdError("");
                                sendProPresenterCommand({ data: { host: ppHost, port: ppApiPort, command: "next" } })
                                  .then(r => { if (!r.ok) setPpCmdError(r.error || "Failed"); })
                                  .catch(e => setPpCmdError(String(e)));
                              }}
                              className="flex items-center gap-1 px-2 py-1 rounded-md bg-board-bg border border-board-border text-[10px] font-medium text-board-muted hover:bg-board-border hover:text-board-text transition-colors"
                              title="Next slide"
                            >
                              Next
                              <SkipForward className="w-3 h-3" />
                            </button>
                            <button
                              onClick={() => {
                                setPpCmdError("");
                                sendProPresenterCommand({ data: { host: ppHost, port: ppApiPort, command: "clear" } })
                                  .then(r => { if (!r.ok) setPpCmdError(r.error || "Failed"); })
                                  .catch(e => setPpCmdError(String(e)));
                              }}
                              className="flex items-center gap-1 px-2 py-1 rounded-md bg-board-bg border border-red-500/30 text-[10px] font-medium text-red-400/70 hover:bg-red-500/10 hover:text-red-400 transition-colors ml-auto"
                              title="Clear all layers"
                            >
                              <X className="w-3 h-3" />
                              Clear
                            </button>
                          </div>
                          {ppCmdError && (
                            <p className="text-[9px] text-red-400/80 mt-1 font-mono truncate" title={ppCmdError}>
                              {ppCmdError}
                            </p>
                          )}
                        </div>
                      ) : (
                        <p className="text-[9px] text-board-muted/40 mb-2">
                          {!ppCuesEnabled ? "Enable \"Send cues\" in Settings → ProPresenter to control slides" : "Set API Port in Settings → ProPresenter to control slides"}
                        </p>
                      )
                    )}

                    {/* Current slide preview */}
                    {activePpSlide && activePpSlide.text ? (
                      <div className={`rounded-lg p-3 ${activePpSlide.isScripture ? "bg-purple-500/10 border border-purple-500/20" : "bg-blue-500/10 border border-blue-500/20"}`}>
                        {activePpSlide.presentationName && (
                          <p className={`text-[10px] font-medium uppercase tracking-wider mb-1 ${activePpSlide.isScripture ? "text-purple-400/70" : "text-blue-400/70"}`}>
                            {activePpSlide.presentationName}
                          </p>
                        )}
                        <p className={`text-sm leading-snug ${activePpSlide.isScripture ? "text-purple-200 italic" : "text-blue-100"}`}>
                          {activePpSlide.text.length > 120 ? activePpSlide.text.slice(0, 120) + "..." : activePpSlide.text}
                        </p>
                        <p className="text-[9px] text-board-muted/50 mt-1.5">
                          {ppSource === "bridge" ? "Gateway Bridge preview" : "Direct ProPresenter preview"}
                        </p>
                      </div>
                    ) : (
                      <div>
                        <p className="text-[10px] text-board-muted/40 italic">
                          Waiting for slide content from ProPresenter...
                        </p>
                        {/* Debug info — helps troubleshoot why slides aren't appearing */}
                        {pp.debugInfo && (
                          <div className="mt-2 rounded-lg bg-board-bg/80 border border-board-border/50 p-2 space-y-1">
                            <p className="text-[9px] font-medium text-board-muted/60 uppercase tracking-wider">Debug</p>
                            <div className="text-[9px] text-board-muted/50 font-mono space-y-0.5">
                              <p>WS: {pp.debugInfo.wsConnected ? "open" : "closed"} | msgs: {pp.debugInfo.wsMessagesReceived}</p>
                              {pp.debugInfo.lastWsMessage && (
                                <p className="truncate max-w-full" title={pp.debugInfo.lastWsMessage}>
                                  Last WS: {pp.debugInfo.lastWsMessage.slice(0, 80)}
                                </p>
                              )}
                              <p>Poll: {pp.debugInfo.pollingActive ? "active" : "inactive"} | ok: {pp.debugInfo.pollSuccessCount}</p>
                              {pp.debugInfo.lastPollResult && (
                                <p className="truncate max-w-full" title={pp.debugInfo.lastPollResult}>
                                  Poll: {pp.debugInfo.lastPollResult.slice(0, 80)}
                                </p>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </>
                )}

                {!ppEnabled && (
                  <p className="text-[10px] text-board-muted/40">
                    Stream lyrics & scripture from ProPresenter to stage display
                  </p>
                )}
              </div>
            )}

            {/* Shortcuts */}
            <div className="rounded-xl border border-board-border bg-board-card/50 p-4">
              <p className="text-[10px] font-medium text-board-muted/50 uppercase tracking-widest mb-2">Shortcuts</p>
              <div className="space-y-1 text-xs text-board-muted">
                <div className="flex justify-between"><span>Play / Pause</span><kbd className="px-1.5 py-0.5 rounded bg-board-bg border border-board-border text-[10px] font-mono">Space</kbd></div>
                <div className="flex justify-between"><span>Next item</span><kbd className="px-1.5 py-0.5 rounded bg-board-bg border border-board-border text-[10px] font-mono">N</kbd></div>
                <div className="flex justify-between"><span>Previous item</span><kbd className="px-1.5 py-0.5 rounded bg-board-bg border border-board-border text-[10px] font-mono">P</kbd></div>
                <div className="flex justify-between"><span>Stop</span><kbd className="px-1.5 py-0.5 rounded bg-board-bg border border-board-border text-[10px] font-mono">S</kbd></div>
                <div className="flex justify-between"><span>Add 1 minute</span><kbd className="px-1.5 py-0.5 rounded bg-board-bg border border-board-border text-[10px] font-mono">+</kbd></div>
                <div className="flex justify-between"><span>Subtract 1 minute</span><kbd className="px-1.5 py-0.5 rounded bg-board-bg border border-board-border text-[10px] font-mono">-</kbd></div>
              </div>
            </div>
          </div>

          {/* Right: Runsheet */}
          <div className="flex-1 min-w-0 flex flex-col">
            {/* Runsheet header */}
            <div className="flex items-center justify-between mb-3 shrink-0">
              <h2 className="text-[11px] font-medium text-board-muted uppercase tracking-widest">
                Runsheet
              </h2>
              <div className="flex items-center gap-4 text-[10px] tabular-nums text-board-muted">
                <span>{items.length} items</span>
                {completedDuration > 0 && (
                  <span>{formatDuration(completedDuration)} / {formatDuration(totalDuration)}</span>
                )}
                <span>{formatDuration(remainingDuration)} remaining</span>
              </div>
            </div>

            {items.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center gap-3">
                <Clock className="w-10 h-10 text-board-muted/20" />
                <p className="text-sm text-board-muted">No items in the rundown</p>
                <p className="text-xs text-board-muted/50">Click "Add Item" or "Load" to get started</p>
              </div>
            ) : (
              <div className="space-y-0.5 overflow-auto flex-1 hide-scrollbar pr-1">
                {items.map((item, idx) => {
                  const isCurrent = item.id === timer.currentItemId;
                  const config = TYPE_CONFIG[item.type];
                  const Icon = config.icon;
                  const isLive = timer.playback !== "stop";
                  const isItemOvertime = isCurrent && elapsed > item.duration;

                  // Extract the bg color class for the binder bar
                  const binderColor = isCurrent
                    ? "bg-fire-500"
                    : item.status === "complete"
                      ? "bg-green-500/40"
                      : config.color.split(" ")[0].replace("/15", "/60");

                  return (
                    <div
                      key={item.id}
                      className={`group flex transition-colors ${
                        isCurrent
                          ? "bg-fire-500/8"
                          : item.status === "complete"
                            ? "bg-board-card/15 opacity-50"
                            : "bg-board-card/30 hover:bg-board-card/50"
                      }`}
                    >
                      {/* Left binder bar (OnTime-style) */}
                      <div
                        className={`w-10 shrink-0 flex flex-col items-center justify-center gap-1 ${binderColor} ${
                          isCurrent ? "text-white" : "text-white/70"
                        }`}
                      >
                        <span className="text-[10px] font-bold">{idx + 1}</span>
                        {item.status === "live" && (
                          <div className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />
                        )}
                      </div>

                      {/* Content area */}
                      <div className="flex-1 min-w-0 flex flex-col">
                        {/* Main row */}
                        <div className="flex items-center gap-3 px-3 py-2">
                          {/* Duration */}
                          <span className={`shrink-0 text-xs font-mono tabular-nums ${isCurrent ? "text-board-text" : "text-board-muted/60"}`}>
                            {formatDuration(item.duration)}
                          </span>

                          {/* Divider */}
                          <div className={`w-px h-7 shrink-0 ${isCurrent ? "bg-fire-500/30" : "bg-board-border/30"}`} />

                          {/* Title section */}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <Icon className={`w-3.5 h-3.5 shrink-0 ${
                                isCurrent ? "text-fire-400" : config.color.split(" ")[1]
                              }`} />
                              <p className={`text-sm font-medium truncate ${
                                isCurrent ? "text-fire-400" :
                                item.status === "complete" ? "text-board-muted line-through" : "text-board-text"
                              }`}>
                                {item.title || "Untitled"}
                              </p>
                            </div>
                            {/* Assignee / notes inline */}
                            {(item.assignee || item.notes) && (
                              <p className="text-[10px] text-board-muted/40 truncate mt-0.5 pl-6">
                                {item.assignee}{item.assignee && item.notes ? " · " : ""}{item.notes}
                              </p>
                            )}
                          </div>

                          {/* Offset chip (OnTime-style) */}
                          {isCurrent && elapsed > 0 && (
                            <span className={`text-[11px] font-mono font-bold px-2 py-0.5 rounded-full shrink-0 ${
                              isItemOvertime
                                ? "bg-red-500/20 text-red-400 animate-pulse"
                                : "bg-green-500/15 text-green-400/80"
                            }`}>
                              {formatOffset(elapsed - item.duration)}
                            </span>
                          )}

                          {/* Playback actions (always visible for current, hover for others) */}
                          <div className={`flex items-center gap-0.5 shrink-0 ${
                            isCurrent ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                          } transition-opacity`}>
                            {!isCurrent && item.status !== "complete" && (
                              <button onClick={() => handleStart(item.id)} className="p-1.5 rounded text-board-muted hover:text-green-400 hover:bg-green-500/10 transition-colors" title="Start">
                                <Play className="w-3.5 h-3.5" />
                              </button>
                            )}
                            <button onClick={() => setEditingItem(item)} className="p-1.5 rounded text-board-muted hover:text-fire-500 hover:bg-fire-500/10 transition-colors" title="Edit">
                              <Pencil className="w-3.5 h-3.5" />
                            </button>
                            {!isLive && (
                              <>
                                <button onClick={() => handleMoveItem(item.id, "up")} disabled={idx === 0} className="p-1 rounded text-board-muted hover:text-board-text hover:bg-board-border/30 transition-colors disabled:opacity-20" title="Move up">
                                  <ChevronUp className="w-3.5 h-3.5" />
                                </button>
                                <button onClick={() => handleMoveItem(item.id, "down")} disabled={idx === items.length - 1} className="p-1 rounded text-board-muted hover:text-board-text hover:bg-board-border/30 transition-colors disabled:opacity-20" title="Move down">
                                  <ChevronDown className="w-3.5 h-3.5" />
                                </button>
                                <button onClick={() => handleRemoveItem(item.id)} className="p-1 rounded text-board-muted hover:text-red-400 hover:bg-red-500/10 transition-colors" title="Delete">
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </>
                            )}
                          </div>
                        </div>

                        {/* Progress bar for current item */}
                        {isCurrent && (
                          <div className="h-0.5 w-full bg-board-border/20">
                            <div
                              id="rundown-item-progress"
                              className={`h-full ${isItemOvertime && overtimeBehavior !== "stop" ? "bg-red-500" : isWarning ? "bg-yellow-500" : "bg-white"}`}
                              style={{ width: "0%" }}
                            />
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {showAddForm && <AddItemModal defaultDuration={defaultItemDuration} onAdd={handleAddItem} onClose={() => setShowAddForm(false)} />}
      {editingItem && (
        <EditItemModal
          item={editingItem}
          onSave={(title, type, duration, assignee, notes) => handleEditItem(editingItem.id, title, type, duration, assignee, notes)}
          onClose={() => setEditingItem(null)}
        />
      )}
      {showLoadModal && (
        <LoadRundownModal orgId={orgId} onLoad={handleLoadItems} onClose={() => setShowLoadModal(false)} />
      )}
      {showSaveModal && (
        <SaveRundownModal onSave={handleSaveTemplate} onClose={() => setShowSaveModal(false)} />
      )}
    </div>
  );
}

function AddItemModal({
  defaultDuration,
  onAdd,
  onClose,
}: {
  defaultDuration: string;
  onAdd: (title: string, type: ItemType, duration: string, assignee: string, notes: string) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState("");
  const [type, setType] = useState<ItemType>("segment");
  const [duration, setDuration] = useState(defaultDuration);
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

function formatDurationForInput(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function EditItemModal({
  item,
  onSave,
  onClose,
}: {
  item: RundownItem;
  onSave: (title: string, type: ItemType, duration: string, assignee: string, notes: string) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(item.title);
  const [type, setType] = useState<ItemType>(item.type);
  const [duration, setDuration] = useState(formatDurationForInput(item.duration));
  const [assignee, setAssignee] = useState(item.assignee);
  const [notes, setNotes] = useState(item.notes);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    onSave(title.trim(), type, duration, assignee.trim(), notes.trim());
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-board-card border border-board-border rounded-2xl p-6 w-full max-w-md mx-4 shadow-2xl">
        <h2 className="text-lg font-semibold text-board-text mb-5">Edit Item</h2>
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
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Production notes..." rows={2}
              className="w-full px-4 py-2.5 rounded-xl bg-board-bg border border-board-border text-board-text placeholder:text-board-muted/50 focus:outline-none focus:border-fire-500 transition-colors text-sm resize-none" />
          </div>
          <div className="flex gap-3 pt-2">
            <button type="button" onClick={onClose} className="flex-1 px-4 py-2.5 rounded-xl border border-board-border text-board-muted hover:bg-board-border transition-colors">Cancel</button>
            <button type="submit" disabled={!title.trim()} className="flex-1 px-4 py-2.5 rounded-xl bg-fire-500 text-white font-semibold hover:bg-fire-600 disabled:opacity-50 transition-colors">Save</button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Load Rundown Modal ─────────────────────────────────────

function LoadRundownModal({
  orgId,
  onLoad,
  onClose,
}: {
  orgId: string;
  onLoad: (items: RundownItem[]) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"dates" | "saved">("dates");
  const [dates, setDates] = useState<{ date: string; itemCount: number }[]>([]);
  const [saved, setSaved] = useState<SavedRundownMeta[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingItems, setLoadingItems] = useState(false);

  useEffect(() => {
    setLoadingList(true);
    Promise.all([
      listRundownDates({ data: { orgId } }),
      listSavedRundowns({ data: { orgId } }),
    ]).then(([d, s]) => {
      setDates(d);
      setSaved(s);
    }).catch(() => {}).finally(() => setLoadingList(false));
  }, [orgId]);

  const handleLoadFromDate = async (date: string) => {
    setLoadingItems(true);
    try {
      const state = await getRundownState({ data: { orgId, serviceDate: date } });
      onLoad(state.items as RundownItem[]);
    } catch {
      // keep modal open
    }
    setLoadingItems(false);
  };

  const handleLoadFromSaved = async (rundownId: string) => {
    setLoadingItems(true);
    try {
      const items = await loadSavedRundown({ data: { orgId, rundownId } });
      if (items) onLoad(items as RundownItem[]);
    } catch {
      // keep modal open
    }
    setLoadingItems(false);
  };

  const handleDeleteSaved = async (rundownId: string) => {
    await deleteSavedRundown({ data: { orgId, rundownId } });
    setSaved((prev) => prev.filter((r) => r.id !== rundownId));
  };

  const formatDate = (dateStr: string) => {
    const [y, m, d] = dateStr.split("-");
    const date = new Date(Number(y), Number(m) - 1, Number(d));
    return date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-board-card border border-board-border rounded-2xl w-full max-w-lg mx-4 shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-6 pt-5 pb-3">
          <h2 className="text-lg font-semibold text-board-text">Load Rundown</h2>
          <button onClick={onClose} className="p-1 rounded text-board-muted hover:text-board-text transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 px-6 mb-3">
          <button
            onClick={() => setTab("dates")}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              tab === "dates" ? "bg-fire-500/15 text-fire-500 border border-fire-500/25" : "text-board-muted border border-board-border hover:border-board-muted/50"
            }`}
          >
            <Calendar className="w-3 h-3" />
            Previous Dates
          </button>
          <button
            onClick={() => setTab("saved")}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              tab === "saved" ? "bg-fire-500/15 text-fire-500 border border-fire-500/25" : "text-board-muted border border-board-border hover:border-board-muted/50"
            }`}
          >
            <FileText className="w-3 h-3" />
            Saved Templates
          </button>
        </div>

        <div className="px-6 pb-5 max-h-[400px] overflow-auto">
          {loadingList ? (
            <p className="text-sm text-board-muted py-8 text-center">Loading...</p>
          ) : tab === "dates" ? (
            dates.length === 0 ? (
              <p className="text-sm text-board-muted py-8 text-center">No previous rundowns found</p>
            ) : (
              <div className="space-y-1.5">
                {dates.map((d) => (
                  <button
                    key={d.date}
                    onClick={() => handleLoadFromDate(d.date)}
                    disabled={loadingItems}
                    className="w-full flex items-center justify-between px-4 py-3 rounded-lg border border-board-border/50 bg-board-bg/50 hover:border-board-border hover:bg-board-card/50 transition-colors text-left disabled:opacity-50"
                  >
                    <div>
                      <p className="text-sm font-medium text-board-text">{formatDate(d.date)}</p>
                      <p className="text-[10px] text-board-muted mt-0.5">{d.itemCount} items</p>
                    </div>
                    <FolderOpen className="w-4 h-4 text-board-muted" />
                  </button>
                ))}
              </div>
            )
          ) : (
            saved.length === 0 ? (
              <p className="text-sm text-board-muted py-8 text-center">No saved templates yet. Use "Save" to create one.</p>
            ) : (
              <div className="space-y-1.5">
                {saved.map((s) => (
                  <div
                    key={s.id}
                    className="flex items-center gap-2 px-4 py-3 rounded-lg border border-board-border/50 bg-board-bg/50 hover:border-board-border hover:bg-board-card/50 transition-colors"
                  >
                    <button
                      onClick={() => handleLoadFromSaved(s.id)}
                      disabled={loadingItems}
                      className="flex-1 text-left disabled:opacity-50"
                    >
                      <p className="text-sm font-medium text-board-text">{s.name}</p>
                      <p className="text-[10px] text-board-muted mt-0.5">
                        {s.itemCount} items · saved {new Date(s.createdAt).toLocaleDateString()}
                      </p>
                    </button>
                    <button
                      onClick={() => handleDeleteSaved(s.id)}
                      className="p-1.5 rounded text-board-muted hover:text-red-400 transition-colors shrink-0"
                      title="Delete template"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Save Rundown Modal ─────────────────────────────────────

function SaveRundownModal({
  onSave,
  onClose,
}: {
  onSave: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    await onSave(name.trim());
    setSaving(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-board-card border border-board-border rounded-2xl p-6 w-full max-w-sm mx-4 shadow-2xl">
        <h2 className="text-lg font-semibold text-board-text mb-4">Save Rundown Template</h2>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm text-board-muted mb-1.5">Template Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Sunday Morning Service"
              autoFocus
              className="w-full px-4 py-2.5 rounded-xl bg-board-bg border border-board-border text-board-text placeholder:text-board-muted/50 focus:outline-none focus:border-fire-500 transition-colors text-sm"
            />
          </div>
          <p className="text-[10px] text-board-muted">
            Saves the current rundown items as a reusable template. All items will be reset to "upcoming" status.
          </p>
          <div className="flex gap-3 pt-1">
            <button type="button" onClick={onClose} className="flex-1 px-4 py-2.5 rounded-xl border border-board-border text-board-muted hover:bg-board-border transition-colors">
              Cancel
            </button>
            <button type="submit" disabled={!name.trim() || saving} className="flex-1 px-4 py-2.5 rounded-xl bg-fire-500 text-white font-semibold hover:bg-fire-600 disabled:opacity-50 transition-colors">
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
