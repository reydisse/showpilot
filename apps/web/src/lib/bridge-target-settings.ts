import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { assertOrgPermission } from "./org-access";
import { idSchema, parseOrThrow } from "./validation";
import { parseBridgeEndpoint } from "@showpilot/shared/bridge-target";
import { listBridgeTargets } from "./bridge-targets.server";

const permissions = ["settings:api_keys", "settings:integrations"] as const;
export const getBridgeTargetPolicy = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema }), data))
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, permissions);
    return listBridgeTargets(env.DB, data.orgId);
  });

export const approveBridgeDestination = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => {
    const input = parseOrThrow(z.object({ orgId: idSchema, label: z.string().trim().min(1).max(80), host: z.string(), port: z.union([z.string(), z.number()]), protocol: z.string() }), data);
    return { orgId: input.orgId, label: input.label, endpoint: parseBridgeEndpoint(input) };
  })
  .handler(async ({ data }) => {
    const { user } = await assertOrgPermission(data.orgId, permissions);
    const { targets, warning } = await env.BRIDGE_RELAY.getByName(data.orgId).changeTargetApproval({ ...data, action: "approve", actorUserId: user.id });
    return { targets, warning };
  });

export const removeBridgeDestination = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema, id: idSchema, confirmed: z.literal(true) }), data))
  .handler(async ({ data }) => {
    const { user } = await assertOrgPermission(data.orgId, permissions);
    const { targets, warning } = await env.BRIDGE_RELAY.getByName(data.orgId).changeTargetApproval({ orgId: data.orgId, id: data.id, action: "remove", actorUserId: user.id });
    return { targets, warning };
  });
