import { TestRundownRelay } from "@/test/worker-entry";
import { rundownInternalRequest } from "../rundown-internal-request.server";
import { withRelayMember } from "@/test/relay-fixtures";
import { env } from "cloudflare:workers";
import {
  abortAllDurableObjects,
  evictDurableObject,
  runInDurableObject,
} from "cloudflare:test";
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
      env.DB.prepare(
        "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)",
      ).bind(orgId, "Metadata", orgId, originalVersion),
      env.DB.prepare(
        `INSERT INTO rundown (id, orgId, serviceDate, name, location, status, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, '', 'stopped', ?, ?)`,
      ).bind(
        showId,
        orgId,
        serviceDate,
        "Old title",
        originalVersion,
        originalVersion,
      ),
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
      "SELECT name, scheduledStartTime, scheduledCallTime, location, updatedAt FROM rundown WHERE id = ?",
    )
      .bind(showId)
      .first<Record<string, string>>();
    expect(row).toMatchObject({
      name: "New title",
      scheduledStartTime: "2026-09-27T13:30:00.000Z",
      scheduledCallTime: "2026-09-27T12:30:00.000Z",
      location: "Main room",
    });

    const relay = env.RUNDOWN_RELAY.getByName(`${orgId}:show:${showId}`);
    const state = await (
      await relay.fetch(
        new Request(
          await withRelayMember(
            `https://rundown.test/state?orgId=${orgId}&serviceDate=${serviceDate}&showId=${showId}&access=edit`,
          ),
        ),
      )
    ).json<Record<string, unknown>>();
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
    const commandUrl = await withRelayMember(
      `https://rundown.test/command?orgId=${orgId}&serviceDate=${serviceDate}&showId=${showId}&access=edit`,
    );
    const response = await relay.fetch(
      new Request(commandUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: crypto.randomUUID(),
          expectedRevision: state.revision,
          action: "update-meta",
          payload: { scheduledCallTime: nextCall },
        }),
      }),
    );
    expect(response.ok).toBe(true);
    const updated = await env.DB.prepare(
      "SELECT scheduledCallTime, updatedAt FROM rundown WHERE id = ?",
    )
      .bind(showId)
      .first<{ scheduledCallTime: string; updatedAt: string }>();
    expect(updated?.scheduledCallTime).toBe(nextCall);
    expect(Date.parse(updated?.updatedAt ?? "")).toBeGreaterThan(
      Date.parse(row?.updatedAt ?? ""),
    );
    await expect(
      updateRundownMetadataThroughRelay({
        env,
        orgId,
        showId,
        serviceDate,
        expectedUpdatedAt: row?.updatedAt ?? "",
        payload: {
          serviceName: "Old form",
          scheduledStartTime: null,
          scheduledCallTime: null,
          location: "",
        },
      }),
    ).rejects.toBeInstanceOf(RundownMetadataConflictError);
    expect(formatTimeInput(updated?.scheduledCallTime, "America/Toronto")).toBe(
      "09:15",
    );
    expect(formatTimeInput(updated?.scheduledCallTime, "Africa/Accra")).toBe(
      "13:15",
    );

    // Clearing the override from Schedule must clear the live state too.
    const version = await env.DB.prepare(
      "SELECT updatedAt FROM rundown WHERE id = ?",
    )
      .bind(showId)
      .first<{ updatedAt: string }>();
    expect(version).not.toBeNull();
    await updateRundownMetadataThroughRelay({
      env,
      orgId,
      showId,
      serviceDate,
      expectedUpdatedAt: version?.updatedAt ?? "",
      payload: {
        serviceName: "New title",
        scheduledStartTime: "2026-09-27T13:30:00.000Z",
        scheduledCallTime: null,
        location: "Main room",
      },
    });
    const cleared = await (
      await relay.fetch(
        new Request(
          await withRelayMember(
            `https://rundown.test/state?orgId=${orgId}&serviceDate=${serviceDate}&showId=${showId}&access=edit`,
          ),
        ),
      )
    ).json<{ scheduledCallTime: string | null }>();
    expect(cleared.scheduledCallTime).toBeNull();

    await expect(
      updateRundownMetadataThroughRelay({
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
      }),
    ).rejects.toBeInstanceOf(RundownMetadataConflictError);
  });
});

