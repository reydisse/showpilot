import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { getPrisma } from "@/lib/db";
import { hasPermission, normalizeRole } from "@/lib/app-permissions";
import { z } from "zod";
import { idSchema, parseOrThrow } from "@/lib/validation";

// ─────────────────────────────────────────────────────────────
// Kiosk display command: the per-org "blank" flag (button 9).
//
// Stored as a `kiosk_blanked` AppSetting so the existing read-only kiosk
// polling API can surface it without a new socket. When blanked, kiosk
// clients show a black/branded slate; when restored, they return to their
// view. Caller is responsible for access control.
// ─────────────────────────────────────────────────────────────

const KIOSK_BLANKED_KEY = "kiosk_blanked";

/** Map a stored kiosk_blanked AppSetting value to a boolean (default off). */
export function interpretBlankedValue(value: string | null | undefined): boolean {
  return value === "true";
}

export async function setKioskBlanked(orgId: string, blanked: boolean): Promise<void> {
  const prisma = getPrisma();
  await prisma.appSetting.upsert({
    where: { orgId_key: { orgId, key: KIOSK_BLANKED_KEY } },
    update: { value: blanked ? "true" : "false" },
    create: { orgId, key: KIOSK_BLANKED_KEY, value: blanked ? "true" : "false" },
  });
}

export async function getKioskBlanked(orgId: string): Promise<boolean> {
  const prisma = getPrisma();
  const row = await prisma.appSetting.findUnique({
    where: { orgId_key: { orgId, key: KIOSK_BLANKED_KEY } },
  });
  return interpretBlankedValue(row?.value);
}

// ─── Settings UI server fns (session-gated) ──────────────────
// Same permission as kiosk admin (settings:members) so the kiosk settings
// tab can flip the blank flag without a companion token.

async function assertKioskDisplayAccess(orgId: string): Promise<void> {
  const { getAuth } = await import("@/lib/auth");
  const auth = getAuth();
  const session = await auth.api.getSession({ headers: getRequestHeaders() });
  if (!session) throw new Error("Unauthorized");
  const prisma = getPrisma();
  const member = await prisma.member.findFirst({
    where: { organizationId: orgId, userId: session.user.id },
    select: { role: true },
  });
  const role = normalizeRole(member?.role ?? null);
  if (!role || !hasPermission(role, "settings:members")) throw new Error("Forbidden");
}

export const getKioskBlankState = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema }), data))
  .handler(async ({ data }) => {
    await assertKioskDisplayAccess(data.orgId);
    return { blanked: await getKioskBlanked(data.orgId) };
  });

export const setKioskBlankState = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(z.object({ orgId: idSchema, blanked: z.boolean() }), data),
  )
  .handler(async ({ data }) => {
    await assertKioskDisplayAccess(data.orgId);
    await setKioskBlanked(data.orgId, data.blanked);
    return { ok: true, blanked: data.blanked };
  });
