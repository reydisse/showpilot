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
import { idSchema, orgSlugSchema, parseOrThrow, serviceDateSchema } from "@/lib/validation";

// ─────────────────────────────────────────────────────────────
// Onboarding wizard server functions. Wizard progress lives in
// org-scoped appSettings (the same storage UI prefs use) so a
// refresh mid-wizard resumes at the right scene with no localStorage.
// ─────────────────────────────────────────────────────────────

const ONBOARDING_SEED_KEY = "onboarding-template-seeded";
const ONBOARDING_STARTED_KEY = "onboarding-started";
const ONBOARDING_COMPLETED_KEY = "onboarding-completed";

function onboardingRoleKey(userId: string) {
  return `onboarding-role:${userId}`;
}

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

// ─── Wizard progress (resume derivation source) ──────────────

export interface OnboardingProgressPayload {
  authenticated: boolean;
  hasOrg: boolean;
  isOwner: boolean;
  started: boolean;
  completed: boolean;
  archetype: string | null;
  landing: string | null;
  seededTemplate: string | null;
  seedServiceDate: string | null;
  org: { id: string; name: string; slug: string } | null;
}

const EMPTY_PROGRESS: OnboardingProgressPayload = {
  authenticated: false,
  hasOrg: false,
  isOwner: false,
  started: false,
  completed: false,
  archetype: null,
  landing: null,
  seededTemplate: null,
  seedServiceDate: null,
  org: null,
};

/**
 * Server-derived wizard state for the setup route. A refresh mid-wizard
 * resumes from this — no localStorage.
 */
export const getOnboardingProgress = createServerFn({ method: "GET" }).handler(
  async (): Promise<OnboardingProgressPayload> => {
    const user = await getSessionUser().catch(() => null);
    if (!user) return EMPTY_PROGRESS;

    const prisma = getPrisma();
    const membership = await prisma.member.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: "asc" },
      include: { organization: { select: { id: true, name: true, slug: true } } },
    });
    if (!membership) return { ...EMPTY_PROGRESS, authenticated: true };

    const orgId = membership.organizationId;
    const roleKey = onboardingRoleKey(user.id);
    const settings = await prisma.appSetting.findMany({
      where: {
        orgId,
        key: { in: [ONBOARDING_STARTED_KEY, ONBOARDING_COMPLETED_KEY, ONBOARDING_SEED_KEY, roleKey] },
      },
    });
    const byKey = new Map(settings.map((setting) => [setting.key, setting.value]));

    let archetype: string | null = null;
    let landing: string | null = null;
    const roleValue = byKey.get(roleKey);
    if (roleValue) {
      try {
        const parsed = JSON.parse(roleValue) as { archetype?: string; landing?: string };
        archetype = typeof parsed.archetype === "string" ? parsed.archetype : null;
        landing = typeof parsed.landing === "string" ? parsed.landing : null;
      } catch {
        archetype = null;
      }
    }

    const seedMarker = parseSeedMarker(byKey.get(ONBOARDING_SEED_KEY));

    return {
      authenticated: true,
      hasOrg: true,
      isOwner: membership.role === "owner",
      started: Boolean(byKey.get(ONBOARDING_STARTED_KEY)),
      completed: Boolean(byKey.get(ONBOARDING_COMPLETED_KEY)),
      archetype,
      landing,
      seededTemplate: seedMarker?.template ?? null,
      seedServiceDate: seedMarker?.serviceDate ?? null,
      org: membership.organization,
    };
  },
);

async function upsertOrgSetting(orgId: string, key: string, value: string) {
  const prisma = getPrisma();
  await prisma.appSetting.upsert({
    where: { orgId_key: { orgId, key } },
    update: { value },
    create: { orgId, key, value },
  });
}

/**
 * Checkpoint #1 marker: the org was created through the wizard. Orgs
 * without it (pre-existing, invited members) never see the wizard.
 */
export const markOnboardingStarted = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema }), data))
  .handler(async ({ data }) => {
    const role = await getOrgMemberRole(data.orgId);
    if (role !== "owner") throw new Error("Forbidden");
    await upsertOrgSetting(data.orgId, ONBOARDING_STARTED_KEY, new Date().toISOString());
    return { ok: true };
  });

// ─── Slug availability (Scene 1 live check) ──────────────────

export const checkOrgSlug = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ slug: z.string().max(60) }), data))
  .handler(async ({ data }): Promise<{ available: boolean; suggestion: string | null }> => {
    await getSessionUser();

    const parsed = orgSlugSchema.safeParse(data.slug);
    if (!parsed.success) return { available: false, suggestion: null };

    const prisma = getPrisma();
    const existing = await prisma.organization.findUnique({
      where: { slug: parsed.data },
      select: { id: true },
    });
    if (!existing) return { available: true, suggestion: null };

    // Taken — offer the first free numbered variant, e.g. faithfire-2.
    const base = parsed.data.slice(0, 37);
    const candidates = Array.from({ length: 8 }, (_, i) => `${base}-${i + 2}`);
    const taken = await prisma.organization.findMany({
      where: { slug: { in: candidates } },
      select: { slug: true },
    });
    const takenSet = new Set(taken.map((org) => org.slug));
    const suggestion = candidates.find((candidate) => !takenSet.has(candidate)) ?? null;
    return { available: false, suggestion };
  });

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
