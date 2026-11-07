import { getAuth } from "./auth";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { executeTeamCommand } from "./team-command.server";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getD1 } from "@/lib/d1";
import { assertOrgPermission } from "@/lib/org-access";
import { idSchema, parseOrThrow } from "@/lib/validation";

export interface ContentReportItem {
  id: string;
  reporterName: string;
  targetType: "chat-message" | "incident-comment";
  targetId: string;
  targetAuthorName: string | null;
  reason: string;
  details: string;
  status: "open" | "reviewing" | "resolved" | "dismissed";
  createdAt: string;
}

export const getContentReports = createServerFn({ method: "GET" })
  .inputValidator((value: unknown) =>
    parseOrThrow(z.object({ orgId: idSchema }), value),
  )
  .handler(async ({ data }): Promise<ContentReportItem[]> => {
    await assertOrgPermission(data.orgId, "settings:members");
    const rows = await getD1()
      .prepare(
        `SELECT r.id, reporter.name AS reporterName, r.targetType, r.targetId,
              author.name AS targetAuthorName, r.reason, r.details, r.status, strftime('%Y-%m-%dT%H:%M:%fZ', r.createdAt) AS createdAt
       FROM content_report r
       JOIN user reporter ON reporter.id = r.reporterUserId
       LEFT JOIN user author ON author.id = r.targetAuthorId
       WHERE r.orgId = ? AND r.status IN ('open', 'reviewing')
       ORDER BY r.createdAt ASC LIMIT 100`,
      )
      .bind(data.orgId)
      .all<ContentReportItem>();
    return rows.results ?? [];
  });

export const closeContentReport = createServerFn({ method: "POST" })
  .inputValidator((value: unknown) =>
    parseOrThrow(
      z.object({
        orgId: idSchema,
        reportId: idSchema,
        status: z.enum(["resolved", "dismissed"]),
        requestId: z.uuid().optional(),
      }),
      value,
    ),
  )
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "settings:members");
    const session = await getAuth().api.getSession({
      headers: getRequestHeaders(),
      query: { disableCookieCache: true },
    });
    if (!session) throw new Error("Unauthorized");
    await executeTeamCommand(
      getD1(),
      { userId: session.user.id, sessionId: session.session.id },
      { ...data, kind: "report" },
    );
    return { ok: true as const };
  });