async function metadataFixture() {
  const orgId = crypto.randomUUID();
  const showId = crypto.randomUUID();
  const serviceDate = "2026-11-08";
  const originalVersion = "2026-01-01T00:00:00.000Z";
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO organization (id,name,slug,createdAt) VALUES (?,'Metadata race',?,CURRENT_TIMESTAMP)",
    ).bind(orgId, orgId),
    env.DB.prepare(
      "INSERT INTO rundown (id,orgId,serviceDate,name,updatedAt) VALUES (?,?,?,'Original',?)",
    ).bind(showId, orgId, serviceDate, originalVersion),
  ]);
  const payload = {
    serviceName: "Saved title",
    scheduledStartTime: null,
    scheduledCallTime: null,
    location: "Main room",
  };
  await updateRundownMetadataThroughRelay({
    env,
    orgId,
    showId,
    serviceDate,
    expectedUpdatedAt: originalVersion,
    payload,
  });
  const row = await env.DB.prepare(
    "SELECT updatedAt FROM rundown WHERE orgId=? AND id=?",
  )
    .bind(orgId, showId)
    .first<{ updatedAt: string }>();
  if (!row) throw new Error("Missing fixture");
  const stub = env.RUNDOWN_RELAY.getByName(`${orgId}:show:${showId}`);
  const query = new URLSearchParams({
    orgId,
    showId,
    serviceDate,
    access: "edit",
  });
  const request = (path: string, body?: unknown) =>
    rundownInternalRequest(
      `https://rundown.test/${path}?${query}`,
      env.BETTER_AUTH_SECRET,
      body ? { method: "POST", body: JSON.stringify(body) } : undefined,
    );
  return {
    orgId,
    showId,
    serviceDate,
    payload,
    expectedUpdatedAt: row.updatedAt,
    stub,
    request,
    state: async () => {
      const state = await (
        await stub.fetch(request("state"))
      ).json<{ revision: number; serviceName: string }>();
      return { revision: state.revision, serviceName: state.serviceName };
    },
    control: (action: "hold" | "release" | "waiting") =>
      runInDurableObject(stub, async (instance) => {
        if (!(instance instanceof TestRundownRelay))
          throw new Error("Missing batch control");
        if (action === "hold") instance.holdNextBatch();
        if (action === "release") instance.releaseBatch();
        return instance.isBatchWaiting();
      }),
  };
}

it.each(["edit", "delete", "reschedule", "retire"] as const)(
  "rejects a metadata save when another write can %s the show before its D1 commit",
  async (change) => {
    const f = await metadataFixture();
    const before = await f.state();
    await f.control("hold");
    const saving = updateRundownMetadataThroughRelay({
      env,
      ...f,
      payload: { ...f.payload, serviceName: "Stale overwrite" },
    }).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    try {
      await expect.poll(() => f.control("waiting")).toBe(true);
      if (change === "edit")
        await env.DB.prepare(
          "UPDATE rundown SET name='Other operator', updatedAt='2099-01-01T00:00:00.000Z' WHERE orgId=? AND id=?",
        )
          .bind(f.orgId, f.showId)
          .run();
      if (change === "delete")
        await env.DB.prepare("DELETE FROM rundown WHERE orgId=? AND id=?")
          .bind(f.orgId, f.showId)
          .run();
      if (change === "reschedule")
        await env.DB.prepare(
          "UPDATE rundown SET serviceDate='2026-11-09' WHERE orgId=? AND id=?",
        )
          .bind(f.orgId, f.showId)
          .run();
      if (change === "retire")
        await env.DB.prepare(
          "INSERT INTO app_setting(id,orgId,key,value) VALUES (?,?,?,'deleting')",
        )
          .bind(crypto.randomUUID(), f.orgId, `show-deleting:${f.showId}`)
          .run();
    } finally {
      await f.control("release");
    }
    const outcome = await saving;
    expect(outcome).toEqual({
      error: expect.any(RundownMetadataConflictError),
    });
    const row = await env.DB.prepare(
      "SELECT name FROM rundown WHERE orgId=? AND id=?",
    )
      .bind(f.orgId, f.showId)
      .first<{ name: string }>();
    expect(row?.name ?? null).toBe(
      change === "delete"
        ? null
        : change === "edit"
          ? "Other operator"
          : "Saved title",
    );
    expect(await f.state()).toEqual(before);
    await evictDurableObject(f.stub);
    expect(await f.state()).toEqual(before);
  },
);

