import { z } from "zod";
import {
  rundownChangeCommandSchema,
  type RundownChangeCommand,
  type RundownChangeReply,
} from "../../../mobile/src/lib/rundown-change-recovery";
import { rundownRelayKey } from "./rundown-relay-key";
import { RUNDOWN_PIN_HEADER } from "./rundown-pin.server";
import type { MobileApiEnvironment } from "./mobile-api.server";
const replySchema = z.object({
  ok: z.boolean(),
  revision: z.number().int().nonnegative().optional(),
  reason: z.string().optional(),
});

/** Keep native edits on the existing revision-checked single writer.
 * The actor is server-derived and the relay rechecks the live session and PIN. */
export async function applyMobileRundownChange(
  bindings: {
    DB: Pick<D1Database, "prepare">;
    RUNDOWN_RELAY: NonNullable<MobileApiEnvironment["RUNDOWN_RELAY"]>;
  },
  input: RundownChangeCommand,
  actor: { userId: string; sessionId: string; pin: string | null },
): Promise<RundownChangeReply> {
  const command = rundownChangeCommandSchema.parse(input);
  if (actor.userId !== command.userId)
    throw new Error("Your account changed. Reopen this rundown action.");
  const result = (
    outcome: RundownChangeReply["outcome"],
    revision: number | null,
  ): RundownChangeReply => ({
    orgId: command.orgId,
    userId: actor.userId,
    showId: command.showId,
    requestId: command.requestId,
    outcome,
    revision,
  });
  const show = await bindings.DB.prepare(
    "SELECT serviceDate FROM rundown WHERE orgId=? AND id=? AND NOT EXISTS (SELECT 1 FROM app_setting WHERE orgId=rundown.orgId AND key='show-deleting:' || rundown.id)",
  )
    .bind(command.orgId, command.showId)
    .first<{ serviceDate: string }>();
  if (!show) return result("unavailable", null);
  if (show.serviceDate !== command.serviceDate) return result("conflict", null);
  const query = new URLSearchParams({
    orgId: command.orgId,
    showId: command.showId,
    serviceDate: command.serviceDate,
    access: command.action === "reset" ? "control" : "edit",
    authUserId: actor.userId,
    authSessionId: actor.sessionId,
  });
  const relay = bindings.RUNDOWN_RELAY.get(
    bindings.RUNDOWN_RELAY.idFromName(
      rundownRelayKey(
        command.orgId,
        command.serviceDate,
        command.serviceDate,
        command.showId,
      ),
    ),
  );
  const headers = new Headers({ "Content-Type": "application/json" });
  if (actor.pin) headers.set(RUNDOWN_PIN_HEADER, actor.pin);
  const response = await relay.fetch(
    new Request(`https://rundown.internal/command?${query}`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        id: command.requestId,
        expectedRevision: command.expectedRevision,
        action: command.action,
        ...(command.action === "add-item"
          ? { payload: { id: command.itemId, ...command.fields } }
          : command.action === "update-item"
            ? { payload: { id: command.itemId, updates: command.fields } }
            : command.action === "reorder"
              ? { payload: { order: command.order } }
              : "itemId" in command
                ? { payload: { id: command.itemId } }
                : {}),
      }),
    }),
  );
  if (response.status === 404 || response.status === 410) {
    await response.arrayBuffer();
    return result("unavailable", null);
  }
  if (![200, 400, 409].includes(response.status)) {
    await response.body?.cancel();
    throw new Error(
      response.status === 401 || response.status === 403
        ? "Your rundown access changed. Restore access before retrying this action."
        : "The rundown action could not be confirmed. Retry the original request.",
    );
  }
  const reply = replySchema.parse(await response.json());
  if (response.status === 200 && reply.ok)
    return result("applied", reply.revision ?? null);
  if (response.status === 409)
    return result("conflict", reply.revision ?? null);
  return result("unavailable", reply.revision ?? null);
}
