import { z } from "zod";
import { WORKSPACE_TYPES, resolveModules } from "@showpilot/shared";

export const workspaceSchema = z.object({
  type: z.enum(WORKSPACE_TYPES).catch("church"),
  label: z.string().nullable(),
  modules: z.array(z.string()).transform(resolveModules),
  terms: z.object({
    event: z.string(),
    eventTitle: z.string(),
    eventPlural: z.string(),
    eventName: z.string(),
    participate: z.string(),
    scheduled: z.string(),
    checkinCta: z.string(),
    section: z.string(),
    item: z.string(),
    itemPlural: z.string(),
    presenter: z.string(),
    presenterExample: z.string(),
    sectionExample: z.string(),
    eventNameExample: z.string(),
  }),
  isExplicit: z.boolean(),
});
export type MobileWorkspace = z.infer<typeof workspaceSchema>;
