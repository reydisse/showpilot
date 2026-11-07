import { z } from "zod";
import { getD1 } from "./d1";
import { markDatabaseWrite } from "./request-database.server";
import { normalizeLiveInputStatus } from "./stream-health";
import { streamProviderRequest } from "./stream-provider.server";

const responseSchema = z.object({
  result: z.object({
    status: z.union([
      z.string(),
      z.object({ current: z.object({ state: z.string() }) }),
    ]),
    enabled: z.boolean().optional(),
  }),
});
type Health = {
  inputId: string;
  status: ReturnType<typeof normalizeLiveInputStatus>;
  providerStatus: string;
  checkedAt: string;
  error?: string;
};

export async function readLiveInputHealth(
  orgId: string,
  inputId: string,
): Promise<Health | null> {
  const db = getD1();
  const input = await db
    .prepare(
      `SELECT i.cfInputId,l.desired,l.phase FROM live_input i
    LEFT JOIN stream_input_lifecycle l ON l.orgId=i.orgId AND l.inputId=i.id WHERE i.orgId=? AND i.id=?`,
    )
    .bind(orgId, inputId)
    .first<{
      cfInputId: string;
      desired: string | null;
      phase: string | null;
    }>();
  if (!input) return null;
  const unknown = (message: string): Health => ({
    inputId,
    status: "unknown",
    providerStatus: "unconfirmed",
    checkedAt: new Date().toISOString(),
    error: message,
  });
  if (
    !input.cfInputId ||
    input.cfInputId.startsWith("pending:") ||
    (input.phase !== null &&
      (input.phase !== "ready" || input.desired !== "active"))
  )
    return unknown(
      input.desired === "deleted"
        ? "Input removal is pending. Retry removal."
        : "Input setup is pending. Resume setup before checking health.",
    );
  const requestId = crypto.randomUUID();
  markDatabaseWrite();
  await db
    .prepare(
      `INSERT INTO stream_input_health(orgId,inputId,requestId)
    SELECT orgId,id,? FROM live_input WHERE orgId=? AND id=? AND cfInputId=?
    ON CONFLICT(orgId,inputId) DO UPDATE SET requestId=excluded.requestId`,
    )
    .bind(requestId, orgId, inputId, input.cfInputId)
    .run();
  let health: Health;
  try {
    const parsed = responseSchema.safeParse(
      await streamProviderRequest(["live_inputs", input.cfInputId], "GET"),
    );
    if (!parsed.success)
      health = unknown(
        "The provider returned an unreadable input status. Retry the check.",
      );
    else {
      const raw =
        typeof parsed.data.result.status === "string"
          ? parsed.data.result.status
          : parsed.data.result.status.current.state;
      const status = normalizeLiveInputStatus(
        raw,
        parsed.data.result.enabled !== false,
      );
      health =
        status === "unknown"
          ? unknown(
              "The provider returned an unrecognized input status. Retry the check.",
            )
          : {
              inputId,
              status,
              providerStatus: status === "disabled" ? "disabled" : raw,
              checkedAt: new Date().toISOString(),
              ...(status === "error"
                ? {
                    error:
                      "The provider reports an input connection error. Check the encoder and retry.",
                  }
                : {}),
            };
    }
  } catch {
    health = unknown("Input health could not be confirmed. Retry the check.");
  }
  // Only the newest check for this exact input binding may update the cache.
  // Removal or a setup transition also invalidates any in-flight health result.
  const guard = `EXISTS(SELECT 1 FROM stream_input_health h JOIN live_input i ON i.orgId=h.orgId AND i.id=h.inputId
    WHERE h.orgId=? AND h.inputId=? AND h.requestId=? AND i.cfInputId=?
    AND NOT EXISTS(SELECT 1 FROM stream_input_lifecycle l WHERE l.orgId=i.orgId AND l.inputId=i.id AND (l.desired<>'active' OR l.phase<>'ready')))`;
  const scope = [orgId, inputId, requestId, input.cfInputId];
  const saved = await db.batch([
    db
      .prepare(
        `UPDATE live_input SET status=? WHERE orgId=? AND id=? AND ${guard}`,
      )
      .bind(health.status, orgId, inputId, ...scope),
    db
      .prepare(
        `UPDATE stream_input_health SET checkedAt=? WHERE orgId=? AND inputId=? AND ${guard}`,
      )
      .bind(health.checkedAt, orgId, inputId, ...scope),
  ]);
  return saved[0].meta.changes === 1
    ? health
    : unknown(
        "This health check was superseded by a newer check or input change. Retry to refresh.",
      );
}
