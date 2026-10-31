import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { idSchema, parseOrThrow } from "@/lib/validation";
import { getRequestOrgAccess } from "@/lib/org-access";
import { getD1 } from "@/lib/d1";

export const getMyDutyRoster = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({
    orgId: idSchema,
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }), data))
  .handler(async ({ data }) => {
    const { user } = await getRequestOrgAccess(data.orgId);
    const result = await getD1().prepare(`
      SELECT a.id, a.weekStart,
        CASE WHEN a.kind = 'pm' THEN 'Production Manager' ELSE r.name END AS roleName
      FROM roster_assignment a
      LEFT JOIN roster_role r ON r.orgId = a.orgId AND r.id = a.roleId
      WHERE a.orgId = ? AND a.userId = ?
        AND ((? IS NOT NULL AND a.weekStart = ?) OR (? IS NULL AND a.weekStart >= date('now', '-7 days')))
      ORDER BY a.weekStart, roleName LIMIT 100
    `).bind(data.orgId, user.id, data.date ?? null, data.date ?? null, data.date ?? null)
      .all<{ id: string; weekStart: string; roleName: string }>();
    return result.results;
  });
