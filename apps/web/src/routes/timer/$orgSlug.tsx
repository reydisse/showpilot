import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { getPrisma } from "@/lib/db";
import type { RundownItem, NativeTimerState, RundownState } from "@/types/rundown";

// ─── Server Function: Get Rundown State by Org Slug ──────────

const getRundownStateBySlug = createServerFn({ method: "GET" })
  .inputValidator((data: { orgSlug: string; serviceDate: string }) => data)
  .handler(async ({ data }): Promise<RundownState | null> => {
    const prisma = getPrisma();

    const org = await prisma.organization.findUnique({
      where: { slug: data.orgSlug },
    });
    if (!org) return null;

    const [itemsSetting, timerSetting] = await Promise.all([
      prisma.appSetting.findUnique({
        where: {
          orgId_key: {
            orgId: org.id,
            key: `rundown-items:${data.serviceDate}`,
          },
        },
      }),
      prisma.appSetting.findUnique({
        where: {
          orgId_key: {
            orgId: org.id,
            key: `rundown-timer:${data.serviceDate}`,
          },
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

    return { items, timer };
  });

// ─── Route ───────────────────────────────────────────────────

export const Route = createFileRoute("/timer/$orgSlug")({
  component: TimerKioskPage,
});

// ─── Types ───────────────────────────────────────────────────

type ViewMode = "timer" | "minimal" | "stage";

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

function formatClockHHMMSS(date: Date): string {
  const h = String(date.getHours()).padStart(2, "0");
  const m = String(date.getMinutes()).padStart(2, "0");
  const s = String(date.getSeconds()).padStart(2, "0");
  return `${h}:${m}:${s}`;
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

// ─── Styles (inline, self-contained) ─────────────────────────

const COLORS = {
  bg: "#0a0a0a",
  text: "#ffffff",
  muted: "#666666",
  accent: "#ffc107",
  danger: "#ef4444",
  progressBg: "#222222",
  progressFill: "#ffc107",
  barBg: "rgba(255,255,255,0.04)",
  nextBg: "rgba(255,255,255,0.03)",
  messageBg: "rgba(255,193,7,0.12)",
  messageBorder: "#ffc107",
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

  @keyframes pulse-overtime {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.7; }
  }
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
  const [connected, setConnected] = useState(true);
  const [now, setNow] = useState(Date.now());
  const rafRef = useRef<number>(0);
  const serviceDate = useRef(getTodayDateString());

  // Poll server every 1s
  const poll = useCallback(async () => {
    try {
      const result = await getRundownStateBySlug({
        data: { orgSlug, serviceDate: serviceDate.current },
      });
      if (result) {
        setState(result);
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
    const interval = setInterval(poll, 1000);
    return () => clearInterval(interval);
  }, [poll]);

  // RAF for smooth clock + timer rendering
  useEffect(() => {
    let running = true;
    const tick = () => {
      if (!running) return;
      setNow(Date.now());
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
  const isOvertime = remaining < 0 && timer?.playback === "play";
  const duration = currentItem?.duration ?? 0;
  const progress = duration > 0 ? Math.min(1, elapsed / duration) : 0;

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
    return renderMinimalView(displayTime, isOvertime);
  }

  if (viewMode === "stage") {
    return renderStageView(
      currentItem,
      nextItem,
      displayTime,
      isOvertime,
      timer
    );
  }

  return renderTimerView(
    currentItem,
    nextItem,
    displayTime,
    isOvertime,
    progress,
    timer,
    now,
    connected,
    totalElapsed
  );
}

// ─── Minimal View ────────────────────────────────────────────

function renderMinimalView(displayTime: string, isOvertime: boolean) {
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: TIMER_CSS }} />
      <div
        style={{
          width: "100vw",
          height: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: COLORS.bg,
        }}
      >
        <div
          style={{
            fontFamily: "'Inter', monospace",
            fontSize: "min(20vw, 20vh)",
            fontWeight: 700,
            fontVariantNumeric: "tabular-nums",
            letterSpacing: "-0.02em",
            color: isOvertime ? COLORS.danger : COLORS.text,
            animation: isOvertime ? "pulse-overtime 1s ease-in-out infinite" : "none",
          }}
        >
          {displayTime}
        </div>
      </div>
    </>
  );
}

// ─── Stage View ──────────────────────────────────────────────

function renderStageView(
  currentItem: RundownItem | null,
  nextItem: RundownItem | null,
  displayTime: string,
  isOvertime: boolean,
  timer: NativeTimerState | null
) {
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: TIMER_CSS }} />
      <div
        style={{
          width: "100vw",
          height: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background: COLORS.bg,
          padding: "5vh 5vw",
          gap: "4vh",
        }}
      >
        {/* Current item title */}
        <div
          style={{
            fontSize: "min(5vw, 5vh)",
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

        {/* Timer */}
        <div
          style={{
            fontFamily: "'Inter', monospace",
            fontSize: "min(18vw, 30vh)",
            fontWeight: 700,
            fontVariantNumeric: "tabular-nums",
            letterSpacing: "-0.02em",
            lineHeight: 1,
            color: isOvertime ? COLORS.danger : COLORS.text,
            animation: isOvertime ? "pulse-overtime 1s ease-in-out infinite" : "none",
          }}
        >
          {currentItem ? displayTime : "--:--"}
        </div>

        {/* Playback state indicator */}
        {timer && (
          <div
            style={{
              fontSize: "min(2vw, 2.5vh)",
              fontWeight: 500,
              textTransform: "uppercase",
              letterSpacing: "0.15em",
              color: timer.playback === "play"
                ? COLORS.accent
                : timer.playback === "pause"
                  ? COLORS.accent
                  : COLORS.muted,
              opacity: timer.playback === "stop" ? 0.5 : 1,
            }}
          >
            {timer.playback === "play"
              ? isOvertime
                ? "OVERTIME"
                : "RUNNING"
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
              marginTop: "2vh",
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
      </div>
    </>
  );
}

// ─── Full Timer View ─────────────────────────────────────────

function renderTimerView(
  currentItem: RundownItem | null,
  nextItem: RundownItem | null,
  displayTime: string,
  isOvertime: boolean,
  progress: number,
  timer: NativeTimerState | null,
  now: number,
  connected: boolean,
  totalElapsed: number
) {
  const clockTime = formatClockHHMMSS(new Date(now));

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: TIMER_CSS }} />
      <div
        style={{
          width: "100vw",
          height: "100vh",
          display: "flex",
          flexDirection: "column",
          background: COLORS.bg,
          overflow: "hidden",
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
            borderBottom: "1px solid rgba(255,255,255,0.06)",
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

          {/* Playback state + connection */}
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
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "0.12em",
                  color:
                    timer.playback === "play"
                      ? isOvertime
                        ? COLORS.danger
                        : "#22c55e"
                      : COLORS.accent,
                  padding: "0.3vh 1vw",
                  borderRadius: "4px",
                  background:
                    timer.playback === "play"
                      ? isOvertime
                        ? "rgba(239,68,68,0.15)"
                        : "rgba(34,197,94,0.12)"
                      : "rgba(255,193,7,0.12)",
                }}
              >
                {timer.playback === "play"
                  ? isOvertime
                    ? "OVERTIME"
                    : "LIVE"
                  : "PAUSED"}
              </div>
            )}
            <div
              style={{
                width: "10px",
                height: "10px",
                borderRadius: "50%",
                background: connected ? "#22c55e" : COLORS.danger,
                boxShadow: connected
                  ? "0 0 6px rgba(34,197,94,0.5)"
                  : "0 0 6px rgba(239,68,68,0.5)",
              }}
            />
          </div>
        </div>

        {/* ── Main Timer Area ── */}
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            padding: "2vh 3vw",
            gap: "1.5vh",
            minHeight: 0,
          }}
        >
          {/* Current item title */}
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

          {/* Item type badge */}
          {currentItem && (
            <div
              style={{
                fontSize: "min(1.2vw, 1.5vh)",
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.15em",
                color: COLORS.accent,
                opacity: 0.8,
              }}
            >
              {currentItem.type}
            </div>
          )}

          {/* Timer display */}
          <div
            style={{
              fontFamily: "'Inter', monospace",
              fontSize: "min(16vw, 22vh)",
              fontWeight: 700,
              fontVariantNumeric: "tabular-nums",
              letterSpacing: "-0.02em",
              lineHeight: 1,
              color: isOvertime ? COLORS.danger : COLORS.text,
              animation: isOvertime
                ? "pulse-overtime 1s ease-in-out infinite"
                : "none",
              marginTop: "1vh",
              marginBottom: "1vh",
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
                borderRadius: "3px",
                overflow: "hidden",
                flexShrink: 0,
              }}
            >
              <div
                style={{
                  width: `${Math.min(100, progress * 100)}%`,
                  height: "100%",
                  background: isOvertime ? COLORS.danger : COLORS.progressFill,
                  borderRadius: "3px",
                  transition: "width 0.3s linear",
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
              borderTop: "1px solid rgba(255,255,255,0.04)",
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
            borderTop: "1px solid rgba(255,255,255,0.06)",
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
        </div>
      </div>
    </>
  );
}
