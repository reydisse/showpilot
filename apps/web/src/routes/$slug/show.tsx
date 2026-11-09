import { useOperatorRead } from "@/hooks/useOperatorRead";
import { ReadFailureNotice } from "@/components/layout/ReadFailureNotice";
import { useDeviceTimeZone } from "@/hooks/useDeviceTimeZone";
import { createFileRoute, Link } from "@tanstack/react-router";
import { PageSkeleton } from "@/components/ui/Skeleton";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem } from "@/components/ui/dropdown-menu";
import {
  useState,
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  type CSSProperties,
} from "react";
import {
  Clock,
  Play,
  Pause,
  Square,
  Radio,
  WifiOff,
  LayoutGrid,
  ChevronDown,
} from "lucide-react";
import { getCrewMembers } from "@/lib/data";
import {
  getOntimeState,
  formatOntimeTime,
  formatDuration as formatOntimeDuration,
} from "@/lib/ontime";
import { getRundownOpeningDate, getShowRundownState } from "@/lib/rundown";
import {
  getActiveAdapters,
  getClockFormat,
  getOrgSettings,
  type RundownAdapterType,
} from "@/lib/settings";
import {
  getTodayDateString,
  formatTime,
  formatClockFull,
  type ClockFormat,
} from "@/lib/utils";
import { useRundownSync } from "@/hooks/useRundownSync";
import { nextPlayableItem } from "@/lib/rundown-transport";
import { useChat } from "@/hooks/useChat";
import { ChatPanel as SharedChatPanel } from "@/components/chat/ChatPanel";
import {
  getChatMembers,
  type ChatMemberSummary,
} from "@/lib/chat-collaboration";
import { ShowPageTabs } from "@/components/ui/ShowPageTabs";
import { FirstSessionChecklist } from "@/components/onboarding/FirstSessionChecklist";
import type { OntimeRuntimeState } from "@/types/ontime";
import type {
  RundownItem,
  NativeTimerState,
  RundownState,
} from "@/types/rundown";

// ─── Helpers ─────────────────────────────────────────────────

