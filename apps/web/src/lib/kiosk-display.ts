import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { kioskDisplayCommandSchema } from "./kiosk-display-contract";
import {
  readMemberKioskDisplay,
  writeKioskDisplay,
} from "./kiosk-display-command.server";
import { z } from "zod";
import { idSchema, parseOrThrow } from "@/lib/validation";

// ─── Settings UI server fns (session-gated) ──────────────────
// Same permission as kiosk admin (settings:members) so the kiosk settings
// tab can flip the blank flag without a companion token.

async function kioskDisplayActor() {
  const { getAuth } = await import("@/lib/auth");
  const session = await getAuth().api.getSession({
    headers: getRequestHeaders(),
    query: { disableCookieCache: true },
  });
  if (!session) throw new Error("Sign in before controlling kiosk displays.");
  return { userId: session.user.id, sessionId: session.session.id };
}

export const getKioskBlankState = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) =>
    parseOrThrow(z.object({ orgId: idSchema }), data),
  )
  .handler(async ({ data }) =>
    readMemberKioskDisplay(data.orgId, await kioskDisplayActor()),
  );

export const setKioskBlankState = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(kioskDisplayCommandSchema, data),
  )
  .handler(async ({ data }) =>
    writeKioskDisplay({ command: data, actor: await kioskDisplayActor() }),
  );
