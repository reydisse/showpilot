import { z } from "zod";

export const publicCheckInOrgSchema = z.object({ slug: z.string().min(1).max(64) });
export const publicMemberLookupSchema = publicCheckInOrgSchema.extend({
  memberId: z.string().trim().min(1, "Enter your member ID.").max(64).transform(value => value.toUpperCase()),
});
export const publicAttendanceWriteSchema = publicMemberLookupSchema.extend({
  intent: z.enum(["check-in", "check-out"]),
  requestId: z.uuid(),
  expectedRevision: z.string().regex(/^[a-f0-9]{64}$/, "Find your member ID again before confirming attendance."),
});
export type PublicAttendanceWrite = z.infer<typeof publicAttendanceWriteSchema>;
export interface PublicCrewMember {
  memberId: string;
  name: string;
  photoUrl: string;
  role: string;
  isOnline: boolean;
  revision: string;
}
export interface PublicAttendanceResult {
  requestId: string;
  outcome: "applied" | "conflict";
  member: PublicCrewMember | null;
}
