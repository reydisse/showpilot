import { createFileRoute, Link } from "@tanstack/react-router";
import { PageSkeleton } from "@/components/ui/Skeleton";
import {
  useState,
  useEffect,
  useRef,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  type CSSProperties,
} from "react";
import {
  Flame,
  Clock,
  Play,
  Pause,
  Square,
  Radio,
  WifiOff,
  UserPlus,
  LayoutDashboard,
  ArrowRight,
} from "lucide-react";
import { getCrewMembers } from "@/lib/data";
import { getOntimeState, formatOntimeTime, formatDuration as formatOntimeDuration } from "@/lib/ontime";
import { getRundownState } from "@/lib/rundown";
import { getActiveAdapters, getClockFormat, type RundownAdapterType } from "@/lib/settings";
import { getTodayDateString, formatTime, formatClockFull, type ClockFormat } from "@/lib/utils";
import { useRundownSync } from "@/hooks/useRundownSync";
import { useChat } from "@/hooks/useChat";
import { ChatPanel as SharedChatPanel } from "@/components/chat/ChatPanel";
import { ShowPageTabs } from "@/components/ui/ShowPageTabs";
import type { OntimeRuntimeState } from "@/types/ontime";
import type { RundownItem, NativeTimerState, RundownState } from "@/types/rundown";

// ─── Helpers ─────────────────────────────────────────────────

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

type ItemType = "segment" | "song" | "prayer" | "announcement" | "offering" | "custom";
type ShowTab = "show" | "chat" | "rundown";

const TYPE_COLORS: Record<ItemType, string> = {
  segment: "bg-blue-500",
  song: "bg-purple-500",
  prayer: "bg-pink-500",
  announcement: "bg-yellow-500",
  offering: "bg-green-500",
  custom: "bg-board-muted",
};

// ─── Route ───────────────────────────────────────────────────

export const Route = createFileRoute("/$slug/show")({
  pendingComponent: () => <PageSkeleton />,
  loader: async ({ context }) => {
    const { withPermission } = await import("@/lib/route-permissions");
    await withPermission(context.role, "show:view", context.slug, context.orgId);
    const today = getTodayDateString();
    const [members, adapters, clockFormat] = await Promise.all([
      getCrewMembers({ data: { orgId: context.orgId } }),
      getActiveAdapters({ data: { orgId: context.orgId } }),
      getClockFormat({ data: { orgId: context.orgId } }),
    ]);

    // Load rundown data based on adapter
    let ontimeState: OntimeRuntimeState | null = null;
    let nativeRundown: RundownState | null = null;
    let effectiveRundownAdapter: RundownAdapterType = adapters.rundown;

    if (adapters.rundown === "ontime") {
      // Try OnTime — if it fails or isn't configured, fall back to native
      const ot = await getOntimeState({ data: { orgId: context.orgId } });
      if (ot.connected) {
        ontimeState = ot;
      } else {
        // OnTime not reachable — silent fallback to native
        effectiveRundownAdapter = "native";
        nativeRundown = await getRundownState({ data: { orgId: context.orgId, serviceDate: today } });
      }
    } else {
      // Native (or any other not-yet-implemented adapter)
      nativeRundown = await getRundownState({ data: { orgId: context.orgId, serviceDate: today } });
    }

    return {
      members,
      ontimeState,
      nativeRundown,
      rundownAdapter: effectiveRundownAdapter,
      chatAdapter: adapters.chat,
      orgId: context.orgId,
      slug: context.slug,
      serviceDate: today,
      clockFormat,
    };
  },
  component: ShowPage,
});

// ─── LiveFlash ────────────────────────────────────────────────

function LiveFlash({ onDone }: { onDone: () => void }) {
  const [phase, setPhase] = useState<"in" | "hold" | "out">("in");
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    const t1 = setTimeout(() => setPhase("hold"), 100);
    const t2 = setTimeout(() => setPhase("out"), 3000);
    const t3 = setTimeout(() => onDoneRef.current(), 3700);
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
  }, []);

  return (
    <div
      className={`fixed inset-0 z-[100] flex items-center justify-center transition-opacity ${
        phase === "in" ? "opacity-0" : phase === "hold" ? "opacity-100" : "opacity-0"
      }`}
      style={{ transitionDuration: phase === "out" ? "700ms" : "300ms" }}
    >
      <div className="absolute inset-0 bg-red-600 animate-pulse" />
      <div className="relative flex flex-col items-center gap-4">
        <Radio className="w-16 h-16 text-white animate-bounce" />
        <h1 className="text-6xl sm:text-8xl font-black text-white tracking-tight uppercase select-none">
          SHOW IS LIVE
        </h1>
        <div className="flex items-center gap-2 mt-2">
          <span className="w-3 h-3 rounded-full bg-white animate-ping" />
          <span className="text-white/80 text-lg font-medium uppercase tracking-widest">On Air</span>
        </div>
      </div>
    </div>
  );
}

