import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { parseOrThrow } from "./validation";
import {
  tmManagementCommandSchema,
  tmManagementScopeSchema,
} from "./tm-management-contract";
import {
  readTmManagement,
  retryTmManagementNotifications,
  writeTmManagement,
} from "./tm-management.server";
export const getTmManagementState = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) =>
    parseOrThrow(tmManagementScopeSchema, data),
  )
  .handler(({ data }) => readTmManagement(getRequestHeaders(), data));
export const commandTmManagement = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(tmManagementCommandSchema, data),
  )
  .handler(({ data }) => writeTmManagement(getRequestHeaders(), data, "write"));
export const reviewTmManagement = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(tmManagementCommandSchema, data),
  )
  .handler(({ data }) =>
    writeTmManagement(getRequestHeaders(), data, "review"),
  );
export const retryTmNotifications = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(tmManagementScopeSchema, data),
  )
  .handler(({ data }) =>
    retryTmManagementNotifications(getRequestHeaders(), data),
  );
