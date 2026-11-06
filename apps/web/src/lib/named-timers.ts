import { z } from "zod";

export const MAX_NAMED_TIMER_DURATION_MS = 24 * 60 * 60 * 1000;
export const MAX_VISIBLE_NAMED_TIMERS = 16;
const nameSchema = z.string().trim().min(1, "Enter a timer name.").max(80, "Timer names must be 80 characters or fewer.")
  .refine(value => !/[\u0000-\u001f\u007f]/u.test(value), "Timer names cannot contain control characters.")
  .transform(value => value.normalize("NFC"));
export const namedTimerStartSchema = z.object({
  name: nameSchema,
  durationMs: z.number().int().min(1000).max(MAX_NAMED_TIMER_DURATION_MS),
}).strict();
export const namedTimerStopSchema = z.object({ name: nameSchema }).strict();
export type NamedTimerCommand =
  | { action: "timer-start"; payload: z.infer<typeof namedTimerStartSchema> }
  | { action: "timer-stop"; payload: z.infer<typeof namedTimerStopSchema> };
export interface NamedTimerOutput { name: string; durationMs: number; endsAt: number }
export interface NamedTimerSample { serverTime: number; timers: NamedTimerOutput[] }

/** Names are show-scoped identities; capitalization cannot create a second timer. */
export function namedTimerKey(name: string): string { return name.trim().normalize("NFC").toLowerCase(); }

/** The editor accepts minutes or m:ss. Never silently substitute a duration. */
export function parseNamedTimerDuration(text: string): number | null {
  const match = /^(\d{1,4})(?::([0-5]\d))?$/.exec(text.trim());
  if (!match) return null;
  const duration = (Number(match[1]) * 60 + Number(match[2] ?? 0)) * 1000;
  return duration >= 1000 && duration <= MAX_NAMED_TIMER_DURATION_MS ? duration : null;
}
export function formatNamedTimerRemaining(ms: number): string {
  const seconds = Math.ceil(Math.max(0, ms) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Uses the relay clock only at receipt, then monotonic local elapsed time. */
export class NamedTimerClock {
  private sample: NamedTimerSample | null = null;
  private receivedAt = 0;
  private serverTime = 0;
  private connected = false;
  private frozenElapsed = 0;
  observe(sample: NamedTimerSample | null, connected: boolean, now: number): void {
    if (sample !== this.sample) {
      const elapsed = this.connected ? Math.max(0, now - this.receivedAt) : this.frozenElapsed;
      // A delayed snapshot must not make an existing countdown run backward.
      this.serverTime = sample ? Math.max(sample.serverTime, this.sample ? this.serverTime + elapsed : 0) : 0;
      this.sample = sample;
      this.receivedAt = now;
      this.frozenElapsed = 0;
    } else if (this.connected && !connected) {
      this.frozenElapsed = Math.max(0, now - this.receivedAt);
    }
    this.connected = connected;
  }
  values(now: number): Array<NamedTimerOutput & { remainingMs: number }> {
    const sample = this.sample;
    if (!sample) return [];
    const elapsed = this.connected ? Math.max(0, now - this.receivedAt) : this.frozenElapsed;
    return sample.timers.map(timer => ({ ...timer, remainingMs: Math.max(0, timer.endsAt - this.serverTime - elapsed) }));
  }
}
