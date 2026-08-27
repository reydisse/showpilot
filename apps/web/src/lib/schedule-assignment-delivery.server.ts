import { getRequestHeaders } from "@tanstack/react-start/server";

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
    const headers = getRequestHeaders();
    const host = headers.get("x-forwarded-host") ?? headers.get("host");
    const protocol = headers.get("x-forwarded-proto")
      ?? (host?.includes("localhost") || host?.startsWith("127.0.0.1") ? "http" : "https");
    const origin = headers.get("origin") ?? (host ? `${protocol}://${host}` : "https://showpilot.tech");
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
