import { z } from "zod";
import { idSchema } from "./validation";
import type { PublicCrewMember } from "./public-checkin";
export interface CrewAttendanceMember extends PublicCrewMember { id: string }
export const crewAttendanceOperationSchema = z.object({
  isOnline: z.boolean(),
  members: z.array(z.object({ id: idSchema, expectedRevision: z.string().regex(/^[a-f0-9]{64}$/) })).min(1).max(5_000)
    .refine(members => new Set(members.map(member => member.id)).size === members.length, "Choose each crew member once."),
});
export const crewAttendanceWriteSchema = crewAttendanceOperationSchema.extend({ orgId: idSchema, requestId: z.uuid() });
export type CrewAttendanceOperation = z.infer<typeof crewAttendanceOperationSchema>;
export type CrewAttendanceWrite = z.infer<typeof crewAttendanceWriteSchema>;
export interface CrewAttendanceResult { requestId: string; outcome: "applied" | "conflict"; changedCount: number }
