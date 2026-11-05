// A read lease avoids database work in broadcast loops. Writes never use it.
export const SOCKET_READ_LEASE_MS = 60_000;
const REFRESH_EARLY_MS = 30_000;

function isAttachment(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function attachment(socket: WebSocket): Record<string, unknown> | null {
  const value: unknown = socket.deserializeAttachment();
  return isAttachment(value) ? value : null;
}

export function renewSocketReadLease(socket: WebSocket, now = Date.now()): void {
  const current = attachment(socket);
  if (!current) throw new Error("Cannot authorize a socket without an attachment");
  socket.serializeAttachment({ ...current, readAuthorizedUntil: now + SOCKET_READ_LEASE_MS });
}

/** No I/O: an overdue refresh fails closed, even if the alarm was delayed. */
export function socketReadLeaseAllows(socket: WebSocket, required: boolean, now = Date.now()): boolean {
  if (!required) return true;
  const until = attachment(socket)?.readAuthorizedUntil;
  if (typeof until === "number" && Number.isFinite(until) && until > now) return true;
  try { socket.close(4403, "Read authorization expired. Reconnect."); } catch { /* Already closed. */ }
  return false;
}

/** Run only on an alarm or a trusted permission-change push, never a broadcast. */
export async function refreshSocketReadLeases(
  sockets: WebSocket[],
  authorize: (socket: WebSocket) => Promise<boolean | null>,
): Promise<void> {
  await Promise.all(sockets.map(async socket => {
    try {
      const allowed = await authorize(socket);
      if (allowed === null) return; // Displays/guests have their own deadlines.
      if (allowed) renewSocketReadLease(socket);
      else socket.close(4403, "Read access changed");
    } catch {
      try { socket.close(1011, "Read authorization unavailable"); } catch { /* Already closed. */ }
    }
  }));
}

/** Compose the read refresh deadline with another alarm owned by this relay. */
export async function scheduleSocketReadRefresh(
  ctx: DurableObjectState,
  needsLease: (socket: WebSocket) => boolean,
  otherDeadline: number | null = null,
): Promise<void> {
  const now = Date.now();
  let deadline = otherDeadline;
  for (const socket of ctx.getWebSockets()) {
    if (socket.readyState !== WebSocket.OPEN || !needsLease(socket)) continue;
    const until = attachment(socket)?.readAuthorizedUntil;
    const refreshAt = typeof until === "number" && Number.isFinite(until)
      ? Math.max(now + 1, until - REFRESH_EARLY_MS) : now + 1;
    deadline = deadline === null ? refreshAt : Math.min(deadline, refreshAt);
  }
  const existing = await ctx.storage.getAlarm();
  if (deadline === null) {
    if (existing !== null) await ctx.storage.deleteAlarm();
  } else if (existing !== deadline) await ctx.storage.setAlarm(Math.max(now + 1, deadline));
}
