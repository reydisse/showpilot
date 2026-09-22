import { rundownRelayKey } from "@/lib/rundown-relay-key";

export class RundownMetadataConflictError extends Error {
  constructor(message = "This show changed on another device. Refresh and try again.") {
    super(message);
    this.name = "RundownMetadataConflictError";
  }
}

function sameInstant(left: string, right: string): boolean {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  return Number.isFinite(leftMs) && Number.isFinite(rightMs) ? leftMs === rightMs : left === right;
}

export async function updateRundownMetadataThroughRelay(input: {
  env: {
    DB: D1Database;
    RUNDOWN_RELAY?: DurableObjectNamespace<import("@/durable-objects/RundownRelay").RundownRelay>;
  };
  orgId: string;
  showId: string;
  serviceDate: string;
  expectedUpdatedAt: string;
  payload: {
    serviceName: string;
    scheduledStartTime: string | null;
    scheduledCallTime: string | null;
    location: string;
  };
}): Promise<{ revision?: number }> {
  const row = await input.env.DB.prepare(
    "SELECT updatedAt FROM rundown WHERE id = ? AND orgId = ? AND serviceDate = ? LIMIT 1",
  ).bind(input.showId, input.orgId, input.serviceDate).first<{ updatedAt: string }>();
  if (!row) throw new Error("Show not found");
  if (!sameInstant(row.updatedAt, input.expectedUpdatedAt)) throw new RundownMetadataConflictError();

  if (!input.env.RUNDOWN_RELAY) {
    const result = await input.env.DB.prepare(
      `UPDATE rundown
       SET name = ?, scheduledStartTime = ?, scheduledCallTime = ?, location = ?, updatedAt = CURRENT_TIMESTAMP
       WHERE id = ? AND orgId = ? AND serviceDate = ? AND updatedAt = ?`,
    ).bind(
      input.payload.serviceName,
      input.payload.scheduledStartTime,
      input.payload.scheduledCallTime,
      input.payload.location,
      input.showId,
      input.orgId,
      input.serviceDate,
      row.updatedAt,
    ).run();
    if ((result.meta.changes ?? 0) !== 1) throw new RundownMetadataConflictError();
    return {};
  }

  const key = rundownRelayKey(input.orgId, input.serviceDate, input.serviceDate, input.showId);
  const relay = input.env.RUNDOWN_RELAY.get(input.env.RUNDOWN_RELAY.idFromName(key));
  const query = `orgId=${encodeURIComponent(input.orgId)}&serviceDate=${encodeURIComponent(input.serviceDate)}&showId=${encodeURIComponent(input.showId)}&access=edit`;
  const stateResponse = await relay.fetch(new Request(`https://rundown.local/state?${query}`));
  if (!stateResponse.ok) throw new Error("Live rundown editing is temporarily unavailable.");
  const state = await stateResponse.json<{ revision?: number }>();
  if (!Number.isSafeInteger(state.revision) || (state.revision ?? -1) < 0) {
    throw new Error("Live rundown returned an invalid revision.");
  }

  const response = await relay.fetch(new Request(`https://rundown.local/command?${query}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: crypto.randomUUID(),
      expectedRevision: state.revision,
      action: "update-meta",
      payload: input.payload,
    }),
  }));
  if (response.status === 409) throw new RundownMetadataConflictError("Another operator changed the show details first.");
  if (!response.ok) throw new Error("The show details were not accepted by live sync.");
  return response.json<{ revision?: number }>();
}
