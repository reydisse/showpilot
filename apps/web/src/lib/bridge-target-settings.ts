import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { assertOrgPermission } from "./org-access";
import { idSchema, parseOrThrow } from "./validation";
import { parseBridgeEndpoint } from "./bridge-target";
import { approveBridgeTarget, listBridgeTargets, removeBridgeTarget } from "./bridge-targets.server";

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
    await approveBridgeTarget(env.DB, { ...data, actorUserId: user.id });
    return listBridgeTargets(env.DB, data.orgId);
  });

export const removeBridgeDestination = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema, id: idSchema, confirmed: z.literal(true) }), data))
  .handler(async ({ data }) => {
    const { user } = await assertOrgPermission(data.orgId, permissions);
    await removeBridgeTarget(env.DB, { orgId: data.orgId, id: data.id, actorUserId: user.id });
    return listBridgeTargets(env.DB, data.orgId);
  });
