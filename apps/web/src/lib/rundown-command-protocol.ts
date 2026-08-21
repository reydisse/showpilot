export type RelayCommandDecision = "apply" | "duplicate" | "revision-conflict";

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
