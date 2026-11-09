import { z } from "zod";

const timecodeValueSchema = z.object({
  hours: z.number().int().min(0).max(23),
  minutes: z.number().int().min(0).max(59),
  seconds: z.number().int().min(0).max(59),
  frames: z.number().int().min(0).max(29),
});
export const timecodeStateSchema = z.object({
  showId: z.string().min(1),
  serviceDate: z.string().min(1),
  triggersEnabled: z.boolean(),
  automaticCuesEnabled: z.boolean().default(true),
  automationRevision: z.string().optional(),
  incomingFormat: z.object({ id: z.string(), format: z.object({ frameRate: z.union([z.literal(24), z.literal(25), z.literal(29.97), z.literal(30)]), dropFrame: z.enum(["df", "ndf"]) }) }).nullable().optional(),
  automationHold: z.object({ id: z.string(), reason: z.literal("timecode-jump"), from: z.string(), to: z.string(), detectedAt: z.number() }).nullable().optional(),
  signal: z.object({
    status: z.enum(["idle", "waiting", "live", "timecode-stalled", "timecode-lost", "format-mismatch", "midi-stopped", "midi-waiting", "paused"]),
    lastFeedAt: z.number().nullable(),
  }).optional(),
  timecode: timecodeValueSchema,
  display: z.string(),
  source: z.enum([
    "internal-freerun",
    "internal-rundown",
    "mtc",
    "ltc-bridge",
    "network",
  ]),
  format: z.object({
    frameRate: z.union([
      z.literal(24),
      z.literal(25),
      z.literal(29.97),
      z.literal(30),
    ]),
    dropFrame: z.enum(["df", "ndf"]),
  }),
  running: z.boolean(),
  serverTime: z.number(),
  totalFrames: z.number(),
  lyrics: z
    .object({
      songId: z.string(),
      songTitle: z.string(),
      sectionId: z.string(),
      sectionLabel: z.string(),
      lyrics: z.string(),
      nextLabel: z.string(),
      updatedAt: z.number(),
    })
    .nullable()
    .default(null),
});
export const timecodeEventSchema = z.object({
  id: z.string(),
  label: z.string(),
  triggerTimecode: timecodeValueSchema,
  triggerFrame: z.number(),
  // Read future actions as data; only the server executes/validates their payload.
  action: z.string().min(1),
  enabled: z.boolean().default(true),
  skipped: z.boolean().default(false),
  executionStatus: z.enum(["scheduled", "dispatching", "acknowledged", "failed"]).optional(),
  executionError: z.string().optional(),
  executionId: z.string().optional(),
  executionAttempts: z.number().int().min(0).optional(),
  editRevision: z.string().optional(),
  payload: z.record(z.string(), z.unknown()),
  fired: z.boolean(),
  toleranceFrames: z.number().optional(),
  leadMs: z.number().optional(),
  targetDeviceId: z.string().optional(),
  targetActionId: z.string().optional(),
});

export type MobileTimecodeState = z.infer<typeof timecodeStateSchema>;
export type MobileTimecodeEvent = z.infer<typeof timecodeEventSchema>;

export function parseMobileTimecodeState(
  value: unknown,
): MobileTimecodeState | null {
  const result = timecodeStateSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function parseMobileTimecodeEvents(
  value: unknown,
): MobileTimecodeEvent[] | null {
  const result = z.array(timecodeEventSchema).safeParse(value);
  return result.success ? result.data : null;
}

export function parseMobileTimecodeEvent(
  value: unknown,
): MobileTimecodeEvent | null {
  const result = timecodeEventSchema.safeParse(value);
  return result.success ? result.data : null;
}


export type MobileTimecodeTarget = Pick<MobileTimecodeState, "showId" | "serviceDate">;

export function timecodeEventStatus(event: MobileTimecodeEvent): string {
  if (event.executionStatus === "failed") return "Failed";
  if (event.executionStatus === "dispatching") return "Sending";
  if (!event.enabled) return "Disabled";
  if (event.skipped) return "Skipped";
  return event.executionStatus === "acknowledged" || event.fired ? "Fired" : "Armed";
}

export const timecodeShowsSchema = z.object({
  shows: z.array(z.object({
    id: z.string().min(1), serviceDate: z.string().min(1), name: z.string(),
    scheduledStartTime: z.string().nullable(),
  })),
});
export type MobileTimecodeShow = z.infer<typeof timecodeShowsSchema>["shows"][number];
