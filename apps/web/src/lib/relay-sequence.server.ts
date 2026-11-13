import type { RelaySequence } from "@showpilot/shared";

/** SQLite-backed room counter. Synchronous writes participate in the DO output
 * gate, so messages cannot escape before their revision has been committed.
 */
export class RelaySequenceStore {
  private value: number;
  constructor(private readonly sql: SqlStorage) {
    sql.exec("CREATE TABLE IF NOT EXISTS relay_sequence (id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL)");
    this.value = sql.exec<{ value: number }>("SELECT value FROM relay_sequence WHERE id = 1").toArray()[0]?.value ?? 0;
  }

  current(): number { return this.value; }

  next(): number {
    this.value += 1;
    this.sql.exec("INSERT INTO relay_sequence (id,value) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value", this.value);
    return this.value;
  }

  envelope(socket: WebSocket, sequence = this.value): RelaySequence {
    const attachment: unknown = socket.deserializeAttachment();
    if (!attachment || typeof attachment !== "object") throw new Error("Relay socket has no attachment");
    const previousSequence = "lastSentSequence" in attachment && typeof attachment.lastSentSequence === "number"
      ? attachment.lastSentSequence : null;
    socket.serializeAttachment({ ...attachment, lastSentSequence: sequence });
    return { sequence, previousSequence };
  }
}
