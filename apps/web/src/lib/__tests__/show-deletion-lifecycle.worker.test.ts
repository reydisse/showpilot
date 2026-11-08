import { env } from "cloudflare:workers";
import {
  abortAllDurableObjects,
  evictDurableObject,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { seedRelayMember } from "@/test/relay-fixtures";
import { TestRundownRelay } from "@/test/worker-entry";
import { getPrisma } from "../db";
import { getAuth } from "../auth";
import { hashPassword } from "better-auth/crypto";
import { deleteService } from "../schedule";
import { deleteServiceForOrg } from "../service-deletion.server";
import {
  showDeletionRelays,
  type ShowDeletionRelays,
} from "../show-deletion-relays.server";
import { ShowDeletionBlockedError } from "../show-deletion-contract";
import { rundownInternalRequest } from "../rundown-internal-request.server";
afterEach(async () => {
  vi.restoreAllMocks();
  await abortAllDurableObjects();
});
const auth = vi.hoisted(() => ({ cookie: "", ip: 0 }));
vi.mock("better-auth/tanstack-start", () => ({
  tanstackStartCookies: () => ({ id: "test-cookie-bridge" }),
}));
vi.mock("@tanstack/react-start/server", () => ({
  getRequestHeaders: () => new Headers({ Cookie: auth.cookie }),
}));
vi.mock("@tanstack/react-start", () => {
  const builder = () => {
    let validate = (value: unknown) => value;
    const chain = {
      middleware: () => chain,
      inputValidator: (fn: typeof validate) => {
        validate = fn;
        return chain;
      },
      handler:
        (fn: (input: { data: unknown }) => unknown) =>
        async (input: { data: unknown }) =>
          fn({ data: validate(input.data) }),
      server: () => chain,
    };
    return chain;
  };
  return {
    createServerFn: builder,
    createMiddleware: builder,
    createServerOnlyFn: <T>(fn: T): T => fn,
  };
});

async function actorFixture() {
  const { orgId, userId } = await seedRelayMember(crypto.randomUUID());
  const password = "Disposable-assignment-password-92!";
  await getPrisma().account.create({
    data: {
      id: crypto.randomUUID(),
      issuer: "local:credential",
      accountId: userId,
      providerId: "credential",
      userId,
      password: await hashPassword(password),
    },
  });
  const login = await getAuth().handler(
    new Request("https://app.showpilot.tech/api/auth/sign-in/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://app.showpilot.tech",
        "cf-connecting-ip": `192.0.2.${++auth.ip}`,
      },
      body: JSON.stringify({ email: `${userId}@example.test`, password }),
    }),
  );
  expect(login.status).toBe(200);
  await login.arrayBuffer();
  auth.cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  return { orgId, userId, headers: new Headers({ Cookie: auth.cookie }) };
}

async function fixture() {
  const actor = await actorFixture();
  const showId = crypto.randomUUID(),
    serviceDate = "2026-11-08";
  await env.DB.prepare(
    "INSERT INTO rundown(id,orgId,serviceDate,name,status,updatedAt) VALUES (?,?,?,'Deletion fixture','stopped','2026-01-01T00:00:00.000Z')",
  )
    .bind(showId, actor.orgId, serviceDate)
    .run();
  const relay = env.RUNDOWN_RELAY.getByName(`${actor.orgId}:show:${showId}`);
  const query = new URLSearchParams({
    orgId: actor.orgId,
    showId,
    serviceDate,
    access: "control",
  });
  const command = (action: string, payload?: unknown) =>
    relay.fetch(
      rundownInternalRequest(
        `https://rundown.test/command?${query}`,
        env.BETTER_AUTH_SECRET,
        { method: "POST", body: JSON.stringify({ action, payload }) },
      ),
    );
  const seeded = await command("seed", {
    items: [
      {
        id: "cue",
        title: "Cue",
        type: "segment",
        duration: 60000,
        notes: "",
        assignee: "",
        cue: "",
        status: "upcoming",
        sortOrder: 0,
        hardStop: false,
      },
    ],
  });
  expect(seeded.status).toBe(200);
  await seeded.body?.cancel();
  return {
    ...actor,
    showId,
    serviceDate,
    relay,
    command,
    remove: (relays: ShowDeletionRelays = showDeletionRelays) =>
      deleteServiceForOrg(
        { orgId: actor.orgId, showId },
        actor.headers,
        relays,
      ),
    operation: () =>
      env.DB.prepare(
        "SELECT stage FROM show_deletion WHERE orgId=? AND showId=?",
      )
        .bind(actor.orgId, showId)
        .first(),
    row: () =>
      env.DB.prepare("SELECT id,status FROM rundown WHERE orgId=? AND id=?")
        .bind(actor.orgId, showId)
        .first(),
    marker: () =>
      env.DB.prepare("SELECT value FROM app_setting WHERE orgId=? AND key=?")
        .bind(actor.orgId, `show-deleting:${showId}`)
        .first(),
    control: (action: "hold" | "release" | "waiting") =>
      runInDurableObject(relay, async (instance) => {
        if (!(instance instanceof TestRundownRelay))
          throw new Error("Missing batch control");
        if (action === "hold") instance.holdNextBatch();
        if (action === "release") instance.releaseBatch();
        return instance.isBatchWaiting();
      }),
  };
}

