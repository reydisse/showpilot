import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { getPrisma } from "@/lib/db";
import { getClockFormatBySlug } from "@/lib/settings";
import { formatClockFull, type ClockFormat } from "@/lib/utils";
import type { RundownItem, NativeTimerState, RundownState } from "@/types/rundown";
import type { PPSlidePayload } from "@/lib/rundown";

// ─── Server Functions ────────────────────────────────────────

const getRundownStateBySlug = createServerFn({ method: "GET" })
  .inputValidator((data: { orgSlug: string; serviceDate: string }) => data)
  .handler(async ({ data }): Promise<{ state: RundownState; message: string; ppSlide: PPSlidePayload | null } | null> => {
    const prisma = getPrisma();

    const org = await prisma.organization.findUnique({
      where: { slug: data.orgSlug },
    });
    if (!org) return null;

    const [itemsSetting, timerSetting, messageSetting, ppSlideSetting] = await Promise.all([
      prisma.appSetting.findUnique({
        where: {
          orgId_key: { orgId: org.id, key: `rundown-items:${data.serviceDate}` },
        },
      }),
      prisma.appSetting.findUnique({
        where: {
          orgId_key: { orgId: org.id, key: `rundown-timer:${data.serviceDate}` },
        },
      }),
      prisma.appSetting.findUnique({
        where: {
          orgId_key: { orgId: org.id, key: `rundown-message:${data.serviceDate}` },
        },
      }),
      prisma.appSetting.findUnique({
        where: {
          orgId_key: { orgId: org.id, key: `rundown-ppslide:${data.serviceDate}` },
        },
      }),
    ]);

    const items: RundownItem[] = itemsSetting
      ? JSON.parse(itemsSetting.value)
      : [];

    const defaultTimer: NativeTimerState = {
      playback: "stop",
      currentItemId: null,
      elapsed: 0,
      startedAt: null,
      pausedAt: null,
      mode: "count-down",
      serverTime: Date.now(),
    };

    const timer: NativeTimerState = timerSetting
      ? JSON.parse(timerSetting.value)
      : { ...defaultTimer, serverTime: Date.now() };

    const ppSlide: PPSlidePayload | null = ppSlideSetting
      ? JSON.parse(ppSlideSetting.value)
      : null;

    return {
      state: { items, timer },
      message: messageSetting?.value ?? "",
      ppSlide,
    };
  });

// ─── Route ───────────────────────────────────────────────────

export const Route = createFileRoute("/timer/$orgSlug")({
  component: TimerKioskPage,
});

// ─── Types ───────────────────────────────────────────────────

type ViewMode = "timer" | "minimal" | "stage";

/** OnTime-style color phases */
type TimerPhase = "normal" | "warning" | "danger" | "overtime";

// ─── Helpers ─────────────────────────────────────────────────

