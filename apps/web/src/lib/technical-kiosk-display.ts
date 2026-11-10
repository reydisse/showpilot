import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { z } from "zod";
import { idSchema, parseOrThrow } from "./validation";
import { kioskDisplayCommandSchema } from "./kiosk-display-contract";
import {
  readMemberKioskDisplay,
  writeKioskDisplay,
} from "./kiosk-display-command.server";
async function actor() {
  const { getAuth } = await import("./auth");
  const session = await getAuth().api.getSession({
    headers: getRequestHeaders(),
    query: { disableCookieCache: true },
  });
  if (!session) throw new Error("Sign in before controlling kiosk displays.");
  return { userId: session.user.id, sessionId: session.session.id };
}
export const getTechnicalKioskDisplay = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) =>
    parseOrThrow(z.object({ orgId: idSchema }), data),
  )
  .handler(async ({ data }) =>
    readMemberKioskDisplay(data.orgId, await actor(), "technical"),
  );
export const writeTechnicalKioskDisplay = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(kioskDisplayCommandSchema, data),
  )
  .handler(async ({ data }) =>
    writeKioskDisplay({
      command: data,
      actor: await actor(),
      surface: "technical",
    }),
  );
