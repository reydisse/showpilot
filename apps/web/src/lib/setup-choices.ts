import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getRequestOrgAccess } from "./org-access";
import { getD1 } from "./d1";
import { idSchema, parseOrThrow } from "./validation";
import { setupWorkspaceCommandSchema, setupRoleCommandSchema } from "./setup-choices-contract";
import { readSetupChoices, saveSetupChoice } from "./setup-choices.server";
async function owner(orgId: string) {
  const { user, access } = await getRequestOrgAccess(orgId);
  if (access.role !== "owner") throw new Error("Forbidden");
  return user.id;
}
export const getSetupChoices = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema }), data))
  .handler(async ({ data }) => readSetupChoices(getD1(), data.orgId, await owner(data.orgId)));
export const saveSetupWorkspace = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(setupWorkspaceCommandSchema, data))
  .handler(async ({ data }) => saveSetupChoice(getD1(), await owner(data.orgId), data));
export const saveSetupRole = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(setupRoleCommandSchema, data))
  .handler(async ({ data }) => saveSetupChoice(getD1(), await owner(data.orgId), data));