it("confirms a completed deletion when the original successful reply was lost", async () => {
  const f = await fixture();
  await f.remove();
  await expect(f.remove()).resolves.toMatchObject({ ok: true });
  expect(await f.row()).toBeNull();
});

it("never accepts both a queued Start and deletion of the same stopped show", async () => {
  const f = await fixture();
  await f.control("hold");
  const starting = f.command("timer-start", { itemId: "cue" });
  await expect.poll(() => f.control("waiting")).toBe(true);
  const removing = f.remove().then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  try {
    await expect.poll(() => f.marker()).not.toBeNull();
  } finally {
    await f.control("release");
  }
  const started = await starting,
    deleted = await removing;
  const startAccepted = started.ok;
  await started.body?.cancel();
  expect(startAccepted && "value" in deleted).toBe(false);
  if (startAccepted) {
    expect(deleted).toEqual({ error: expect.any(Error) });
    expect(await f.row()).toMatchObject({ status: "running" });
    expect(await f.marker()).toBeNull();
  } else {
    expect(deleted).toMatchObject({ value: { ok: true } });
    expect(await f.row()).toBeNull();
  }
});

it("a deleted show rejects late internal writes before and after relay restart", async () => {
  const f = await fixture();
  await f.remove();
  for (const restart of [false, true]) {
    if (restart) await evictDurableObject(f.relay);
    const response = await f.command("stage-message", {
      message: "Late output",
    });
    expect(response.status).toBe(410);
    await response.body?.cancel();
  }
  expect(
    await env.DB.prepare(
      "SELECT value FROM app_setting WHERE orgId=? AND key=?",
    )
      .bind(f.orgId, `rundown-message:${f.showId}`)
      .first(),
  ).toBeNull();
});

it.each(["live", "running", "paused"])(
  "refuses to delete a %s show without starting cleanup",
  async (status) => {
    const f = await fixture();
    await env.DB.prepare("UPDATE rundown SET status=? WHERE orgId=? AND id=?")
      .bind(status, f.orgId, f.showId)
      .run();
    await expect(f.remove()).rejects.toThrow("Stop the show");
    expect(await f.row()).toMatchObject({ status });
    expect(await f.operation()).toBeNull();
    expect(await f.marker()).toBeNull();
  },
);

it.each(['{"playback":"play"}', '{"playback":"pause"}', "invalid json"])(
  "fails closed for a persisted active or malformed timer: %s",
  async (value) => {
    const f = await fixture();
    await env.DB.prepare(
      "INSERT INTO app_setting(id,orgId,key,value) VALUES (?,?,?,?) ON CONFLICT(orgId,key) DO UPDATE SET value=excluded.value",
    )
      .bind(crypto.randomUUID(), f.orgId, `rundown-timer:${f.showId}`, value)
      .run();
    await expect(f.remove()).rejects.toThrow("Stop the show");
    expect(await f.operation()).toBeNull();
    expect(await f.row()).not.toBeNull();
  },
);

it("finishes one deletion when two authorized requests overlap", async () => {
  const f = await fixture();
  await expect(Promise.all([f.remove(), f.remove()])).resolves.toEqual([
    { ok: true },
    { ok: true },
  ]);
  expect(await f.operation()).toEqual({ stage: "deleted" });
  expect(await f.row()).toBeNull();
});

