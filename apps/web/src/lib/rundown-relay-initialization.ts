interface LegacyRundownRelayState {
  initialized?: unknown;
  items?: unknown;
  revision?: unknown;
}

/**
 * Old relay snapshots predate the explicit initialization flag. A non-empty
 * snapshot or a room with more than the relabel revision has already owned
 * authoritative rundown state and must never accept a stale loader seed.
 */
export function inferRundownRelayInitialized(
  stored: LegacyRundownRelayState,
): boolean {
  if (typeof stored.initialized === "boolean") return stored.initialized;
  const itemCount = Array.isArray(stored.items) ? stored.items.length : 0;
  const revision =
    typeof stored.revision === "number" && Number.isFinite(stored.revision)
      ? stored.revision
      : 0;
  return itemCount > 0 || revision > 1;
}

export function shouldAcceptRundownSeed(
  initialized: boolean,
  force: boolean,
): boolean {
  return force || !initialized;
}
