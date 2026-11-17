// A large show is roughly 60 crew x 2 devices plus displays: about 130
// sockets on the busiest relay. 200 leaves real headroom while bounding
// one room/org's blast radius.
export const MAX_SOCKETS_PER_RELAY = 200;
export const ROOM_FULL_CLOSE_CODE = 4413;
export const ROOM_FULL_CLOSE_REASON = "Room full";
// The fastest legitimate sustained sender is the 10 Hz feed master (5x
// headroom). 150 absorbs reconnect device-status bursts and hydration sync;
// no healthy show traffic comes close.
export const SOCKET_MESSAGE_RATE_PER_SECOND = 50;
export const SOCKET_MESSAGE_BURST = 150;
export const RATE_LIMIT_CLOSE_CODE = 1008;
export const RATE_LIMIT_CLOSE_REASON = "Message rate limit exceeded";

// In-memory only: eviction resets buckets, deliberately failing open.
const buckets = new WeakMap<object, { tokens: number; at: number }>();

export function relaySocketCapReached(ctx: { getWebSockets(): WebSocket[] }): boolean {
  return ctx.getWebSockets().length >= MAX_SOCKETS_PER_RELAY;
}

export function consumeSocketMessage(socket: object, nowMs: number): boolean {
  const bucket = buckets.get(socket) ?? { tokens: SOCKET_MESSAGE_BURST, at: nowMs };
  bucket.tokens = Math.min(SOCKET_MESSAGE_BURST,
    bucket.tokens + Math.max(0, nowMs - bucket.at) * SOCKET_MESSAGE_RATE_PER_SECOND / 1000);
  bucket.at = Math.max(bucket.at, nowMs);
  buckets.set(socket, bucket);
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}
