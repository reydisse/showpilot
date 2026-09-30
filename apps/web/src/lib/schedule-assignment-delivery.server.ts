import { env } from "cloudflare:workers";
import { requireShowPilotBaseUrl } from "@/lib/auth-origins";

export async function deliverScheduleAssignmentInvitation(
  orgId: string,
  assignmentId: string,
  serviceDate: string,
  role: string,
  crewMemberId: string,
  reminder = false,
) {
  try {
    const { sendCrewScheduleInvite } = await import("@/lib/crew-schedule");
    const origin = requireShowPilotBaseUrl(env.BETTER_AUTH_URL);
    return await sendCrewScheduleInvite({
      orgId,
      assignmentId,
      serviceDate,
      role,
      crewMemberId,
      reminder,
      origin,
    });
  } catch (error) {
    console.error("[Schedule] Crew invitation delivery failed", error);
    return { delivered: false, reason: "delivery-failed" as const };
  }
}
