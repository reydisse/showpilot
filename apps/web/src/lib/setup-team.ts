import { z } from "zod";
import { ASSIGNABLE_ROLES } from "./permissions";
import { emailSchema } from "./validation";

export const crewSchema = z.object({
  name: z.string().trim().min(1, "Enter a name or clear this row.").max(200, "Use 200 characters or fewer."),
  pos: z.string().trim().min(1, "Enter a position or clear this row.").max(100, "Use 100 characters or fewer."),
});
export const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(emailSchema),
  role: z.enum(ASSIGNABLE_ROLES),
});
export type SetupCrewRow = z.input<typeof crewSchema>;
export type SetupInviteRow = z.input<typeof inviteSchema>;
interface TeamIssue { field: string; row: string; message: string }

/** Blank optional rows are omitted; entered invalid rows block the whole submission. */
export function validateSetupTeam(crew: SetupCrewRow[], invites: SetupInviteRow[]) {
  const validCrew: z.output<typeof crewSchema>[] = [];
  const validInvites: z.output<typeof inviteSchema>[] = [];
  const issues: TeamIssue[] = [];
  for (const [index, row] of crew.entries()) {
    if (!row.name.trim() && !row.pos.trim()) continue;
    const result = crewSchema.safeParse(row);
    if (result.success) validCrew.push(result.data);
    else for (const issue of result.error.issues) {
      issues.push({ field: `crew-${index}-${String(issue.path[0])}`, row: `crew-${index}`, message: issue.message });
    }
  }
  const emails = new Map<string, number>();
  for (const [index, row] of invites.entries()) {
    if (!row.email.trim() && row.role === "member") continue;
    const result = inviteSchema.safeParse(row);
    if (!result.success) {
      for (const issue of result.error.issues) issues.push({
        field: `invite-${index}-${String(issue.path[0])}`, row: `invite-${index}`,
        message: issue.path[0] === "email" ? "Enter a valid email address, up to 254 characters, or clear this row." : "Choose an available role.",
      });
      continue;
    }
    const previous = emails.get(result.data.email);
    if (previous !== undefined) {
      for (const duplicate of [previous, index]) {
        const field = `invite-${duplicate}-email`;
        if (!issues.some(issue => issue.field === field)) issues.push({ field, row: `invite-${duplicate}`, message: "This email appears more than once. Keep one invitation." });
      }
    } else emails.set(result.data.email, index);
    validInvites.push(result.data);
  }
  return { crew: validCrew, invites: validInvites, issues, invalidRows: new Set(issues.map(issue => issue.row)).size };
}
