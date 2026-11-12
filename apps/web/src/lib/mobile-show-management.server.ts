import { getAuth } from "./auth";
import { getD1 } from "./d1";
import { memberPermissionGuard } from "./member-permission-guard.server";
import { mobileShowReadSchema } from "./mobile-show-management-contract";
import { readShowDetailsSnapshot } from "./show-details-write.server";
import type { z } from "zod";

/** Explicit reload never adopts a snapshot from another account. Recheck the
 * fresh permission after reading, before returning any retained form data. */
export async function readMobileShowDetails(
  headers: Headers,
  input: z.infer<typeof mobileShowReadSchema>,
  db: Pick<D1Database, "prepare" | "batch"> = getD1(),
) {
  const data = mobileShowReadSchema.parse(input);
  const session = await getAuth().api.getSession({
    headers,
    query: { disableCookieCache: true },
  });
  if (!session || session.user.id !== data.userId)
    throw new Error(
      "Your account changed. Reopen Schedule before loading this show.",
    );
  const actor = { userId: session.user.id, sessionId: session.session.id };
  await memberPermissionGuard(db, data.orgId, actor, ["schedule:manage"]);
  const [current, zone] = await Promise.all([
    readShowDetailsSnapshot(db, data.orgId, data.showId),
    db
      .prepare(
        "SELECT value FROM app_setting WHERE orgId=? AND key='org-timezone'",
      )
      .bind(data.orgId)
      .first<{ value: string }>(),
  ]);
  await memberPermissionGuard(db, data.orgId, actor, ["schedule:manage"]);
  return {
    ...data,
    timeZone: zone?.value || "UTC",
    snapshot: current?.snapshot ?? null,
  };
}
