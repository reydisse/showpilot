import { env } from "cloudflare:workers";
import { z } from "zod";
import { getAuth } from "./auth";
import { memberPermissionGuard } from "./member-permission-guard.server";
import { hasLivePermissionAuthority } from "./live-rundown-authority.server";
import { withOperationTimeout } from "./operation-timeout";
import {
  graphicsClearCommandSchema,
  graphicsClearOutcomeSchema,
  graphicsClearResultSchema,
  graphicsClearSnapshotSchema,
  type GraphicsClearCommand,
} from "./graphics-clear-contract";
type Database = Pick<D1Database, "prepare" | "batch">;
async function authority(
  orgId: string,
  headers: Headers,
  write = false,
  database: Database = env.DB,
) {
  const session = await getAuth().api.getSession({
    headers,
    query: { disableCookieCache: true },
  });
  if (!session) throw new Error("Sign in before controlling graphics.");
  const actor = {
    userId: session.user.id,
    sessionId: session.session.id,
    orgId,
  };
  const guard = await memberPermissionGuard(database, orgId, actor, [
    "dashboard:tm",
    write ? "lowerthird:trigger" : "lowerthird:view",
  ]);
  guard.guard +=
    " AND EXISTS(SELECT 1 FROM organization WHERE id=? AND cloud_enabled=1)";
  guard.guardArgs.push(orgId);
  if (
    !(await database
      .prepare(`SELECT 1 WHERE ${guard.guard}`)
      .bind(...guard.guardArgs)
      .first())
  )
    throw new Error(
      "Graphics output is unavailable or your access has changed.",
    );
  return { ...actor, ...guard };
}
type Actor = Awaited<ReturnType<typeof authority>>;
const currentPayload = z.object({
  id: z.string(),
  name: z.string().optional(),
  title: z.string().optional(),
  scripture: z.string().optional(),
  line1: z.string().optional(),
});
const relayState = z.object({
  revision: z.number().int().nonnegative(),
  current: currentPayload.nullable(),
});
async function relay(
  actor: Actor,
  body?: { id: string; expectedRevision: number; expiresAt: number },
) {
  const url = new URL(
    body ? "https://graphics/clear-reviewed" : "https://graphics/control-state",
  );
  for (const [key, value] of Object.entries({
    orgId: actor.orgId,
    authUserId: actor.userId,
    authSessionId: actor.sessionId,
    access: body ? "write" : "read",
  }))
    url.searchParams.set(key, value);
  const stub = env.LOWER_THIRDS_RELAY.get(
    env.LOWER_THIRDS_RELAY.idFromName(actor.orgId),
  );
  return withOperationTimeout(
    (async () => {
      const response = await stub.fetch(
        new Request(url, {
          method: body ? "POST" : "GET",
          ...(body
            ? {
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
              }
            : {}),
        }),
      );
      if (!response.ok)
        throw new Error(
          "Lower-third feedback was not confirmed. Check your permission and retry the original request.",
        );
      return response.json<unknown>();
    })(),
    6_000,
    "Lower-third feedback did not arrive. Retry to recover the original request.",
  );
}
const title = (payload: z.infer<typeof currentPayload>) =>
  payload.name ||
  payload.title ||
  payload.line1 ||
  payload.scripture ||
  "Lower third";
async function readProgram(orgId: string, database: Database) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const saved = await database
      .prepare(
        `SELECT
      COALESCE((SELECT revision FROM graphics_output_revision WHERE orgId=?),0) AS revision,
      (SELECT value FROM app_setting WHERE orgId=? AND key='active-graphics') AS multiple,
      (SELECT value FROM app_setting WHERE orgId=? AND key='active-graphic') AS single,
      (SELECT value FROM app_setting WHERE orgId=? AND key='active-lower-third') AS lowerThird`,
      )
      .bind(orgId, orgId, orgId, orgId)
      .first<{
        revision: number;
        multiple: string | null;
        single: string | null;
        lowerThird: string | null;
      }>();
    if (!saved) throw new Error("Graphics feedback is unavailable.");
    let ids: string[] = saved.single ? [saved.single] : [],
      unknown = false;
    if (saved.multiple) {
      try {
        ids = z
          .array(z.string().min(1).max(64))
          .max(50)
          .parse(JSON.parse(saved.multiple));
      } catch {
        unknown = true;
      }
    }
    // Match the overlay's legacy fallback when the multi-graphic list is empty.
    if (ids.length === 0 && saved.single) ids = [saved.single];
    const rows = ids.length
      ? (
          await database
            .prepare(
              `SELECT id,name,title FROM graphic_template WHERE orgId=? AND id IN (${ids.map(() => "?").join(",")})`,
            )
            .bind(orgId, ...ids)
            .all<{ id: string; name: string; title: string }>()
        ).results
      : [];
    const program = ids.map((id) => {
      const row = rows.find((row) => row.id === id);
      if (!row) unknown = true;
      return { id, title: row?.name || row?.title || "Unavailable graphic" };
    });
    let lowerThird: string | null = null;
    if (saved.lowerThird) {
      try {
        lowerThird = title(currentPayload.parse(JSON.parse(saved.lowerThird)));
      } catch {
        lowerThird = "Unrecognized saved lower third";
      }
    }
    const revision =
      (
        await database
          .prepare(
            "SELECT revision FROM graphics_output_revision WHERE orgId=?",
          )
          .bind(orgId)
          .first<{ revision: number }>()
      )?.revision ?? 0;
    if (revision === saved.revision)
      return { revision, program, unknown, lowerThird };
  }
  throw new Error(
    "Graphics changed while their state was being read. Retry to review current output.",
  );
}
export async function readTmGraphics(orgId: string, headers: Headers) {
  const actor = await authority(orgId, headers);
  const [program, live, canClear] = await Promise.all([
    readProgram(orgId, env.DB),
    relay(actor).then((value) => relayState.parse(value)),
    hasLivePermissionAuthority(env.DB, actor, "lowerthird:trigger"),
  ]);
  return graphicsClearSnapshotSchema.parse({
    programRevision: program.revision,
    relayRevision: live.revision,
    serverTime: Date.now(),
    program: program.program,
    programUnknown: program.unknown,
    lowerThirds: [
      ...new Set(
        [program.lowerThird, live.current ? title(live.current) : null].filter(
          (value) => value !== null,
        ),
      ),
    ],
    canClear,
  });
}
/** Program and relay commit separately. Each owns its reviewed revision and
 * receipt; an interrupted second step can recover without clearing newer work. */
