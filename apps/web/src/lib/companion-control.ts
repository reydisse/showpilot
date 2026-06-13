// ─────────────────────────────────────────────────────────────
// Companion control core.
//
// Pure orchestration for the /api/v1/companion/* control endpoints. Every
// side effect (relay broadcast, DB read/write, CF Stream call) is reached
// through the injected `CompanionDeps` so this module unit-tests without the
// Workers env. The route handlers in src/routes/api/v1/companion/* build the
// real deps (see companion-api.ts) and map CompanionResult → HTTP Response.
//
// Transport transitions are applied by the RundownRelay — the exact same
// command path the operator UI uses (useRundownSync.sendCommand) — so a
// button press updates every connected screen live and stays authoritative.
// ─────────────────────────────────────────────────────────────

import type { LowerThirdPayload } from "@/lib/lowerthirds";

export interface RelayTimer {
  playback: "stop" | "play" | "pause";
  currentItemId: string | null;
  elapsed: number;
  startedAt: number | null;
  pausedAt: number | null;
  mode: "count-up" | "count-down" | "clock";
  serverTime?: number;
}

export interface RelayItem {
  id: string;
  title: string;
  status: string;
  duration: number;
}

export interface RelayState {
  items: RelayItem[];
  timer: RelayTimer;
  stageMessage?: string;
}

export interface StreamStatus {
  connected: number;
  total: number;
}

export interface CompanionDeps {
  /** Forward a command to the org's RundownRelay (applies + broadcasts). */
  relayCommand(orgId: string, action: string, payload?: Record<string, unknown>): Promise<void>;
  /** Read the org's authoritative live rundown state from the relay. */
  relayState(orgId: string): Promise<RelayState>;
  /** ProPresenter lyrics-on-timer flag. */
  setLyrics(orgId: string, enabled: boolean): Promise<void>;
  getLyrics(orgId: string): Promise<boolean>;
  /** Whether Cloud Graphics (lower thirds) is enabled for the org. */
  isCloudEnabled(orgId: string): Promise<boolean>;
  /** Lower thirds: persist + broadcast to the LT relay. */
  triggerLowerThird(orgId: string, payload: LowerThirdLike, triggeredBy?: string): Promise<LowerThirdPayload>;
  clearLowerThird(orgId: string): Promise<void>;
  getLowerThird(orgId: string): Promise<LowerThirdPayload | null>;
  /** Kiosk blank/restore (COMP-4). */
  setKioskBlank(orgId: string, blanked: boolean): Promise<void>;
  getKioskBlank(orgId: string): Promise<boolean>;
  /** Stream go-live / stop / status (COMP-5). */
  streamGoLive(orgId: string): Promise<StreamGoLiveResult>;
  streamStop(orgId: string): Promise<void>;
  streamStatus(orgId: string): Promise<StreamStatus>;
}

export type LowerThirdLike = Record<string, unknown> & { id: string; style: string };

export interface StreamGoLiveResult {
  status: number;
  results?: { id: string; success: boolean; error?: string }[];
  error?: string;
}

export interface CompanionResult {
  status: number;
  body: Record<string, unknown>;
}

// ─── Helpers ─────────────────────────────────────────────────

/** Compact transport summary for Stream Deck button feedback. */
function transportSummary(state: RelayState): Record<string, unknown> {
  const idx = state.items.findIndex((i) => i.id === state.timer.currentItemId);
  const current = idx >= 0 ? state.items[idx] : null;
  const nextItem = idx >= 0 ? state.items[idx + 1] ?? null : state.items[0] ?? null;
  return {
    ok: true,
    playback: state.timer.playback,
    currentItemId: state.timer.currentItemId,
    currentItem: current ? { id: current.id, title: current.title } : null,
    nextItem: nextItem ? { id: nextItem.id, title: nextItem.title } : null,
  };
}

async function forwardAndSummarize(
  deps: CompanionDeps,
  orgId: string,
  action: string,
  payload?: Record<string, unknown>,
): Promise<CompanionResult> {
  await deps.relayCommand(orgId, action, payload);
  const post = await deps.relayState(orgId);
  return { status: 200, body: transportSummary(post) };
}

// ─── Transport (buttons 1–6) ─────────────────────────────────

/** Button 1 — start / resume the timer (itemId optional). */
export async function timerStart(
  deps: CompanionDeps,
  orgId: string,
  itemId?: string,
): Promise<CompanionResult> {
  const state = await deps.relayState(orgId);

  if (itemId) {
    return forwardAndSummarize(deps, orgId, "timer-start", { itemId });
  }
  if (state.timer.playback === "pause") {
    return forwardAndSummarize(deps, orgId, "timer-resume");
  }
  if (state.timer.currentItemId) {
    return forwardAndSummarize(deps, orgId, "timer-start", { itemId: state.timer.currentItemId });
  }
  if (state.items.length > 0) {
    return forwardAndSummarize(deps, orgId, "timer-start", { itemId: state.items[0].id });
  }
  return { status: 409, body: { ok: false, error: "No rundown items to start" } };
}

