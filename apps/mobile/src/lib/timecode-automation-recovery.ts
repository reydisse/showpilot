import { z } from "zod";
import { isTimecodeGateCommand, type TimecodeGateCommand, type TimecodeGateReview } from "@showpilot/shared";
import type { MobileTimecodeState } from "./timecode-contract";
export type MobileGateCommand = TimecodeGateCommand & { orgId: string; userId: string };
export const mobileGateCommandSchema = z.object({ orgId: z.string().min(1), userId: z.string().min(1) }).and(z.custom<TimecodeGateCommand>(isTimecodeGateCommand));
export const mobileGateReplySchema = z.object({ orgId: z.string().min(1), userId: z.string().min(1), requestId: z.uuid(),
  showId: z.string().min(1), serviceDate: z.string().min(1), outcome: z.enum(["applied", "conflict", "rejected"]), message: z.string().optional() });
export type MobileGateReply = z.infer<typeof mobileGateReplySchema>;
export type MobileGateReview = { command: Extract<MobileGateCommand, { expected: TimecodeGateReview }>; reason: string };
export function reviewAutomationGate(state: MobileTimecodeState): TimecodeGateReview | null {
  return state.automationRevision ? { revision: state.automationRevision, holdId: state.automationHold?.id ?? null } : null;
}