it("keeps a failed preparation retryable and blocks writes until it finishes", async () => {
  const f = await fixture();
  await expect(
    f.remove({
      ...showDeletionRelays,
      async prepare(target) {
        await showDeletionRelays.prepare(target);
        throw new Error("lost preparation reply");
      },
    }),
  ).rejects.toThrow("lost preparation reply");
  expect(await f.operation()).toEqual({ stage: "preparing" });
  const response = await f.command("stage-message", { message: "Blocked" });
  expect(response.status).toBe(409);
  await response.body?.cancel();
  await expect(f.remove()).resolves.toEqual({ ok: true });
});

it("releases reversible fences when a relay refuses deletion", async () => {
  const f = await fixture();
  await expect(
    f.remove({
      ...showDeletionRelays,
      async prepare(target) {
        await showDeletionRelays.prepare(target);
        throw new ShowDeletionBlockedError();
      },
    }),
  ).rejects.toThrow("Stop the show");
  expect(await f.operation()).toBeNull();
  expect(await f.marker()).toBeNull();
  expect(await f.row()).not.toBeNull();
  await evictDurableObject(f.relay);
  const response = await f.command("stage-message", {
    message: "Still available",
  });
  expect(response.status).toBe(200);
  await response.body?.cancel();
});

it("releases preparation if permission is revoked before deletion is accepted", async () => {
  const f = await fixture();
  await expect(
    f.remove({
      ...showDeletionRelays,
      async prepare(target) {
        await showDeletionRelays.prepare(target);
        await env.DB.prepare(
          "DELETE FROM member WHERE organizationId=? AND userId=?",
        )
          .bind(f.orgId, f.userId)
          .run();
      },
    }),
  ).rejects.toThrow("Deletion was not accepted");
  expect(await f.operation()).toBeNull();
  expect(await f.marker()).toBeNull();
  expect(await f.row()).not.toBeNull();
  // Signed integration writes remain available after the reversible fence is released.
  const response = await f.command("stage-message", { message: "Available" });
  expect(response.status).toBe(200);
  await response.body?.cancel();
});

it("retains an accepted deletion after relay failure and finishes it on retry", async () => {
  const f = await fixture();
  await expect(
    f.remove({
      ...showDeletionRelays,
      async purge() {
        throw new Error("relay unavailable");
      },
    }),
  ).rejects.toThrow("relay unavailable");
  expect(await f.operation()).toEqual({ stage: "purging" });
  expect(await f.marker()).not.toBeNull();
  expect(await f.row()).not.toBeNull();
  await expect(
    env.DB.prepare("UPDATE rundown SET name='Late edit' WHERE orgId=? AND id=?")
      .bind(f.orgId, f.showId)
      .run(),
  ).rejects.toThrow("being deleted");
  await expect(f.remove()).resolves.toEqual({ ok: true });
});

it("rolls back the whole graph if final deletion fails, then completes without reviving retired relays", async () => {
  const f = await fixture();
  await env.DB.prepare(
    "CREATE TRIGGER deletion_fixture_failure BEFORE DELETE ON rundown BEGIN SELECT RAISE(ABORT,'fixture delete failed'); END",
  ).run();
  try {
    await expect(f.remove()).rejects.toThrow("fixture delete failed");
  } finally {
    await env.DB.prepare("DROP TRIGGER deletion_fixture_failure").run();
  }
  expect(await f.operation()).toEqual({ stage: "purging" });
  expect(await f.row()).not.toBeNull();
  expect(
    await env.DB.prepare(
      "SELECT id FROM rundown_item WHERE orgId=? AND showId=?",
    )
      .bind(f.orgId, f.showId)
      .first(),
  ).not.toBeNull();
  const response = await f.command("timer-start", { itemId: "cue" });
  expect(response.status).toBe(410);
  await response.body?.cancel();
  await expect(f.remove()).resolves.toEqual({ ok: true });
  expect(await f.row()).toBeNull();
});

it("rejects stale confirmation, another account or organization, and revoked permission on receipt retry", async () => {
  const f = await fixture();
  await expect(
    deleteServiceForOrg(
      {
        orgId: f.orgId,
        showId: f.showId,
        expectedUpdatedAt: "2020-01-01T00:00:00Z",
      },
      f.headers,
    ),
  ).rejects.toThrow("changed");
  await expect(
    deleteServiceForOrg(
      { orgId: f.orgId, showId: f.showId, userId: "another-user" },
      f.headers,
    ),
  ).rejects.toThrow("account changed");
  const other = await actorFixture();
  await expect(
    deleteServiceForOrg({ orgId: f.orgId, showId: f.showId }, other.headers),
  ).rejects.toThrow("permission");
  expect(await f.operation()).toBeNull();
  await f.remove();
  await env.DB.prepare("DELETE FROM member WHERE organizationId=? AND userId=?")
    .bind(f.orgId, f.userId)
    .run();
  await expect(f.remove()).rejects.toThrow("permission");
});

