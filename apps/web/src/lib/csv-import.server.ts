import { z } from "zod";
import { getAuth } from "./auth";
import { getD1 } from "./d1";
import { memberPermissionGuard } from "./member-permission-guard.server";
import { markDatabaseWrite } from "./request-database.server";
import {
  getEffectivePlan,
  PLAN_LIMITS,
  PUBLIC_LAUNCH_DATE_KEY,
} from "./plan-limits";
import { generateMemberId } from "./import-members-csv";
import {
  csvImportCommandSchema,
  csvImportContextSchema,
  csvImportResultSchema,
  csvRowErrorSchema,
  parseCrewImport,
  type CsvImportScope,
  type CsvImportCommand,
  type CsvImportResult,
} from "./csv-import-contract";
type Database = Pick<D1Database, "prepare" | "batch">;
async function authority(
  headers: Headers,
  scope: CsvImportScope,
  db: Database,
) {
  const session = await getAuth().api.getSession({
    headers,
    query: { disableCookieCache: true },
  });
  if (!session || session.user.id !== scope.userId)
    throw new Error("Your account changed. Reopen the CSV importer.");
  // CSV imports retain the existing base-role requirement; a capability grant alone is insufficient.
  return memberPermissionGuard(
    db,
    scope.orgId,
    { userId: scope.userId, sessionId: session.session.id },
    ["settings:members"],
    false,
  );
}
export async function readCsvImportContext(
  headers: Headers,
  scope: CsvImportScope,
  db: Database = getD1(),
) {
  await authority(headers, scope, db);
  return csvImportContextSchema.parse({ ...scope, serverTime: Date.now() });
}
const receiptSchema = z.object({
  fingerprint: z.string(),
  token: z.uuid(),
  requestId: z.uuid(),
  outcome: z.enum(["applied", "cancelled", "expired", "conflict"]),
  errors: z.array(csvRowErrorSchema),
  rows: z.array(
    z.object({
      line: z.number().int(),
      status: z.enum(["imported", "skipped", "limited"]),
    }),
  ),
  plan: z.enum(["free", "starter", "pro"]),
  limit: z.number().int().nonnegative(),
});
interface PlanSnapshot {
  plan: string;
  betaTester: number;
  trialEndsAt: string | number | null;
  subscriptionStatus: string | null;
  trialMs: number | null;
  launchRaw: string | null;
  launchMs: number | null;
}
async function importPlan(db: Database, orgId: string) {
  const row = await db
    .prepare(
      `SELECT o.plan,o.betaTester,o.trialEndsAt,o.subscriptionStatus,
    CASE WHEN typeof(o.trialEndsAt) IN ('integer','real') THEN o.trialEndsAt ELSE (julianday(o.trialEndsAt)-2440587.5)*86400000 END AS trialMs,
    p.value AS launchRaw,(julianday(p.value)-2440587.5)*86400000 AS launchMs
    FROM organization o LEFT JOIN platform_setting p ON p.key=? WHERE o.id=?`,
    )
    .bind(PUBLIC_LAUNCH_DATE_KEY, orgId)
    .first<PlanSnapshot>();
  if (!row) throw new Error("Organization not found");
  const now = Date.now(),
    plan = getEffectivePlan(
      {
        ...row,
        betaTester: Boolean(row.betaTester),
        trialEndsAt: row.trialMs === null ? null : new Date(row.trialMs),
      },
      row.launchMs === null ? null : new Date(row.launchMs),
      new Date(now),
    );
  // Keep plan policy in getEffectivePlan; snapshot fields and the next time boundary fence changes at commit.
  const until = Math.min(
    now + 30_000,
    ...[row.trialMs, row.launchMs].filter(
      (value): value is number => value !== null && value > now,
    ),
  );
  return {
    plan,
    limit: PLAN_LIMITS[plan].members,
    guard: `EXISTS(SELECT 1 FROM organization WHERE id=? AND plan IS ? AND betaTester IS ? AND trialEndsAt IS ? AND subscriptionStatus IS ?)
    AND (SELECT value FROM platform_setting WHERE key=?) IS ? AND julianday('now')<julianday(?)`,
    args: [
      orgId,
      row.plan,
      row.betaTester,
      row.trialEndsAt,
      row.subscriptionStatus,
      PUBLIC_LAUNCH_DATE_KEY,
      row.launchRaw,
      new Date(until).toISOString(),
    ],
  };
}
export async function writeCsvImport(
  headers: Headers,
  input: CsvImportCommand,
  mode: "write" | "review",
  db: Database = getD1(),
): Promise<CsvImportResult> {
  const command = csvImportCommandSchema.parse(input),
    { orgId, requestId } = command;
  const access = await authority(headers, command, db);
  const fingerprint = Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(command)),
      ),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  const key = `csv-import:${requestId}`,
    token = crypto.randomUUID();
  const readReceipt = async () => {
    const row = await db
      .prepare(
        `SELECT value FROM app_setting WHERE orgId=? AND key=? AND ${access.guard}`,
      )
      .bind(orgId, key, ...access.guardArgs)
      .first<{ value: string }>();
    if (!row) return null;
    const receipt = receiptSchema.parse(JSON.parse(row.value));
    if (receipt.fingerprint !== fingerprint)
      throw new Error(
        "This request belongs to a different CSV import. Review it before starting another import.",
      );
    if (receipt.outcome !== "applied")
      return csvImportResultSchema.parse({
        requestId,
        outcome: receipt.outcome,
      });
    return csvImportResultSchema.parse({
      requestId,
      outcome: "applied",
      summary: {
        imported: receipt.rows.filter((row) => row.status === "imported")
          .length,
        skipped: receipt.rows.filter((row) => row.status === "skipped").length,
        errors: [
          ...receipt.errors,
          ...receipt.rows
            .filter((row) => row.status === "limited")
            .map((row) => ({
              line: row.line,
              message: `Plan limit reached (${receipt.limit} team members on the ${receipt.plan} plan). Upgrade in Settings → Billing.`,
            })),
        ].sort((a, b) => a.line - b.line),
      },
    });
  };
  const prior = await readReceipt();
  if (prior) return prior;
  const base = {
    fingerprint,
    token,
    requestId,
    errors: [],
    rows: [],
    plan: "free",
    limit: 0,
  };
  if (mode === "review") {
    markDatabaseWrite();
    await db
      .prepare(
        `INSERT INTO app_setting(id,orgId,key,value) SELECT ?,?,?,? WHERE ${access.guard} ON CONFLICT(orgId,key) DO NOTHING`,
      )
      .bind(
        crypto.randomUUID(),
        orgId,
        key,
        JSON.stringify({ ...base, outcome: "cancelled" }),
        ...access.guardArgs,
      )
      .run();
  } else {
    const parsed = parseCrewImport(command.csv),
      plan = await importPlan(db, orgId);
    const taken = new Set(
      (
        await db
          .prepare("SELECT memberId FROM crew_member WHERE orgId=?")
          .bind(orgId)
          .all<{ memberId: string }>()
      ).results.map((row) => row.memberId),
    );
    const candidates = parsed.valid.map((row) => ({
      ...row,
      id: crypto.randomUUID(),
      memberId: generateMemberId(row.name, taken),
    }));
    const rows = JSON.stringify(candidates),
      value = (outcome: string) =>
        JSON.stringify({
          ...base,
          outcome,
          errors: parsed.errors,
          plan: plan.plan,
          limit: plan.limit,
        });
    const claim =
        "EXISTS(SELECT 1 FROM app_setting WHERE orgId=? AND key=? AND json_extract(value,'$.token')=? AND json_extract(value,'$.outcome')='applied')",
      claimArgs = [orgId, key, token];
    const expiry = new Date(command.expiresAt).toISOString();
    markDatabaseWrite();
    await db.batch([
      db
        .prepare(
          `INSERT INTO app_setting(id,orgId,key,value) SELECT ?,?,?,CASE
        WHEN julianday(?)<=julianday('now') OR julianday(?)>julianday('now','+30 seconds') THEN ?
        WHEN ${plan.guard} THEN ? ELSE ? END WHERE ${access.guard} ON CONFLICT(orgId,key) DO NOTHING`,
        )
        .bind(
          crypto.randomUUID(),
          orgId,
          key,
          expiry,
          expiry,
          value("expired"),
          ...plan.args,
          value("applied"),
          value("conflict"),
          ...access.guardArgs,
        ),
      db
        .prepare(
          `WITH candidates AS (SELECT json_extract(value,'$.id') AS id,json_extract(value,'$.memberId') AS memberId,json_extract(value,'$.name') AS name,json_extract(value,'$.email') AS email,json_extract(value,'$.role') AS role,json_extract(value,'$.line') AS line FROM json_each(?))
        INSERT INTO crew_member(id,orgId,memberId,name,email,role,photoUrl,isOnline,createdAt)
        SELECT c.id,?,c.memberId,c.name,c.email,c.role,'',0,CURRENT_TIMESTAMP FROM candidates c
        WHERE ${claim} AND NOT EXISTS(SELECT 1 FROM crew_member WHERE orgId=? AND lower(trim(email))=c.email)
          AND c.line=(SELECT min(first.line) FROM candidates first WHERE first.email=c.email)
        ORDER BY c.line LIMIT max(0,?-(SELECT count(*) FROM crew_member WHERE orgId=?))`,
        )
        .bind(rows, orgId, ...claimArgs, orgId, plan.limit, orgId),
      db
        .prepare(
          `UPDATE app_setting SET value=json_set(value,'$.rows',json((SELECT json_group_array(json_object('line',json_extract(c.value,'$.line'),'status',CASE
        WHEN EXISTS(SELECT 1 FROM crew_member WHERE orgId=? AND id=json_extract(c.value,'$.id')) THEN 'imported'
        WHEN EXISTS(SELECT 1 FROM crew_member WHERE orgId=? AND lower(trim(email))=json_extract(c.value,'$.email')) THEN 'skipped' ELSE 'limited' END)) FROM json_each(?) c)))
        WHERE orgId=? AND key=? AND json_extract(value,'$.token')=? AND json_extract(value,'$.outcome')='applied'`,
        )
        .bind(orgId, orgId, rows, ...claimArgs),
    ]);
  }
  const result = await readReceipt();
  if (!result)
    throw new Error(
      "The CSV import was not confirmed. Retry the original import.",
    );
  return result;
}
