import type { RundownItem, RundownTimer } from "@/lib/mobile-api";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function finiteNumber(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nullableNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function normalizeRelayItems(value: unknown): RundownItem[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((candidate, index) => {
    if (!isRecord(candidate)) return [];
    return [{
      id: stringValue(candidate.id, `item-${index}`),
      title: stringValue(candidate.title, "Untitled"),
      type: stringValue(candidate.type, "segment"),
      duration: Math.max(0, finiteNumber(candidate.duration, 300_000)),
      notes: stringValue(candidate.notes),
      assignee: stringValue(candidate.assignee),
      cue: stringValue(candidate.cue),
      status: stringValue(candidate.status, "upcoming"),
      sortOrder: finiteNumber(candidate.sortOrder, index),
      hardStop: candidate.hardStop === true,
      lowerThirdId: stringValue(candidate.lowerThirdId) || undefined,
      scheduledStart: typeof candidate.scheduledStart === "string" ? candidate.scheduledStart : null,
      expectedEnd: typeof candidate.expectedEnd === "string" ? candidate.expectedEnd : null,
      actualStart: typeof candidate.actualStart === "string" ? candidate.actualStart : null,
      actualEnd: typeof candidate.actualEnd === "string" ? candidate.actualEnd : null,
    }];
  });
}

export function normalizeRelayTimer(value: unknown, receivedAt = Date.now()): RundownTimer {
  if (!isRecord(value)) {
    return {
      playback: "stop",
      currentItemId: null,
      elapsed: 0,
      startedAt: null,
      pausedAt: null,
      mode: "count-down",
      serverTime: receivedAt,
    };
  }

  const serverTime = finiteNumber(value.serverTime, receivedAt);
  const localOffset = receivedAt - serverTime;
  const startedAt = nullableNumber(value.startedAt);
  const pausedAt = nullableNumber(value.pausedAt);

  return {
    playback: value.playback === "play" || value.playback === "pause" ? value.playback : "stop",
    currentItemId: typeof value.currentItemId === "string" && value.currentItemId ? value.currentItemId : null,
    // Negative elapsed means an operator added time beyond the assigned duration.
    elapsed: finiteNumber(value.elapsed),
    startedAt: startedAt === null ? null : startedAt + localOffset,
    pausedAt: pausedAt === null ? null : pausedAt + localOffset,
    mode: value.mode === "count-up" || value.mode === "clock" ? value.mode : "count-down",
    serverTime: receivedAt,
  };
}

export function timerElapsed(timer: RundownTimer, now = Date.now()) {
  if (timer.mode === "clock") return now;
  if (timer.playback === "play" && timer.startedAt !== null) {
    return timer.elapsed + Math.max(0, now - timer.startedAt);
  }
  return timer.elapsed;
}

export function formatTimer(milliseconds: number) {
  const negative = milliseconds < 0;
  const totalSeconds = Math.floor(Math.abs(milliseconds) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const value = hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return negative ? `-${value}` : value;
}
