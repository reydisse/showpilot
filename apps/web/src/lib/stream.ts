import { createServerFn, createServerOnlyFn } from "@tanstack/react-start";
import { getPrisma } from "@/lib/db";
import { assertOrgPermission } from "@/lib/org-access";
import { z } from "zod";
import { idSchema, labelSchema, parseOrThrow } from "@/lib/validation";
import { createLiveInputForOrg, deleteLiveInputForOrg, resumeLiveInputForOrg, readLiveInputKey, getInputLifecycles } from "./stream-input-lifecycle.server";
import { readLiveInputHealth } from "./stream-input-health.server";
import { streamProviderRequest } from "./stream-provider.server";

const requestIdSchema = z.string().uuid().optional();

export const getLiveInputs = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema, includeCredentials: z.boolean().optional() }), data))
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, data.includeCredentials ? "stream_health:manage" : "stream_health:view");
    const [inputs, lifecycles] = await Promise.all([
      getPrisma().liveInput.findMany({ where: { orgId: data.orgId }, orderBy: { createdAt: "asc" } }),
      getInputLifecycles(data.orgId),
    ]);
    return Promise.all(inputs.map(async input => ({
      ...redactLiveInput(input),
      setupState: lifecycles[input.id] ?? "ready",
      ...(data.includeCredentials ? { rtmpKey: await readLiveInputKey(input) } : {}),
    })));
  });

export function redactLiveInput<T extends { rtmpKey: string }>(input: T, includeCredentials = false): Omit<T, "rtmpKey"> & { hasRtmpKey: boolean; rtmpKey?: string } {
  const { rtmpKey, ...safeInput } = input;
  return { ...safeInput, hasRtmpKey: rtmpKey.trim().length > 0, ...(includeCredentials ? { rtmpKey } : {}) };
}

export const createLiveInput = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema, name: labelSchema, requestId: requestIdSchema }), data))
  .handler(async ({ data }) => {
    const { user } = await assertOrgPermission(data.orgId, "stream_health:manage");
    const id = await createLiveInputForOrg({ ...data, actorId: user.id });
    const input = await getPrisma().liveInput.findFirst({ where: { orgId: data.orgId, id } });
    if (!input) throw new Error("The input was removed. Refresh the input list.");
    return redactLiveInput(input);
  });

export const resumeLiveInput = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema, inputId: idSchema }), data))
  .handler(async ({ data }) => {
    const { user } = await assertOrgPermission(data.orgId, "stream_health:manage");
    await resumeLiveInputForOrg(data.orgId, data.inputId, user.id);
  });

export const deleteLiveInput = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema, inputId: idSchema, requestId: requestIdSchema }), data))
  .handler(async ({ data }) => {
    const { user } = await assertOrgPermission(data.orgId, "stream_health:manage");
    await deleteLiveInputForOrg({ ...data, actorId: user.id });
  });

export const deleteCfLiveInput = createServerOnlyFn(async (cfInputId: string): Promise<void> => {
  await streamProviderRequest(["live_inputs", cfInputId], "DELETE");
});

export const getLiveInputStatus = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema, inputId: idSchema }), data))
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "stream_health:view");
    return getLiveInputStatusForOrg(data.orgId, data.inputId);
  });

/** Shared by web and the separately authorized mobile API. */
export const getLiveInputStatusForOrg = createServerOnlyFn(readLiveInputHealth);
