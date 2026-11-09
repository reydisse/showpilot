import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { workspaceScopeSchema, workspaceChangeSchema } from "@showpilot/shared/workspace-change";
import { parseOrThrow } from "../validation";
import { readWorkspaceChange, writeWorkspaceChange } from "./change.server";
export const getWorkspaceChange = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) => parseOrThrow(workspaceScopeSchema, input))
  .handler(({ data }) => readWorkspaceChange(getRequestHeaders(), data));
export const saveWorkspaceChange = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => parseOrThrow(workspaceChangeSchema, input))
  .handler(({ data }) => writeWorkspaceChange(getRequestHeaders(), data, "save"));
export const reviewWorkspaceChange = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => parseOrThrow(workspaceChangeSchema, input))
  .handler(({ data }) => writeWorkspaceChange(getRequestHeaders(), data, "review"));
