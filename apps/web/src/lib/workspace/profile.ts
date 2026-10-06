import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getRequestOrgAccess, assertOrgPermission } from "../org-access";
import { idSchema, parseOrThrow } from "../validation";
import {
  workspacePrismaStore,
  readWorkspaceProfile,
  writeWorkspaceProfile,
  workspaceCustomSchema,
  workspaceModulesSchema,
  workspaceTypeSchema,
} from "./profile.server";
const orgInput = z.object({ orgId: idSchema });
export const getWorkspaceProfile = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => parseOrThrow(orgInput, d))
  .handler(async ({ data }) => {
    await getRequestOrgAccess(data.orgId);
    return readWorkspaceProfile(await workspacePrismaStore(data.orgId));
  });
export const saveWorkspaceType = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    parseOrThrow(
      orgInput.extend({
        type: workspaceTypeSchema,
        custom: workspaceCustomSchema.optional(),
        modules: workspaceModulesSchema.optional(),
      }),
      d,
    ),
  )
  .handler(async ({ data }) => {
    const { access } = await getRequestOrgAccess(data.orgId);
    if (access.role !== "owner") throw new Error("Forbidden");
    return writeWorkspaceProfile(await workspacePrismaStore(data.orgId), {
      kind: "initial",
      ...data,
      onlyIfUnconfigured: false,
    });
  });
export const setWorkspaceType = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    parseOrThrow(
      orgInput.extend({ type: workspaceTypeSchema, resetModules: z.boolean() }),
      d,
    ),
  )
  .handler(async ({ data }) => {
    const { access } = await assertOrgPermission(
      data.orgId,
      "settings:organization",
    );
    if (access.role !== "owner" && access.role !== "admin")
      throw new Error("Forbidden");
    return writeWorkspaceProfile(await workspacePrismaStore(data.orgId), {
      kind: "type",
      ...data,
    });
  });
export const setWorkspaceModules = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    parseOrThrow(orgInput.extend({ modules: workspaceModulesSchema }), d),
  )
  .handler(async ({ data }) => {
    const { access } = await assertOrgPermission(
      data.orgId,
      "settings:organization",
    );
    if (access.role !== "owner" && access.role !== "admin")
      throw new Error("Forbidden");
    return writeWorkspaceProfile(await workspacePrismaStore(data.orgId), {
      kind: "modules",
      ...data,
    });
  });
export const setWorkspaceCustom = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    parseOrThrow(orgInput.extend(workspaceCustomSchema.shape), d),
  )
  .handler(async ({ data }) => {
    const { access } = await assertOrgPermission(
      data.orgId,
      "settings:organization",
    );
    if (access.role !== "owner" && access.role !== "admin")
      throw new Error("Forbidden");
    return writeWorkspaceProfile(await workspacePrismaStore(data.orgId), {
      kind: "custom",
      custom: { label: data.label, terms: data.terms },
    });
  });