export async function clearTmGraphics(
  input: GraphicsClearCommand,
  headers: Headers,
  database: Database = env.DB,
) {
  const command = graphicsClearCommandSchema.parse(input),
    actor = await authority(command.orgId, headers, true, database);
  const scope = [command.orgId, actor.userId, command.requestId],
    fingerprint = JSON.stringify(command);
  const receiptSchema = z.object({
    fingerprint: z.string(),
    programOutcome: graphicsClearOutcomeSchema,
    relayOutcome: z
      .enum(["applied", "conflict", "expired", "skipped"])
      .nullable(),
  });
  const read = async () => {
    const value = await database
      .prepare(
        `SELECT fingerprint,programOutcome,relayOutcome FROM graphics_clear_receipt WHERE orgId=? AND actorId=? AND requestId=? AND ${actor.guard}`,
      )
      .bind(...scope, ...actor.guardArgs)
      .first();
    return value ? receiptSchema.parse(value) : null;
  };
  let receipt = await read();
  if (!receipt) {
    if (command.expiresAt > Date.now() + 5_000)
      throw new Error(
        "Clear deadline is too far ahead. Refresh graphics feedback.",
      );
    const claimId = crypto.randomUUID();
    await database.batch([
      database
        .prepare(
          `INSERT INTO graphics_clear_receipt(orgId,actorId,requestId,fingerprint,claimId,programOutcome)
        SELECT ?,?,?,?,?,CASE WHEN ?<=(julianday('now')-2440587.5)*86400000 THEN 'expired'
        WHEN COALESCE((SELECT revision FROM graphics_output_revision WHERE orgId=?),0)=? THEN 'applied' ELSE 'conflict' END
        WHERE ${actor.guard} ON CONFLICT(orgId,actorId,requestId) DO NOTHING`,
        )
        .bind(
          ...scope,
          fingerprint,
          claimId,
          command.expiresAt,
          command.orgId,
          command.expectedProgramRevision,
          ...actor.guardArgs,
        ),
      database
        .prepare(
          `DELETE FROM app_setting WHERE orgId=? AND key IN ('active-graphics','active-graphic','active-lower-third')
        AND EXISTS(SELECT 1 FROM graphics_clear_receipt WHERE orgId=? AND actorId=? AND requestId=? AND claimId=? AND programOutcome='applied')`,
        )
        .bind(command.orgId, ...scope, claimId),
    ]);
    receipt = await read();
  }
  if (!receipt)
    throw new Error(
      "Graphics access changed before Clear was confirmed. Review output before retrying.",
    );
  if (receipt.fingerprint !== fingerprint)
    throw new Error(
      "This request already belongs to a different graphics clear.",
    );
  if (!receipt.relayOutcome) {
    let outcome: z.infer<typeof receiptSchema>["relayOutcome"] = "skipped";
    if (receipt.programOutcome === "applied") {
      const bytes = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(scope)),
      );
      const id = Array.from(new Uint8Array(bytes), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      const result = await relay(actor, {
        id,
        expectedRevision: command.expectedRelayRevision,
        expiresAt: command.expiresAt,
      });
      outcome = z
        .object({ outcome: graphicsClearOutcomeSchema })
        .parse(result).outcome;
    }
    await database
      .prepare(
        "UPDATE graphics_clear_receipt SET relayOutcome=? WHERE orgId=? AND actorId=? AND requestId=? AND relayOutcome IS NULL",
      )
      .bind(outcome, ...scope)
      .run();
    receipt = await read();
  }
  return graphicsClearResultSchema.parse({
    requestId: command.requestId,
    program: receipt?.programOutcome,
    relay: receipt?.relayOutcome,
  });
}