it("never recreates a deleted show identity or its child rows", async () => {
  const f = await fixture();
  await f.remove();
  await expect(
    env.DB.prepare(
      "INSERT INTO rundown(id,orgId,serviceDate,name) VALUES (?,?,?,'Recreated')",
    )
      .bind(f.showId, f.orgId, f.serviceDate)
      .run(),
  ).rejects.toThrow("has been deleted");
  await expect(
    env.DB.prepare(
      "INSERT INTO service_assignment(id,orgId,showId,serviceDate,role,updatedAt) VALUES (?,?,?,?,'Late',CURRENT_TIMESTAMP)",
    )
      .bind(crypto.randomUUID(), f.orgId, f.showId, f.serviceDate)
      .run(),
  ).rejects.toThrow("has been deleted");
});

it("purges storage beyond one delete batch and retains the retirement marker across restart", async () => {
  const f = await fixture();
  await runInDurableObject(f.relay, async (_, state) => {
    for (let start = 0; start < 270; start += 90) {
      const values: Record<string, string> = {};
      for (let n = start; n < start + 90; n++)
        values[`fixture:${n}`] = "old data";
      await state.storage.put(values);
    }
  });
  await f.remove();
  await evictDurableObject(f.relay);
  expect(
    await runInDurableObject(f.relay, async (_, state) =>
      Object.fromEntries(await state.storage.list()),
    ),
  ).toEqual({ retired: true });
});

async function seedGraph(
  orgId: string,
  showId: string,
  serviceDate: string,
  userId: string,
) {
  const id = (kind: string) => `${showId}-${kind}`;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO cue_column(id,orgId,label,updatedAt) VALUES (?,?,'Production',CURRENT_TIMESTAMP)",
    ).bind(id("column"), orgId),
    env.DB.prepare(
      "INSERT INTO checklist_template(id,orgId,label,category) VALUES (?,?,'Line check','audio')",
    ).bind(id("template"), orgId),
    env.DB.prepare(
      "INSERT INTO cue_note(id,orgId,showId,serviceDate,itemId,columnId,text,updatedAt) VALUES (?,?,?,?,'cue',?,'Ready',CURRENT_TIMESTAMP)",
    ).bind(id("note"), orgId, showId, serviceDate, id("column")),
    env.DB.prepare(
      "INSERT INTO cue_sheet(id,orgId,showId,serviceDate,cueNumber,rundownItem,updatedAt) VALUES (?,?,?,?,1,'Cue',CURRENT_TIMESTAMP)",
    ).bind(id("sheet"), orgId, showId, serviceDate),
    env.DB.prepare(
      "INSERT INTO checklist_entry(id,orgId,showId,serviceDate,templateId) VALUES (?,?,?,?,?)",
    ).bind(id("entry"), orgId, showId, serviceDate, id("template")),
    env.DB.prepare(
      "INSERT INTO service_assignment(id,orgId,showId,serviceDate,role,updatedAt) VALUES (?,?,?,?,'Audio',CURRENT_TIMESTAMP)",
    ).bind(id("assignment"), orgId, showId, serviceDate),
    env.DB.prepare(
      "INSERT INTO incident(id,orgId,showId,serviceDate,category,severity,description,reportedBy) VALUES (?,?,?,?,'audio','low','Fixture','Fixture')",
    ).bind(id("incident"), orgId, showId, serviceDate),
    env.DB.prepare(
      "INSERT INTO incident_comment(id,orgId,incidentId,userId,authorName,body) VALUES (?,?,?,?,'Fixture','Check')",
    ).bind(id("comment"), orgId, id("incident"), userId),
    env.DB.prepare(
      "INSERT INTO content_reaction(id,orgId,targetType,targetId,userId,authorName,emoji) VALUES (?,?,'incident-comment',?,?,'Fixture','👍')",
    ).bind(id("reaction"), orgId, id("comment"), userId),
    env.DB.prepare(
      "INSERT INTO mic_assignment(id,orgId,showId,serviceDate,channel,label,micType,updatedAt) VALUES (?,?,?,?,1,'Mic','wired',CURRENT_TIMESTAMP)",
    ).bind(id("mic"), orgId, showId, serviceDate),
    ...["incident", "assignment"].map((source) =>
      env.DB.prepare(
        "INSERT INTO notification(id,orgId,type,title,message,source) VALUES (?,?,'test','Fixture','Fixture',?)",
      ).bind(id(`${source}-notification`), orgId, id(source)),
    ),
  ]);
  return id;
}

