import { namedTimerKey, MAX_VISIBLE_NAMED_TIMERS, type NamedTimerCommand, type NamedTimerSample, type NamedTimerOutput } from "./named-timers";

interface TimerRow extends Record<string, SqlStorageValue> {
  name: string; duration_ms: number; ends_at: number;
}

/** Show-local output and execution receipt commit in the same SQLite transaction. */
export class NamedTimerStore {
  private outputs: NamedTimerOutput[];
  constructor(private readonly storage: DurableObjectStorage) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS named_timers (
      timer_key TEXT PRIMARY KEY, name TEXT NOT NULL, duration_ms INTEGER NOT NULL,
      ends_at INTEGER NOT NULL, visible INTEGER NOT NULL
    )`);
    storage.sql.exec("CREATE TABLE IF NOT EXISTS named_timer_receipts (execution_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL)");
    this.outputs = this.readOutputs();
  }
  private readOutputs(): NamedTimerOutput[] {
    return [...this.storage.sql.exec<TimerRow>("SELECT name,duration_ms,ends_at FROM named_timers WHERE visible=1 ORDER BY timer_key")]
      .map(row => ({ name: row.name, durationMs: row.duration_ms, endsAt: row.ends_at }));
  }
  sample(now = Date.now()): NamedTimerSample | undefined {
    // An empty output has no clock to sample. Keep no-output reads stable.
    return this.outputs.length ? { serverTime: now, timers: this.outputs } : undefined;
  }
  apply(command: NamedTimerCommand, eventId: string, executionId: string, now = Date.now()): void {
    const key = namedTimerKey(command.payload.name);
    const fingerprint = JSON.stringify([eventId, command.action, key, command.action === "timer-start" ? command.payload.durationMs : null]);
    this.storage.transactionSync(() => {
      const previous = this.storage.sql.exec<{ fingerprint: string }>("SELECT fingerprint FROM named_timer_receipts WHERE execution_id=?", executionId).toArray()[0];
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new Error("This timer attempt already ran with different details. Re-arm the cue before firing the edited timer.");
        return;
      }
      const timer = this.storage.sql.exec<{ visible: number }>("SELECT visible FROM named_timers WHERE timer_key=?", key).toArray()[0];
      if (command.action === "timer-start") {
        if (!timer?.visible && this.outputs.length >= MAX_VISIBLE_NAMED_TIMERS) throw new Error(`Stop a named timer before showing more than ${MAX_VISIBLE_NAMED_TIMERS} timers.`);
        this.storage.sql.exec(`INSERT INTO named_timers (timer_key,name,duration_ms,ends_at,visible) VALUES (?,?,?,?,1)
          ON CONFLICT(timer_key) DO UPDATE SET name=excluded.name,duration_ms=excluded.duration_ms,ends_at=excluded.ends_at,visible=1`,
        key, command.payload.name, command.payload.durationMs, now + command.payload.durationMs);
      } else {
        if (!timer) throw new Error("This named timer has not started in this show. Check its name and cue order.");
        this.storage.sql.exec("UPDATE named_timers SET visible=0 WHERE timer_key=?", key);
      }
      this.storage.sql.exec("INSERT INTO named_timer_receipts (execution_id,fingerprint) VALUES (?,?)", executionId, fingerprint);
    });
    this.outputs = this.readOutputs();
  }
  clear(): void {
    this.storage.transactionSync(() => {
      this.storage.sql.exec("DELETE FROM named_timers");
      this.storage.sql.exec("DELETE FROM named_timer_receipts");
    });
    this.outputs = [];
  }
}
