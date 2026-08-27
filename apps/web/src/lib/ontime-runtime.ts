import { z } from "zod";
import type { OntimeEvent, OntimeRuntimeState, OntimeTimer } from "@/types/ontime";

const playbackSchema = z.enum(["play", "pause", "armed", "stop", "roll"]);
const nullableNumber = z.number().finite().nullable().optional();

const timerSchema = z.object({
  addedTime: z.number().finite().optional(),
  current: nullableNumber,
  duration: nullableNumber,
  elapsed: nullableNumber,
  playback: playbackSchema.optional(),
  startedAt: nullableNumber,
  expectedFinish: nullableNumber,
  finishedAt: nullableNumber,
});

const eventSchema = z.object({
  id: z.string(),
  type: z.literal("event"),
  title: z.string().optional(),
  cue: z.string().optional(),
  timeStart: z.number().finite().optional(),
  timeEnd: z.number().finite().optional(),
  duration: z.number().finite().optional(),
  colour: z.string().optional(),
  note: z.string().optional(),
  skip: z.boolean().optional(),
});

const pollSchema = z.object({
  payload: z.object({
    timer: timerSchema.optional(),
    eventNow: eventSchema.nullable().optional(),
    eventNext: eventSchema.nullable().optional(),
    clock: z.number().finite().optional(),
  }).optional(),
});

const orderedRundownSchema = z.object({
  order: z.array(z.string()).optional(),
  entries: z.record(z.string(), z.unknown()).optional(),
});

export const defaultOntimeTimer: OntimeTimer = {
  addedTime: 0,
  current: null,
  duration: null,
  elapsed: null,
  playback: "stop",
  startedAt: null,
  expectedFinish: null,
  finishedAt: null,
};

export function disconnectedOntimeState(): OntimeRuntimeState {
  return {
    timer: { ...defaultOntimeTimer },
    eventNow: null,
    eventNext: null,
    clock: 0,
    events: [],
    connected: false,
  };
}

function normalizeEvent(value: z.infer<typeof eventSchema>): OntimeEvent {
  return {
    id: value.id,
    type: "event",
    title: value.title ?? "Untitled",
    cue: value.cue ?? "",
    timeStart: value.timeStart ?? 0,
    timeEnd: value.timeEnd ?? 0,
    duration: value.duration ?? 0,
    colour: value.colour ?? "",
    note: value.note ?? "",
    skip: value.skip ?? false,
  };
}

function normalizeEvents(value: unknown): OntimeEvent[] {
  if (Array.isArray(value)) {
    return value.flatMap((candidate) => {
      const parsed = eventSchema.safeParse(candidate);
      return parsed.success && parsed.data.skip !== true ? [normalizeEvent(parsed.data)] : [];
    });
  }

  const parsed = orderedRundownSchema.safeParse(value);
  if (!parsed.success || !parsed.data.order || !parsed.data.entries) return [];
  return parsed.data.order.flatMap((id) => {
    const event = eventSchema.safeParse(parsed.data.entries?.[id]);
    return event.success && event.data.skip !== true ? [normalizeEvent(event.data)] : [];
  });
}

async function readJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  return response.ok ? response.json() : null;
}

export async function fetchOntimeRuntimeState(configuredUrl: string): Promise<OntimeRuntimeState> {
  const baseUrl = configuredUrl.replace(/\/+$/, "");
  try {
    const [rawPoll, rawRundown] = await Promise.all([
      readJson(`${baseUrl}/api/poll`).catch(() => null),
      readJson(`${baseUrl}/data/rundown`).catch(() => null),
    ]);
    const parsedPoll = pollSchema.safeParse(rawPoll);
    const poll = parsedPoll.success ? parsedPoll.data.payload : undefined;
    if (!poll) return disconnectedOntimeState();

    const timer: OntimeTimer = {
      addedTime: poll.timer?.addedTime ?? 0,
      current: poll.timer?.current ?? null,
      duration: poll.timer?.duration ?? null,
      elapsed: poll.timer?.elapsed ?? null,
      playback: poll.timer?.playback ?? "stop",
      startedAt: poll.timer?.startedAt ?? null,
      expectedFinish: poll.timer?.expectedFinish ?? null,
      finishedAt: poll.timer?.finishedAt ?? null,
    };
    return {
      timer,
      eventNow: poll.eventNow ? normalizeEvent(poll.eventNow) : null,
      eventNext: poll.eventNext ? normalizeEvent(poll.eventNext) : null,
      clock: poll.clock ?? Date.now(),
      events: normalizeEvents(rawRundown),
      connected: true,
    };
  } catch {
    return disconnectedOntimeState();
  }
}