it("checks the saved version even when the requested metadata matches the live room", async () => {
  const f = await metadataFixture();
  const before = await f.state();
  await env.DB.prepare(
    "UPDATE rundown SET name='Other operator', updatedAt='2099-01-01T00:00:00.000Z' WHERE orgId=? AND id=?",
  )
    .bind(f.orgId, f.showId)
    .run();
  const response = await f.stub.fetch(
    f.request("command", {
      id: crypto.randomUUID(),
      expectedRevision: before.revision,
      action: "update-meta",
      payload: { ...f.payload, expectedUpdatedAt: f.expectedUpdatedAt },
    }),
  );
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({
    ok: false,
    reason: "metadata-conflict",
  });
  expect(await f.state()).toEqual(before);
});

it("allows a fresh unchanged save and does not overwrite fields omitted by a guarded command", async () => {
  const f = await metadataFixture();
  await updateRundownMetadataThroughRelay({ env, ...f });
  const row = await env.DB.prepare(
    "SELECT updatedAt FROM rundown WHERE orgId=? AND id=?",
  )
    .bind(f.orgId, f.showId)
    .first<{ updatedAt: string }>();
  expect(row?.updatedAt).not.toBe(f.expectedUpdatedAt);
  const before = await f.state();
  const response = await f.stub.fetch(
    f.request("command", {
      id: crypto.randomUUID(),
      expectedRevision: before.revision,
      action: "update-meta",
      payload: { location: "Side room", expectedUpdatedAt: row?.updatedAt },
    }),
  );
  expect(response.status).toBe(200);
  await response.body?.cancel();
  expect(
    await env.DB.prepare(
      "SELECT name,location FROM rundown WHERE orgId=? AND id=?",
    )
      .bind(f.orgId, f.showId)
      .first(),
  ).toEqual({ name: "Saved title", location: "Side room" });
});

it("carries the exact stored SQLite timestamp when the form uses its ISO equivalent", async () => {
  const f = await metadataFixture();
  await env.DB.prepare(
    "UPDATE rundown SET updatedAt='2026-01-01 00:00:00' WHERE orgId=? AND id=?",
  )
    .bind(f.orgId, f.showId)
    .run();
  await updateRundownMetadataThroughRelay({
    env,
    ...f,
    expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
    payload: { ...f.payload, serviceName: "ISO form" },
  });
  expect((await f.state()).serviceName).toBe("ISO form");
});

it.each([null, 12, "not-a-date", "x".repeat(65)])(
  "rejects invalid metadata versions: %s",
  async (expectedUpdatedAt) => {
    const f = await metadataFixture();
    const before = await f.state();
    const response = await f.stub.fetch(
      f.request("command", {
        action: "update-meta",
        payload: { serviceName: "Invalid", expectedUpdatedAt },
      }),
    );
    expect(response.status).toBe(400);
    await response.body?.cancel();
    expect(await f.state()).toEqual(before);
  },
);

