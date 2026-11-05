import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { assertOrgPermission } from "@/lib/org-access";
import { idSchema, parseOrThrow } from "@/lib/validation";

const installationInput = z.object({ orgId: idSchema, installationId: idSchema });


export const getBridgeSelection = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema }), data))
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "settings:api_keys");
    const { activeInstallation, connections } = await env.BRIDGE_RELAY.getByName(data.orgId).getBridgeStatus();
    return { activeInstallation, connections };
  });

export const takeBridgeControl = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(installationInput.extend({
    expectedActiveInstallationId: idSchema.nullable(), confirmed: z.literal(true),
  }), data))
  .handler(async ({ data }) => {
    const { user } = await assertOrgPermission(data.orgId, "settings:api_keys");
    const { activeInstallation, connections } = await env.BRIDGE_RELAY.getByName(data.orgId).selectInstallation({
      orgId: data.orgId, installationId: data.installationId,
      expectedActiveInstallationId: data.expectedActiveInstallationId, actorUserId: user.id,
    });
    return { activeInstallation, connections };
  });