// ─── Chat Panel ───────────────────────────────────────────────

function ChatPanel({
  orgId,
  chatAdapter,
}: {
  orgId: string;
  chatAdapter: ReturnType<typeof Route.useLoaderData>["chatAdapter"];
}) {
  const [senderName, setSenderName] = useState("");
  const [draftName, setDraftName] = useState("");
  const [showNameInput, setShowNameInput] = useState(true);
  const { messages, sendMessage, connectionStatus } = useChat({
    orgId,
    isVisible: true,
    chatAdapter,
    senderName,
    senderRole: "Operator",
  });

  useEffect(() => {
    const saved = localStorage.getItem("showpilot-chat-name");
    if (saved) {
      setSenderName(saved);
      setDraftName(saved);
      setShowNameInput(false);
    }
  }, []);

  const handleSetName = () => {
    if (!draftName.trim()) return;
    localStorage.setItem("showpilot-chat-name", draftName.trim());
    setSenderName(draftName.trim());
    setShowNameInput(false);
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {showNameInput && (
        <div className="py-3 border-b border-board-border/50 space-y-2">
          <label className="text-xs text-board-muted block">Your name</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSetName()}
              placeholder="Enter your name"
              className="flex-1 px-3 py-2 rounded-lg bg-board-bg border border-board-border text-sm text-board-text placeholder:text-board-muted/40 focus:outline-none focus:border-fire-500/50 transition-colors"
            />
            <button
              onClick={handleSetName}
              disabled={!draftName.trim()}
              className="px-3 py-2 rounded-lg bg-fire-500 text-white text-xs font-medium disabled:opacity-40 transition-colors"
            >
              Join
            </button>
          </div>
        </div>
      )}

      {!showNameInput && (
        <SharedChatPanel
          messages={messages}
          connectionStatus={connectionStatus}
          unreadCount={0}
          onSendMessage={sendMessage}
          title="Team Chat"
          subtitle={chatAdapter === "native" ? senderName : `${senderName} via ${chatAdapter}`}
          className="border-l-0 flex-1 min-h-0"
        />
      )}
    </div>
  );
}

// ─── Show Page ────────────────────────────────────────────────

