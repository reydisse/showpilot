import { getAuth } from "./auth";
import { resolveEffectiveAccess } from "./effective-access";
import { readRequestJsonWithinLimit } from "./request-body.server";
import { browserErrorSchema, OPERATIONAL_ERRORS, type OperationalErrorCode } from "./operational-errors";
import { recordOperationalError } from "./operational-errors.server";

export async function handleOperationalErrorRequest(request: Request, db: D1Database, orgId: string, ctx: Pick<ExecutionContext, "waitUntil">): Promise<Response> {
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
  if (!["GET", "POST"].includes(request.method)) return json({ error: "Method not allowed" }, 405);
  if (request.method === "POST" && request.headers.get("origin") !== new URL(request.url).origin) return json({ error: "Origin not allowed" }, 403);
  const session = await getAuth().api.getSession({ headers: request.headers });
  if (!session) return json({ error: "Unauthorized" }, 401);
  const access = await resolveEffectiveAccess(db, session.user.id, orgId);
  if (!access) return json({ error: "Forbidden" }, 403);
  if (request.method === "GET") {
    if (!access.permissions.includes("settings:api_keys")) return json({ error: "Forbidden" }, 403);
    const result = await db.prepare("SELECT id,source,code,errorName,asset,line,column,createdAt FROM operational_error WHERE orgId=? ORDER BY createdAt DESC, id DESC LIMIT 50")
      .bind(orgId).all<{ id: string; source: string; code: OperationalErrorCode; errorName: string; asset: string | null; line: number | null; column: number | null; createdAt: number }>();
    return json({ errors: result.results.map(row => ({ ...row, message: OPERATIONAL_ERRORS[row.code]?.message ?? "Unexpected operational error." })) });
  }
  const body = await readRequestJsonWithinLimit(request, 1024);
  if (!body.ok) return json({ error: "Invalid report" }, body.status);
  const parsed = browserErrorSchema.safeParse(body.value);
  if (!parsed.success) return json({ error: "Invalid report" }, 400);
  // 202 acknowledges receipt, not persistence. The rate limit may suppress a report.
  ctx.waitUntil(recordOperationalError(db, orgId, parsed.data).then(() => undefined).catch(() => undefined));
  return json({ accepted: true }, 202);
}