function getTodayDateString(): string {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatDurationHHMMSS(ms: number): string {
  const negative = ms < 0;
  const abs = Math.abs(ms);
  const totalSeconds = Math.floor(abs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const prefix = negative ? "-" : "";
  if (hours > 0) {
    return `${prefix}${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${prefix}${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatDurationShort(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}



function computeElapsed(timer: NativeTimerState, now: number): number {
  if (timer.playback === "stop") return timer.elapsed;
  if (timer.playback === "pause") return timer.elapsed;
  if (timer.playback === "play" && timer.startedAt != null) {
    const serverOffset = now - timer.serverTime;
    const running = timer.elapsed + serverOffset;
    return Math.max(0, running);
  }
  return timer.elapsed;
}

function computeRemaining(
  timer: NativeTimerState,
  currentItem: RundownItem | null,
  now: number
): number {
  if (!currentItem) return 0;
  const elapsed = computeElapsed(timer, now);
  return currentItem.duration - elapsed;
}

/**
 * OnTime-style phase calculation:
 * - normal:  > 2 minutes remaining
 * - warning: <= 2 minutes remaining (amber)
 * - danger:  <= 30 seconds remaining (red, slow blink)
 * - overtime: negative remaining (red, fast blink)
 */
function getTimerPhase(remaining: number, playback: string): TimerPhase {
  if (playback === "stop") return "normal";
  if (remaining < 0) return "overtime";
  if (remaining <= 30_000) return "danger";
  if (remaining <= 120_000) return "warning";
  return "normal";
}

// ─── Phase Colors ────────────────────────────────────────────

const PHASE_COLORS: Record<TimerPhase, {
  timer: string;
  bg: string;
  accent: string;
  progressFill: string;
}> = {
  normal: {
    timer: "#ffffff",
    bg: "#0a0a0a",
    accent: "#ffc107",
    progressFill: "#ffc107",
  },
  warning: {
    timer: "#f59e0b",
    bg: "#0a0a0a",
    accent: "#f59e0b",
    progressFill: "#f59e0b",
  },
  danger: {
    timer: "#ef4444",
    bg: "#0a0a0a",
    accent: "#ef4444",
    progressFill: "#ef4444",
  },
  overtime: {
    timer: "#ef4444",
    bg: "#1a0000",
    accent: "#ef4444",
    progressFill: "#ef4444",
  },
};

// ─── Styles ──────────────────────────────────────────────────

const COLORS = {
  bg: "#0a0a0a",
  text: "#ffffff",
  muted: "#666666",
  accent: "#ffc107",
  danger: "#ef4444",
  warning: "#f59e0b",
  green: "#22c55e",
  progressBg: "#222222",
  barBg: "rgba(255,255,255,0.04)",
  nextBg: "rgba(255,255,255,0.03)",
} as const;

const TIMER_CSS = `
  * { margin: 0; padding: 0; box-sizing: border-box; }

  html, body, #root {
    width: 100%;
    height: 100%;
    background: ${COLORS.bg};
    overflow: hidden;
    font-family: 'Inter', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    color: ${COLORS.text};
  }

  @keyframes blink-slow {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }

  @keyframes blink-fast {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.0; }
  }

  @keyframes blink-bg {
    0%, 100% { background-color: #1a0000; }
    50% { background-color: #300000; }
  }

  @keyframes pulse-glow {
    0%, 100% { text-shadow: 0 0 20px rgba(239, 68, 68, 0.3); }
    50% { text-shadow: 0 0 60px rgba(239, 68, 68, 0.8), 0 0 120px rgba(239, 68, 68, 0.4); }
  }

  @keyframes message-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.7; }
  }

  @keyframes progress-sweep {
    0% { width: 0%; opacity: 0.5; }
    100% { opacity: 1; }
  }

  .phase-normal {}
  .phase-warning { animation: none; }
  .phase-danger { animation: blink-slow 1s ease-in-out infinite; }
  .phase-overtime { animation: blink-fast 0.5s ease-in-out infinite; }

  .bg-overtime { animation: blink-bg 1s ease-in-out infinite; }

  .glow-overtime { animation: pulse-glow 1s ease-in-out infinite; }

  .message-bar { animation: message-pulse 2s ease-in-out infinite; }
`;

// ─── Main Component ──────────────────────────────────────────

function TimerKioskPage() {
  const { orgSlug } = Route.useParams();

  const viewMode: ViewMode = useMemo(() => {
    if (typeof window === "undefined") return "timer";
    const params = new URLSearchParams(window.location.search);
    const v = params.get("view");
    if (v === "minimal" || v === "stage") return v;
    return "timer";
  }, []);

  const [state, setState] = useState<RundownState | null>(null);
  const [stageMessage, setStageMessage] = useState("");
  const [messagePriority, setMessagePriority] = useState(false);
  const [ppSlide, setPpSlide] = useState<PPSlidePayload | null>(null);
  const [connected, setConnected] = useState(true);
  const [now, setNow] = useState(Date.now());
  const [clockFormat, setClockFormat] = useState<ClockFormat>("12hr");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const rafRef = useRef<number>(0);
  const serviceDate = useRef(getTodayDateString());

  // Fetch clock format once
  useEffect(() => {
    getClockFormatBySlug({ data: { orgSlug } }).then(setClockFormat).catch(() => {});
  }, [orgSlug]);

  // Track fullscreen state
  useEffect(() => {
    const handleChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", handleChange);
    return () => document.removeEventListener("fullscreenchange", handleChange);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
  }, []);

  // Poll server every 500ms for responsiveness
  const poll = useCallback(async () => {
    try {
      const result = await getRundownStateBySlug({
        data: { orgSlug, serviceDate: serviceDate.current },
      });
      if (result) {
        setState(result.state);
        // Parse priority flag from message
        if (result.message.startsWith("!!PRIORITY!!")) {
          setStageMessage(result.message.slice(12));
          setMessagePriority(true);
        } else {
          setStageMessage(result.message);
          setMessagePriority(false);
        }
        // PP slide data
        setPpSlide(result.ppSlide);
        setConnected(true);
      } else {
        setConnected(false);
      }
    } catch {
      setConnected(false);
    }
  }, [orgSlug]);

  useEffect(() => {
    poll();
    const interval = setInterval(poll, 500);
    return () => clearInterval(interval);
  }, [poll]);

  // RAF for smooth clock + timer rendering
  useEffect(() => {
    let running = true;
    const tick = () => {
      if (!running) return;
      const n = Date.now();
      setNow(n);

      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      running = false;
      cancelAnimationFrame(rafRef.current);
    };
  }, []);

  // Derived state
  const items = state?.items ?? [];
  const timer = state?.timer ?? null;

  const currentItem = useMemo(() => {
    if (!timer?.currentItemId) return null;
    return items.find((i) => i.id === timer.currentItemId) ?? null;
  }, [items, timer?.currentItemId]);

  const nextItem = useMemo(() => {
    if (!currentItem) {
      const upcoming = items.filter((i) => i.status === "upcoming");
      return upcoming.length > 0 ? upcoming[0] : null;
    }
    const currentIndex = items.findIndex((i) => i.id === currentItem.id);
    if (currentIndex === -1 || currentIndex >= items.length - 1) return null;
    return items[currentIndex + 1] ?? null;
  }, [items, currentItem]);

  const elapsed = timer ? computeElapsed(timer, now) : 0;
  const remaining = timer ? computeRemaining(timer, currentItem, now) : 0;
  const phase = timer ? getTimerPhase(remaining, timer.playback) : "normal";
  const phaseColors = PHASE_COLORS[phase];

  // Progress percentage — computed at 60fps from RAF-driven `now`
  const progress = currentItem && currentItem.duration > 0
    ? Math.min(100, (elapsed / currentItem.duration) * 100)
    : 0;

  const displayTime = useMemo(() => {
    if (!timer || !currentItem) return "00:00";
    if (timer.mode === "count-down") {
      return formatDurationHHMMSS(remaining);
    }
    return formatDurationHHMMSS(elapsed);
  }, [timer, currentItem, remaining, elapsed]);

  // Total elapsed across completed items + current
  const totalElapsed = useMemo(() => {
    let total = 0;
    for (const item of items) {
      if (item.status === "complete") {
        total += item.duration;
      }
    }
    if (currentItem) total += elapsed;
    return total;
  }, [items, currentItem, elapsed]);

  // ── Render by view mode ──

  if (viewMode === "minimal") {
    return <MinimalView displayTime={displayTime} phase={phase} phaseColors={phaseColors} currentItem={currentItem} stageMessage={stageMessage} messagePriority={messagePriority} ppSlide={ppSlide} isFullscreen={isFullscreen} toggleFullscreen={toggleFullscreen} progress={progress} />;
  }

  if (viewMode === "stage") {
    return (
      <StageView
        currentItem={currentItem}
        nextItem={nextItem}
        displayTime={displayTime}
        phase={phase}
        phaseColors={phaseColors}
        timer={timer}
        stageMessage={stageMessage}
        messagePriority={messagePriority}
        ppSlide={ppSlide}
        isFullscreen={isFullscreen}
        toggleFullscreen={toggleFullscreen}
        progress={progress}
      />
    );
  }

  return (
    <FullTimerView
      currentItem={currentItem}
      nextItem={nextItem}
      displayTime={displayTime}
      phase={phase}
      phaseColors={phaseColors}
      timer={timer}
      now={now}
      connected={connected}
      totalElapsed={totalElapsed}
      stageMessage={stageMessage}
      messagePriority={messagePriority}
      ppSlide={ppSlide}
      clockFormat={clockFormat}
      isFullscreen={isFullscreen}
      toggleFullscreen={toggleFullscreen}
      progress={progress}
    />
  );
}

// ─── Minimal View ────────────────────────────────────────────

function MinimalView({
  displayTime,
  phase,
  phaseColors,
  currentItem,
  stageMessage,
  messagePriority,
  ppSlide,
  isFullscreen,
  toggleFullscreen,
  progress,
}: {
  displayTime: string;
  phase: TimerPhase;
  phaseColors: typeof PHASE_COLORS.normal;
  currentItem: RundownItem | null;
  stageMessage: string;
  messagePriority: boolean;
  ppSlide: PPSlidePayload | null;
  isFullscreen: boolean;
  toggleFullscreen: () => void;
  progress: number;
}) {
  const isPriority = messagePriority && stageMessage;
  // PP slide takes over the priority space when active and no priority message
  const showPPSlide = ppSlide && ppSlide.text && !isPriority;

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: TIMER_CSS }} />
      <div
        className={phase === "overtime" ? "bg-overtime" : ""}
        style={{
          width: "100vw",
          height: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background: phaseColors.bg,
        }}
      >
        {/* Priority message — highest priority */}
        {isPriority && (
          <div
            className="message-bar"
            style={{
              marginBottom: "3vh",
              padding: "2vh 4vw",
              background: "rgba(255, 193, 7, 0.2)",
              border: "3px solid rgba(255, 193, 7, 0.5)",
              borderRadius: "12px",
              maxWidth: "85vw",
            }}
          >
            <div
              style={{
                fontSize: "min(12vw, 14vh)",
                fontWeight: 700,
                color: COLORS.accent,
                textAlign: "center",
                lineHeight: 1.1,
              }}
            >
              {stageMessage}
            </div>
          </div>
        )}

        {/* PP Slide content — shown when no priority message */}
        {showPPSlide && <PPSlideDisplay slide={ppSlide} size="large" />}

        <div
          className={`phase-${phase} ${phase === "overtime" ? "glow-overtime" : ""}`}
          style={{
            fontFamily: "'Inter', monospace",
            fontSize: isPriority || showPPSlide ? "min(8vw, 8vh)" : "min(20vw, 20vh)",
            fontWeight: 700,
            fontVariantNumeric: "tabular-nums",
            letterSpacing: "-0.02em",
            color: isPriority || showPPSlide ? "rgba(255,255,255,0.5)" : phaseColors.timer,
            transition: "font-size 0.4s ease",
          }}
        >
          {displayTime}
        </div>

        {/* Progress bar */}
        {currentItem && currentItem.duration > 0 && (
          <div
            style={{
              width: "min(60vw, 600px)",
              height: "min(0.6vh, 5px)",
              background: COLORS.progressBg,
              borderRadius: "3px",
              overflow: "hidden",
              marginTop: "3vh",
            }}
          >
            <div
              style={{
                width: `${progress}%`,
                height: "100%",
                background: phaseColors.progressFill,
                borderRadius: "3px",
                transition: "none",
              }}
            />
          </div>
        )}

        {/* Non-priority stage message */}
        {stageMessage && !isPriority && !showPPSlide && (
          <div
            className="message-bar"
            style={{
              marginTop: "4vh",
              padding: "1.5vh 4vw",
              background: "rgba(255, 193, 7, 0.15)",
              border: "2px solid rgba(255, 193, 7, 0.4)",
              borderRadius: "8px",
              maxWidth: "80vw",
            }}
          >
            <div
              style={{
                fontSize: "min(4vw, 4vh)",
                fontWeight: 600,
                color: COLORS.accent,
                textAlign: "center",
              }}
            >
              {stageMessage}
            </div>
          </div>
        )}

        {/* Fullscreen button */}
        <FullscreenButton isFullscreen={isFullscreen} toggleFullscreen={toggleFullscreen} />
      </div>
    </>
  );
}

// ─── Fullscreen Button ──────────────────────────────────────

function FullscreenButton({ isFullscreen, toggleFullscreen }: { isFullscreen: boolean; toggleFullscreen: () => void }) {
  return (
    <button
      onClick={toggleFullscreen}
      style={{
        position: "fixed",
        bottom: "2vh",
        right: "2vw",
        padding: "0.8vh 1.5vw",
        background: "rgba(255,255,255,0.06)",
        border: "1px solid rgba(255,255,255,0.1)",
        borderRadius: "8px",
        color: "rgba(255,255,255,0.4)",
        fontSize: "min(1.2vw, 1.5vh)",
        fontWeight: 500,
        cursor: "pointer",
        transition: "all 0.2s ease",
        zIndex: 50,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "rgba(255,255,255,0.1)";
        e.currentTarget.style.color = "rgba(255,255,255,0.7)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "rgba(255,255,255,0.06)";
        e.currentTarget.style.color = "rgba(255,255,255,0.4)";
      }}
    >
      {isFullscreen ? "⤡ Exit Fullscreen" : "⤢ Fullscreen"}
    </button>
  );
}

// ─── PP Slide Display ────────────────────────────────────────

function PPSlideDisplay({ slide, size }: { slide: PPSlidePayload; size: "large" | "small" }) {
  const isLarge = size === "large";
  const lines = slide.text.split("\n").filter(Boolean);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: isLarge ? "1.5vh" : "0.5vh",
        maxWidth: "90vw",
        textAlign: "center",
      }}
    >
      {/* Presentation name / reference */}
      {(slide.presentationName || slide.notes) && (
        <div
          style={{
            fontSize: isLarge ? "min(2vw, 2.5vh)" : "min(1.2vw, 1.5vh)",
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.1em",
            color: "rgba(255, 255, 255, 0.5)",
          }}
        >
          {slide.presentationName}
          {slide.notes && slide.presentationName ? " — " : ""}
          {slide.notes}
        </div>
      )}

      {/* Slide text */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: isLarge ? "0.8vh" : "0.3vh",
        }}
      >
        {lines.map((line, i) => (
          <div
            key={i}
            style={{
              fontSize: isLarge
                ? lines.length <= 2 ? "min(8vw, 10vh)" : lines.length <= 4 ? "min(5vw, 7vh)" : "min(3.5vw, 5vh)"
                : "min(2vw, 2.5vh)",
              fontWeight: 600,
              color: "#ffffff",
              lineHeight: 1.2,
            }}
          >
            {line}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Stage View ──────────────────────────────────────────────

function StageView({
  currentItem,
  nextItem,
  displayTime,
  phase,
  phaseColors,
  timer,
  stageMessage,
  messagePriority,
  ppSlide,
  isFullscreen,
  toggleFullscreen,
  progress,
}: {
  currentItem: RundownItem | null;
  nextItem: RundownItem | null;
  displayTime: string;
  phase: TimerPhase;
  phaseColors: typeof PHASE_COLORS.normal;
  timer: NativeTimerState | null;
  stageMessage: string;
  messagePriority: boolean;
  ppSlide: PPSlidePayload | null;
  isFullscreen: boolean;
  toggleFullscreen: () => void;
  progress: number;
}) {
  const isPriority = messagePriority && stageMessage;
  const showPPSlide = ppSlide && ppSlide.text && !isPriority;

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: TIMER_CSS }} />
      <div
        className={phase === "overtime" ? "bg-overtime" : ""}
        style={{
          width: "100vw",
          height: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background: phaseColors.bg,
          padding: "3vh 5vw",
          gap: "2vh",
        }}
      >
        {/* Stage message — large when priority */}
        {stageMessage && (
          <div
            className="message-bar"
            style={{
              padding: isPriority ? "3vh 4vw" : "2vh 4vw",
              background: isPriority ? "rgba(255, 193, 7, 0.2)" : "rgba(255, 193, 7, 0.15)",
              border: `3px solid rgba(255, 193, 7, ${isPriority ? "0.6" : "0.5"})`,
              borderRadius: "12px",
              maxWidth: "90vw",
              width: "100%",
              textAlign: "center",
            }}
          >
            <div
              style={{
                fontSize: isPriority ? "min(10vw, 14vh)" : "min(5vw, 6vh)",
                fontWeight: 700,
                color: COLORS.accent,
                lineHeight: 1.1,
                transition: "font-size 0.4s ease",
              }}
            >
              {stageMessage}
            </div>
          </div>
        )}

        {/* PP Slide content — shown when no priority message */}
        {showPPSlide && <PPSlideDisplay slide={ppSlide} size="large" />}

        {/* Current item title */}
        {!isPriority && !showPPSlide && (
          <div
            style={{
              fontSize: "min(4vw, 4.5vh)",
              fontWeight: 600,
              color: COLORS.text,
              textAlign: "center",
              maxWidth: "90vw",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {currentItem?.title ?? "No Active Item"}
          </div>
        )}

        {/* Timer — small when priority or PP slide */}
        <div
          className={`phase-${phase} ${phase === "overtime" ? "glow-overtime" : ""}`}
          style={{
            fontFamily: "'Inter', monospace",
            fontSize: isPriority || showPPSlide ? "min(6vw, 8vh)" : stageMessage ? "min(14vw, 22vh)" : "min(18vw, 30vh)",
            fontWeight: 700,
            fontVariantNumeric: "tabular-nums",
            letterSpacing: "-0.02em",
            lineHeight: 1,
            color: isPriority ? "rgba(255,255,255,0.5)" : phaseColors.timer,
            transition: "font-size 0.4s ease",
          }}
        >
          {currentItem ? displayTime : "--:--"}
        </div>

        {/* Progress bar */}
        {currentItem && currentItem.duration > 0 && (
          <div
            style={{
              width: "min(70vw, 800px)",
              height: "min(0.8vh, 6px)",
              background: COLORS.progressBg,
              borderRadius: "4px",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${progress}%`,
                height: "100%",
                background: phaseColors.progressFill,
                borderRadius: "4px",
                transition: "none",
              }}
            />
          </div>
        )}

        {/* Playback state indicator */}
        {timer && (
          <div
            style={{
              fontSize: "min(2vw, 2.5vh)",
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.15em",
              padding: "0.5vh 2vw",
              borderRadius: "6px",
              background:
                phase === "overtime"
                  ? "rgba(239, 68, 68, 0.2)"
                  : timer.playback === "play"
                    ? "rgba(34, 197, 94, 0.12)"
                    : timer.playback === "pause"
                      ? "rgba(255, 193, 7, 0.12)"
                      : "rgba(255,255,255,0.05)",
              color:
                phase === "overtime"
                  ? COLORS.danger
                  : timer.playback === "play"
                    ? COLORS.green
                    : timer.playback === "pause"
                      ? COLORS.accent
                      : COLORS.muted,
            }}
          >
            {phase === "overtime"
              ? "OVERTIME"
              : timer.playback === "play"
                ? "RUNNING"
                : timer.playback === "pause"
                  ? "PAUSED"
                  : "STOPPED"}
          </div>
        )}

        {/* Next item */}
        {nextItem && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "min(2vw, 1.5rem)",
              marginTop: "1vh",
            }}
          >
            <span
              style={{
                fontSize: "min(1.8vw, 2vh)",
                fontWeight: 700,
                color: COLORS.accent,
                textTransform: "uppercase",
                letterSpacing: "0.1em",
              }}
            >
              NEXT
            </span>
            <span
              style={{
                fontSize: "min(2.5vw, 3vh)",
                fontWeight: 500,
                color: COLORS.muted,
              }}
            >
              {nextItem.title}
            </span>
            <span
              style={{
                fontSize: "min(1.8vw, 2vh)",
                fontWeight: 400,
                color: COLORS.muted,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {formatDurationShort(nextItem.duration)}
            </span>
          </div>
        )}

        {/* Fullscreen button */}
        <FullscreenButton isFullscreen={isFullscreen} toggleFullscreen={toggleFullscreen} />
      </div>
    </>
  );
}