it("keeps the no-relay fallback version checked and refuses a show being deleted", async () => {
  const f = await metadataFixture();
  const fallback = { DB: env.DB };
  await updateRundownMetadataThroughRelay({
    ...f,
    env: fallback,
    payload: { ...f.payload, serviceName: "Fallback" },
  });
  await expect(
    updateRundownMetadataThroughRelay({ ...f, env: fallback }),
  ).rejects.toBeInstanceOf(RundownMetadataConflictError);
  const row = await env.DB.prepare(
    "SELECT updatedAt FROM rundown WHERE orgId=? AND id=?",
  )
    .bind(f.orgId, f.showId)
    .first<{ updatedAt: string }>();
  if (!row) throw new Error("Missing fixture");
  await env.DB.prepare(
    "INSERT INTO app_setting(id,orgId,key,value) VALUES (?,?,?,'deleting')",
  )
    .bind(crypto.randomUUID(), f.orgId, `show-deleting:${f.showId}`)
    .run();
  await expect(
    updateRundownMetadataThroughRelay({
      ...f,
      env: fallback,
      expectedUpdatedAt: row.updatedAt,
    }),
  ).rejects.toBeInstanceOf(RundownMetadataConflictError);
  expect(
    await env.DB.prepare("SELECT name FROM rundown WHERE orgId=? AND id=?")
      .bind(f.orgId, f.showId)
      .first(),
  ).toEqual({ name: "Fallback" });
});

it("reports a socket conflict and allows the rejected command ID to retry with a fresh version", async () => {
  const f = await metadataFixture();
  const before = await f.state();
  const url = await withRelayMember(
    `https://rundown.test/ws?orgId=${f.orgId}&showId=${f.showId}&serviceDate=${f.serviceDate}&access=edit`,
  );
  const response = await f.stub.fetch(url, {
    headers: { Upgrade: "websocket" },
  });
  const socket = response.webSocket;
  if (!socket) throw new Error("Missing operator socket");
  const hydrated = new Promise((resolve) =>
    socket.addEventListener("message", resolve, { once: true }),
  );
  socket.accept();
  await hydrated;
  const messages: Array<{
    type: string;
    id?: string;
    accepted?: boolean;
    reason?: string;
    revision?: number;
  }> = [];
  socket.addEventListener("message", (event) => {
    messages.push(JSON.parse(String(event.data)));
  });
  const id = crypto.randomUUID();
  try {
    await env.DB.prepare(
      "UPDATE rundown SET name='Other operator', updatedAt='2099-01-01T00:00:00.000Z' WHERE orgId=? AND id=?",
    )
      .bind(f.orgId, f.showId)
      .run();
    socket.send(
      JSON.stringify({
        type: "command",
        id,
        action: "update-meta",
        expectedRevision: before.revision,
        payload: {
          serviceName: "Reviewed title",
          expectedUpdatedAt: f.expectedUpdatedAt,
        },
      }),
    );
    await expect
      .poll(() =>
        messages.find(
          (message) => message.type === "command-result" && message.id === id,
        ),
      )
      .toMatchObject({
        accepted: false,
        reason: "metadata-conflict",
        revision: before.revision,
      });
    expect(await f.state()).toEqual(before);
    socket.send(
      JSON.stringify({
        type: "command",
        id,
        action: "update-meta",
        expectedRevision: before.revision,
        payload: {
          serviceName: "Reviewed title",
          expectedUpdatedAt: "2099-01-01T00:00:00.000Z",
        },
      }),
    );
    await expect
      .poll(() =>
        messages
          .filter(
            (message) => message.type === "command-result" && message.id === id,
          )
          .at(-1),
      )
      .toMatchObject({ accepted: true, revision: before.revision + 1 });
    expect(
      await env.DB.prepare("SELECT name FROM rundown WHERE orgId=? AND id=?")
        .bind(f.orgId, f.showId)
        .first(),
    ).toEqual({ name: "Reviewed title" });
  } finally {
    socket.close(1000);
  }
});
