import { env } from "cloudflare:workers";
import { abortAllDurableObjects } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
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
