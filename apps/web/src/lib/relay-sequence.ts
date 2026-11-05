/** A room revision plus the last revision delivered to this particular reader.
 * Readers intentionally receive different projections, so numeric gaps alone
 * do not mean a packet was lost. The predecessor must match what they saw.
 */
export interface RelaySequence {
  sequence: number;
  previousSequence: number | null;
}

export function readRelaySequence(value: unknown): RelaySequence | null {
  if (!value || typeof value !== "object" || !("sequence" in value) || !("previousSequence" in value)) return null;
  const { sequence, previousSequence } = value;
  if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 0) return null;
  if (previousSequence !== null && (typeof previousSequence !== "number" || !Number.isSafeInteger(previousSequence) || previousSequence < 0)) return null;
  return { sequence, previousSequence };
}

export class RelaySequenceTracker {
  lastSeenSequence: number | null = null;
  private hydrated = false;

  disconnect(): void { this.hydrated = false; }

  /** A hydrate is a full refresh, including changes missed while disconnected. */
  snapshot(value: unknown): { changed: boolean } {
    const next = readRelaySequence(value)?.sequence ?? null;
    const changed = this.lastSeenSequence === null || next !== this.lastSeenSequence;
    this.lastSeenSequence = next;
    this.hydrated = true;
    return { changed };
  }

  delta(value: unknown): "apply" | "ignore" | "refresh" {
    if (!this.hydrated) return "ignore";
    const next = readRelaySequence(value);
    // Older deployed relays remain readable during a staged rollout. Once a
    // connection uses revisions, missing/invalid envelopes cannot bypass them.
    if (!next && this.lastSeenSequence === null) return "apply";
    if (next && this.lastSeenSequence !== null && next.sequence <= this.lastSeenSequence) return "ignore";
    if (!next || next.previousSequence !== this.lastSeenSequence) {
      this.hydrated = false;
      return "refresh";
    }
    this.lastSeenSequence = next.sequence;
    return "apply";
  }
}
