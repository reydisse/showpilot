import {
  parseBridgeEndpoint,
  resolveBridgeEndpoints,
  type BridgeEndpoint,
} from "@showpilot/shared/bridge-target";
import type {
  RundownTimer,
  RundownTimingItem,
} from "@showpilot/shared/rundown-transport";

export const LOCAL_SHOW_LIMIT = 2000;
export const LOCAL_SHOW_MAX_AGE = 86_400_000;
/** Only messages written for operators may cross the native control boundary. */
export class LocalShowError extends Error {}
export interface LocalShowItem extends RundownTimingItem {
  title: string;
  duration: number;
  notes: string;
  assignee: string;
  cue: string;
}
export interface LocalShowAction {
  id: string;
  label: string;
  deviceId: string;
  protocol: BridgeEndpoint["protocol"];
  target: string;
  command: string;
  settings: Record<string, unknown>;
}
export interface PreparedLocalShow {
  version: 1;
  sessionId: string;
  orgId: string;
  installationId: string;
  showId: string;
  serviceDate: string;
  title: string;
  baseRevision: number;
  preparedAt: number;
  expiresAt: number;
  items: LocalShowItem[];
  timer: RundownTimer;
  approvedTargets: BridgeEndpoint[];
  actions: LocalShowAction[];
}
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export const isLocalId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9:_-]{1,100}$/.test(value);
export const isTimestamp = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= 8_640_000_000_000_000;
const text = (value: unknown, limit: number): value is string =>
  typeof value === "string" && value.length <= limit;
const isoDate = (value: unknown): value is string | null | undefined =>
  value === undefined ||
  value === null ||
  (typeof value === "string" &&
    value.length <= 40 &&
    Number.isFinite(Date.parse(value)));
const key = (endpoint: BridgeEndpoint) =>
  JSON.stringify([endpoint.protocol, endpoint.host, endpoint.port]);

/** Parse only authenticated, decrypted preparations. The caller must separately
 * verify the org/installation binding and the current active Bridge policy.
 * Public native requests cannot install a preparation or supply device settings.
 */
