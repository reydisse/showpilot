import { env } from "cloudflare:workers";
import { chatRelayKey } from "./chat-relay-key";
import { withOperationTimeout } from "./operation-timeout";

export async function refreshRevokedChatGuests(orgId: string): Promise<boolean> {
  try {
    await withOperationTimeout(env.CHAT_RELAY.getByName(chatRelayKey(orgId, "production")).refreshReadAuthority(),
      5_000, "Guest disconnection acknowledgement timed out");
    return true;
  } catch {
    // The committed denylist entry still blocks requests and per-message writes.
    // Idle reads have a bounded lease, refreshed by the relay alarm.
    return false;
  }
}
