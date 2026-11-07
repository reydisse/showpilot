import { z } from "zod";
import type { BridgeRelay } from "@/durable-objects/BridgeRelay";
import type { BridgeTargetActor } from "./bridge-targets.server";
import { buildHomeAssistantActions } from "./device-modules/homeassistant/homeassistant-module";
import { withOperationTimeout } from "./operation-timeout";

const entitiesSchema = z.array(z.object({
  entity_id: z.string().regex(/^[a-z0-9_]+\.[a-z0-9_]+$/),
  state: z.string(),
  attributes: z.record(z.string(), z.unknown()).optional(),
}));
/** A malformed discovery response is an outage, not an empty action catalog. */
export function homeAssistantAutomationActions(response: string) {
  let value: unknown;
  try { value = JSON.parse(response); } catch { throw new Error("Home Assistant returned an unreadable action list. Refresh actions to try again."); }
  const parsed = entitiesSchema.safeParse(value);
  if (!parsed.success) throw new Error("Home Assistant returned an invalid action list. Refresh actions to try again.");
  return buildHomeAssistantActions(parsed.data);
}

export async function discoverHomeAssistantActions({ relay, target, actor, installationId, assertCanDispatch }: {
  relay: Pick<BridgeRelay, "getBridgeStatus" | "dispatchBridgeMessage">;
  target: string;
  actor: BridgeTargetActor;
  installationId?: string;
  assertCanDispatch: () => void;
}) {
  // Bound the whole read. Its late reply can never dispatch a service command.
  return withOperationTimeout((async () => {
    assertCanDispatch();
    const status = await relay.getBridgeStatus();
    assertCanDispatch();
    const selected = status.activeInstallation?.installationId;
    if (!status.bridgeOnline || !selected) throw new Error("Connect the venue Bridge before refreshing Home Assistant actions.");
    if (installationId && selected !== installationId) throw new Error("Active Venue Bridge changed. Refresh Home Assistant actions before retrying.");
    if (!status.connectedTargets.includes(target)) throw new Error("Connect this Home Assistant device in Devices, then refresh actions.");
    const reply = await relay.dispatchBridgeMessage({
      type: "command", id: `ha-discovery:${crypto.randomUUID()}`, protocol: "http-command", target, command: "GET /api/states",
    }, actor, selected);
    assertCanDispatch();
    if (!reply.success) throw new Error(reply.error ?? "Home Assistant discovery failed. Refresh actions to try again.");
    if (typeof reply.response !== "string") throw new Error("Home Assistant did not return an action list. Refresh actions to try again.");
    // A connection handoff after dispatch must not make old discovery authoritative.
    const current = await relay.getBridgeStatus();
    assertCanDispatch();
    if (!current.bridgeOnline || current.activeInstallation?.installationId !== selected || !current.connectedTargets.includes(target)) {
      throw new Error("Home Assistant connection changed during discovery. Refresh actions before retrying.");
    }
    return homeAssistantAutomationActions(reply.response);
  })(), 8_000, "Home Assistant action discovery timed out. Refresh actions to try again.");
}
