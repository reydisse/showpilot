import { z } from "zod";

export const rundownSchema = z.object({
  id: z.string(),
  serviceDate: z.string(),
  name: z.string(),
  scheduledStartTime: z.string().nullable(),
  scheduledCallTime: z.string().nullable().default(null),
  location: z.string(),
  status: z.string(),
  itemCount: z.number(),
});

export const rundownItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  type: z.string(),
  duration: z.number(),
  notes: z.string(),
  assignee: z.string(),
  cue: z.string(),
  status: z.string(),
  sortOrder: z.number(),
  revision: z.number().int().min(0),
  hardStop: z.boolean(),
  lowerThirdId: z.string().optional(),
  scheduledStart: z.string().nullable().optional(),
  expectedEnd: z.string().nullable().optional(),
  actualStart: z.string().nullable().optional(),
  actualEnd: z.string().nullable().optional(),
});

export const timerSchema = z.object({
  playback: z.enum(["stop", "play", "pause"]).default("stop"),
  currentItemId: z.string().nullable().default(null),
  elapsed: z.number().default(0),
  startedAt: z.number().nullable().default(null),
  pausedAt: z.number().nullable().default(null),
  mode: z.enum(["count-down", "count-up", "clock"]).default("count-down"),
  serverTime: z.number().optional(),
});

export const mobileRundownSchema = z.object({
  show: rundownSchema
    .omit({ itemCount: true })
    .extend({ updatedAt: z.string() }),
  timeZone: z.string().min(1),
  canCreateShows: z.boolean(),
  canEdit: z.boolean(),
  canControl: z.boolean(),
  proPresenter: z.object({
    configured: z.boolean(),
    cuesEnabled: z.boolean(),
    stageDisplayEnabled: z.boolean().default(false),
    bridgeOnline: z.boolean(),
    connected: z.boolean(),
  }),
  items: z.array(rundownItemSchema),
  timer: timerSchema,
});

