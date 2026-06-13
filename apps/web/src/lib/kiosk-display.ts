import { getPrisma } from "@/lib/db";

// ─────────────────────────────────────────────────────────────
// Kiosk display command: the per-org "blank" flag (button 9).
//
// Stored as a `kiosk_blanked` AppSetting so the existing read-only kiosk
// polling API can surface it without a new socket. When blanked, kiosk
// clients show a black/branded slate; when restored, they return to their
// view. Caller is responsible for access control.
// ─────────────────────────────────────────────────────────────

const KIOSK_BLANKED_KEY = "kiosk_blanked";

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
  return row?.value === "true";
}