it("deletes the complete graph while preserving another show on the same date and another organization", async () => {
  const f = await fixture(),
    other = await fixture(),
    siblingId = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO rundown(id,orgId,serviceDate,name) VALUES (?,?,?,'Sibling')",
  )
    .bind(siblingId, f.orgId, f.serviceDate)
    .run();
  await seedGraph(f.orgId, f.showId, f.serviceDate, f.userId);
  await seedGraph(f.orgId, siblingId, f.serviceDate, f.userId);
  await seedGraph(other.orgId, other.showId, other.serviceDate, other.userId);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO app_setting(id,orgId,key,value) VALUES (?,?,'active-show-id',?)",
    ).bind(crypto.randomUUID(), f.orgId, f.showId),
    env.DB.prepare(
      "INSERT INTO app_setting(id,orgId,key,value) VALUES (?,?,'active-service-date',?)",
    ).bind(crypto.randomUUID(), f.orgId, f.serviceDate),
    env.DB.prepare(
      "INSERT INTO app_setting(id,orgId,key,value) VALUES (?,?,?,'Legacy')",
    ).bind(crypto.randomUUID(), f.orgId, `rundown-message:${f.serviceDate}`),
  ]);
  const tables = [
    "cue_note",
    "cue_sheet",
    "checklist_entry",
    "service_assignment",
    "incident",
    "incident_comment",
    "content_reaction",
    "mic_assignment",
    "notification",
  ] as const;
  const before = new Map<string, { id: string }[]>();
  for (const table of tables)
    before.set(
      table,
      (
        await env.DB.prepare(
          `SELECT id FROM ${table} WHERE orgId IN (?,?) ORDER BY id`,
        )
          .bind(f.orgId, other.orgId)
          .all<{ id: string }>()
      ).results,
    );
  await f.remove();
  for (const table of tables) {
    const rows = (
      await env.DB.prepare(
        `SELECT id FROM ${table} WHERE orgId IN (?,?) ORDER BY id`,
      )
        .bind(f.orgId, other.orgId)
        .all<{ id: string }>()
    ).results;
    expect(rows, table).toEqual(
      before.get(table)?.filter((row) => !row.id.startsWith(f.showId)),
    );
  }
  expect(
    await env.DB.prepare(
      "SELECT id FROM rundown_item WHERE orgId=? AND showId=?",
    )
      .bind(f.orgId, f.showId)
      .first(),
  ).toBeNull();
  expect(
    await env.DB.prepare(
      "SELECT id FROM app_setting WHERE orgId=? AND key='active-show-id'",
    )
      .bind(f.orgId)
      .first(),
  ).toBeNull();
  expect(
    await env.DB.prepare(
      "SELECT value FROM app_setting WHERE orgId=? AND key='active-service-date'",
    )
      .bind(f.orgId)
      .first(),
  ).toEqual({ value: f.serviceDate });
  expect(
    await env.DB.prepare(
      "SELECT value FROM app_setting WHERE orgId=? AND key=?",
    )
      .bind(f.orgId, `rundown-message:${f.serviceDate}`)
      .first(),
  ).not.toBeNull();
  expect(await other.row()).not.toBeNull();
  await deleteServiceForOrg({ orgId: f.orgId, showId: siblingId }, f.headers);
  expect(
    await env.DB.prepare(
      "SELECT id FROM app_setting WHERE orgId=? AND key IN ('active-service-date',?)",
    )
      .bind(f.orgId, `rundown-message:${f.serviceDate}`)
      .first(),
  ).toBeNull();
  expect(
    (
      await env.DB.prepare("SELECT id FROM cue_column WHERE orgId=?")
        .bind(f.orgId)
        .all()
    ).results,
  ).toHaveLength(2);
  expect(
    (
      await env.DB.prepare("SELECT id FROM checklist_template WHERE orgId=?")
        .bind(f.orgId)
        .all()
    ).results,
  ).toHaveLength(2);
});

