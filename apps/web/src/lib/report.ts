import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { getPrisma } from "@/lib/db";
import type { NativeTimerState, RundownItem } from "@/types/rundown";

async function assertOrgAccess(orgId: string) {
  const { getAuth } = await import("@/lib/auth");
  const auth = getAuth();
  const headers = getRequestHeaders();
  const session = await auth.api.getSession({ headers });
  if (!session) throw new Error("Unauthorized");

  const prisma = getPrisma();
  const member = await prisma.member.findFirst({
    where: { organizationId: orgId, userId: session.user.id },
    select: { id: true },
  });
  if (!member) throw new Error("Forbidden");
}

type ShowReport = {
  generatedAt: string;
  serviceDate: string;
  organization: { id: string; name: string; slug: string };
  summary: {
    totalItems: number;
    completedItems: number;
    plannedDurationMs: number;
    finalPlayback: NativeTimerState["playback"];
    currentItemId: string | null;
    elapsedMs: number;
  };
  rundown: {
    items: RundownItem[];
    timer: NativeTimerState;
    stageMessage: string;
  };
  incidents: Array<{
    id: string;
    category: string;
    severity: string;
    description: string;
    reportedBy: string;
    timestamp: string;
  }>;
  checklist: Array<{
    id: string;
    label: string;
    category: string;
    checked: boolean;
    checkedBy: string | null;
    checkedAt: string | null;
  }>;
  cueSheets: Array<{
    id: string;
    cueNumber: number;
    rundownItem: string;
    cameraAssignments: string;
    notes: string;
  }>;
};

export const exportShowReport = createServerFn({ method: "POST" })
  .inputValidator((data: { orgId: string; serviceDate: string }) => data)
  .handler(async ({ data }): Promise<ShowReport> => {
    await assertOrgAccess(data.orgId);

    const prisma = getPrisma();
    const org = await prisma.organization.findUnique({
      where: { id: data.orgId },
      select: { id: true, name: true, slug: true },
    });
    if (!org) throw new Error("Organization not found");

    const [itemsSetting, timerSetting, messageSetting, incidents, entries, templates, cueSheets] = await Promise.all([
      prisma.appSetting.findUnique({
        where: { orgId_key: { orgId: data.orgId, key: `rundown-items:${data.serviceDate}` } },
      }),
      prisma.appSetting.findUnique({
        where: { orgId_key: { orgId: data.orgId, key: `rundown-timer:${data.serviceDate}` } },
      }),
      prisma.appSetting.findUnique({
        where: { orgId_key: { orgId: data.orgId, key: `rundown-message:${data.serviceDate}` } },
      }),
      prisma.incident.findMany({
        where: { orgId: data.orgId, serviceDate: data.serviceDate },
        orderBy: { timestamp: "asc" },
      }),
      prisma.checklistEntry.findMany({
        where: { orgId: data.orgId, serviceDate: data.serviceDate },
        orderBy: { checkedAt: "asc" },
      }),
      prisma.checklistTemplate.findMany({
        where: { orgId: data.orgId },
        select: { id: true, label: true, category: true },
      }),
      prisma.cueSheet.findMany({
        where: { orgId: data.orgId, serviceDate: data.serviceDate },
        orderBy: { cueNumber: "asc" },
      }),
    ]);

    const items = itemsSetting ? (JSON.parse(itemsSetting.value) as RundownItem[]) : [];
    const timer = timerSetting
      ? (JSON.parse(timerSetting.value) as NativeTimerState)
      : {
          playback: "stop",
          currentItemId: null,
          elapsed: 0,
          startedAt: null,
          pausedAt: null,
          mode: "count-down",
          serverTime: Date.now(),
        };

    const templateMap = new Map(templates.map((template) => [template.id, template]));
    const plannedDurationMs = items.reduce((sum, item) => sum + item.duration, 0);

    return {
      generatedAt: new Date().toISOString(),
      serviceDate: data.serviceDate,
      organization: org,
      summary: {
        totalItems: items.length,
        completedItems: items.filter((item) => item.status === "complete").length,
        plannedDurationMs,
        finalPlayback: timer.playback,
        currentItemId: timer.currentItemId,
        elapsedMs: timer.elapsed,
      },
      rundown: {
        items,
        timer,
        stageMessage: messageSetting?.value ?? "",
      },
      incidents: incidents.map((incident) => ({
        id: incident.id,
        category: incident.category,
        severity: incident.severity,
        description: incident.description,
        reportedBy: incident.reportedBy,
        timestamp: incident.timestamp.toISOString(),
      })),
      checklist: entries.map((entry) => {
        const template = templateMap.get(entry.templateId);
        return {
          id: entry.id,
          label: template?.label ?? entry.templateId,
          category: template?.category ?? "unknown",
          checked: entry.checked,
          checkedBy: entry.checkedBy,
          checkedAt: entry.checkedAt?.toISOString() ?? null,
        };
      }),
      cueSheets: cueSheets.map((cueSheet) => ({
        id: cueSheet.id,
        cueNumber: cueSheet.cueNumber,
        rundownItem: cueSheet.rundownItem,
        cameraAssignments: cueSheet.cameraAssignments,
        notes: cueSheet.notes,
      })),
    };
  });
