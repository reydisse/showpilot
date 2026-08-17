import { z } from "zod";

export const orgTerminologyProfileSchema = z.enum(["general", "church"]);
export type OrgTerminologyProfile = z.infer<typeof orgTerminologyProfileSchema>;

export function orgTerms(profile: OrgTerminologyProfile) {
  return profile === "church"
    ? {
        event: "service",
        eventTitle: "Service",
        eventName: "Service name",
        participate: "serve",
        scheduled: "You've been scheduled to serve",
      }
    : {
        event: "show",
        eventTitle: "Show",
        eventName: "Show name",
        participate: "work this show",
        scheduled: "You've been assigned",
      };
}