it("rejects a running relay even when the database snapshot says stopped", async () => {
  const f = await fixture();
  const started = await f.command("timer-start", { itemId: "cue" });
  expect(started.status).toBe(200);
  await started.body?.cancel();
  // Reproduce a stale database snapshot without changing the relay's live timer.
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE rundown SET status='stopped' WHERE orgId=? AND id=?",
    ).bind(f.orgId, f.showId),
    env.DB.prepare("DELETE FROM app_setting WHERE orgId=? AND key=?").bind(
      f.orgId,
      `rundown-timer:${f.showId}`,
    ),
  ]);
  await expect(f.remove()).rejects.toThrow("Stop the show");
  expect(await f.operation()).toBeNull();
  expect(await f.marker()).toBeNull();
  expect(await f.row()).not.toBeNull();
  const paused = await f.command("timer-pause");
  expect(paused.status).toBe(200);
  await paused.body?.cancel();
});

it("does not retire a legacy room currently serving a different show", async () => {
  const f = await fixture(),
    siblingId = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO rundown(id,orgId,serviceDate,name) VALUES (?,?,?,'Sibling')",
  )
    .bind(siblingId, f.orgId, f.serviceDate)
    .run();
  const legacy = env.RUNDOWN_RELAY.getByName(`${f.orgId}:${f.serviceDate}`);
  const url = `https://rundown.test/command?${new URLSearchParams({ orgId: f.orgId, showId: siblingId, serviceDate: f.serviceDate, access: "control" })}`;
  const send = () =>
    legacy.fetch(
      rundownInternalRequest(url, env.BETTER_AUTH_SECRET, {
        method: "POST",
        body: JSON.stringify({
          action: "stage-message",
          payload: { message: "Sibling output" },
        }),
      }),
    );
  let response = await send();
  expect(response.status).toBe(200);
  await response.body?.cancel();
  await f.remove();
  await evictDurableObject(legacy);
  response = await send();
  expect(response.status).toBe(200);
  await response.body?.cancel();
  expect(
    await env.DB.prepare(
      "SELECT value FROM app_setting WHERE orgId=? AND key=?",
    )
      .bind(f.orgId, `rundown-message:${siblingId}`)
      .first(),
  ).toEqual({ value: "Sibling output" });
});

it.each([
  "rundown-items",
  "rundown-timer",
  "rundown-message",
  "rundown-ppslide",
  "rundown-items-storage",
])("blocks a delayed direct %s save after deletion", async (prefix) => {
  const f = await fixture();
  await f.remove();
  await expect(
    env.DB.prepare(
      "INSERT INTO app_setting(id,orgId,key,value) VALUES (?,?,?,'Delayed snapshot')",
    )
      .bind(crypto.randomUUID(), f.orgId, `${prefix}:${f.showId}`)
      .run(),
  ).rejects.toThrow("has been deleted");
});

it("blocks an upsert or renamed snapshot during preparation without blocking unrelated settings", async () => {
  const f = await fixture();
  await expect(
    f.remove({
      ...showDeletionRelays,
      async prepare() {
        throw new Error("offline");
      },
    }),
  ).rejects.toThrow("offline");
  await expect(
    env.DB.prepare(
      "UPDATE app_setting SET value='Late timer' WHERE orgId=? AND key=?",
    )
      .bind(f.orgId, `rundown-timer:${f.showId}`)
      .run(),
  ).rejects.toThrow("being deleted");
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO app_setting(id,orgId,key,value) VALUES (?,?,'fixture-setting','Allowed')",
  )
    .bind(id, f.orgId)
    .run();
  await expect(
    env.DB.prepare("UPDATE app_setting SET key=? WHERE orgId=? AND id=?")
      .bind(`rundown-message:${f.showId}`, f.orgId, id)
      .run(),
  ).rejects.toThrow("being deleted");
  expect(
    await env.DB.prepare("SELECT value FROM app_setting WHERE orgId=? AND id=?")
      .bind(f.orgId, id)
      .first(),
  ).toEqual({ value: "Allowed" });
  await f.remove();
});