function formatDuration(ms: number): string {
  const negative = ms < 0;
  const abs = Math.abs(ms);
  const totalSeconds = Math.floor(abs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const prefix = negative ? "-" : "";
  if (hours > 0)
    return `${prefix}${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
  return `${prefix}${minutes}:${seconds.toString().padStart(2, "0")}`;
}

type ItemType =
  | "segment"
  | "song"
  | "prayer"
  | "announcement"
  | "offering"
  | "custom"
  | "header";
type ShowTab = "show" | "chat" | "rundown";
type ShowLayoutPreset =
  | "balanced"
  | "show-focus"
  | "chat-focus"
  | "rundown-focus"
  | "custom";

const SHOW_LAYOUT_PRESETS: Array<{
  id: Exclude<ShowLayoutPreset, "custom">;
  label: string;
  description: string;
  left: number;
  top: number;
}> = [
  { id: "balanced", label: "Default", description: "Timer, chat and rundown together", left: 40, top: 45 },
  { id: "show-focus", label: "Timer focus", description: "More space for the timer", left: 62, top: 70 },
  { id: "chat-focus", label: "Chat focus", description: "More space for team messages", left: 62, top: 24 },
  { id: "rundown-focus", label: "Rundown focus", description: "More space for the rundown", left: 25, top: 50 },
];

const TYPE_COLORS: Record<ItemType, string> = {
  header: "bg-board-muted",
  segment: "bg-blue-500",
  song: "bg-purple-500",
  prayer: "bg-pink-500",
  announcement: "bg-yellow-500",
  offering: "bg-green-500",
  custom: "bg-board-muted",
};

function useLiveNow(initialNow: number): number {
  const [now, setNow] = useState(initialNow);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const interval = window.setInterval(tick, 1_000);
    return () => window.clearInterval(interval);
  }, []);
  return now;
}

// ─── Route ───────────────────────────────────────────────────

export const Route = createFileRoute("/$slug/show")({
  pendingComponent: () => <PageSkeleton />,
  loader: async ({ context }) => {
    const { withPermission } = await import("@/lib/route-permissions");
    await withPermission(
      context.role,
      "show:view",
      context.slug,
      context.orgId,
    );
    const [members, chatMembers, adapters, clockFormat, settings] =
      await Promise.all([
        getCrewMembers({ data: { orgId: context.orgId } }),
        getChatMembers({ data: { orgId: context.orgId } }),
        getActiveAdapters({ data: { orgId: context.orgId } }),
        getClockFormat({ data: { orgId: context.orgId } }),
        getOrgSettings({ data: { orgId: context.orgId } }),
      ]);
    const today = getTodayDateString(settings["org-timezone"]);
    const { serviceDate, showId } = await getRundownOpeningDate({
      data: { orgId: context.orgId, today },
    });

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
        nativeRundown = await getShowRundownState({
          data: { orgId: context.orgId, serviceDate, showId },
        });
      }
    } else {
      // Native (or any other not-yet-implemented adapter)
      nativeRundown = await getShowRundownState({
        data: { orgId: context.orgId, serviceDate, showId },
      });
    }

    return {
      members,
      chatMembers,
      ontimeState,
      nativeRundown,
      rundownAdapter: effectiveRundownAdapter,
      orgId: context.orgId,
      slug: context.slug,
      serviceDate,
      showId,
      today,
      clockFormat,
      timeZone: settings["org-timezone"] || "UTC",
      initialNow: Date.now(),
      userName: context.user.name,
      userId: context.user.id,
      userRole: context.role,
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
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
    };
  }, []);

  return (
    <div
      className={`fixed inset-0 z-[100] flex items-center justify-center transition-opacity ${
        phase === "in"
          ? "opacity-0"
          : phase === "hold"
            ? "opacity-100"
            : "opacity-0"
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
          <span className="text-white/80 text-lg font-medium uppercase tracking-widest">
            On Air
          </span>
        </div>
      </div>
    </div>
  );
}

// ─── Chat Panel ───────────────────────────────────────────────

function ChatPanel({
  orgId,
  userName,
  userRole,
  userId,
  mentionMembers,
  liveStatus,
}: {
  orgId: string;
  userName: string;
  userRole: string;
  userId: string;
  mentionMembers: ChatMemberSummary[];
  liveStatus?: string | null;
}) {
  const {
    messages,
    sendMessage,
    uploadAttachment,
    discardAttachment,
    votePoll,
    setReaction,
    connectionStatus,
    connectionUpdatedAt,
    retryConnection,
    typingUsers,
    setTyping,
    gatewayStatus,
    hydrated,
    markRead,
    hasOlderMessages,
    loadingOlderMessages,
    olderMessagesError,
    loadOlderMessages,
    mutations, retryMutation, dismissMutation, notifications, retryNotifications,
    retryQueuedMessage,
    cancelQueuedMessage,
  } = useChat({
    orgId,
    isVisible: true,
    senderName: userName,
    senderRole: userRole,
    currentUserId: userId,
  });

  // Vibrate on new incoming chat message (two short pulses)
  const prevMessageCountRef = useRef(0);
  useEffect(() => {
    const prev = prevMessageCountRef.current;
    prevMessageCountRef.current = messages.length;
    if (messages.length > prev && prev > 0 && "vibrate" in navigator) {
      try {
        navigator.vibrate([100, 50, 100]);
      } catch {
        // Silently fail — vibration not supported or blocked
      }
    }
  }, [messages.length]);

  return (
    <div className="flex h-full w-full min-h-0 min-w-0 max-w-full flex-col overflow-hidden">
      <SharedChatPanel
        messages={messages}
        connectionStatus={connectionStatus}
        unreadCount={0}
        onSendMessage={sendMessage}
        onUploadAttachment={uploadAttachment}
        onDiscardAttachment={discardAttachment}
        gatewayStatus={gatewayStatus}
        hydrated={hydrated} connectionUpdatedAt={connectionUpdatedAt} onReconnect={retryConnection}
        onReadThrough={markRead}
        hasOlderMessages={hasOlderMessages}
        loadingOlderMessages={loadingOlderMessages}
        olderMessagesError={olderMessagesError}
        onLoadOlderMessages={loadOlderMessages}
        mutations={mutations} onRetryMutation={retryMutation} onDismissMutation={dismissMutation}
          notifications={notifications} onRetryNotifications={retryNotifications}
        onRetryQueuedMessage={retryQueuedMessage}
        onCancelQueuedMessage={cancelQueuedMessage}
        onVotePoll={votePoll}
        onSetReaction={setReaction}
        typingUsers={typingUsers}
        onTypingChange={setTyping}
        title="Team Chat"
        subtitle={userName}
        currentUserName={userName}
        currentUserId={userId}
        mentionMembers={mentionMembers.filter(
          (member) => member.userId !== userId,
        )}
        liveStatus={liveStatus}
        className="min-h-0 min-w-0 max-w-full flex-1 border-l-0"
      />
    </div>
  );
}

// ─── Show Page ────────────────────────────────────────────────

function ShowPage() {
  const {
    members: initialMembers,
    chatMembers,
    ontimeState,
    nativeRundown,
    rundownAdapter,
    orgId,
    slug,
    serviceDate,
    showId,
    today,
    clockFormat,
    initialNow,
    userName,
    userId,
    userRole,
  } = Route.useLoaderData();
  const timeZone = useDeviceTimeZone();
  const crewRead = useOperatorRead({
    key: orgId, initialValue: initialMembers, intervalMs: 3000,
    read: useCallback(signal => getCrewMembers({ data: { orgId }, signal }), [orgId]),
    errorMessage: "Crew status could not refresh. Showing the last confirmed presence.",
  });
  const members = crewRead.value;
  const crewNotice = <ReadFailureNotice {...crewRead} label="Retry crew status" />;

  const activeMembers = members.filter((m) => m.isOnline);

  // Determine which rundown mode to render
  if (rundownAdapter === "ontime" && ontimeState) {
    return (
      <>
        <ShowPageWithOntime
          key={orgId}
          crewNotice={crewNotice}
          ontimeState={ontimeState}
          activeMembers={activeMembers}
          orgId={orgId}
          clockFormat={clockFormat}
          timeZone={timeZone}
          initialNow={initialNow}
          userName={userName}
          userId={userId}
          userRole={userRole}
          chatMembers={chatMembers}
        />
        <FirstSessionChecklist orgId={orgId} slug={slug} userId={userId} />
      </>
    );
  }

  // Default: native rundown
  return (
    <>
      <ShowPageWithNative
        key={orgId}
        crewNotice={crewNotice}
        initialRundown={nativeRundown}
        activeMembers={activeMembers}
        orgId={orgId}
        serviceDate={serviceDate}
        showId={showId}
        today={today}
        slug={slug}
        clockFormat={clockFormat}
        timeZone={timeZone}
        initialNow={initialNow}
        userName={userName}
        userId={userId}
        userRole={userRole}
        chatMembers={chatMembers}
      />
      <FirstSessionChecklist orgId={orgId} slug={slug} userId={userId} />
    </>
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
  notices,
}: {
  activeTab: ShowTab;
  onTabChange: (tab: ShowTab) => void;
  statusClock: string;
  statusNode: ReactNode;
  showPanel: ReactNode;
  chatPanel: ReactNode;
  rundownPanel: ReactNode;
  crewPanel?: ReactNode;
  notices?: ReactNode;
}) {
  const STORAGE_LEFT_WIDTH = "show-page-left-width";
  const STORAGE_TOP_HEIGHT = "show-page-top-height";
  const STORAGE_LAYOUT_VERSION = "show-page-layout-version";
  const STORAGE_LAYOUT_PRESET = "show-page-layout-preset";
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
    window.localStorage.setItem(STORAGE_LAYOUT_PRESET, "balanced");
    window.localStorage.setItem(STORAGE_LAYOUT_VERSION, CURRENT_LAYOUT_VERSION);
    setLayoutPreset("balanced");
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
  const [layoutPreset, setLayoutPreset] =
    useState<ShowLayoutPreset>("balanced");

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
    const savedPreset = window.localStorage.getItem(
      STORAGE_LAYOUT_PRESET,
    ) as ShowLayoutPreset | null;

    if (Number.isFinite(savedLeft) && savedLeft >= 24 && savedLeft <= 72) {
      setLeftWidthPercent(savedLeft);
    }

    if (Number.isFinite(savedTop) && savedTop >= 20 && savedTop <= 80) {
      setTopHeightPercent(savedTop);
    }
    if (
      savedPreset &&
      [...SHOW_LAYOUT_PRESETS.map((preset) => preset.id), "custom"].includes(
        savedPreset,
      )
    ) {
      setLayoutPreset(savedPreset);
    }
  }, []);

  const clamp = (value: number, min: number, max: number) => {
    if (Number.isNaN(value)) return min;
    return Math.min(Math.max(value, min), max);
  };

  const chooseLayout = (preset: (typeof SHOW_LAYOUT_PRESETS)[number]) => {
    applyStoredLayout(preset.left, preset.top);
    setLayoutPreset(preset.id);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_LEFT_WIDTH, String(preset.left));
      window.localStorage.setItem(STORAGE_TOP_HEIGHT, String(preset.top));
      window.localStorage.setItem(STORAGE_LAYOUT_PRESET, preset.id);
      window.localStorage.setItem(
        STORAGE_LAYOUT_VERSION,
        CURRENT_LAYOUT_VERSION,
      );
    }
  };

  const beginResize =
    (mode: "horizontal" | "vertical") =>
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      const panels = panelsRef.current;
      if (!panels) return;

      const rect = panels.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;

      event.preventDefault();
      setLayoutPreset("custom");
      if (typeof window !== "undefined")
        window.localStorage.setItem(STORAGE_LAYOUT_PRESET, "custom");
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
        if (
          !state.mode ||
          state.pointerId == null ||
          moveEvent.pointerId !== state.pointerId
        )
          return;

        if (state.mode === "vertical") {
          const deltaX = moveEvent.clientX - state.startX;
          const nextWidth = clamp(
            state.startLeftWidth + (deltaX / state.baseWidth) * 100,
            24,
            72,
          );
          leftWidthRef.current = nextWidth;
          setLeftWidthPercent(nextWidth);
          return;
        }

        const deltaY = moveEvent.clientY - state.startY;
        const nextTop = clamp(
          state.startTopHeight + (deltaY / state.baseHeight) * 100,
          20,
          80,
        );
        topHeightRef.current = nextTop;
        setTopHeightPercent(nextTop);
      };

      const handleUp = (upEvent: PointerEvent) => {
        const state = resizeRef.current;
        if (state.pointerId == null || upEvent.pointerId !== state.pointerId)
          return;

        if (typeof window !== "undefined") {
          window.localStorage.setItem(
            STORAGE_LEFT_WIDTH,
            String(leftWidthRef.current),
          );
          window.localStorage.setItem(
            STORAGE_TOP_HEIGHT,
            String(topHeightRef.current),
          );
          window.localStorage.setItem(
            STORAGE_LAYOUT_VERSION,
            CURRENT_LAYOUT_VERSION,
          );
        }

        window.removeEventListener("pointermove", moveListenerRef.current);
        window.removeEventListener("pointerup", upListenerRef.current);
        window.removeEventListener("pointercancel", upListenerRef.current);
        resizeRef.current.mode = null;
        resizeRef.current.pointerId = null;
        if (
          state.source &&
          state.pointerId != null &&
          state.source.hasPointerCapture(state.pointerId)
        ) {
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
    <div className="flex h-full min-h-0 flex-col overflow-x-hidden overflow-y-auto">
      <div className="max-h-[40dvh] shrink-0 overflow-y-auto">{notices}</div>
      <div className="show-page-root flex-1" style={{ height: "auto", minHeight: "min(24rem, 60dvh)" }} data-show-tab={activeTab}>
        <div className="show-page-shell">
          <header className="show-page-header">
            <h1 className="text-sm font-medium text-board-text/70">
              Show Flow
            </h1>
            <div className="flex items-center gap-2 sm:gap-4">
              <div className="hidden sm:block">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className="flex min-h-11 items-center gap-1.5 rounded-md border border-board-border bg-board-card px-2.5 py-1.5 text-xs font-medium text-board-muted transition-colors hover:text-board-text focus-visible:outline-2 focus-visible:outline-fire-500"
                    >
                      <LayoutGrid className="h-3.5 w-3.5" />
                      <span>
                        Layout:{" "}
                        {layoutPreset === "custom"
                          ? "Custom"
                          : SHOW_LAYOUT_PRESETS.find(
                              (preset) => preset.id === layoutPreset,
                            )?.label}
                      </span>
                      <ChevronDown className="h-3 w-3" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" aria-label="Panel layout" className="w-72 max-w-[calc(100vw-2rem)] border-board-border bg-board-card text-board-text">
                    <DropdownMenuRadioGroup value={layoutPreset} onValueChange={value => {
                      const preset = SHOW_LAYOUT_PRESETS.find(preset => preset.id === value);
                      if (preset) chooseLayout(preset);
                    }}>
                      {SHOW_LAYOUT_PRESETS.map((preset) => (
                        <DropdownMenuRadioItem
                          key={preset.id}
                          value={preset.id}
                          className="min-h-11 py-2 focus:bg-board-border/50 focus:text-board-text"
                        >
                          <span><span className="block text-sm font-medium">{preset.label}</span><span className="block text-xs text-board-muted">{preset.description}</span></span>
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <span className="text-xs text-board-muted tabular-nums">
                {statusClock}
              </span>
              {statusNode}
            </div>
          </header>

          <ShowPageTabs activeTab={activeTab} onChange={onTabChange} />

          <main
            className="show-page-panels"
            ref={panelsRef}
            aria-live="polite"
            style={
              {
                "--show-page-left-width": `${leftWidthPercent}%`,
                "--show-page-top-height": `${topHeightPercent}%`,
              } as CSSProperties
            }
          >
            <section
              data-tab="show"
              className="show-page-tab-panel show-page-show-panel"
            >
              {showPanel}
            </section>
            <section
              data-tab="chat"
              className="show-page-tab-panel show-page-chat-panel"
            >
              {chatPanel}
            </section>
            <section
              data-tab="rundown"
              className="show-page-tab-panel show-page-rundown-panel"
            >
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

          {crewPanel && (
            <section className="show-page-crew-strip">{crewPanel}</section>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Show Page: Native Rundown ───────────────────────────────

function ShowPageWithNative({
  initialRundown,
  crewNotice,
  activeMembers,
  orgId,
  serviceDate,
  showId,
  today,
  slug,
  clockFormat,
  timeZone,
  initialNow,
  userName,
  userId,
  userRole,
  chatMembers,
}: {
  initialRundown: RundownState | null;
  crewNotice: ReactNode;
  activeMembers: Awaited<ReturnType<typeof getCrewMembers>>;
  orgId: string;
  serviceDate: string;
  showId?: string;
  today: string;
  slug: string;
  clockFormat: ClockFormat;
  timeZone: string;
  initialNow: number;
  userName: string;
  userId: string;
  userRole: string;
  chatMembers: ChatMemberSummary[];
}) {
  const statusNow = useLiveNow(initialNow);
  const [activeTab, setActiveTab] = useState<ShowTab>("show");
  const targetRead = useOperatorRead({
    key: `${orgId}:${today}`, initialValue: { serviceDate, showId, rundown: initialRundown }, intervalMs: 2000,
    read: useCallback(async (signal: AbortSignal, previous: { serviceDate: string; showId?: string; rundown: RundownState | null }) => {
      const opening = await getRundownOpeningDate({ data: { orgId, today }, signal });
      if (opening.serviceDate === previous.serviceDate && opening.showId === previous.showId) return previous;
      const rundown = await getShowRundownState({ data: { orgId, serviceDate: opening.serviceDate, showId: opening.showId }, signal });
      return { serviceDate: opening.serviceDate, showId: opening.showId, rundown };
    }, [orgId, today]),
    errorMessage: "The active show could not be confirmed. Showing the last confirmed rundown.",
  });
  const syncTarget = targetRead.value;

  // Real-time sync via RundownRelay Durable Object (replaces DB polling)
  const {
    items: syncedItems,
    timer: syncedTimer,
    hydrated: syncHydrated,
    stateInitialized: syncedInitialized,
    stateServiceDate: syncedServiceDate,
    stateShowId: syncedShowId,
    connected: syncConnected,
    lastError: syncError,
    lastErrorAt: syncErrorAt,
    retryConnection,
  } = useRundownSync(orgId, syncTarget.serviceDate, syncTarget.showId, "show");

  const relayMatchesTarget =
    syncHydrated &&
    syncedInitialized &&
    syncedServiceDate === syncTarget.serviceDate &&
    (!syncTarget.showId || syncedShowId === syncTarget.showId);

  // Use synced state when available, fall back to initial loader data
  // IMPORTANT: only use synced data after hydration (before that, syncedItems is [])
  const items: RundownItem[] = (
    relayMatchesTarget ? syncedItems : (syncTarget.rundown?.items ?? [])
  ) as RundownItem[];
  const timer: NativeTimerState = relayMatchesTarget
    ? {
        playback: syncedTimer.playback,
        currentItemId: syncedTimer.currentItemId,
        elapsed: syncedTimer.elapsed,
        startedAt: syncedTimer.startedAt,
        pausedAt: syncedTimer.pausedAt ?? null,
        mode: syncedTimer.mode ?? "count-down",
        serverTime: syncedTimer.serverTime ?? Date.now(),
      }
    : (syncTarget.rundown?.timer ?? {
        playback: "stop",
        currentItemId: null,
        elapsed: 0,
        startedAt: null,
        pausedAt: null,
        mode: "count-down",
        serverTime: Date.now(),
      });

  const [displayTime, setDisplayTime] = useState(0);
  const liveRundown = syncConnected && relayMatchesTarget && !targetRead.error;
  const isPlaying = timer.playback === "play";
  const isPaused = timer.playback === "pause";

  // Timer text is second-granular. A 10 Hz sample stays responsive while
  // avoiding a full show-page React render on every animation frame.
  useEffect(() => {
    if (!liveRundown) return;
    const tick = () => {
      if (timer.mode === "clock") {
        setDisplayTime(Date.now());
      } else if (timer.playback === "play" && timer.startedAt) {
        setDisplayTime(timer.elapsed + (Date.now() - timer.startedAt));
      } else {
        setDisplayTime(timer.elapsed);
      }
    };
    tick();
    const timerId = window.setInterval(tick, 100);
    return () => window.clearInterval(timerId);
  }, [liveRundown, timer.playback, timer.startedAt, timer.elapsed, timer.mode]);

  const currentItem = items.find((i) => i.id === timer.currentItemId);
  const nextItem = nextPlayableItem(items, timer.currentItemId);
  const remaining =
    currentItem && timer.mode === "count-down"
      ? currentItem.duration -
        (timer.playback === "pause" && timer.startedAt === null
          ? timer.elapsed
          : displayTime)
      : 0;
  const isOvertime = timer.mode === "count-down" && remaining < 0;
  const timerDisplay = currentItem
    ? timer.mode === "clock"
      ? formatClockFull(new Date(displayTime), clockFormat, timeZone)
      : timer.mode === "count-down"
        ? formatDuration(remaining)
        : formatDuration(displayTime)
    : "--:--";
  const progressPercent =
    currentItem && timer.mode !== "clock"
      ? Math.min(100, (Math.max(0, displayTime) / currentItem.duration) * 100)
      : 0;

  // Show flash on transition to play
  const [showFlash, setShowFlash] = useState(false);
  const prevPlayback = useRef(timer.playback);
  useEffect(() => {
    if (timer.playback === "play" && prevPlayback.current !== "play")
      setShowFlash(true);
    prevPlayback.current = timer.playback;
  }, [timer.playback]);

  const showPanel = (
    <div
      className={`h-full rounded-xl border ${isOvertime ? "bg-red-500/5 border-red-500/20" : "bg-board-card border-board-border"} p-5`}
    >
      <div className="flex items-center gap-2 mb-2">
        {isPlaying ? (
          <Play className="w-3.5 h-3.5 text-green-400 fill-green-400" />
        ) : isPaused ? (
          <Pause className="w-3.5 h-3.5 text-yellow-400" />
        ) : (
          <Square className="w-3.5 h-3.5 text-board-muted" />
        )}
        <span className="text-[11px] font-medium text-board-muted uppercase tracking-widest">
          {!liveRundown && "Last confirmed: "}
          {timer.playback === "stop"
            ? "Stopped"
            : isPlaying
              ? "Playing"
              : "Paused"}
        </span>
        {isOvertime && (
          <span className="text-[10px] font-bold text-red-400 uppercase tracking-wider ml-auto animate-pulse">
            Overtime
          </span>
        )}
      </div>

      <p
        aria-label="Show timer"
        className={`text-6xl font-semibold tabular-nums tracking-tight ${isOvertime ? "text-red-400" : isPlaying ? "text-board-text" : "text-board-muted"}`}
      >
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
          <p className="text-sm font-medium text-board-text truncate">
            {currentItem.title}
          </p>
          <p className="text-xs text-board-muted mt-0.5">
            Duration: {formatDuration(currentItem.duration)}
            {currentItem.assignee && ` · ${currentItem.assignee}`}
          </p>
        </div>
      )}

      {nextItem && (
        <p className="text-xs text-board-muted mt-2">
          Next: <span className="text-board-text/70">{nextItem.title}</span>
          <span className="text-board-muted/50 ml-1">
            ({formatDuration(nextItem.duration)})
          </span>
        </p>
      )}
    </div>
  );

  const chatPanel = (
    <div className="h-full min-h-0 flex flex-col overflow-hidden rounded-xl bg-board-card border border-board-border">
      <ChatPanel
        orgId={orgId}
        userName={userName}
        userId={userId}
        userRole={userRole}
        mentionMembers={chatMembers}
        liveStatus={isPlaying ? (currentItem?.title ?? null) : null}
      />
    </div>
  );

  const rundownPanel = (
    <div className="h-full min-h-0 flex flex-col overflow-hidden">
      <h2 className="text-[11px] font-medium text-board-muted uppercase tracking-widest mb-3 shrink-0">
        Rundown
      </h2>
      {items.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-3">
          <Clock className="w-8 h-8 text-board-muted/20" />
          <p className="text-sm text-board-muted">No items in the rundown</p>
          <p className="text-xs text-board-muted/50">
            Add items in the{" "}
            <Link
              to="/$slug/rundown"
              params={{ slug }}
              className="text-fire-500 hover:text-fire-400"
            >
              Rundown Editor
            </Link>
          </p>
        </div>
      ) : (
        <div className="space-y-1 overflow-auto flex-1 hide-scrollbar pr-1">
          {items.map((event) => {
            const isCurrent = event.id === timer.currentItemId;
            const isComplete = event.status === "complete";
            const dotColor =
              TYPE_COLORS[event.type as ItemType] ?? "bg-board-muted";

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
                <div
                  className={`w-2 h-2 rounded-full shrink-0 ${
                    isCurrent
                      ? "bg-fire-500 animate-pulse"
                      : isComplete
                        ? "bg-green-500"
                        : dotColor
                  }`}
                />
                <div className="flex-1 min-w-0">
                  <p
                    className={`text-xs font-medium truncate ${
                      isCurrent
                        ? "text-fire-500"
                        : isComplete
                          ? "text-board-muted line-through"
                          : "text-board-text/80"
                    }`}
                  >
                    {event.title || "Untitled"}
                  </p>
                  {event.assignee && (
                    <p className="text-[10px] text-board-muted/40 truncate mt-0.5">
                      {event.assignee}
                    </p>
                  )}
                  {event.notes && (
                    <p className="text-[11px] text-board-muted/60 truncate mt-0.5">
                      {event.notes}
                    </p>
                  )}
                </div>

                <div className="text-right shrink-0">
                  <p className="text-[11px] text-board-muted tabular-nums">
                    <Clock className="w-2.5 h-2.5 inline mr-0.5 -mt-px" />
                    {formatDuration(event.duration)}
                  </p>
                </div>

                {isCurrent && (
                  <div className="w-1 h-8 rounded-full bg-fire-500 shrink-0" />
                )}
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
        notices={<>{crewNotice}<ReadFailureNotice {...targetRead} label="Retry show selection" />
          <ReadFailureNotice error={syncError && syncErrorAt !== null ? { message: syncError, occurredAt: syncErrorAt } : null} refreshing={false} retry={retryConnection} label="Reconnect show" />
          {!liveRundown && <p role="status" aria-live="polite" className="px-4 py-2 text-sm text-amber-200">{syncHydrated ? "Reconnecting, showing last known rundown state." : "Connecting to the live rundown…"}</p>}
        </>}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        statusClock={formatTime(new Date(statusNow), clockFormat, timeZone)}
        statusNode={
          <div className="flex items-center gap-1.5">
            <span
              className={`w-1.5 h-1.5 rounded-full ${!liveRundown ? "bg-amber-400" : isPlaying ? "bg-green-500 animate-pulse" : "bg-green-500"}`}
            />
            <span className="text-xs text-board-muted">
              {!liveRundown ? syncHydrated ? "Reconnecting" : "Connecting" : isPlaying ? "Live" : "Ready"}
            </span>
          </div>
        }
        showPanel={showPanel}
        chatPanel={chatPanel}
        rundownPanel={rundownPanel}
        crewPanel={
          activeMembers.length > 0 ? (
            <CrewTicker activeMembers={activeMembers} />
          ) : null
        }
      />
    </>
  );
}

// ─── Show Page: OnTime Adapter ───────────────────────────────

function ShowPageWithOntime({
  ontimeState: initialOntime,
  crewNotice,
  activeMembers,
  orgId,
  clockFormat,
  timeZone,
  initialNow,
  userName,
  userId,
  userRole,
  chatMembers,
}: {
  ontimeState: OntimeRuntimeState;
  crewNotice: ReactNode;
  activeMembers: Awaited<ReturnType<typeof getCrewMembers>>;
  orgId: string;
  clockFormat: ClockFormat;
  timeZone: string;
  initialNow: number;
  userName: string;
  userId: string;
  userRole: string;
  chatMembers: ChatMemberSummary[];
}) {
  const statusNow = useLiveNow(initialNow);
  const timerRead = useOperatorRead({
    key: orgId, initialValue: initialOntime, intervalMs: 1500,
    read: useCallback(async (signal: AbortSignal) => {
      const result = await getOntimeState({ data: { orgId }, signal });
      if (!result.connected) throw new Error("Timer feed unavailable");
      return result;
    }, [orgId]),
    errorMessage: "Timer feed could not refresh. Showing the last confirmed timer.",
  });
  const ontime = timerRead.value;
  const [activeTab, setActiveTab] = useState<ShowTab>("show");
  const currentId = ontime.eventNow?.id;
  const isPlaying = ontime.timer.playback === "play";
  const isPaused = ontime.timer.playback === "pause";
  const isOvertime = ontime.timer.current !== null && ontime.timer.current < 0;

  // Live flash
  const [showFlash, setShowFlash] = useState(false);
  const prevPlayback = useRef(ontime.timer.playback);
  useEffect(() => {
    if (ontime.timer.playback === "play" && prevPlayback.current !== "play")
      setShowFlash(true);
    prevPlayback.current = ontime.timer.playback;
  }, [ontime.timer.playback]);

  const showPanel = (
    <div
      className={`h-full rounded-xl border ${isOvertime ? "bg-red-500/5 border-red-500/20" : "bg-board-card border-board-border"} p-5`}
    >
      <div className="flex items-center gap-2 mb-2">
        {isPlaying ? (
          <Play className="w-3.5 h-3.5 text-green-400 fill-green-400" />
        ) : isPaused ? (
          <Pause className="w-3.5 h-3.5 text-yellow-400" />
        ) : (
          <Square className="w-3.5 h-3.5 text-board-muted" />
        )}
        <span className="text-[11px] font-medium text-board-muted uppercase tracking-widest">
          {timerRead.error && "Last confirmed: "}
          {ontime.timer.playback === "stop"
            ? "Stopped"
            : ontime.timer.playback === "armed"
              ? "Armed"
              : ontime.timer.playback === "roll"
                ? "Rolling"
                : isPlaying
                  ? "Playing"
                  : "Paused"}
        </span>
        {isOvertime && (
          <span className="text-[10px] font-bold text-red-400 uppercase tracking-wider ml-auto animate-pulse">
            Overtime
          </span>
        )}
      </div>

      <p
        aria-label="Show timer"
        className={`text-6xl font-semibold tabular-nums tracking-tight ${isOvertime ? "text-red-400" : "text-board-text"}`}
      >
        {formatOntimeDuration(ontime.timer.current)}
      </p>

      {ontime.eventNow && (
        <div className="mt-3 pt-3 border-t border-board-border/40">
          <p className="text-sm font-medium text-board-text truncate">
            {ontime.eventNow.title}
          </p>
          <p className="text-xs text-board-muted mt-0.5">
            {formatOntimeTime(ontime.eventNow.timeStart)} –{" "}
            {formatOntimeTime(ontime.eventNow.timeEnd)}
          </p>
        </div>
      )}

      {ontime.eventNext && (
        <p className="text-xs text-board-muted mt-2">
          Next:{" "}
          <span className="text-board-text/70">{ontime.eventNext.title}</span>
        </p>
      )}
    </div>
  );

  const chatPanel = (
    <div className="h-full min-h-0 flex flex-col overflow-hidden rounded-xl bg-board-card border border-board-border">
      <ChatPanel
        orgId={orgId}
        userName={userName}
        userId={userId}
        userRole={userRole}
        mentionMembers={chatMembers}
        liveStatus={isPlaying ? (ontime.eventNow?.title ?? null) : null}
      />
    </div>
  );

  const rundownPanel = (
    <div className="h-full min-h-0 flex flex-col overflow-hidden">
      <h2 className="text-[11px] font-medium text-board-muted uppercase tracking-widest mb-3 shrink-0">
        Rundown
      </h2>
      {ontime.events.length === 0 ? (
        <p className="text-center text-board-muted text-sm py-12">
          No events in the rundown
        </p>
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
                <div
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{
                    backgroundColor:
                      event.colour || (isCurrent ? "#ffc107" : "#444"),
                  }}
                />
                <div className="flex-1 min-w-0">
                  <p
                    className={`text-xs xl:text-sm font-medium truncate ${isCurrent ? "text-fire-500" : "text-board-text/80"}`}
                  >
                    {event.title || "Untitled"}
                  </p>
                  {event.note && (
                    <p className="text-[11px] xl:text-xs text-board-muted/60 truncate mt-0.5">
                      {event.note}
                    </p>
                  )}
                </div>
                <div className="text-right shrink-0">
                  <p className="text-[11px] xl:text-xs text-board-muted tabular-nums">
                    {formatOntimeTime(event.timeStart)}
                  </p>
                  <p className="text-[10px] text-board-muted/50 tabular-nums mt-0.5">
                    <Clock className="w-2.5 h-2.5 inline mr-0.5 -mt-px" />
                    {formatOntimeDuration(event.duration)}
                  </p>
                </div>
                {isCurrent && (
                  <div className="w-1 h-8 rounded-full bg-fire-500 shrink-0" />
                )}
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
        notices={<>{crewNotice}<ReadFailureNotice {...timerRead} label="Retry timer feed" /></>}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        statusClock={formatTime(new Date(statusNow), clockFormat, timeZone)}
        statusNode={
          <div className="flex items-center gap-1.5">
            {!timerRead.error ? (
              <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
            ) : (
              <WifiOff className="w-3.5 h-3.5 text-red-400" />
            )}
            <span className="text-xs text-board-muted">
              {timerRead.error ? "Reconnecting" : isPlaying ? "Live" : "Ready"}
            </span>
          </div>
        }
        showPanel={showPanel}
        chatPanel={chatPanel}
        rundownPanel={rundownPanel}
        crewPanel={
          activeMembers.length > 0 ? (
            <CrewTicker activeMembers={activeMembers} />
          ) : null
        }
      />
    </>
  );
}

// ─── Shared Components ───────────────────────────────────────

function CrewTicker({
  activeMembers,
}: {
  activeMembers: Awaited<ReturnType<typeof getCrewMembers>>;
}) {
  return (
    <footer className="shrink-0 border-t border-board-border py-2.5 overflow-hidden">
      <div className="flex items-center px-8">
        <div className="overflow-hidden flex-1">
          <div className="animate-scroll-left flex items-center gap-5 whitespace-nowrap">
            {[...activeMembers, ...activeMembers].map((member, i) => (
              <div
                key={`${member.id}-${i}`}
                className="flex items-center gap-1.5 shrink-0"
              >
                <div className="w-5 h-5 rounded-full overflow-hidden bg-board-border shrink-0">
                  {member.photoUrl ? (
                    <img
                      src={member.photoUrl}
                      alt={member.name}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-board-muted text-[9px] font-medium">
                      {member.name
                        .split(" ")
                        .map((n) => n[0])
                        .join("")
                        .slice(0, 2)}
                    </div>
                  )}
                </div>
                <span className="text-xs text-board-text/70">
                  {member.name}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </footer>
  );
}
