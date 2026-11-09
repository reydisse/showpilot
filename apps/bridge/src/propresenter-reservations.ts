/** A reservation starts on this machine's monotonic clock. No clock agreement
 * with the cloud is required. It is consumed before touching ProPresenter. */
export class ProPresenterReservations {
  private readonly entries = new Map<
    string,
    { target: string; command: string; expires: number; consumed: boolean }
  >();
  constructor(private readonly now: () => number = () => performance.now()) {}
  clear() {
    this.entries.clear();
  }
  reserve(id: string, target: string, command: string) {
    const now = this.now();
    // Keep consumed IDs until the original reservation has expired. Replays
    // cannot renew it during the only interval in which execution is allowed.
    for (const [key, entry] of this.entries)
      if (entry.expires <= now) this.entries.delete(key);
    const existing = this.entries.get(id);
    if (existing) {
      if (
        existing.target !== target ||
        existing.command !== command ||
        existing.consumed
      )
        throw new Error(
          "Slide command reservation was already used or changed.",
        );
      return;
    }
    if (this.entries.size >= 256)
      throw new Error(
        "Too many slide commands are waiting. Check the output and try again.",
      );
    this.entries.set(id, {
      target,
      command,
      expires: now + 5000,
      consumed: false,
    });
  }
  take(id: string, target: string, command: string) {
    const entry = this.entries.get(id);
    if (
      !entry ||
      entry.consumed ||
      entry.expires <= this.now() ||
      entry.target !== target ||
      entry.command !== command
    )
      throw new Error(
        "Slide command expired or was already used. Check the output before sending another command.",
      );
    entry.consumed = true;
    return () => {
      if (this.entries.get(id) !== entry || entry.expires <= this.now())
        throw new Error("Slide command expired before reaching ProPresenter.");
    };
  }
}