it("returns an explicit rejected result for a stale confirmation or a running show", async () => {
  const f = await fixture();
  const data = { orgId: f.orgId, userId: f.userId, showId: f.showId };
  expect(
    await deleteService({
      data: { ...data, expectedUpdatedAt: "2020-01-01T00:00:00Z" },
    }),
  ).toEqual({ ok: false, message: expect.stringContaining("changed") });
  await env.DB.prepare(
    "UPDATE rundown SET status='running' WHERE orgId=? AND id=?",
  )
    .bind(f.orgId, f.showId)
    .run();
  expect(await deleteService({ data })).toEqual({
    ok: false,
    message: "Stop the show before deleting it",
  });
  expect(await f.operation()).toBeNull();
});

it("does not describe an interrupted accepted deletion as rejected", async () => {
  const f = await fixture();
  await env.DB.prepare(
    "CREATE TRIGGER deletion_reply_failure BEFORE DELETE ON rundown BEGIN SELECT RAISE(ABORT,'cleanup interrupted'); END",
  ).run();
  try {
    await expect(
      deleteService({ data: { orgId: f.orgId, showId: f.showId } }),
    ).rejects.toThrow("cleanup interrupted");
  } finally {
    await env.DB.prepare("DROP TRIGGER deletion_reply_failure").run();
  }
  expect(await f.operation()).toEqual({ stage: "purging" });
  expect(
    await deleteService({ data: { orgId: f.orgId, showId: f.showId } }),
  ).toEqual({ ok: true });
});

it("keeps an accepted deletion unconfirmed when a purge endpoint refuses cleanup", async () => {
  const f = await fixture();
  vi.spyOn(showDeletionRelays, "purge").mockRejectedValueOnce(
    new ShowDeletionBlockedError(),
  );
  await expect(
    deleteService({ data: { orgId: f.orgId, showId: f.showId } }),
  ).rejects.toThrow("cleanup");
  expect(await f.operation()).toEqual({ stage: "purging" });
  expect(
    await deleteService({ data: { orgId: f.orgId, showId: f.showId } }),
  ).toEqual({ ok: true });
});

it("does not reject a preparation refusal if an overlapping request already accepted deletion", async () => {
  const f = await fixture(),
    prepare = showDeletionRelays.prepare;
  vi.spyOn(showDeletionRelays, "prepare").mockImplementationOnce(
    async (target) => {
      await prepare(target);
      await env.DB.prepare(
        "UPDATE show_deletion SET stage='purging' WHERE orgId=? AND showId=? AND nonce=? AND stage='preparing'",
      )
        .bind(target.orgId, target.showId, target.nonce)
        .run();
      throw new ShowDeletionBlockedError();
    },
  );
  await expect(
    deleteService({ data: { orgId: f.orgId, showId: f.showId } }),
  ).rejects.toThrow("cleanup");
  expect(await f.operation()).toEqual({ stage: "purging" });
  expect(
    await deleteService({ data: { orgId: f.orgId, showId: f.showId } }),
  ).toEqual({ ok: true });
});

it("native deletion uses the reviewed show version and returns a known rejection for a live show", async () => {
  const f = await fixture();
  await env.DB.prepare(
    "UPDATE rundown SET status='running' WHERE orgId=? AND id=?",
  )
    .bind(f.orgId, f.showId)
    .run();
  const { handleMobileApi } = await import("../mobile-api.server");
  const requestId = crypto.randomUUID();
  const row = await env.DB.prepare(
    "SELECT updatedAt FROM rundown WHERE orgId=? AND id=?",
  )
    .bind(f.orgId, f.showId)
    .first<{ updatedAt: string | number }>();
  const expectedUpdatedAt = new Date(row!.updatedAt).toISOString();
  const response = await handleMobileApi(
    new Request(
      `https://app.showpilot.tech/api/mobile/v1/schedule/shows/command?orgId=${f.orgId}`,
      {
        method: "POST",
        headers: {
          Cookie: f.headers.get("Cookie") ?? "",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          orgId: f.orgId,
          userId: f.userId,
          requestId,
          kind: "delete",
          showId: f.showId,
          expectedUpdatedAt,
        }),
      },
    ),
    { DB: env.DB },
  );
  expect(response?.status).toBe(200);
  expect(await response?.json()).toMatchObject({
    orgId: f.orgId,
    userId: f.userId,
    requestId,
    kind: "delete",
    result: { ok: false, message: "Stop the show before deleting it" },
  });
});

