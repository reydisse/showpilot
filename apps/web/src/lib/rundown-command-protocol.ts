export type RelayCommandDecision = "apply" | "duplicate" | "revision-conflict";

export type RundownRelayWriteAccess = "edit" | "control";

export interface RundownRelayHttpCommand {
  action: string;
  payload?: Record<string, unknown>;
  id?: string;
  expectedRevision?: number;
}

const EDIT_ACTIONS = new Set([
  "seed",
  "add-item",
  "update-item",
  "remove-item",
  "reorder",
  "timer-mode",
  "pp-slide",
  "pp-preview",
  "reset",
  "clear-all",
  "stage-message",
  "stage-clear",
  "update-meta",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse the untrusted HTTP envelope before it reaches relay state logic. */
export function parseRundownRelayHttpCommand(value: unknown): RundownRelayHttpCommand | null {
  if (!isRecord(value) || typeof value.action !== "string") return null;
  const action = value.action.trim();
  if (!action || action.length > 64) return null;
  if (value.payload !== undefined && !isRecord(value.payload)) return null;
  if (
    value.id !== undefined
    && (typeof value.id !== "string" || !value.id.trim() || value.id.length > 128)
  ) return null;
  if (
    value.expectedRevision !== undefined
    && (
      typeof value.expectedRevision !== "number"
      || !Number.isSafeInteger(value.expectedRevision)
      || value.expectedRevision < 0
    )
  ) return null;

  return {
    action,
    ...(value.payload === undefined ? {} : { payload: value.payload }),
    ...(value.id === undefined ? {} : { id: value.id }),
    ...(value.expectedRevision === undefined
      ? {}
      : { expectedRevision: value.expectedRevision }),
  };
}

/** Keep edit-only grants from invoking live transport controls. */
export function canApplyRundownRelayAction(
  access: RundownRelayWriteAccess,
  action: string,
): boolean {
  return access === "control" || EDIT_ACTIONS.has(action);
}

/**
 * Decide whether a relay command may mutate the current authoritative state.
 * Every operator acts against the revision it most recently received, so two
 * simultaneous advances cannot both apply to the same rundown position.
 */
export function classifyRelayCommand(
  currentRevision: number,
  recentCommandIds: readonly string[],
  commandId?: string,
  expectedRevision?: number,
): RelayCommandDecision {
  if (commandId && recentCommandIds.includes(commandId)) return "duplicate";
  if (
    typeof expectedRevision === "number" &&
    Number.isFinite(expectedRevision) &&
    expectedRevision !== currentRevision
  ) {
    return "revision-conflict";
  }
  return "apply";
}
