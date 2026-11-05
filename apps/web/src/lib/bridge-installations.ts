import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { assertOrgPermission } from "@/lib/org-access";
import { idSchema, parseOrThrow } from "@/lib/validation";
import {
  issueBridgeInstallation, listBridgeInstallations, migrateLegacyBridgeInstallation,
  revokeBridgeInstallation, rotateBridgeInstallation,
} from "@/lib/bridge-credentials.server";

const installationInput = z.object({ orgId: idSchema, installationId: idSchema });
async function refreshConnection(orgId: string): Promise<boolean> {
  try { await env.BRIDGE_RELAY.getByName(orgId).refreshCredentialAuthority(); return true; }
  catch { return false; } // Every subsequent relay write still revalidates against D1.
}

export const getBridgeInstallations = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema }), data))
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "settings:api_keys");
    await migrateLegacyBridgeInstallation(env.DB, data.orgId);
    return listBridgeInstallations(env.DB, data.orgId);
  });

export const createBridgeInstallation = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema, label: z.string().trim().min(1).max(80) }), data))
  .handler(async ({ data }) => {
    const { user } = await assertOrgPermission(data.orgId, "settings:api_keys");
    return issueBridgeInstallation(env.DB, { ...data, actorUserId: user.id });
  });

export const rotateBridgeInstallationKey = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(installationInput, data))
  .handler(async ({ data }) => {
    const { user } = await assertOrgPermission(data.orgId, "settings:api_keys");
    const issued = await rotateBridgeInstallation(env.DB, { ...data, actorUserId: user.id });
    return { ...issued, connectionUpdated: await refreshConnection(data.orgId) };
  });

export const revokeBridgeInstallationKey = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(installationInput, data))
  .handler(async ({ data }) => {
    const { user } = await assertOrgPermission(data.orgId, "settings:api_keys");
    await revokeBridgeInstallation(env.DB, { ...data, actorUserId: user.id });
    return { revoked: true, connectionUpdated: await refreshConnection(data.orgId) };
  });
