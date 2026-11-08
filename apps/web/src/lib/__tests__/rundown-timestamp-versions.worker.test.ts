import { env } from "cloudflare:workers";
import {
  abortAllDurableObjects,
  evictDurableObject,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import { seedRelayMember } from "@/test/relay-fixtures";
import { TestRundownRelay } from "@/test/worker-entry";
import { getPrisma } from "../db";
import { rundownInternalRequest } from "../rundown-internal-request.server";
import {
  updateRundownMetadataThroughRelay,
  RundownMetadataConflictError,
} from "../rundown-meta-update.server";
import {
  writeShowDetails,
  writeRundownDetails,
} from "../show-details-write.server";
import {
  NEXT_UPDATED_AT_SQL,
  sqliteTimestampMillis,
} from "../sqlite-timestamp.server";
import type { ShowDetailsCommand } from "../show-details-contract";
afterEach(() => abortAllDurableObjects());
const future = "2090-01-01T00:00:00.000Z";
const item = {
  id: "cue",
  title: "Cue",
  type: "segment",
  duration: 10000,
  notes: "",
  assignee: "",
  cue: "",
  status: "upcoming",
  sortOrder: 0,
  hardStop: false,
};
async function fixture(storage: "prisma" | "numeric" = "numeric") {
  const actor = await seedRelayMember(crypto.randomUUID()),
    showId = crypto.randomUUID(),
    serviceDate = "2026-11-08";
  await getPrisma().rundown.create({
    data: {
      id: showId,
      orgId: actor.orgId,
      serviceDate,
      name: "Prisma show",
      updatedAt: new Date(future),
    },
  });
  const row = () =>
    env.DB.prepare(
      "SELECT name,location,updatedAt,typeof(updatedAt) AS storageType FROM rundown WHERE orgId=? AND id=?",
    )
      .bind(actor.orgId, showId)
      .first<{
        name: string;
        location: string;
        updatedAt: string | number;
        storageType: string;
      }>();
  expect(await row()).toMatchObject({
    updatedAt: "2090-01-01T00:00:00.000+00:00",
    storageType: "text",
  });
  if (storage === "numeric") {
    await env.DB.prepare(
      "UPDATE rundown SET updatedAt=? WHERE orgId=? AND id=?",
    )
      .bind(Date.parse(future), actor.orgId, showId)
      .run();
    expect(await row()).toMatchObject({
      updatedAt: Date.parse(future),
      storageType: "integer",
    });
  }
  const stub = env.RUNDOWN_RELAY.getByName(`${actor.orgId}:show:${showId}`);
  const query = new URLSearchParams({
    orgId: actor.orgId,
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
  const command = (action: string, payload: unknown, extra: object = {}) => {
    const commandQuery = new URLSearchParams(query);
    if (action.startsWith("timer-")) commandQuery.set("access", "control");
    return stub.fetch(
      rundownInternalRequest(
        `https://rundown.test/command?${commandQuery}`,
        env.BETTER_AUTH_SECRET,
        {
          method: "POST",
          body: JSON.stringify({
            id: crypto.randomUUID(),
            action,
            payload,
            ...extra,
          }),
        },
      ),
    );
  };
  const details: ShowDetailsCommand = {
    orgId: actor.orgId,
    userId: actor.userId,
    showId,
    serviceDate,
    expectedUpdatedAt: future,
    requestId: crypto.randomUUID(),
    name: "Saved title",
    location: "Main room",
    startTime: "",
    callTime: "",
    timeZone: "UTC",
  };
  const payload = {
    serviceName: "Saved title",
    location: "Main room",
    scheduledStartTime: null,
    scheduledCallTime: null,
  };
  return {
    ...actor,
    showId,
    serviceDate,
    row,
    stub,
    command,
    details,
    payload,
    state: async () =>
      (await stub.fetch(request("state"))).json<{
        revision: number;
        serviceName: string;
        items: Array<{ id: string; title: string }>;
        timer: { playback: string };
      }>(),
    control: (action: "hold" | "release" | "waiting") =>
      runInDurableObject(stub, (instance) => {
        if (!(instance instanceof TestRundownRelay))
          throw new Error("Missing batch control");
        if (action === "hold") instance.holdNextBatch();
        if (action === "release") instance.releaseBatch();
        return instance.isBatchWaiting();
      }),
  };
}
it.each(["schedule", "rundown"])(
  "%s detail saves accept numeric stored timestamps and preserve replay receipts",
  async (family) => {
    const f = await fixture();
    const save = () =>
      family === "schedule"
        ? writeShowDetails(
            env.DB,
            f.details,
            f.sessionId,
            "save",
            async () => {},
          )
        : writeRundownDetails(
            env.DB,
            { ...f.details, timeZone: "UTC", expectedRevision: 0 },
            { sessionId: f.sessionId, pin: null },
            "save",
            0,
            async () => {},
          );
    expect((await save()).outcome).toBe("applied");
    const first = await f.row();
    expect(first?.name).toBe("Saved title");
    expect(new Date(first!.updatedAt).getTime()).toBeGreaterThan(
      Date.parse(future),
    );
    await save();
    expect(await f.row()).toEqual(first);
  },
);
it.each(["relay", "fallback"])(
  "the %s metadata path matches an ISO form to the numeric stored version",
  async (mode) => {
    const f = await fixture(),
      bindings = mode === "relay" ? env : { DB: env.DB };
    await updateRundownMetadataThroughRelay({
      env: bindings,
      ...f,
      expectedUpdatedAt: future,
      payload: f.payload,
    });
    const row = await f.row();
    expect(row?.name).toBe("Saved title");
    expect(new Date(row!.updatedAt).getTime()).toBeGreaterThan(
      Date.parse(future),
    );
    await expect(
      updateRundownMetadataThroughRelay({
        env: bindings,
        ...f,
        expectedUpdatedAt: future,
        payload: { ...f.payload, serviceName: "Stale overwrite" },
      }),
    ).rejects.toBeInstanceOf(RundownMetadataConflictError);
    expect(await f.row()).toEqual(row);
  },
);
it("direct guarded metadata commands match the numeric stored instant without accepting numeric wire versions", async () => {
  const f = await fixture();
  const response = await f.command("update-meta", {
    ...f.payload,
    expectedUpdatedAt: future,
  });
  expect(response.status).toBe(200);
  await response.arrayBuffer();
  expect((await f.state()).serviceName).toBe("Saved title");
  const invalid = await f.command("update-meta", {
    ...f.payload,
    expectedUpdatedAt: Date.parse(future),
  });
  expect(invalid.status).toBe(400);
  await invalid.arrayBuffer();
});
it("row and timer writes advance numeric timestamps and survive relay eviction", async () => {
  const f = await fixture();
  const seeded = await f.command("seed", { items: [item] });
  expect(seeded.status).toBe(200);
  await seeded.arrayBuffer();
  const seededVersion = (await f.row())!.updatedAt;
  const started = await f.command("timer-start", { itemId: item.id });
  expect(started.status).toBe(200);
  await started.arrayBuffer();
  expect(new Date((await f.row())!.updatedAt).getTime()).toBeGreaterThan(
    new Date(seededVersion).getTime(),
  );
  await evictDurableObject(f.stub);
  expect(await f.state()).toMatchObject({
    items: [{ title: "Cue" }],
    timer: { playback: "play" },
  });
});
it("the final metadata CAS rejects a Prisma write after the reviewed numeric version was read", async () => {
  const f = await fixture(),
    before = await f.state();
  await f.control("hold");
  const saving = f.command("update-meta", {
    ...f.payload,
    expectedUpdatedAt: future,
  });
  await expect.poll(() => f.control("waiting")).toBe(true);
  try {
    await getPrisma().rundown.update({
      where: { id: f.showId },
      data: {
        name: "Other operator",
        updatedAt: new Date(Date.parse(future) + 1000),
      },
    });
  } finally {
    await f.control("release");
  }
  const response = await saving;
  expect(response.status).toBe(409);
  await response.arrayBuffer();
  expect((await f.row())?.name).toBe("Other operator");
  expect((await f.state()).revision).toBe(before.revision);
});

it("matches the installed Prisma ISO offset format to the equivalent ISO-Z wire version", async () => {
  const f = await fixture("prisma");
  const response = await f.command("update-meta", {
    ...f.payload,
    expectedUpdatedAt: future,
  });
  expect(response.status).toBe(200);
  await response.arrayBuffer();
  expect((await f.row())?.name).toBe("Saved title");
});

// A future stored time forces SQL to advance the version rather than use now.
it.each([
  Date.parse(future),
  future,
  "2090-01-01T00:00:00.000+00:00",
  "2090-01-01 00:00:00",
  "2089-12-31T19:00:00.000-05:00",
])("advances stored version %s on each rapid write", async (stored) => {
  const f = await fixture();
  await env.DB.prepare("UPDATE rundown SET updatedAt=? WHERE orgId=? AND id=?")
    .bind(stored, f.orgId, f.showId)
    .run();
  let previous = Date.parse(future);
  for (let i = 0; i < 20; i++) {
    await env.DB.prepare(
      `UPDATE rundown SET updatedAt=${NEXT_UPDATED_AT_SQL} WHERE orgId=? AND id=?`,
    )
      .bind(f.orgId, f.showId)
      .run();
    const row = await f.row();
    expect(row).not.toBeNull();
    if (!row) throw new Error("Missing timestamp fixture");
    const current = sqliteTimestampMillis(row.updatedAt);
    expect(current).toBe(previous + 1);
    previous = current;
  }
});
it("matches SQLite UTC text to an ISO version and rejects a stale repeat", async () => {
  const f = await fixture();
  await env.DB.prepare("UPDATE rundown SET updatedAt=? WHERE orgId=? AND id=?")
    .bind("2090-01-01 00:00:00", f.orgId, f.showId)
    .run();
  const response = await f.command("update-meta", {
    ...f.payload,
    expectedUpdatedAt: future,
  });
  expect(response.status).toBe(200);
  await response.arrayBuffer();
  const stale = await f.command("update-meta", {
    ...f.payload,
    serviceName: "Stale",
    expectedUpdatedAt: future,
  });
  expect(stale.status).toBe(409);
  await stale.arrayBuffer();
  expect((await f.row())?.name).toBe("Saved title");
});