it("an expired account cannot classify an already accepted deletion as rejected", async () => {
  const f = await fixture();
  await expect(
    f.remove({
      prepare: showDeletionRelays.prepare,
      purge: async () => {
        throw new Error("Lost cleanup response");
      },
    }),
  ).rejects.toThrow("Lost cleanup response");
  expect(await f.operation()).toMatchObject({ stage: "purging" });
  const { ShowDeletionRejectedError } =
    await import("../show-deletion-contract");
  const result = await deleteServiceForOrg(
    { orgId: f.orgId, showId: f.showId, userId: f.userId },
    new Headers(),
  ).catch((error) => error);
  expect(result).toBeInstanceOf(Error);
  expect(result).not.toBeInstanceOf(ShowDeletionRejectedError);
  expect(await f.operation()).toMatchObject({ stage: "purging" });
  await expect(f.remove()).resolves.toEqual({ ok: true });
});

async function nativeDeletion(f: Awaited<ReturnType<typeof fixture>>) {
  const row = await env.DB.prepare(
    "SELECT updatedAt FROM rundown WHERE orgId=? AND id=?",
  )
    .bind(f.orgId, f.showId)
    .first<{ updatedAt: string | number }>();
  const command = {
    orgId: f.orgId,
    userId: f.userId,
    showId: f.showId,
    requestId: crypto.randomUUID(),
    kind: "delete",
    expectedUpdatedAt: new Date(row!.updatedAt).toISOString(),
  };
  const { handleMobileApi } = await import("../mobile-api.server");
  const send = async (body = command, review = false) => {
    const response = await handleMobileApi(
      new Request(
        `https://app.showpilot.tech/api/mobile/v1/schedule/shows/${review ? "review" : "command"}?orgId=${f.orgId}`,
        {
          method: "POST",
          headers: {
            Cookie: f.headers.get("Cookie") ?? "",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        },
      ),
      env,
    );
    if (!response) throw new Error("Missing native delete route");
    return response;
  };
  return { command, send };
}
it("native deletion resumes accepted cleanup after a lost response and exact retry remains successful", async () => {
  const f = await fixture(),
    native = await nativeDeletion(f);
  vi.spyOn(showDeletionRelays, "purge").mockRejectedValueOnce(
    new Error("Cleanup reply lost"),
  );
  await expect(native.send()).rejects.toThrow("Cleanup reply lost");
  expect(await f.operation()).toMatchObject({ stage: "purging" });
  const { showManagementReplySchema } =
    await import("../../../../mobile/src/lib/show-management-recovery");
  const result = showManagementReplySchema.parse(
    await (await native.send()).json(),
  );
  expect(result).toMatchObject({
    kind: "delete",
    requestId: native.command.requestId,
    result: { ok: true },
  });
  expect(await (await native.send()).json()).toEqual(result);
  expect(await f.row()).toBeNull();
  expect(await f.operation()).toMatchObject({ stage: "deleted" });
});
it("native stale or review-only deletion cannot purge a show", async () => {
  const f = await fixture(),
    native = await nativeDeletion(f);
  const stale = await native.send({
    ...native.command,
    expectedUpdatedAt: "2020-01-01T00:00:00Z",
  });
  expect(await stale.json()).toMatchObject({
    result: {
      ok: false,
      message: "This show changed. Refresh and confirm deletion again.",
    },
  });
  expect((await native.send(native.command, true)).status).toBe(400);
  expect(await f.operation()).toBeNull();
  expect(await f.row()).not.toBeNull();
});
it("native deletion cannot use another actor or workspace and exposes no deleted-show snapshot", async () => {
  const f = await fixture(),
    native = await nativeDeletion(f);
  expect(
    (await native.send({ ...native.command, userId: "other-account" })).status,
  ).toBe(403);
  expect(
    (await native.send({ ...native.command, orgId: "other-org" })).status,
  ).toBe(403);
  expect(await f.operation()).toBeNull();
  await (await native.send()).arrayBuffer();
  const { handleMobileApi } = await import("../mobile-api.server");
  const response = await handleMobileApi(
    new Request(
      `https://app.showpilot.tech/api/mobile/v1/schedule/shows/${f.showId}?orgId=${f.orgId}&userId=${f.userId}`,
      { headers: f.headers },
    ),
    env,
  );
  expect(await response?.json()).toMatchObject({
    orgId: f.orgId,
    userId: f.userId,
    showId: f.showId,
    snapshot: null,
  });
});
