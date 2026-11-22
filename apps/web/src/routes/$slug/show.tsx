import { useOperatorRead } from "@/hooks/useOperatorRead";
import { ReadFailureNotice } from "@/components/layout/ReadFailureNotice";
import { useDeviceTimeZone } from "@/hooks/useDeviceTimeZone";
import { createFileRoute } from "@tanstack/react-router";
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
  LayoutGrid,
  ChevronDown,
  Check,
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
import {
  computeShowPlan,
  dayTime,
  hoursClock,
  minutesClock,
  behindLabel,
  LayoutThumb,
  NoRundownCard,
  OfflineBanner,
  RundownCard,
  ShowFlowHeader,
  TimerCard,
  type HeaderStat,
  type StatusPillState,
  type TimerCardModel,
} from "@/components/show/show-flow-a";
import { FirstSessionChecklist } from "@/components/onboarding/FirstSessionChecklist";
import type { OntimeRuntimeState } from "@/types/ontime";
import type {
  RundownItem,
  NativeTimerState,
  RundownState,
} from "@/types/rundown";

// ─── Helpers ─────────────────────────────────────────────────


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
  { id: "balanced", label: "Default", description: "Timer, chat and rundown together", left: 60, top: 42 },
  { id: "show-focus", label: "Timer focus", description: "More space for the timer", left: 62, top: 70 },
  { id: "chat-focus", label: "Chat focus", description: "More space for team messages", left: 62, top: 24 },
  { id: "rundown-focus", label: "Rundown focus", description: "More space for the rundown", left: 25, top: 50 },
];


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
  onlineLabel,
}: {
  orgId: string;
  userName: string;
  userRole: string;
  userId: string;
  mentionMembers: ChatMemberSummary[];
  liveStatus?: string | null;
  /** "Rey Disse online" / "3 online", shown in the chat header. */
  onlineLabel?: string;
}) {
  const {
    messages,
    sendMessage,
    attachmentDraft, composer,
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
        attachmentDraft={attachmentDraft} composer={composer}
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
        title="Production Chat"
        subtitle={onlineLabel || userName}
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
  header,
  showPanel,
  chatPanel,
  rundownPanel,
  notices,
  rundownCount,
  empty = false,
}: {
  activeTab: ShowTab;
  onTabChange: (tab: ShowTab) => void;
  header: { dateLine: string; title: string; stats: HeaderStat[]; clock: string; status: StatusPillState };
  /** `wide` is true in the desktop grid (container ≥ 64rem), where layout presets apply. */
  showPanel: (layout: ShowLayoutPreset, wide: boolean) => ReactNode;
  chatPanel: ReactNode;
  rundownPanel: ReactNode;
  notices?: ReactNode;
  rundownCount?: number;
  /** No rundown attached: the timer slot shows the empty state and the rundown column is hidden. */
  empty?: boolean;
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
    applyStoredLayout(60, 42);
  };

  const panelsRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setWide(entry.contentRect.width >= 1024));
    observer.observe(root);
    return () => observer.disconnect();
  }, []);
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

  const leftWidthRef = useRef(60);
  const topHeightRef = useRef(42);

  const [leftWidthPercent, setLeftWidthPercent] = useState(60);
  const [topHeightPercent, setTopHeightPercent] = useState(42);
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

    // A named preset always uses its own proportions; only Custom keeps saved numbers.
    const presetValues = SHOW_LAYOUT_PRESETS.find((preset) => preset.id === savedPreset);
    if (presetValues) {
      applyStoredLayout(presetValues.left, presetValues.top);
      setLayoutPreset(presetValues.id);
      return;
    }
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

  const layoutLabel = layoutPreset === "custom"
    ? "Custom"
    : SHOW_LAYOUT_PRESETS.find((preset) => preset.id === layoutPreset)?.label;
  const layoutMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex h-9 min-w-[176px] items-center gap-2 rounded-lg border border-[var(--sa-border-strong)] bg-[var(--sa-surface-2)] px-3 text-left text-[13px] text-board-text hover:bg-[var(--sa-surface-3)] focus-visible:outline-2 focus-visible:outline-fire-500"
        >
          <LayoutGrid className="h-3.5 w-3.5 shrink-0 text-[var(--sa-ink-3)]" />
          <span className="min-w-0 flex-1 whitespace-nowrap">Layout: {layoutLabel}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--sa-ink-3)]" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" aria-label="Panel layout" className="schedule-a w-[340px] max-w-[calc(100vw-2rem)] rounded-xl border-[var(--sa-border-strong)] bg-[var(--sa-surface)] p-2 text-board-text">
        <p className="px-2 pb-2 pt-1 text-[11px] font-medium uppercase tracking-[0.07em] text-[var(--sa-ink-3)]">Layout</p>
        <DropdownMenuRadioGroup value={layoutPreset} onValueChange={value => {
          const preset = SHOW_LAYOUT_PRESETS.find(preset => preset.id === value);
          if (preset) chooseLayout(preset);
        }}>
          {SHOW_LAYOUT_PRESETS.map((preset) => (
            <DropdownMenuRadioItem
              key={preset.id}
              value={preset.id}
              className="flex items-center gap-3 rounded-lg p-2 focus:bg-[var(--sa-surface-2)] focus:text-board-text data-[state=checked]:bg-[var(--sa-surface-2)] [&>span:first-child]:hidden"
            >
              <LayoutThumb shape={preset.id} active={layoutPreset === preset.id} />
              <span className="min-w-0 flex-1"><span className="block text-[13px] font-semibold">{preset.label}</span><span className="block text-xs text-[var(--sa-ink-3)]">{preset.description}</span></span>
              {layoutPreset === preset.id ? <Check className="h-3.5 w-3.5 shrink-0 text-fire-500" /> : null}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <div className="my-1.5 h-px bg-[var(--sa-border)]" />
        <div className={`flex items-center gap-3 rounded-lg p-2 ${layoutPreset === "custom" ? "bg-[var(--sa-surface-2)]" : ""}`}>
          <LayoutThumb shape="custom" active={layoutPreset === "custom"} />
          <span className="min-w-0 flex-1"><span className="block text-[13px] font-semibold">Custom</span><span className="block text-xs text-[var(--sa-ink-3)]">{layoutPreset === "custom" ? "Your current arrangement" : "Drag a divider to arrange your own"}</span></span>
          {layoutPreset === "custom" ? <Check className="h-3.5 w-3.5 text-fire-500" /> : null}
        </div>
        <div className="flex justify-end px-1 pb-0.5 pt-1.5">
          <button type="button" onClick={resetStoredLayout} className="rounded-md px-2 py-1 text-xs text-[var(--sa-ink-2)] hover:bg-[var(--sa-surface-2)] hover:text-board-text">Reset to default</button>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
  const tabs: Array<{ id: Exclude<ShowTab, "show">; label: string; count?: string }> = [
    { id: "rundown", label: "Rundown", count: rundownCount ? String(rundownCount) : undefined },
    { id: "chat", label: "Chat" },
  ];
  const visibleTab = activeTab === "show" ? "rundown" : activeTab;

  return (
    <div className="schedule-a flex h-full min-h-0 flex-col overflow-x-hidden overflow-y-auto bg-board-bg">
      <div
        ref={rootRef}
        className="show-page-root flex-1"
        style={{ height: "auto", minHeight: "min(24rem, 60dvh)" }}
        data-show-tab={visibleTab}
        data-layout={layoutPreset}
        data-empty={empty ? "true" : undefined}
      >
        <div className="show-page-shell">
          <ShowFlowHeader {...header} layoutMenu={layoutMenu} />
          <div className="flex max-h-[40dvh] shrink-0 flex-col gap-2 overflow-y-auto empty:hidden">{notices}</div>

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
              {showPanel(layoutPreset, wide)}
            </section>
            <div className="show-page-tabs" role="tablist" aria-label="Show sections">
              {tabs.map(tab => (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={visibleTab === tab.id}
                  onClick={() => onTabChange(tab.id)}
                  className={`-mb-px inline-flex h-11 items-center gap-2 border-b-2 px-2 text-[13px] font-medium ${visibleTab === tab.id ? "border-board-text text-board-text" : "border-transparent text-[var(--sa-ink-2)] hover:text-board-text"}`}
                >
                  {tab.label}
                  {tab.count ? <span className="tabular-nums text-xs text-[var(--sa-ink-3)]">{tab.count}</span> : null}
                </button>
              ))}
            </div>
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
    errorMessage: "This change needs attention.",
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
    retryConnection,
    serviceName: syncedName,
    scheduledStartTime: syncedStartTime,
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
  // Show flash on transition to play
  const [showFlash, setShowFlash] = useState(false);
  const prevPlayback = useRef(timer.playback);
  useEffect(() => {
    if (timer.playback === "play" && prevPlayback.current !== "play")
      setShowFlash(true);
    prevPlayback.current = timer.playback;
  }, [timer.playback]);

  const hour12 = clockFormat === "12hr";
  const showName = (relayMatchesTarget && syncedName) || syncTarget.rundown?.meta?.name || "Show";
  const scheduledStart = (relayMatchesTarget && syncedStartTime !== undefined ? syncedStartTime : syncTarget.rundown?.meta?.scheduledStartTime) ?? null;
  const plan = computeShowPlan(items, scheduledStart);
  const running = !!currentItem && timer.playback !== "stop";
  // In clock mode the display ticks wall time, so derive the cue's own elapsed time.
  const cueElapsed = timer.mode === "clock"
    ? (isPlaying && timer.startedAt ? timer.elapsed + (displayTime - timer.startedAt) : timer.elapsed)
    : isPaused && timer.startedAt === null ? timer.elapsed : displayTime;
  const remainingMs = currentItem ? currentItem.duration - cueElapsed : 0;
  const startedAt = currentItem?.actualStart ? Date.parse(currentItem.actualStart) : statusNow - cueElapsed;
  const plannedCurrent = currentItem ? plan.starts.get(currentItem.id) ?? null : null;
  const rawBehind = running && plannedCurrent !== null ? startedAt - plannedCurrent + Math.max(0, -remainingMs) : null;
  // More than six hours off plan means the show is not running on its planned day; don't report a schedule delta.
  const behind = rawBehind !== null && Math.abs(rawBehind) <= 6 * 3_600_000 ? rawBehind : null;
  const projectedEnd = behind !== null && plan.plannedEnd !== null ? plan.plannedEnd + behind : null;
  const firstStart = items.map(item => item.actualStart ? Date.parse(item.actualStart) : NaN).filter(Number.isFinite).sort((a, b) => a - b)[0];
  const showElapsed = statusNow - (firstStart ?? startedAt);
  const firstCue = (currentItem && !running ? currentItem : null) ?? plan.cues.find(item => item.status !== "complete") ?? null;
  const later = currentItem ? plan.cues.slice(plan.cues.findIndex(item => item.id === currentItem.id) + 1) : [];
  const overtimeNote = currentItem && remainingMs < 0
    ? `${currentItem.title || "This cue"} is running ${minutesClock(-remainingMs)} long.${later.length && behind !== null && behind > 30_000
      ? ` ${later.length === 1 ? later[0].title : later.length === 2 ? `${later[0].title} and ${later[1].title}` : `${later[0].title} and the ${later.length - 1} cues after it`} will start about ${minutesClock(behind)} late${projectedEnd !== null ? `, so the show now ends around ${dayTime(projectedEnd, timeZone, hour12)} instead of ${dayTime(plan.plannedEnd, timeZone, hour12)}` : ""}.`
      : ""}`
    : null;
  const timerModel: TimerCardModel = running && currentItem
    ? {
        kind: "running",
        paused: isPaused,
        section: plan.sections.get(plan.sectionOf.get(currentItem.id) ?? "")?.title ?? null,
        cueIndex: plan.cues.findIndex(item => item.id === currentItem.id) + 1,
        cueCount: plan.cues.length,
        item: currentItem,
        remaining: remainingMs,
        progress: currentItem.duration > 0 ? Math.min(1, Math.max(0, cueElapsed / currentItem.duration)) : 0,
        elapsed: hoursClock(cueElapsed),
        started: dayTime(startedAt, timeZone, hour12),
        cueEnds: dayTime(startedAt + currentItem.duration, timeZone, hour12),
        planned: minutesClock(currentItem.duration),
        schedule: behind === null ? null : Math.abs(behind) < 30_000 ? "On time" : `${behind > 0 ? "+" : "−"}${behindLabel(behind)}`,
        scheduleTone: behind !== null && behind > 30_000 ? "warn" : "default",
        next: nextItem ?? null,
        overtimeNote,
      }
    : {
        kind: "ready",
        startsAt: plan.plannedStart !== null ? dayTime(plan.plannedStart, timeZone, hour12) : null,
        untilStart: plan.plannedStart !== null ? plan.plannedStart - statusNow : null,
        first: firstCue,
        firstLength: firstCue ? minutesClock(firstCue.duration) : "",
      };
  const offline = syncHydrated && !liveRundown;
  const status: StatusPillState = offline ? "offline" : running && remainingMs < 0 ? "over" : isPlaying ? "live" : isPaused ? "paused" : "ready";
  const headerStats: HeaderStat[] = running
    ? [
        { label: "Show elapsed", value: hoursClock(showElapsed) },
        ...(projectedEnd !== null ? [{ label: "Projected end", value: dayTime(projectedEnd, timeZone, hour12), tone: (behind ?? 0) > 30_000 ? "warn" as const : "default" as const }] : []),
      ]
    : [
        ...(plan.cues.length ? [{ label: "Runtime", value: hoursClock(plan.runtime) }] : []),
        ...(plan.plannedEnd !== null && plan.cues.length ? [{ label: "Planned end", value: dayTime(plan.plannedEnd, timeZone, hour12) }] : []),
      ];
  const onlineLabel = activeMembers.length === 0 ? "" : activeMembers.length === 1 ? `${activeMembers[0].name} online` : `${activeMembers.length} online`;

  const chatPanel = (
    <div className="h-full min-h-0 flex flex-col overflow-hidden rounded-xl border border-[var(--sa-border)] bg-[var(--sa-surface)]">
      <ChatPanel
        orgId={orgId}
        userName={userName}
        userId={userId}
        userRole={userRole}
        mentionMembers={chatMembers}
        liveStatus={null}
        onlineLabel={onlineLabel}
      />
    </div>
  );

  const rundownPanel = (
    <RundownCard
      items={items}
      plan={plan}
      currentId={running ? (currentItem?.id ?? null) : null}
      nextId={running ? (nextItem?.id ?? null) : (firstCue?.id ?? null)}
      timeZone={timeZone}
      hour12={hour12}
      running={running && behind !== null ? { label: behindLabel(behind), tone: behind > 30_000 ? "warn" : "default" } : null}
    />
  );

  return (
    <>
      {showFlash && <LiveFlash onDone={() => setShowFlash(false)} />}
      <ShowPageLayout
        notices={<>{crewNotice}<ReadFailureNotice {...targetRead} label="Retry show selection" />
          {offline ? <OfflineBanner onRetry={retryConnection} /> : null}
        </>}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        header={{
          dateLine: `Show flow · ${showDateLine(syncTarget.serviceDate)}`,
          title: showName,
          stats: headerStats,
          clock: formatTime(new Date(statusNow), clockFormat, timeZone),
          status,
        }}
        empty={items.length === 0}
        rundownCount={plan.cues.length}
        showPanel={(layout, wide) => items.length === 0 ? <NoRundownCard slug={slug} /> : <TimerCard model={timerModel} compact={wide && layout === "rundown-focus"} />}
        chatPanel={chatPanel}
        rundownPanel={rundownPanel}
      />
    </>
  );
}

function showDateLine(date: string) {
  const value = new Date(`${date}T12:00:00Z`);
  const part = (options: Intl.DateTimeFormatOptions) => value.toLocaleDateString("en-GB", { ...options, timeZone: "UTC" });
  return `${part({ weekday: "short" })} ${part({ day: "numeric" })} ${part({ month: "short" })} ${part({ year: "numeric" })}`;
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
          {timerRead.error && ""}
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
        onlineLabel={activeMembers.length === 1 ? `${activeMembers[0].name} online` : activeMembers.length ? `${activeMembers.length} online` : ""}
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
        header={{
          dateLine: "Show flow · OnTime",
          title: ontime.eventNow?.title || "Show flow",
          stats: [],
          clock: formatTime(new Date(statusNow), clockFormat, timeZone),
          status: timerRead.error ? "offline" : isOvertime ? "over" : isPlaying ? "live" : isPaused ? "paused" : "ready",
        }}
        rundownCount={ontime.events.length}
        showPanel={() => showPanel}
        chatPanel={chatPanel}
        rundownPanel={rundownPanel}
      />
    </>
  );
}
