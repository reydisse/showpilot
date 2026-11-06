import { env } from "cloudflare:workers";
import { chatRelayKey } from "./chat-relay-key";
import { rundownRelayKey } from "./rundown-relay-key";
import { relayUpgradeCache } from "./relay-upgrade-cache.server";

type ReadAuthorityBindings = Pick<Env, "DB" | "CHAT_RELAY" | "RUNDOWN_RELAY" | "TIMECODE_RELAY" | "BRIDGE_RELAY" | "LOWER_THIRDS_RELAY" | "CUE_SHEET_RELAY">;

/** Called after committing access changes. Alarms remain the fallback if a push fails. */
export async function refreshOrgReadAuthority(orgId: string, userId?: string, bindings: ReadAuthorityBindings = env): Promise<void> {
  relayUpgradeCache.invalidate({ orgId, userId });
  try {
    const [rooms, shows] = await Promise.all([
      bindings.DB.prepare("SELECT DISTINCT roomId FROM chat_user_room WHERE orgId = ?")
        .bind(orgId).all<{ roomId: string }>(),
      bindings.DB.prepare("SELECT id, serviceDate FROM rundown WHERE orgId = ?")
        .bind(orgId).all<{ id: string; serviceDate: string }>(),
    ]);
    const chatKeys = new Set(["production", "planning", ...rooms.results.map(room => room.roomId)]
      .map(room => chatRelayKey(orgId, room)));
    const showKeys = new Set([orgId, ...shows.results.flatMap(show => [
      rundownRelayKey(orgId, show.serviceDate, "", show.id),
      rundownRelayKey(orgId, show.serviceDate, ""),
    ])]);
    const results = await Promise.allSettled([
      ...[...chatKeys].map(key => bindings.CHAT_RELAY.getByName(key).refreshReadAuthority(userId)),
      ...[...showKeys].map(key => bindings.RUNDOWN_RELAY.getByName(key).refreshReadAuthority(userId)),
      ...[...showKeys].map(key => bindings.TIMECODE_RELAY.getByName(key).refreshReadAuthority(userId)),
      bindings.BRIDGE_RELAY.getByName(orgId).refreshReadAuthority(userId),
      bindings.LOWER_THIRDS_RELAY.getByName(orgId).refreshReadAuthority(userId),
      bindings.CUE_SHEET_RELAY.getByName(orgId).refreshReadAuthority(userId),
    ]);
    const failures = results.filter(result => result.status === "rejected").length;
    if (failures) console.error(JSON.stringify({ message: "Relay read-authority push failed; lease expiry remains active", orgId, userId, failures }));
  } catch {
    // Never report an already-committed revocation as an unsaved mutation.
    console.error(JSON.stringify({ message: "Relay read-authority push unavailable; lease expiry remains active", orgId, userId }));
  }
}

export async function refreshUserReadAuthority(userId: string, bindings: ReadAuthorityBindings = env): Promise<void> {
  relayUpgradeCache.invalidate({ userId });
  try {
    const memberships = await bindings.DB.prepare("SELECT organizationId FROM member WHERE userId = ?")
      .bind(userId).all<{ organizationId: string }>();
    await Promise.all(memberships.results.map(member => refreshOrgReadAuthority(member.organizationId, userId, bindings)));
  } catch {
    console.error(JSON.stringify({ message: "Session read-authority push unavailable; lease expiry remains active", userId }));
  }
}
