import { rundownInternalRequest } from "@/lib/rundown-internal-request.server";
import { rundownRelayKey } from "@/lib/rundown-relay-key";

import { RundownMetadataConflictError } from "./rundown-metadata-conflict";
export { RundownMetadataConflictError } from "./rundown-metadata-conflict";

function sameInstant(left: string, right: string): boolean {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  return Number.isFinite(leftMs) && Number.isFinite(rightMs)
    ? leftMs === rightMs
    : left === right;
}

export async function updateRundownMetadataThroughRelay(input: {
  env: {
    DB: D1Database;
    BETTER_AUTH_SECRET?: string;
    RUNDOWN_RELAY?: DurableObjectNamespace<
      import("@/durable-objects/RundownRelay").RundownRelay
    >;
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
  const readExpectedVersion = async () => {
    const row = await input.env.DB.prepare(
      "SELECT updatedAt FROM rundown WHERE id = ? AND orgId = ? AND serviceDate = ? LIMIT 1",
    )
      .bind(input.showId, input.orgId, input.serviceDate)
      .first<{ updatedAt: string }>();
    if (!row) throw new Error("Show not found");
    if (!sameInstant(row.updatedAt, input.expectedUpdatedAt))
      throw new RundownMetadataConflictError();
    return row;
  };

  if (!input.env.RUNDOWN_RELAY) {
    const row = await readExpectedVersion();
    const result = await input.env.DB.prepare(
      `UPDATE rundown
       SET name = ?, scheduledStartTime = ?, scheduledCallTime = ?, location = ?,
           updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', MAX(julianday('now'), julianday(updatedAt) + 1.0 / 86400000))
       WHERE id = ? AND orgId = ? AND serviceDate = ? AND updatedAt = ?
         AND NOT EXISTS (SELECT 1 FROM app_setting WHERE orgId = rundown.orgId AND key = 'show-deleting:' || rundown.id)`,
    )
      .bind(
        input.payload.serviceName,
        input.payload.scheduledStartTime,
        input.payload.scheduledCallTime,
        input.payload.location,
        input.showId,
        input.orgId,
        input.serviceDate,
        row.updatedAt,
      )
      .run();
    if ((result.meta.changes ?? 0) !== 1)
      throw new RundownMetadataConflictError();
    return {};
  }

  const key = rundownRelayKey(
    input.orgId,
    input.serviceDate,
    input.serviceDate,
    input.showId,
  );
  const relay = input.env.RUNDOWN_RELAY.get(
    input.env.RUNDOWN_RELAY.idFromName(key),
  );
  const query = `orgId=${encodeURIComponent(input.orgId)}&serviceDate=${encodeURIComponent(input.serviceDate)}&showId=${encodeURIComponent(input.showId)}&access=edit`;
  const stateResponse = await relay.fetch(
    rundownInternalRequest(
      `https://rundown.local/state?${query}`,
      input.env.BETTER_AUTH_SECRET,
    ),
  );
  if (!stateResponse.ok) {
    await stateResponse.body?.cancel();
    throw new Error("Live rundown editing is temporarily unavailable.");
  }
  const state = await stateResponse.json<{ revision?: number }>();
  if (!Number.isSafeInteger(state.revision) || (state.revision ?? -1) < 0) {
    throw new Error("Live rundown returned an invalid revision.");
  }

  // Retain the exact stored timestamp, including legacy SQLite formatting.
  // The relay checks it again in the same statement that commits the edit.
  const row = await readExpectedVersion();

  const response = await relay.fetch(
    rundownInternalRequest(
      `https://rundown.local/command?${query}`,
      input.env.BETTER_AUTH_SECRET,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: crypto.randomUUID(),
          expectedRevision: state.revision,
          action: "update-meta",
          payload: { ...input.payload, expectedUpdatedAt: row.updatedAt },
        }),
      },
    ),
  );
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 409) throw new RundownMetadataConflictError();
    throw new Error("The show details were not accepted by live sync.");
  }
  return response.json<{ revision?: number }>();
}
