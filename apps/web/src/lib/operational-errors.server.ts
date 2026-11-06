import { OPERATIONAL_ERRORS, safeErrorName, type OperationalErrorCode, type BrowserErrorReport, type SafeErrorName } from "./operational-errors";

export const ERROR_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const ERROR_MINUTE_LIMIT = 30;
export const ERROR_DAY_LIMIT = 2000;
type ErrorInput = { code: OperationalErrorCode; errorName: SafeErrorName; asset?: string; line?: number; column?: number };

/** One atomic, indexed statement bounds concurrent browser/relay writers per org. */
export async function recordOperationalError(db: D1Database, orgId: string, input: ErrorInput, now = Date.now()): Promise<boolean> {
  if (!orgId) return false;
  const event = OPERATIONAL_ERRORS[input.code];
  const result = await db.prepare(`INSERT INTO operational_error (id,orgId,source,code,errorName,asset,line,column,createdAt)
    SELECT ?,?,?,?,?,?,?,?,? WHERE
      (SELECT COUNT(*) FROM operational_error WHERE orgId=? AND createdAt>=?) < ? AND
      (SELECT COUNT(*) FROM operational_error WHERE orgId=? AND createdAt>=?) < ?`)
    .bind(crypto.randomUUID(), orgId, event.source, input.code, input.errorName, input.asset ?? null, input.line ?? null, input.column ?? null, now,
      orgId, now - 60_000, ERROR_MINUTE_LIMIT, orgId, now - 86_400_000, ERROR_DAY_LIMIT).run();
  return result.meta.changes === 1;
}

const recent = new Map<string, number>();
/** Reporting is best effort; missing migrations or storage outages cannot reject a live operation. */
export function reportRelayError(ctx: Pick<ExecutionContext, "waitUntil">, db: D1Database, orgId: string, code: Exclude<OperationalErrorCode, BrowserErrorReport["code"]>, cause?: unknown): void {
  if (!orgId) return;
  const key = `${orgId}:${code}`; const now = Date.now();
  if (now - (recent.get(key) ?? -Infinity) < 60_000) return;
  if (recent.size >= 200) recent.delete(recent.keys().next().value!);
  recent.set(key, now);
  ctx.waitUntil(recordOperationalError(db, orgId, { code, errorName: safeErrorName(cause) }, now).then(() => undefined).catch(() => undefined));
}
export async function pruneOperationalErrors(db: D1Database, now = Date.now()): Promise<void> {
  await db.prepare("DELETE FROM operational_error WHERE createdAt < ?").bind(now - ERROR_RETENTION_MS).run();
}
