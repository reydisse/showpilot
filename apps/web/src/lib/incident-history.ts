import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { z } from "zod";
import { getPrisma } from "@/lib/db";
import { getD1 } from "@/lib/d1";
import { hasAnyPermission } from "@/lib/app-permissions";
import { idSchema, parseOrThrow, serviceDateSchema } from "@/lib/validation";

const historyInput = z.object({
  orgId: idSchema,
  query: z.string().trim().max(200).optional(),
  status: z.enum(["all", "open", "resolved"]).default("all"),
  severity: z.enum(["all", "low", "medium", "high", "critical"]).default("all"),
  category: z.string().trim().max(100).optional(),
  assignee: z.string().trim().max(200).optional(),
  from: serviceDateSchema.optional(),
  to: serviceDateSchema.optional(),
  sort: z.enum(["newest", "oldest", "severity"]).default("newest"),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(10).max(100).default(30),
});

const CATEGORY_LABELS: Record<string, string> = {
  audio: "Audio",
  video: "Video",
  lighting: "Lighting",
  network: "Network",
  power: "Power",
  software: "Software",
  hardware: "Hardware",
  other: "Other",
};

function categoryLabel(value: string): string {
  const normalized = value.trim().toLowerCase();
  return CATEGORY_LABELS[normalized] ?? normalized.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

async function assertAccess(orgId: string) {
  const { getAuth } = await import("@/lib/auth");
  const session = await getAuth().api.getSession({ headers: getRequestHeaders() });
  if (!session) throw new Error("Unauthorized");
  const member = await getPrisma().member.findFirst({
    where: { organizationId: orgId, userId: session.user.id },
    select: { role: true },
  });
  if (!member || !hasAnyPermission(member.role ?? "member", ["incidents:report", "incidents:access"])) {
    throw new Error("Forbidden");
  }
}

export const getIncidentHistory = createServerFn({ method: "GET" })
  .inputValidator((value: unknown) => parseOrThrow(historyInput, value))
  .handler(async ({ data }) => {
    await assertAccess(data.orgId);
    const conditions = ["i.orgId = ?"];
    const params: unknown[] = [data.orgId];
    const add = (sql: string, value: unknown) => { conditions.push(sql); params.push(value); };
    if (data.status !== "all") add("i.status = ?", data.status);
    if (data.severity !== "all") add("i.severity = ?", data.severity);
    if (data.category) add("lower(trim(i.category)) = ?", data.category.trim().toLowerCase());
    if (data.assignee) add("lower(i.assignedName) LIKE ?", `%${data.assignee.toLowerCase()}%`);
    if (data.from) add("i.serviceDate >= ?", data.from);
    if (data.to) add("i.serviceDate <= ?", data.to);
    if (data.query) {
      const needle = `%${data.query.toLowerCase()}%`;
      conditions.push("(lower(i.description) LIKE ? OR lower(i.reportedBy) LIKE ? OR lower(i.assignedName) LIKE ? OR lower(i.category) LIKE ?)");
      params.push(needle, needle, needle, needle);
    }
    const whereSql = conditions.join(" AND ");
    const orderSql = data.sort === "oldest"
      ? "i.timestamp ASC"
      : data.sort === "severity"
        ? "CASE lower(i.severity) WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC, i.timestamp DESC"
        : "i.timestamp DESC";
    type HistoryRow = { id: string; orgId: string; showId: string | null; category: string; severity: string; description: string; reportedBy: string; serviceDate: string; timestamp: string; status: string; resolvedAt: string | null; resolvedBy: string | null; assignedTo: string | null; assignedName: string; acknowledgedAt: string | null; assignedBy: string | null; assignedAt: string | null; commentCount: number };
    const db = getD1();
    const [countRow, rowResult, categoryResult] = await Promise.all([
      db.prepare(`SELECT COUNT(*) AS total FROM incident i WHERE ${whereSql}`).bind(...params).first<{ total: number }>(),
      db.prepare(`SELECT i.*, (SELECT COUNT(*) FROM incident_comment c WHERE c.incidentId = i.id) AS commentCount FROM incident i WHERE ${whereSql} ORDER BY ${orderSql} LIMIT ? OFFSET ?`).bind(...params, data.pageSize, (data.page - 1) * data.pageSize).all<HistoryRow>(),
      db.prepare("SELECT DISTINCT lower(trim(category)) AS category FROM incident WHERE orgId = ? AND trim(category) <> '' ORDER BY category ASC").bind(data.orgId).all<{ category: string }>(),
    ]);
    const rows = rowResult.results ?? [];
    return {
      total: countRow?.total ?? 0,
      page: data.page,
      pageSize: data.pageSize,
      categories: (categoryResult.results ?? []).map((row) => categoryLabel(row.category)),
      incidents: rows.map((row) => ({ ...row, category: categoryLabel(row.category) })),
    };
  });
