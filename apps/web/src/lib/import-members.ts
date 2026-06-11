import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { z } from "zod";
import { getPrisma } from "@/lib/db";
import { hasPermission, normalizeRole } from "@/lib/app-permissions";
import { emailSchema, parseOrThrow, idSchema } from "@/lib/validation";
import { PLAN_LIMITS, getEffectivePlanForOrg } from "@/lib/plan-limits";
import { parseCsv, mapColumns, generateMemberId } from "@/lib/import-members-csv";

const MAX_ROWS = 500;
const MAX_CSV_BYTES = 512 * 1024;

export interface ImportSummary {
  imported: number;
  skipped: number;
  errors: Array<{ line: number; message: string }>;
}

async function assertCanManageMembers(orgId: string) {
  const { getAuth } = await import("@/lib/auth");
  const auth = getAuth();
  const headers = getRequestHeaders();
  const session = await auth.api.getSession({ headers });
  if (!session) throw new Error("Unauthorized");

  const prisma = getPrisma();
  const member = await prisma.member.findFirst({
    where: { organizationId: orgId, userId: session.user.id },
    select: { role: true },
  });
  const role = normalizeRole(member?.role ?? null);
  if (!role || !hasPermission(role, "settings:members")) throw new Error("Forbidden");
}

const rowSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100, "Name too long"),
  email: emailSchema,
  role: z.string().trim().max(50, "Role too long"),
});

export const importMembersCsv = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(
      z.object({
        orgId: idSchema,
        csv: z.string().min(1, "CSV is empty").max(MAX_CSV_BYTES, "CSV too large (max 512 KB)"),
      }),
      data,
    ),
  )
  .handler(async ({ data }): Promise<ImportSummary> => {
    await assertCanManageMembers(data.orgId);
    const prisma = getPrisma();

    const rows = parseCsv(data.csv);
    if (rows.length < 2) throw new Error("CSV needs a header row and at least one data row");
    if (rows.length - 1 > MAX_ROWS) throw new Error(`Too many rows (max ${MAX_ROWS})`);

    const cols = mapColumns(rows[0]);
    if (cols.name === undefined && cols.firstName === undefined) {
      throw new Error('Missing a "name" column (or "First Name"/"Last Name")');
    }
    if (cols.email === undefined) throw new Error('Missing an "email" column');

    const existing = await prisma.crewMember.findMany({
      where: { orgId: data.orgId },
      select: { email: true, memberId: true },
    });
    const seenEmails = new Set(existing.map((m) => m.email.toLowerCase()).filter(Boolean));
    const takenIds = new Set(existing.map((m) => m.memberId));

    // Crew roster is capped by the plan's member limit.
    const plan = await getEffectivePlanForOrg(data.orgId);
    const memberLimit = PLAN_LIMITS[plan].members;
    let roster = existing.length;

    const errors: ImportSummary["errors"] = [];
    let skipped = 0;
    const toCreate: Array<{
      orgId: string;
      memberId: string;
      name: string;
      role: string;
      email: string;
    }> = [];

    for (let i = 1; i < rows.length; i++) {
      const line = i + 1; // 1-based, header is line 1
      const row = rows[i];
      const name =
        cols.name !== undefined
          ? row[cols.name]
          : `${row[cols.firstName!] ?? ""} ${cols.lastName !== undefined ? (row[cols.lastName] ?? "") : ""}`.trim();
      const parsed = rowSchema.safeParse({
        name,
        email: (row[cols.email] ?? "").trim().toLowerCase(),
        role: cols.role !== undefined ? (row[cols.role] ?? "") : "",
      });
      if (!parsed.success) {
        errors.push({ line, message: parsed.error.issues[0]?.message ?? "Invalid row" });
        continue;
      }

      if (seenEmails.has(parsed.data.email)) {
        skipped++;
        continue;
      }

      if (roster >= memberLimit) {
        errors.push({
          line,
          message: `Plan limit reached (${memberLimit} team members on the ${plan} plan). Upgrade in Settings → Billing.`,
        });
        continue;
      }

      seenEmails.add(parsed.data.email);
      roster++;
      toCreate.push({
        orgId: data.orgId,
        memberId: generateMemberId(parsed.data.name, takenIds),
        name: parsed.data.name,
        role: parsed.data.role || "Crew",
        email: parsed.data.email,
      });
    }

    if (toCreate.length > 0) {
      await prisma.crewMember.createMany({ data: toCreate });
    }

    return { imported: toCreate.length, skipped, errors };
  });