export function parsePreparedLocalShow(value: unknown): PreparedLocalShow {
  const fail = (): never => {
    throw new LocalShowError(
      "The prepared local show is invalid. Reconnect and prepare it again.",
    );
  };
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !isLocalId(value.sessionId) ||
    !isLocalId(value.orgId) ||
    !isLocalId(value.installationId) ||
    !isLocalId(value.showId) ||
    !text(value.title, 500) ||
    !text(value.serviceDate, 10) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value.serviceDate) ||
    !isTimestamp(value.baseRevision) ||
    !isTimestamp(value.preparedAt) ||
    !isTimestamp(value.expiresAt) ||
    value.expiresAt <= value.preparedAt ||
    value.expiresAt - value.preparedAt > LOCAL_SHOW_MAX_AGE ||
    !Array.isArray(value.items) ||
    value.items.length > 1000 ||
    !isRecord(value.timer) ||
    !Array.isArray(value.actions) ||
    value.actions.length > 500 ||
    !Array.isArray(value.approvedTargets) ||
    value.approvedTargets.length > 1000
  )
    return fail();
  const items = value.items.map((item: unknown): LocalShowItem => {
    if (
      !isRecord(item) ||
      !isLocalId(item.id) ||
      !text(item.title, 1000) ||
      !text(item.type, 50) ||
      !isTimestamp(item.duration) ||
      item.duration > LOCAL_SHOW_MAX_AGE ||
      !text(item.notes, 10000) ||
      !text(item.assignee, 1000) ||
      !text(item.cue, 1000) ||
      !["upcoming", "live", "complete"].includes(String(item.status)) ||
      !isoDate(item.actualStart) ||
      !isoDate(item.actualEnd)
    )
      return fail();
    if (
      item.status !== "upcoming" &&
      item.status !== "live" &&
      item.status !== "complete"
    )
      return fail();
    return {
      id: item.id,
      title: item.title,
      type: item.type,
      duration: item.duration,
      notes: item.notes,
      assignee: item.assignee,
      cue: item.cue,
      status: item.status,
      actualStart: item.actualStart,
      actualEnd: item.actualEnd,
    };
  });
  if (new Set(items.map((item) => item.id)).size !== items.length)
    return fail();
  const timer = value.timer;
  if (
    timer.playback !== "stop" &&
    timer.playback !== "play" &&
    timer.playback !== "pause"
  )
    return fail();
  if (
    timer.mode !== "count-up" &&
    timer.mode !== "count-down" &&
    timer.mode !== "clock"
  )
    return fail();
  if (
    timer.currentItemId !== null &&
    (!isLocalId(timer.currentItemId) ||
      !items.some(
        (item) => item.id === timer.currentItemId && item.type !== "header",
      ))
  )
    return fail();
  if (
    typeof timer.elapsed !== "number" ||
    !Number.isFinite(timer.elapsed) ||
    Math.abs(timer.elapsed) > 7 * LOCAL_SHOW_MAX_AGE ||
    (timer.startedAt !== null && !isTimestamp(timer.startedAt)) ||
    (timer.pausedAt !== null && !isTimestamp(timer.pausedAt)) ||
    (timer.playback === "play" &&
      (timer.currentItemId === null ||
        timer.startedAt === null ||
        timer.pausedAt !== null)) ||
    (timer.playback === "pause" &&
      (timer.currentItemId === null ||
        timer.pausedAt === null ||
        timer.startedAt !== null)) ||
    (timer.playback === "stop" &&
      (timer.currentItemId !== null ||
        timer.startedAt !== null ||
        timer.pausedAt !== null))
  )
    return fail();
  let approvedTargets: BridgeEndpoint[];
  try {
    approvedTargets = value.approvedTargets.map(parseBridgeEndpoint);
  } catch {
    return fail();
  }
  const approved = new Set(approvedTargets.map(key));
  const actions = value.actions.map((action: unknown): LocalShowAction => {
    if (
      !isRecord(action) ||
      !isLocalId(action.id) ||
      !isLocalId(action.deviceId) ||
      !text(action.label, 500) ||
      !text(action.target, 2048) ||
      !text(action.command, 65536) ||
      !isRecord(action.settings)
    )
      return fail();
    try {
      if (JSON.stringify(action.settings).length > 65536) return fail();
      const endpoints = resolveBridgeEndpoints({
        type: "connect-device",
        protocol: action.protocol,
        target: action.target,
        settings: action.settings,
      });
      const commandEndpoints = resolveBridgeEndpoints({
        type: "command",
        protocol: action.protocol,
        target: action.target,
        command: action.command,
        settings: action.settings,
      });
      const [primary] = endpoints;
      if (
        !primary ||
        ![...endpoints, ...commandEndpoints].every((endpoint) =>
          approved.has(key(endpoint)),
        )
      )
        return fail();
      return {
        id: action.id,
        label: action.label,
        deviceId: action.deviceId,
        protocol: primary.protocol,
        target: action.target,
        command: action.command,
        settings: structuredClone(action.settings),
      };
    } catch {
      return fail();
    }
  });
  if (new Set(actions.map((action) => action.id)).size !== actions.length)
    return fail();
  return {
    version: 1,
    sessionId: value.sessionId,
    orgId: value.orgId,
    installationId: value.installationId,
    showId: value.showId,
    serviceDate: value.serviceDate,
    title: value.title,
    baseRevision: value.baseRevision,
    preparedAt: value.preparedAt,
    expiresAt: value.expiresAt,
    items,
    timer: {
      playback: timer.playback,
      mode: timer.mode,
      currentItemId: timer.currentItemId,
      elapsed: timer.elapsed,
      startedAt: timer.startedAt,
      pausedAt: timer.pausedAt,
    },
    approvedTargets,
    actions,
  };
}
