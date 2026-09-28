import { env } from "cloudflare:workers";
import { abortAllDurableObjects } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { editServiceTimeToIso, formatTimeInput } from "../utils";
import {
  RundownMetadataConflictError,
  updateRundownMetadataThroughRelay,
} from "../rundown-meta-update.server";

afterEach(async () => {
  await abortAllDurableObjects();
});

describe("schedule metadata live authority", () => {
  it("updates D1 and the live rundown together and rejects an older form", async () => {
    const orgId = `meta-${crypto.randomUUID()}`;
    const showId = `show-${crypto.randomUUID()}`;
    const serviceDate = "2026-09-27";
    const originalVersion = "2026-01-01T00:00:00.000Z";
    await env.DB.batch([
      env.DB.prepare("INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)")
        .bind(orgId, "Metadata", orgId, originalVersion),
      env.DB.prepare(
        `INSERT INTO rundown (id, orgId, serviceDate, name, location, status, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, '', 'stopped', ?, ?)`,
      ).bind(showId, orgId, serviceDate, "Old title", originalVersion, originalVersion),
    ]);

    const result = await updateRundownMetadataThroughRelay({
      env,
      orgId,
      showId,
      serviceDate,
      expectedUpdatedAt: originalVersion,
      payload: {
        serviceName: "New title",
        scheduledStartTime: "2026-09-27T13:30:00.000Z",
        scheduledCallTime: "2026-09-27T12:30:00.000Z",
        location: "Main room",
      },
    });
    expect(result.revision).toBeGreaterThan(0);

    const row = await env.DB.prepare(
      "SELECT name, scheduledStartTime, scheduledCallTime, location FROM rundown WHERE id = ?",
    ).bind(showId).first<Record<string, string>>();
    expect(row).toMatchObject({
      name: "New title",
      scheduledStartTime: "2026-09-27T13:30:00.000Z",
      scheduledCallTime: "2026-09-27T12:30:00.000Z",
      location: "Main room",
    });

    const relay = env.RUNDOWN_RELAY.getByName(`${orgId}:show:${showId}`);
    const state = await (await relay.fetch(new Request(
      `https://rundown.test/state?orgId=${orgId}&serviceDate=${serviceDate}&showId=${showId}&access=edit`,
    ))).json<Record<string, unknown>>();
    expect(state).toMatchObject({
      serviceName: "New title",
      scheduledStartTime: "2026-09-27T13:30:00.000Z",
      scheduledCallTime: "2026-09-27T12:30:00.000Z",
      location: "Main room",
    });

    // Edit the same saved call from Rundown on a Toronto device.
    const nextCall = editServiceTimeToIso({
      serviceDate,
      time: "09:15",
      timeZone: "America/Toronto",
      referenceTime: String(state.scheduledCallTime),
    });
    const commandUrl = `https://rundown.test/command?orgId=${orgId}&serviceDate=${serviceDate}&showId=${showId}&access=edit`;
    const response = await relay.fetch(new Request(commandUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: crypto.randomUUID(), expectedRevision: state.revision, action: "update-meta", payload: { scheduledCallTime: nextCall } }),
    }));
    expect(response.ok).toBe(true);
    const updated = await env.DB.prepare("SELECT scheduledCallTime FROM rundown WHERE id = ?")
      .bind(showId).first<{ scheduledCallTime: string }>();
    expect(updated?.scheduledCallTime).toBe(nextCall);
    expect(formatTimeInput(updated?.scheduledCallTime, "America/Toronto")).toBe("09:15");
    expect(formatTimeInput(updated?.scheduledCallTime, "Africa/Accra")).toBe("13:15");

    // Clearing the override from Schedule must clear the live state too.
    const version = await env.DB.prepare("SELECT updatedAt FROM rundown WHERE id = ?")
      .bind(showId).first<{ updatedAt: string }>();
    expect(version).not.toBeNull();
    await updateRundownMetadataThroughRelay({
      env, orgId, showId, serviceDate, expectedUpdatedAt: version?.updatedAt ?? "",
      payload: { serviceName: "New title", scheduledStartTime: "2026-09-27T13:30:00.000Z", scheduledCallTime: null, location: "Main room" },
    });
    const cleared = await (await relay.fetch(new Request(
      `https://rundown.test/state?orgId=${orgId}&serviceDate=${serviceDate}&showId=${showId}&access=edit`,
    ))).json<{ scheduledCallTime: string | null }>();
    expect(cleared.scheduledCallTime).toBeNull();

    await expect(updateRundownMetadataThroughRelay({
      env,
      orgId,
      showId,
      serviceDate,
      expectedUpdatedAt: originalVersion,
      payload: {
        serviceName: "Stale overwrite",
        scheduledStartTime: null,
        scheduledCallTime: null,
        location: "Wrong room",
      },
    })).rejects.toBeInstanceOf(RundownMetadataConflictError);
  });
});
