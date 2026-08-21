import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getD1 } from "@/lib/d1";
import { assertOrgPermission } from "@/lib/org-access";
import { idSchema, parseOrThrow } from "@/lib/validation";

export const TM_LAYOUT_WIDGET_IDS = ["prep", "faults", "all-clear"] as const;
// Default reading order: assess the technical system and work the fault
// queue first; live stream telemetry and execution controls follow. Managers
// can still move Live Operations higher when that better matches their role.
export const TM_LAYOUT_SECTION_IDS = ["overview", "signal-path", "workspace", "operations"] as const;
const widgetIdSchema = z.enum(TM_LAYOUT_WIDGET_IDS);
const sectionIdSchema = z.enum(TM_LAYOUT_SECTION_IDS);
const layoutSchema = z.object({ version: z.literal(1), sections: z.array(sectionIdSchema).max(TM_LAYOUT_SECTION_IDS.length), main: z.array(widgetIdSchema).max(TM_LAYOUT_WIDGET_IDS.length) });
export type TmDashboardLayout = z.infer<typeof layoutSchema>;

async function getLayoutViewer(orgId: string) {
  const { user } = await assertOrgPermission(orgId, "dashboard:tm");
  return user.id;
}

export const getTmDashboardLayout = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema }), data))
  .handler(async ({ data }): Promise<TmDashboardLayout> => {
    const userId = await getLayoutViewer(data.orgId);
    try {
      const row = await getD1().prepare(
        `SELECT layout FROM dashboard_layout WHERE orgId = ? AND userId = ? AND dashboard = 'tech-manager' LIMIT 1`,
      ).bind(data.orgId, userId).first<{ layout: string }>();
      if (!row) return defaultLayout();
      const parsed = layoutSchema.safeParse(JSON.parse(row.layout));
      return parsed.success ? completeLayout(parsed.data) : defaultLayout();
    } catch {
      // Migration not present or stale preference: the dashboard still works.
      return defaultLayout();
    }
  });

export const saveTmDashboardLayout = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema, layout: layoutSchema }), data))
  .handler(async ({ data }) => {
    const userId = await getLayoutViewer(data.orgId);
    const layout = completeLayout(data.layout);
    const id = crypto.randomUUID();
    const result = await getD1().prepare(
      `INSERT INTO dashboard_layout (id, orgId, userId, dashboard, layout, updatedAt)
       VALUES (?, ?, ?, 'tech-manager', ?, CURRENT_TIMESTAMP)
       ON CONFLICT(orgId, userId, dashboard) DO UPDATE SET layout = excluded.layout, updatedAt = CURRENT_TIMESTAMP`,
    ).bind(id, data.orgId, userId, JSON.stringify(layout)).run();
    if (!result.success) throw new Error("Could not save dashboard layout");
    return layout;
  });

function completeLayout(layout: TmDashboardLayout): TmDashboardLayout {
  const unique = [...new Set(layout.main)];
  for (const id of TM_LAYOUT_WIDGET_IDS) if (!unique.includes(id)) unique.push(id);
  const sections = [...new Set(layout.sections)];
  for (const id of TM_LAYOUT_SECTION_IDS) if (!sections.includes(id)) sections.push(id);
  return { version: 1, sections, main: unique };
}

function defaultLayout(): TmDashboardLayout {
  return { version: 1, sections: [...TM_LAYOUT_SECTION_IDS], main: [...TM_LAYOUT_WIDGET_IDS] };
}