// ─── Full Timer View (OnTime-style) ─────────────────────────

function FullTimerView({
  currentItem,
  nextItem,
  displayTime,
  phase,
  phaseColors,
  timer,
  now,
  connected,
  totalElapsed,
  stageMessage,
  messagePriority,
  ppSlide,
  clockFormat,
  isFullscreen,
  toggleFullscreen,
  progress,
}: {
  currentItem: RundownItem | null;
  nextItem: RundownItem | null;
  displayTime: string;
  phase: TimerPhase;
  phaseColors: typeof PHASE_COLORS.normal;
  timer: NativeTimerState | null;
  now: number;
  connected: boolean;
  totalElapsed: number;
  stageMessage: string;
  messagePriority: boolean;
  ppSlide: PPSlidePayload | null;
  clockFormat: ClockFormat;
  isFullscreen: boolean;
  toggleFullscreen: () => void;
  progress: number;
}) {
  const clockTime = formatClockFull(new Date(now), clockFormat);

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: TIMER_CSS }} />
      <div
        className={phase === "overtime" ? "bg-overtime" : ""}
        style={{
          width: "100vw",
          height: "100vh",
          display: "flex",
          flexDirection: "column",
          background: phaseColors.bg,
          overflow: "hidden",
          transition: "background-color 0.3s ease",
        }}
      >
        {/* ── Top Bar ── */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "1.5vh 3vw",
            background: COLORS.barBg,
            borderBottom: `1px solid ${phase === "overtime" ? "rgba(239,68,68,0.2)" : "rgba(255,255,255,0.06)"}`,
            flexShrink: 0,
          }}
        >
          {/* Clock */}
          <div
            style={{
              fontSize: "min(3vw, 3.5vh)",
              fontWeight: 600,
              fontVariantNumeric: "tabular-nums",
              letterSpacing: "0.02em",
              color: COLORS.text,
            }}
          >
            {clockTime}
          </div>

          {/* Playback state badge + connection */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "1.5vw",
            }}
          >
            {timer && timer.playback !== "stop" && (
              <div
                style={{
                  fontSize: "min(1.4vw, 1.8vh)",
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: "0.12em",
                  padding: "0.4vh 1.2vw",
                  borderRadius: "4px",
                  color:
                    phase === "overtime" || phase === "danger"
                      ? "#ffffff"
                      : phase === "warning"
                        ? "#000000"
                        : "#ffffff",
                  background:
                    phase === "overtime"
                      ? COLORS.danger
                      : phase === "danger"
                        ? "rgba(239,68,68,0.8)"
                        : phase === "warning"
                          ? COLORS.warning
                          : timer.playback === "play"
                            ? COLORS.green
                            : COLORS.accent,
                }}
              >
                {phase === "overtime"
                  ? "OVERTIME"
                  : phase === "danger"
                    ? "ENDING"
                    : phase === "warning"
                      ? "WARNING"
                      : timer.playback === "play"
                        ? "LIVE"
                        : "PAUSED"}
              </div>
            )}
            <div
              style={{
                width: "10px",
                height: "10px",
                borderRadius: "50%",
                background: connected ? COLORS.green : COLORS.danger,
                boxShadow: connected
                  ? `0 0 6px rgba(34,197,94,0.5)`
                  : `0 0 6px rgba(239,68,68,0.5)`,
              }}
            />
          </div>
        </div>

        {/* ── Stage Message Bar ── */}
        {stageMessage && (
          <div
            className="message-bar"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: messagePriority ? "3vh 3vw" : "1.5vh 3vw",
              background: messagePriority ? "rgba(255, 193, 7, 0.18)" : "rgba(255, 193, 7, 0.12)",
              borderBottom: `2px solid rgba(255, 193, 7, ${messagePriority ? "0.5" : "0.3"})`,
              flexShrink: messagePriority ? 0 : 0,
              flex: messagePriority ? 1 : undefined,
              minHeight: messagePriority ? 0 : undefined,
              transition: "all 0.4s ease",
            }}
          >
            <div
              style={{
                fontSize: messagePriority ? "min(8vw, 12vh)" : "min(3vw, 3.5vh)",
                fontWeight: 700,
                color: COLORS.accent,
                textAlign: "center",
                lineHeight: 1.1,
                transition: "font-size 0.4s ease",
              }}
            >
              {stageMessage}
            </div>
          </div>
        )}

        {/* ── PP Slide Bar ── */}
        {ppSlide && ppSlide.text && !(messagePriority && stageMessage) && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "3vh 3vw",
              background: "rgba(255, 255, 255, 0.04)",
              borderBottom: "2px solid rgba(255, 255, 255, 0.08)",
              flex: 1,
              minHeight: 0,
              transition: "all 0.4s ease",
            }}
          >
            <PPSlideDisplay slide={ppSlide} size="large" />
          </div>
        )}

        {/* ── Main Timer Area ── */}
        <div
          style={{
            flex: (messagePriority && stageMessage) || (ppSlide && ppSlide.text) ? undefined : 1,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            padding: (messagePriority && stageMessage) || (ppSlide && ppSlide.text) ? "1vh 3vw" : "2vh 3vw",
            gap: (messagePriority && stageMessage) || (ppSlide && ppSlide.text) ? "0.5vh" : "1.5vh",
            minHeight: 0,
            transition: "all 0.4s ease",
          }}
        >
          {/* Current item title — hidden in priority/PP mode */}
          {!(messagePriority && stageMessage) && !(ppSlide && ppSlide.text) && (
            <div
              style={{
                fontSize: "min(3.5vw, 4vh)",
                fontWeight: 600,
                color: currentItem ? COLORS.text : COLORS.muted,
                textAlign: "center",
                maxWidth: "85vw",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                opacity: currentItem ? 1 : 0.6,
              }}
            >
              {currentItem?.title ?? "No Active Item"}
            </div>
          )}

          {/* Item type badge — hidden in priority/PP mode */}
          {currentItem && !(messagePriority && stageMessage) && !(ppSlide && ppSlide.text) && (
            <div
              style={{
                fontSize: "min(1.2vw, 1.5vh)",
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.15em",
                color: phaseColors.accent,
                opacity: 0.8,
              }}
            >
              {currentItem.type}
            </div>
          )}

          {/* Timer display — smaller when priority/PP active */}
          <div
            className={`phase-${phase} ${phase === "overtime" ? "glow-overtime" : ""}`}
            style={{
              fontFamily: "'Inter', monospace",
              fontSize: (messagePriority && stageMessage) || (ppSlide && ppSlide.text)
                ? "min(6vw, 8vh)"
                : stageMessage
                  ? "min(14vw, 18vh)"
                  : "min(16vw, 22vh)",
              fontWeight: 700,
              fontVariantNumeric: "tabular-nums",
              letterSpacing: "-0.02em",
              lineHeight: 1,
              color: (messagePriority && stageMessage) || (ppSlide && ppSlide.text) ? "rgba(255,255,255,0.5)" : phaseColors.timer,
              marginTop: (messagePriority && stageMessage) || (ppSlide && ppSlide.text) ? "0" : "1vh",
              marginBottom: (messagePriority && stageMessage) || (ppSlide && ppSlide.text) ? "0" : "1vh",
              transition: "font-size 0.4s ease, color 0.3s ease",
            }}
          >
            {currentItem ? displayTime : "--:--"}
          </div>

          {/* Progress bar — color matches phase, resets on item change */}
          {currentItem && currentItem.duration > 0 && (
            <div
              style={{
                width: "min(70vw, 800px)",
                height: "min(1vh, 8px)",
                background: COLORS.progressBg,
                borderRadius: "4px",
                overflow: "hidden",
                flexShrink: 0,
              }}
            >
              <div
                style={{
                  width: `${progress}%`,
                  height: "100%",
                  background: phaseColors.progressFill,
                  borderRadius: "4px",
                  transition: "none",
                }}
              />
            </div>
          )}
        </div>

        {/* ── Next Item ── */}
        {nextItem && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "min(2vw, 1.5rem)",
              padding: "2vh 3vw",
              background: COLORS.nextBg,
              borderTop: `1px solid ${phase === "overtime" ? "rgba(239,68,68,0.1)" : "rgba(255,255,255,0.04)"}`,
              flexShrink: 0,
            }}
          >
            <span
              style={{
                fontSize: "min(1.4vw, 1.8vh)",
                fontWeight: 700,
                color: COLORS.accent,
                textTransform: "uppercase",
                letterSpacing: "0.12em",
              }}
            >
              NEXT
            </span>
            <span
              style={{
                fontSize: "min(2vw, 2.5vh)",
                fontWeight: 500,
                color: "rgba(255,255,255,0.8)",
                maxWidth: "50vw",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {nextItem.title}
            </span>
            <span
              style={{
                fontSize: "min(1.6vw, 2vh)",
                fontWeight: 400,
                color: COLORS.muted,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {formatDurationShort(nextItem.duration)}
            </span>
          </div>
        )}

        {/* ── Bottom Bar ── */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "1.2vh 3vw",
            background: COLORS.barBg,
            borderTop: `1px solid ${phase === "overtime" ? "rgba(239,68,68,0.1)" : "rgba(255,255,255,0.06)"}`,
            flexShrink: 0,
          }}
        >
          {/* Total elapsed */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.8vw",
            }}
          >
            <span
              style={{
                fontSize: "min(1.2vw, 1.5vh)",
                fontWeight: 600,
                color: COLORS.muted,
                textTransform: "uppercase",
                letterSpacing: "0.1em",
              }}
            >
              ELAPSED
            </span>
            <span
              style={{
                fontSize: "min(1.6vw, 2vh)",
                fontWeight: 500,
                fontVariantNumeric: "tabular-nums",
                color: "rgba(255,255,255,0.6)",
              }}
            >
              {formatDurationHHMMSS(totalElapsed)}
            </span>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "1.5vw" }}>
            {/* ShowPilot branding */}
            <div
              style={{
                fontSize: "min(1vw, 1.2vh)",
                fontWeight: 500,
                color: "rgba(255,255,255,0.2)",
                letterSpacing: "0.1em",
                textTransform: "uppercase",
              }}
            >
              ShowPilot
            </div>

            {/* Fullscreen toggle */}
            <button
              onClick={toggleFullscreen}
              style={{
                padding: "0.4vh 1vw",
                background: "rgba(255,255,255,0.06)",
                border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: "4px",
                color: "rgba(255,255,255,0.35)",
                fontSize: "min(1vw, 1.2vh)",
                fontWeight: 500,
                cursor: "pointer",
                transition: "all 0.2s ease",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "rgba(255,255,255,0.1)";
                e.currentTarget.style.color = "rgba(255,255,255,0.6)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "rgba(255,255,255,0.06)";
                e.currentTarget.style.color = "rgba(255,255,255,0.35)";
              }}
            >
              {isFullscreen ? "⤡ Exit" : "⤢ Fullscreen"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