function ShowPage() {
  const {
    members: initialMembers, ontimeState, nativeRundown, rundownAdapter,
    chatAdapter, orgId, slug, clockFormat,
  } = Route.useLoaderData();
  const [members, setMembers] = useState(initialMembers);

  useEffect(() => {
    let cancelled = false;

    const refreshMembers = async () => {
      try {
        const latest = await getCrewMembers({ data: { orgId } });
        if (!cancelled) {
          setMembers(latest);
        }
      } catch {
        // Keep last known state.
      }
    };

    const interval = setInterval(refreshMembers, 3000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [orgId]);

  const activeMembers = members.filter((m) => m.isOnline);

  // Determine which rundown mode to render
  if (rundownAdapter === "ontime" && ontimeState) {
    return (
      <ShowPageWithOntime
        ontimeState={ontimeState}
        members={members}
        activeMembers={activeMembers}
        chatAdapter={chatAdapter}
        orgId={orgId}
        slug={slug}
        clockFormat={clockFormat}
      />
    );
  }

  // Default: native rundown
  return (
    <ShowPageWithNative
      initialRundown={nativeRundown}
      members={members}
      activeMembers={activeMembers}
      chatAdapter={chatAdapter}
      orgId={orgId}
      slug={slug}
      clockFormat={clockFormat}
    />
  );
}

// ─── Shared Show Layout ─────────────────────────────────────

function ShowPageLayout({
  activeTab,
  onTabChange,
  statusClock,
  statusNode,
  showPanel,
  chatPanel,
  rundownPanel,
  crewPanel,
}: {
  activeTab: ShowTab;
  onTabChange: (tab: ShowTab) => void;
  statusClock: string;
  statusNode: ReactNode;
  showPanel: ReactNode;
  chatPanel: ReactNode;
  rundownPanel: ReactNode;
  crewPanel?: ReactNode;
}) {
  const STORAGE_LEFT_WIDTH = "show-page-left-width";
  const STORAGE_TOP_HEIGHT = "show-page-top-height";
  const STORAGE_LAYOUT_VERSION = "show-page-layout-version";
  const CURRENT_LAYOUT_VERSION = "2";

  const applyStoredLayout = (leftWidth: number, topHeight: number) => {
    const normalizedLeft = clamp(leftWidth, 24, 72);
    const normalizedTop = clamp(topHeight, 20, 80);
    setLeftWidthPercent(normalizedLeft);
    setTopHeightPercent(normalizedTop);
  };

  const resetStoredLayout = () => {
    if (typeof window === "undefined") return;
    window.localStorage.removeItem(STORAGE_LEFT_WIDTH);
    window.localStorage.removeItem(STORAGE_TOP_HEIGHT);
    window.localStorage.setItem(STORAGE_LAYOUT_VERSION, CURRENT_LAYOUT_VERSION);
    applyStoredLayout(40, 45);
  };

  const panelsRef = useRef<HTMLDivElement | null>(null);
  const moveListenerRef = useRef<(event: PointerEvent) => void>(() => {});
  const upListenerRef = useRef<(event: PointerEvent) => void>(() => {});
  const resizeRef = useRef<{
    mode: "horizontal" | "vertical" | null;
    startX: number;
    startY: number;
    baseWidth: number;
    baseHeight: number;
    startLeftWidth: number;
    startTopHeight: number;
    pointerId: number | null;
    source?: HTMLButtonElement | null;
  }>({
    mode: null,
    startX: 0,
    startY: 0,
    baseWidth: 0,
    baseHeight: 0,
    startLeftWidth: 0,
    startTopHeight: 0,
    pointerId: null,
    source: null,
  });

  const leftWidthRef = useRef(40);
  const topHeightRef = useRef(45);

  const [leftWidthPercent, setLeftWidthPercent] = useState(40);
  const [topHeightPercent, setTopHeightPercent] = useState(45);

  useEffect(() => {
    leftWidthRef.current = leftWidthPercent;
    topHeightRef.current = topHeightPercent;
  }, [leftWidthPercent, topHeightPercent]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const savedVersion = window.localStorage.getItem(STORAGE_LAYOUT_VERSION);
    if (savedVersion !== CURRENT_LAYOUT_VERSION) {
      resetStoredLayout();
      return;
    }

    const savedLeft = Number(window.localStorage.getItem(STORAGE_LEFT_WIDTH));
    const savedTop = Number(window.localStorage.getItem(STORAGE_TOP_HEIGHT));

    if (Number.isFinite(savedLeft) && savedLeft >= 24 && savedLeft <= 72) {
      setLeftWidthPercent(savedLeft);
    }

    if (Number.isFinite(savedTop) && savedTop >= 20 && savedTop <= 80) {
      setTopHeightPercent(savedTop);
    }
  }, []);

  const clamp = (value: number, min: number, max: number) => {
    if (Number.isNaN(value)) return min;
    return Math.min(Math.max(value, min), max);
  };

  const beginResize = (mode: "horizontal" | "vertical") => (event: ReactPointerEvent<HTMLButtonElement>) => {
    const panels = panelsRef.current;
    if (!panels) return;

    const rect = panels.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);

    resizeRef.current = {
      mode,
      startX: event.clientX,
      startY: event.clientY,
      baseWidth: rect.width,
      baseHeight: rect.height,
      startLeftWidth: leftWidthPercent,
      startTopHeight: topHeightPercent,
      pointerId: event.pointerId,
      source: event.currentTarget,
    };

    const handleMove = (moveEvent: PointerEvent) => {
      const state = resizeRef.current;
      if (!state.mode || state.pointerId == null || moveEvent.pointerId !== state.pointerId) return;

      if (state.mode === "vertical") {
        const deltaX = moveEvent.clientX - state.startX;
        const nextWidth = clamp(state.startLeftWidth + (deltaX / state.baseWidth) * 100, 24, 72);
        leftWidthRef.current = nextWidth;
        setLeftWidthPercent(nextWidth);
        return;
      }

      const deltaY = moveEvent.clientY - state.startY;
      const nextTop = clamp(state.startTopHeight + (deltaY / state.baseHeight) * 100, 20, 80);
      topHeightRef.current = nextTop;
      setTopHeightPercent(nextTop);
    };

    const handleUp = (upEvent: PointerEvent) => {
      const state = resizeRef.current;
      if (state.pointerId == null || upEvent.pointerId !== state.pointerId) return;

      if (typeof window !== "undefined") {
        window.localStorage.setItem(STORAGE_LEFT_WIDTH, String(leftWidthRef.current));
        window.localStorage.setItem(STORAGE_TOP_HEIGHT, String(topHeightRef.current));
        window.localStorage.setItem(STORAGE_LAYOUT_VERSION, CURRENT_LAYOUT_VERSION);
      }

      window.removeEventListener("pointermove", moveListenerRef.current);
      window.removeEventListener("pointerup", upListenerRef.current);
      window.removeEventListener("pointercancel", upListenerRef.current);
      resizeRef.current.mode = null;
      resizeRef.current.pointerId = null;
      if (state.source && state.pointerId != null && state.source.hasPointerCapture(state.pointerId)) {
        state.source.releasePointerCapture(state.pointerId);
      }
    };

    moveListenerRef.current = handleMove;
    upListenerRef.current = handleUp;

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleUp);
  };

  useEffect(() => {
    return () => {
      window.removeEventListener("pointermove", moveListenerRef.current);
      window.removeEventListener("pointerup", upListenerRef.current);
      window.removeEventListener("pointercancel", upListenerRef.current);

      const state = resizeRef.current;
      if (state.pointerId == null || !state.source) return;
      if (state.source.hasPointerCapture(state.pointerId)) {
        state.source.releasePointerCapture(state.pointerId);
      }
    };
  }, []);

  return (
    <div className="h-full min-h-0 overflow-hidden">
      <div className="show-page-root" data-show-tab={activeTab}>
        <div className="show-page-shell">
          <header className="show-page-header">
            <h1 className="text-sm font-medium text-board-text/70">Show Flow</h1>
            <div className="flex items-center gap-4">
              <span className="text-xs text-board-muted tabular-nums">{statusClock}</span>
              {statusNode}
            </div>
          </header>

          <ShowPageTabs activeTab={activeTab} onChange={onTabChange} />

          <main
            className="show-page-panels"
            ref={panelsRef}
            aria-live="polite"
              style={{
                "--show-page-left-width": `${leftWidthPercent}%`,
                "--show-page-top-height": `${topHeightPercent}%`,
              } as CSSProperties}
          >
            <section data-tab="show" className="show-page-tab-panel show-page-show-panel">
              {showPanel}
            </section>
            <section data-tab="chat" className="show-page-tab-panel show-page-chat-panel">
              {chatPanel}
            </section>
            <section data-tab="rundown" className="show-page-tab-panel show-page-rundown-panel">
              {rundownPanel}
            </section>

            <button
              type="button"
              aria-label="Resize show and rundown columns"
              className="show-page-resize-handle show-page-resize-handle-vertical"
              onPointerDown={beginResize("vertical")}
            />
            <button
              type="button"
              aria-label="Resize show and chat rows"
              className="show-page-resize-handle show-page-resize-handle-horizontal"
              onPointerDown={beginResize("horizontal")}
            />
          </main>

          {crewPanel && <section className="show-page-crew-strip">{crewPanel}</section>}
        </div>
      </div>
    </div>
  );
}

