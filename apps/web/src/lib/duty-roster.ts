import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { z } from "zod";
import { idSchema, serviceDateSchema, parseOrThrow } from "./validation";
import { dutyRosterCommandSchema } from "./duty-roster-contract";
import {
  executeDutyRosterCommand,
  readMemberDutyRoster,
  retryDutyNotificationDelivery,
} from "./duty-roster-command.server";
async function actor() {
  const { getAuth } = await import("./auth");
  const session = await getAuth().api.getSession({
    headers: getRequestHeaders(),
    query: { disableCookieCache: true },
  });
  if (!session) throw new Error("Sign in before managing duty assignments.");
  return { userId: session.user.id, sessionId: session.session.id };
}
export const getDutyRosterState = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) =>
    parseOrThrow(
      z.object({ orgId: idSchema, weekStart: serviceDateSchema }),
      data,
    ),
  )
  .handler(async ({ data }) =>
    readMemberDutyRoster(data.orgId, data.weekStart, await actor()),
  );
export const writeDutyRoster = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(dutyRosterCommandSchema, data),
  )
  .handler(async ({ data }) => executeDutyRosterCommand(data, await actor()));
export const retryDutyNotifications = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(z.object({ orgId: idSchema }), data),
  )
  .handler(async ({ data }) =>
    retryDutyNotificationDelivery(data.orgId, await actor()),
  );
