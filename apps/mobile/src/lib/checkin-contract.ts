import { z } from "zod";

export const checkInMemberSchema = z.object({
  id: z.string(),
  memberId: z.string(),
  name: z.string(),
  role: z.string(),
  photoUrl: z.string(),
  isOnline: z.boolean(),
  lastCheckIn: z.string().nullable(),
  lastCheckOut: z.string().nullable(),
});

export const checkInSchema = z.object({ members: z.array(checkInMemberSchema) });
export const showBoardSchema = checkInSchema.extend({
  clockFormat: z.enum(["12hr", "24hr"]),
  timeZone: z.string().min(1),
});
export const checkInStatusSchema = z.object({ member: checkInMemberSchema });