// ─── Show Page: Native Rundown ───────────────────────────────

function ShowPageWithNative({
  initialRundown,
  members,
  activeMembers,
  chatAdapter,
  orgId,
  slug,
  clockFormat,
}: {
  initialRundown: RundownState | null;
  members: Awaited<ReturnType<typeof getCrewMembers>>;
  activeMembers: Awaited<ReturnType<typeof getCrewMembers>>;
  chatAdapter: ReturnType<typeof Route.useLoaderData>["chatAdapter"];
  orgId: string;
  slug: string;
  clockFormat: ClockFormat;
}) {
  const [activeTab, setActiveTab] = useState<ShowTab>("show");

  // Real-time sync via RundownRelay Durable Object (replaces DB polling)
  const {
    items: syncedItems,
    timer: syncedTimer,
    hydrated: syncHydrated,
    seedState,
  } = useRundownSync(orgId);

  // Use synced state when available, fall back to initial loader data
  // IMPORTANT: only use synced data after hydration (before that, syncedItems is [])
  const items: RundownItem[] = (syncHydrated && syncedItems.length > 0
    ? syncedItems
    : initialRundown?.items ?? []) as RundownItem[];
  const timer: NativeTimerState = syncHydrated
    ? {
        playback: syncedTimer.playback,
        currentItemId: syncedTimer.currentItemId,
        elapsed: syncedTimer.elapsed,
        startedAt: syncedTimer.startedAt,
        pausedAt: syncedTimer.pausedAt ?? null,
        mode: syncedTimer.mode ?? "count-down",
        serverTime: syncedTimer.serverTime ?? Date.now(),
      }
    : initialRundown?.timer ?? {
        playback: "stop", currentItemId: null, elapsed: 0,
        startedAt: null, pausedAt: null, mode: "count-down", serverTime: Date.now(),
      };

  // Seed DO if it's empty but we have initial data from DB
  const hasSeededRef = useRef(false);
  useEffect(() => {
    if (!syncHydrated || hasSeededRef.current) return;
    if (syncedItems.length === 0 && initialRundown && initialRundown.items.length > 0) {
      hasSeededRef.current = true;
      seedState(initialRundown.items as any[], initialRundown.timer as any);
    } else if (syncedItems.length > 0) {
      hasSeededRef.current = true;
    }
  }, [syncHydrated, syncedItems.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const [displayTime, setDisplayTime] = useState(0);
  const rafRef = useRef<number>(0);

  const isPlaying = timer.playback === "play";
  const isPaused = timer.playback === "pause";

  // RAF for smooth timer display
  useEffect(() => {
    const tick = () => {
      if (timer.mode === "clock") {
        setDisplayTime(Date.now());
      } else if (timer.playback === "play" && timer.startedAt) {
        setDisplayTime(timer.elapsed + (Date.now() - timer.startedAt));
      } else {
        setDisplayTime(timer.elapsed);
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [timer.playback, timer.startedAt, timer.elapsed, timer.mode]);

  const currentItem = items.find((i) => i.id === timer.currentItemId);
  const currentIdx = timer.currentItemId
    ? items.findIndex((i) => i.id === timer.currentItemId)
    : -1;
  const nextItem = items.find((_, i) => i > currentIdx && items[i].status !== "complete");
  const remaining = currentItem && timer.mode === "count-down"
    ? currentItem.duration - (timer.playback === "pause" && timer.startedAt === null ? timer.elapsed : displayTime)
    : 0;
  const isOvertime = timer.mode === "count-down" && remaining < 0;
  const timerDisplay = currentItem
    ? timer.mode === "clock"
      ? formatClockFull(new Date(displayTime), clockFormat)
      : timer.mode === "count-down"
        ? formatDuration(remaining)
        : formatDuration(displayTime)
    : "--:--";
  const progressPercent = currentItem && timer.mode !== "clock"
    ? Math.min(100, (Math.max(0, displayTime) / currentItem.duration) * 100)
    : 0;

  // Show flash on transition to play
  const [showFlash, setShowFlash] = useState(false);
  const prevPlayback = useRef(timer.playback);
  useEffect(() => {
    if (timer.playback === "play" && prevPlayback.current !== "play") setShowFlash(true);
    prevPlayback.current = timer.playback;
  }, [timer.playback]);

  if (members.length === 0) return <EmptyState slug={slug} />;

    const showPanel = (
      <div className={`h-full rounded-xl border ${isOvertime ? "bg-red-500/5 border-red-500/20" : "bg-board-card border-board-border"} p-5`}>
      <div className="flex items-center gap-2 mb-2">
        {isPlaying ? (
          <Play className="w-3.5 h-3.5 text-green-400 fill-green-400" />
        ) : isPaused ? (
          <Pause className="w-3.5 h-3.5 text-yellow-400" />
        ) : (
          <Square className="w-3.5 h-3.5 text-board-muted" />
        )}
        <span className="text-[11px] font-medium text-board-muted uppercase tracking-widest">
          {timer.playback === "stop" ? "Stopped" : isPlaying ? "Playing" : "Paused"}
        </span>
        {isOvertime && (
          <span className="text-[10px] font-bold text-red-400 uppercase tracking-wider ml-auto animate-pulse">Overtime</span>
        )}
      </div>

        <p className={`text-6xl font-semibold tabular-nums tracking-tight ${isOvertime ? "text-red-400" : isPlaying ? "text-board-text" : "text-board-muted"}`}>
          {timerDisplay}
        </p>

      {/* Progress bar */}
        {currentItem && (
          <div className="mt-3 h-1.5 rounded-full bg-board-border overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${isOvertime ? "bg-red-500" : "bg-fire-500"}`}
              style={{ width: `${progressPercent}%` }}
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
  );

  const chatPanel = (
    <div className="h-full min-h-0 flex flex-col overflow-hidden rounded-xl bg-board-card border border-board-border">
      <ChatPanel orgId={orgId} chatAdapter={chatAdapter} />
    </div>
  );

    const rundownPanel = (
      <div className="h-full min-h-0 flex flex-col overflow-hidden">
      <h2 className="text-[11px] font-medium text-board-muted uppercase tracking-widest mb-3 shrink-0">Rundown</h2>
      {items.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-3">
          <Clock className="w-8 h-8 text-board-muted/20" />
          <p className="text-sm text-board-muted">No items in the rundown</p>
          <p className="text-xs text-board-muted/50">
            Add items in the{" "}
            <Link to="/$slug/rundown" params={{ slug }} className="text-fire-500 hover:text-fire-400">
              Rundown Editor
            </Link>
          </p>
        </div>
      ) : (
        <div className="space-y-1 overflow-auto flex-1 hide-scrollbar pr-1">
          {items.map((event) => {
            const isCurrent = event.id === timer.currentItemId;
            const isComplete = event.status === "complete";
            const dotColor = TYPE_COLORS[event.type as ItemType] ?? "bg-board-muted";

            return (
              <div
                key={event.id}
                className={`flex items-center gap-3 px-4 py-2.5 rounded-lg border transition-colors ${
                  isCurrent
                    ? "bg-fire-500/8 border-fire-500/25"
                    : isComplete
                      ? "bg-board-card/30 border-board-border/30 opacity-60"
                      : "bg-board-card/50 border-board-border/50"
                }`}
              >
                <div className={`w-2 h-2 rounded-full shrink-0 ${
                  isCurrent ? "bg-fire-500 animate-pulse" : isComplete ? "bg-green-500" : dotColor
                }`} />
                <div className="flex-1 min-w-0">
                  <p className={`text-xs font-medium truncate ${
                    isCurrent ? "text-fire-500" : isComplete ? "text-board-muted line-through" : "text-board-text/80"
                  }`}>
                    {event.title || "Untitled"}
                  </p>
                  {event.assignee && <p className="text-[10px] text-board-muted/40 truncate mt-0.5">{event.assignee}</p>}
                  {event.notes && <p className="text-[11px] text-board-muted/60 truncate mt-0.5">{event.notes}</p>}
                </div>

                <div className="text-right shrink-0">
                  <p className="text-[11px] text-board-muted tabular-nums">
                    <Clock className="w-2.5 h-2.5 inline mr-0.5 -mt-px" />
                    {formatDuration(event.duration)}
                  </p>
                </div>

                {isCurrent && <div className="w-1 h-8 rounded-full bg-fire-500 shrink-0" />}
              </div>
            );
          })}
        </div>
      )}
      </div>
    );

    return (
      <>
      {showFlash && <LiveFlash onDone={() => setShowFlash(false)} />}
      <ShowPageLayout
        activeTab={activeTab}
        onTabChange={setActiveTab}
        statusClock={formatTime(new Date(), clockFormat)}
        statusNode={(
          <div className="flex items-center gap-1.5">
            <span className={`w-1.5 h-1.5 rounded-full ${isPlaying ? "bg-green-500 animate-pulse" : "bg-green-500"}`} />
            <span className="text-xs text-board-muted">{isPlaying ? "Live" : "Native"}</span>
          </div>
        )}
        showPanel={showPanel}
        chatPanel={chatPanel}
        rundownPanel={rundownPanel}
        crewPanel={activeMembers.length > 0 ? <CrewTicker activeMembers={activeMembers} /> : null}
      />
    </>
  );
}

// ─── Show Page: OnTime Adapter ───────────────────────────────

function ShowPageWithOntime({
  ontimeState: initialOntime,
  members,
  activeMembers,
  chatAdapter,
  orgId,
  slug,
  clockFormat,
}: {
  ontimeState: OntimeRuntimeState;
  members: Awaited<ReturnType<typeof getCrewMembers>>;
  activeMembers: Awaited<ReturnType<typeof getCrewMembers>>;
  chatAdapter: ReturnType<typeof Route.useLoaderData>["chatAdapter"];
  orgId: string;
  slug: string;
  clockFormat: ClockFormat;
}) {
  const [ontime, setOntime] = useState<OntimeRuntimeState>(initialOntime);
  const [activeTab, setActiveTab] = useState<ShowTab>("show");
  const currentId = ontime.eventNow?.id;
  const isPlaying = ontime.timer.playback === "play";
  const isPaused = ontime.timer.playback === "pause";
  const isOvertime = ontime.timer.current !== null && ontime.timer.current < 0;

  // Poll OnTime
  useEffect(() => {
    const poll = async () => {
      try { setOntime(await getOntimeState({ data: { orgId } })); } catch {}
    };
    const interval = setInterval(poll, 1500);
    return () => clearInterval(interval);
  }, [orgId]);

  // Live flash
  const [showFlash, setShowFlash] = useState(false);
  const prevPlayback = useRef(ontime.timer.playback);
  useEffect(() => {
    if (ontime.timer.playback === "play" && prevPlayback.current !== "play") setShowFlash(true);
    prevPlayback.current = ontime.timer.playback;
  }, [ontime.timer.playback]);

  if (members.length === 0) return <EmptyState slug={slug} />;

    const showPanel = (
      <div className={`h-full rounded-xl border ${isOvertime ? "bg-red-500/5 border-red-500/20" : "bg-board-card border-board-border"} p-5`}>
      <div className="flex items-center gap-2 mb-2">
        {isPlaying ? (
          <Play className="w-3.5 h-3.5 text-green-400 fill-green-400" />
        ) : isPaused ? (
          <Pause className="w-3.5 h-3.5 text-yellow-400" />
        ) : (
          <Square className="w-3.5 h-3.5 text-board-muted" />
        )}
        <span className="text-[11px] font-medium text-board-muted uppercase tracking-widest">
          {ontime.timer.playback === "stop" ? "Stopped"
            : ontime.timer.playback === "armed" ? "Armed"
            : ontime.timer.playback === "roll" ? "Rolling"
            : isPlaying ? "Playing" : "Paused"}
        </span>
        {isOvertime && (
          <span className="text-[10px] font-bold text-red-400 uppercase tracking-wider ml-auto animate-pulse">Overtime</span>
        )}
      </div>

      <p className={`text-6xl font-semibold tabular-nums tracking-tight ${isOvertime ? "text-red-400" : "text-board-text"}`}>
        {formatOntimeDuration(ontime.timer.current)}
      </p>

      {ontime.eventNow && (
        <div className="mt-3 pt-3 border-t border-board-border/40">
          <p className="text-sm font-medium text-board-text truncate">{ontime.eventNow.title}</p>
          <p className="text-xs text-board-muted mt-0.5">
            {formatOntimeTime(ontime.eventNow.timeStart)} – {formatOntimeTime(ontime.eventNow.timeEnd)}
          </p>
        </div>
      )}

      {ontime.eventNext && (
        <p className="text-xs text-board-muted mt-2">
          Next: <span className="text-board-text/70">{ontime.eventNext.title}</span>
        </p>
      )}

    </div>
  );

  const chatPanel = (
    <div className="h-full min-h-0 flex flex-col overflow-hidden rounded-xl bg-board-card border border-board-border">
      <ChatPanel orgId={orgId} chatAdapter={chatAdapter} />
    </div>
  );

  const rundownPanel = (
    <div className="h-full min-h-0 flex flex-col overflow-hidden">
      <h2 className="text-[11px] font-medium text-board-muted uppercase tracking-widest mb-3 shrink-0">Rundown</h2>
      {ontime.events.length === 0 ? (
        <p className="text-center text-board-muted text-sm py-12">No events in the rundown</p>
      ) : (
        <div className="space-y-1 overflow-auto flex-1 hide-scrollbar pr-1">
          {ontime.events.map((event) => {
            const isCurrent = event.id === currentId;
            return (
              <div
                key={event.id}
                className={`flex items-center gap-2.5 xl:gap-3 px-3.5 xl:px-4 py-2.5 xl:py-3 rounded-lg border transition-colors ${
                  isCurrent
                    ? "bg-fire-500/8 border-fire-500/25"
                    : "bg-board-card/50 border-board-border/50 hover:border-board-border"
                }`}
              >
                <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: event.colour || (isCurrent ? "#ffc107" : "#444") }} />
                <div className="flex-1 min-w-0">
                  <p className={`text-xs xl:text-sm font-medium truncate ${isCurrent ? "text-fire-500" : "text-board-text/80"}`}>
                    {event.title || "Untitled"}
                  </p>
                  {event.note && <p className="text-[11px] xl:text-xs text-board-muted/60 truncate mt-0.5">{event.note}</p>}
                </div>
                <div className="text-right shrink-0">
                  <p className="text-[11px] xl:text-xs text-board-muted tabular-nums">{formatOntimeTime(event.timeStart)}</p>
                  <p className="text-[10px] text-board-muted/50 tabular-nums mt-0.5">
                    <Clock className="w-2.5 h-2.5 inline mr-0.5 -mt-px" />
                    {formatOntimeDuration(event.duration)}
                  </p>
                </div>
                {isCurrent && <div className="w-1 h-8 rounded-full bg-fire-500 shrink-0" />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );

  return (
    <>
      {showFlash && <LiveFlash onDone={() => setShowFlash(false)} />}
      <ShowPageLayout
        activeTab={activeTab}
        onTabChange={setActiveTab}
        statusClock={formatTime(new Date(), clockFormat)}
        statusNode={
          <div className="flex items-center gap-1.5">
            {ontime.connected ? (
              <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
            ) : (
              <WifiOff className="w-3.5 h-3.5 text-red-400" />
            )}
            <span className="text-xs text-board-muted">{ontime.connected ? (isPlaying ? "Live" : "OnTime") : "Offline"}</span>
          </div>
        }
        showPanel={showPanel}
        chatPanel={chatPanel}
        rundownPanel={rundownPanel}
        crewPanel={activeMembers.length > 0 ? <CrewTicker activeMembers={activeMembers} /> : null}
      />
    </>
  );
}

// ─── Shared Components ───────────────────────────────────────

function EmptyState({ slug }: { slug: string }) {
  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 flex items-center justify-center px-4">
        <div className="w-full max-w-lg animate-float-in">
          <div className="flex justify-center mb-8">
            <div className="relative">
              <div className="absolute inset-0 rounded-3xl bg-fire-500/10 blur-2xl scale-150" />
              <div className="relative w-20 h-20 rounded-2xl bg-gradient-to-br from-fire-500/20 to-fire-800/10 border border-fire-500/20 flex items-center justify-center">
                <Flame className="w-9 h-9 text-fire-500/70" />
              </div>
            </div>
          </div>
          <h2 className="text-center font-[family-name:var(--font-display)] text-2xl font-bold text-board-text mb-2">
            Your production board is ready
          </h2>
          <p className="text-center text-board-muted text-sm leading-relaxed max-w-sm mx-auto mb-10">
            Add your team members and they&apos;ll appear here in real time as they check in for service.
          </p>
          <div className="flex justify-center mb-12">
            <Link
              to="/$slug/admin" params={{ slug }}
              className="group flex items-center gap-2.5 px-6 py-3 rounded-xl font-[family-name:var(--font-display)] font-semibold text-black transition-all duration-200 hover:shadow-lg hover:shadow-fire-500/20 active:scale-[0.98]"
              style={{ background: "linear-gradient(135deg, #FFC107 0%, #FF8F00 100%)" }}
            >
              <UserPlus className="w-5 h-5" />
              Add Team Members
              <ArrowRight className="w-4 h-4 transition-transform duration-200 group-hover:translate-x-0.5" />
            </Link>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {[
              { icon: UserPlus, title: "Build your crew", desc: "Add names, roles, and photos for everyone on the team" },
              { icon: Radio, title: "Live check-in", desc: "Members scan a badge or tap in — status updates instantly" },
              { icon: LayoutDashboard, title: "See it all", desc: "Full-screen board shows who's on crew right now" },
            ].map((card) => (
              <div key={card.title} className="rounded-xl border border-board-border/60 bg-board-card/50 p-4 text-center">
                <div className="mx-auto mb-3 w-10 h-10 rounded-lg bg-fire-500/10 flex items-center justify-center">
                  <card.icon className="w-5 h-5 text-fire-500/70" />
                </div>
                <p className="text-sm font-medium text-board-text mb-1">{card.title}</p>
                <p className="text-xs text-board-muted leading-relaxed">{card.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function CrewTicker({ activeMembers }: { activeMembers: Awaited<ReturnType<typeof getCrewMembers>> }) {
  return (
    <footer className="shrink-0 border-t border-board-border py-2.5 overflow-hidden">
      <div className="flex items-center px-8">
        <div className="overflow-hidden flex-1">
          <div className="animate-scroll-left flex items-center gap-5 whitespace-nowrap">
            {[...activeMembers, ...activeMembers].map((member, i) => (
              <div key={`${member.id}-${i}`} className="flex items-center gap-1.5 shrink-0">
                <div className="w-5 h-5 rounded-full overflow-hidden bg-board-border shrink-0">
                  {member.photoUrl ? (
                    <img src={member.photoUrl} alt={member.name} className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-board-muted text-[9px] font-medium">
                      {member.name.split(" ").map((n) => n[0]).join("").slice(0, 2)}
                    </div>
                  )}
                </div>
                <span className="text-xs text-board-text/70">{member.name}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </footer>
  );
}
