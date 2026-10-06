import { z } from "zod";
export { orgTerms } from "@showpilot/shared";
export const orgTerminologyProfileSchema = z.enum(["general", "church"]);
export type OrgTerminologyProfile = z.infer<typeof orgTerminologyProfileSchema>;
