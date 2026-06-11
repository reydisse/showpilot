import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { getPrisma } from "@/lib/db";
import { hasPermission } from "@/lib/app-permissions";
import { persistRundownItemsForOrg, getRundownStateForOrg } from "@/lib/rundown";
import {
  getOnboardingTemplate,
  runTemplateSeed,
  type TemplateSeedStore,
} from "@/lib/templates";
import { z } from "zod";
import { idSchema, parseOrThrow, serviceDateSchema } from "@/lib/validation";

// ─────────────────────────────────────────────────────────────
// Onboarding wizard server functions. Wizard progress lives in
// org-scoped appSettings (the same storage UI prefs use) so a
// refresh mid-wizard resumes at the right scene with no localStorage.
// ─────────────────────────────────────────────────────────────

const ONBOARDING_SEED_KEY = "onboarding-template-seeded";

async function getSessionUser() {
  const { getAuth } = await import("@/lib/auth");
  const auth = getAuth();
  const headers = getRequestHeaders();
  const session = await auth.api.getSession({ headers });
  if (!session) throw new Error("Unauthorized");
  return session.user;
}

async function getOrgMemberRole(orgId: string) {
  const user = await getSessionUser();
  const prisma = getPrisma();
  const member = await prisma.member.findFirst({
    where: { organizationId: orgId, userId: user.id },
    select: { id: true, role: true },
  });
  if (!member) throw new Error("Forbidden");
  return member.role ?? "member";
}

interface SeedMarker {
  template: string;
  serviceDate: string;
}

function parseSeedMarker(value: string | null | undefined): SeedMarker | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as SeedMarker;
    if (typeof parsed?.template === "string" && typeof parsed?.serviceDate === "string") {
      return parsed;
    }
  } catch {
    // Treat unreadable markers as seeded — never duplicate.
  }
  return { template: "", serviceDate: "" };
}

export async function getSeedMarkerForOrg(orgId: string): Promise<SeedMarker | null> {
  const prisma = getPrisma();
  const setting = await prisma.appSetting.findUnique({
    where: { orgId_key: { orgId, key: ONBOARDING_SEED_KEY } },
  });
  return parseSeedMarker(setting?.value);
}

/**
 * Seed the org's first show from an onboarding template: rundown items,
 * checklist templates, and sample cue rows. Idempotent — re-running for
 * an org that already seeded returns the existing rundown unchanged.
 */
export const seedOrgTemplate = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(
      z.object({
        orgId: idSchema,
        template: z.enum(["sunday", "youth", "special", "blank"]),
        serviceDate: serviceDateSchema,
      }),
      data,
    ),
  )
  .handler(async ({ data }) => {
    const role = await getOrgMemberRole(data.orgId);
    if (!hasPermission(role, "rundown:edit")) throw new Error("Forbidden");

    const template = getOnboardingTemplate(data.template);
    if (!template) throw new Error("Unknown template");

    const prisma = getPrisma();

    const store: TemplateSeedStore = {
      getSeedMarker: async () => {
        const marker = await getSeedMarkerForOrg(data.orgId);
        return marker ? JSON.stringify(marker) : null;
      },
      setSeedMarker: async () => {
        const value = JSON.stringify({ template: template.id, serviceDate: data.serviceDate });
        await prisma.appSetting.upsert({
          where: { orgId_key: { orgId: data.orgId, key: ONBOARDING_SEED_KEY } },
          update: { value },
          create: { orgId: data.orgId, key: ONBOARDING_SEED_KEY, value },
        });
      },
      persistRundownItems: (items) =>
        persistRundownItemsForOrg(data.orgId, data.serviceDate, items),
      createChecklistTemplates: async (rows) => {
        await Promise.all(
          rows.map((row) =>
            prisma.checklistTemplate.create({
              data: {
                orgId: data.orgId,
                label: row.label,
                category: row.category,
                sortOrder: row.sortOrder,
              },
            }),
          ),
        );
      },
      createCueRows: async (rows) => {
        await Promise.all(
          rows.map((row) =>
            prisma.cueSheet.create({
              data: {
                orgId: data.orgId,
                cueNumber: row.cueNumber,
                rundownItem: row.rundownItem,
                cameraAssignments: row.cameraAssignments,
                notes: row.notes,
                serviceDate: data.serviceDate,
              },
            }),
          ),
        );
      },
      getExistingItems: async () => {
        const marker = await getSeedMarkerForOrg(data.orgId);
        const serviceDate = marker?.serviceDate || data.serviceDate;
        const state = await getRundownStateForOrg({ orgId: data.orgId, serviceDate });
        return state.items;
      },
    };

    const result = await runTemplateSeed(store, template);
    return {
      items: result.items,
      alreadySeeded: result.alreadySeeded,
      template: template.id,
      serviceDate: data.serviceDate,
    };
  });