/** Button 2 — stop the timer. */
export async function timerStop(deps: CompanionDeps, orgId: string): Promise<CompanionResult> {
  return forwardAndSummarize(deps, orgId, "timer-stop");
}

/** Button 3 — advance to the next item. */
export async function rundownNext(deps: CompanionDeps, orgId: string): Promise<CompanionResult> {
  return forwardAndSummarize(deps, orgId, "timer-next");
}

/** Button 4 — step back to the previous item. */
export async function rundownPrevious(deps: CompanionDeps, orgId: string): Promise<CompanionResult> {
  return forwardAndSummarize(deps, orgId, "timer-prev");
}

/** Button 5 — add time to the running timer. */
export async function timerAdd(
  deps: CompanionDeps,
  orgId: string,
  seconds: number,
): Promise<CompanionResult> {
  return forwardAndSummarize(deps, orgId, "timer-adjust", { deltaMs: seconds * 1000 });
}

/** Button 6 — subtract time from the running timer. */
export async function timerSubtract(
  deps: CompanionDeps,
  orgId: string,
  seconds: number,
): Promise<CompanionResult> {
  return forwardAndSummarize(deps, orgId, "timer-adjust", { deltaMs: -seconds * 1000 });
}

// ─── ProPresenter lyrics (buttons 7 / 8) ─────────────────────

export async function setLyrics(
  deps: CompanionDeps,
  orgId: string,
  enabled: boolean,
): Promise<CompanionResult> {
  await deps.setLyrics(orgId, enabled);
  return { status: 200, body: { ok: true, lyricsEnabled: enabled } };
}

// ─── Lower thirds (button 11) ────────────────────────────────

export async function triggerLowerThird(
  deps: CompanionDeps,
  orgId: string,
  payload: LowerThirdLike,
  triggeredBy?: string,
): Promise<CompanionResult> {
  if (!(await deps.isCloudEnabled(orgId))) {
    return {
      status: 403,
      body: { ok: false, error: "Cloud Graphics (lower thirds) is not enabled for this org" },
    };
  }
  const stored = await deps.triggerLowerThird(orgId, payload, triggeredBy);
  return { status: 200, body: { ok: true, lowerThird: stored } };
}

export async function clearLowerThird(deps: CompanionDeps, orgId: string): Promise<CompanionResult> {
  if (!(await deps.isCloudEnabled(orgId))) {
    return {
      status: 403,
      body: { ok: false, error: "Cloud Graphics (lower thirds) is not enabled for this org" },
    };
  }
  await deps.clearLowerThird(orgId);
  return { status: 200, body: { ok: true } };
}

// ─── Kiosk blank (button 9) ──────────────────────────────────

export async function kioskBlank(
  deps: CompanionDeps,
  orgId: string,
  blanked: boolean,
): Promise<CompanionResult> {
  await deps.setKioskBlank(orgId, blanked);
  return { status: 200, body: { ok: true, blanked } };
}

// ─── Stream (button 10) ──────────────────────────────────────

export async function streamGoLive(deps: CompanionDeps, orgId: string): Promise<CompanionResult> {
  const result = await deps.streamGoLive(orgId);
  if (result.status !== 200) {
    return { status: result.status, body: { ok: false, error: result.error ?? "Go live failed" } };
  }
  const results = result.results ?? [];
  const connected = results.filter((r) => r.success).length;
  return {
    status: 200,
    body: { ok: true, connected, total: results.length, destinations: results },
  };
}

export async function streamStop(deps: CompanionDeps, orgId: string): Promise<CompanionResult> {
  await deps.streamStop(orgId);
  return { status: 200, body: { ok: true } };
}

// ─── State (button feedback) ─────────────────────────────────

export async function getState(deps: CompanionDeps, orgId: string): Promise<CompanionResult> {
  const [state, lyricsEnabled, lowerThird, kioskBlanked, stream] = await Promise.all([
    deps.relayState(orgId),
    deps.getLyrics(orgId),
    deps.getLowerThird(orgId),
    deps.getKioskBlank(orgId),
    deps.streamStatus(orgId),
  ]);

  const idx = state.items.findIndex((i) => i.id === state.timer.currentItemId);
  const current = idx >= 0 ? state.items[idx] : null;
  const nextItem = idx >= 0 ? state.items[idx + 1] ?? null : state.items[0] ?? null;

  return {
    status: 200,
    body: {
      ok: true,
      timer: {
        playback: state.timer.playback,
        currentItemId: state.timer.currentItemId,
        elapsed: state.timer.elapsed,
        startedAt: state.timer.startedAt,
        mode: state.timer.mode,
        serverTime: state.timer.serverTime ?? Date.now(),
      },
      currentItem: current ? { id: current.id, title: current.title, duration: current.duration } : null,
      nextItem: nextItem ? { id: nextItem.id, title: nextItem.title, duration: nextItem.duration } : null,
      lyricsEnabled,
      lowerThird: lowerThird ? { id: lowerThird.id, state: lowerThird.state } : null,
      kioskBlanked,
      stream: { connected: stream.connected, total: stream.total },
    },
  };
}
