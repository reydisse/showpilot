export interface RelayClockTimer {
  startedAt: number | null;
  pausedAt: number | null;
  serverTime?: number;
}

/**
 * Translate relay epoch timestamps onto the receiving device's clock.
 *
 * Operators regularly use laptops and tablets whose wall clocks differ by
 * seconds (or more). The relay includes the time at which it serialized the
 * state, which lets every client preserve the same elapsed duration without
 * assuming its local Date.now() matches Cloudflare's clock.
 */
export function rebaseTimerToLocalClock<T extends RelayClockTimer>(
  timer: T,
  receivedAt = Date.now(),
): T {
  const serverTime =
    typeof timer.serverTime === "number" && Number.isFinite(timer.serverTime)
      ? timer.serverTime
      : receivedAt;
  const localOffset = receivedAt - serverTime;

  return {
    ...timer,
    startedAt:
      typeof timer.startedAt === "number" && Number.isFinite(timer.startedAt)
        ? timer.startedAt + localOffset
        : null,
    pausedAt:
      typeof timer.pausedAt === "number" && Number.isFinite(timer.pausedAt)
        ? timer.pausedAt + localOffset
        : null,
    serverTime: receivedAt,
  };
}
