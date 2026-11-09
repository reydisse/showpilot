import { env } from "cloudflare:workers";
import {
  abortAllDurableObjects,
  evictDurableObject,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import { seedRelayMember } from "@/test/relay-fixtures";
import { getPrisma } from "../db";
import { applyMobileRundownChange } from "../mobile-rundown-change.server";
import type { RundownChangeCommand } from "../../../../mobile/src/lib/rundown-change-recovery";
import { RUNDOWN_PIN_SETTING_KEY } from "../rundown-pin.server";
afterEach(() => abortAllDurableObjects());
async function fixture() {
  const actor = {
    ...(await seedRelayMember(crypto.randomUUID())),
    pin: null as string | null,
  };
  const showId = crypto.randomUUID(),
    serviceDate = "2026-11-08";
  await getPrisma().rundown.create({
    data: {
      id: showId,
      orgId: actor.orgId,
      serviceDate,
      name: "Native removal show",
    },
  });
  const stub = env.RUNDOWN_RELAY.getByName(`${actor.orgId}:show:${showId}`);
  const query = new URLSearchParams({
    orgId: actor.orgId,
    showId,
    serviceDate,
    access: "edit",
    authUserId: actor.userId,
    authSessionId: actor.sessionId,
  });
  const state = async () =>
    (await stub.fetch(`https://rundown.test/state?${query}`)).json<{
      revision: number;
      items: Array<{
        id: string;
        title: string;
        status: string;
        actualStart: string | null;
        actualEnd: string | null;
      }>;
      timer: {
        playback: string;
        currentItemId: string | null;
        elapsed: number;
      };
    }>();
  async function command(action: string, payload: unknown = {}) {
    const commandQuery = new URLSearchParams(query);
    if (action.startsWith("timer-")) commandQuery.set("access", "control");
    const response = await stub.fetch(
      `https://rundown.test/command?${commandQuery}`,
      {
        method: "POST",
        body: JSON.stringify({ id: crypto.randomUUID(), action, payload }),
      },
    );
    expect(response.status).toBe(200);
    await response.text();
  }
  for (const id of ["welcome", "next"])
    await command("add-item", {
      id,
      title: id,
      type: "segment",
      duration: 10000,
      notes: "",
      assignee: "",
      cue: "",
      status: "upcoming",
      sortOrder: id === "welcome" ? 0 : 1,
      hardStop: false,
    });
  const scope = {
    orgId: actor.orgId,
    userId: actor.userId,
    showId,
    serviceDate,
  };
  const removal = async (): Promise<RundownChangeCommand> => ({
    ...scope,
    requestId: crypto.randomUUID(),
    expectedRevision: (await state()).revision,
    action: "remove-item",
    itemId: "welcome",
  });
  return {
    actor,
    stub,
    state,
    command,
    scope,
    removal,
    send: (request: RundownChangeCommand) =>
      applyMobileRundownChange(env, request, actor),
  };
}
it("removes the active item and stops its timer atomically; undo restores without restarting", async () => {
  const f = await fixture();
  await f.command("timer-start", { itemId: "welcome" });
  const request = await f.removal();
  expect(await f.send(request)).toMatchObject({
    outcome: "applied",
    requestId: request.requestId,
  });
  const removed = await f.state();
  expect(removed.items.map((i) => i.id)).toEqual(["next"]);
  expect(removed.timer).toMatchObject({
    playback: "stop",
    currentItemId: null,
  });
  expect(
    await f.send({
      ...request,
      requestId: crypto.randomUUID(),
      action: "restore-item",
      itemId: "welcome",
      expectedRevision: removed.revision,
    }),
  ).toMatchObject({ outcome: "applied" });
  const restored = await f.state();
  expect(restored.items.map((i) => i.id)).toEqual(["welcome", "next"]);
  expect(restored.items[0].status).toBe("complete");
  expect(restored.timer.playback).toBe("stop");
});
it("rejects a stale removal after the active item advances and does not stop the new timer", async () => {
  const f = await fixture();
  await f.command("timer-start", { itemId: "welcome" });
  const request = await f.removal();
  await f.command("timer-start", { itemId: "next" });
  expect(await f.send(request)).toMatchObject({ outcome: "conflict" });
  const state = await f.state();
  expect(state.items).toHaveLength(2);
  expect(state.timer).toMatchObject({
    playback: "play",
    currentItemId: "next",
  });
  expect(
    await f.send({
      ...request,
      requestId: crypto.randomUUID(),
      expectedRevision: state.revision,
    }),
  ).toMatchObject({ outcome: "applied" });
  expect((await f.state()).timer).toMatchObject({
    playback: "play",
    currentItemId: "next",
  });
});
it("an exact retry after eviction does not remove an item another operator restored", async () => {
  const f = await fixture(),
    request = await f.removal();
  await f.send(request);
  await f.command("restore-item", { id: "welcome" });
  const before = await f.state();
  await evictDurableObject(f.stub);
  expect(await f.send(request)).toMatchObject({ outcome: "applied" });
  const after = await f.state();
  expect(after.revision).toBe(before.revision);
  expect(after.items).toEqual(before.items);
});
it("a retry older than the deduplication history still cannot act on a newer revision", async () => {
  const f = await fixture(),
    request = await f.removal();
  await f.send(request);
  await f.command("restore-item", { id: "welcome" });
  for (let i = 0; i < 101; i++)
    await f.command("stage-message", { message: `Message ${i}` });
  expect(await f.send(request)).toMatchObject({ outcome: "conflict" });
  expect((await f.state()).items).toHaveLength(2);
});
it("clear-all is revision checked and clears items and active timer together", async () => {
  const f = await fixture();
  await f.command("timer-start", { itemId: "welcome" });
  const revision = (await f.state()).revision;
  const request: RundownChangeCommand = {
    ...f.scope,
    requestId: crypto.randomUUID(),
    expectedRevision: revision - 1,
    action: "clear-all",
  };
  expect(await f.send(request)).toMatchObject({ outcome: "conflict" });
  expect((await f.state()).items).toHaveLength(2);
  expect(
    await f.send({
      ...request,
      requestId: crypto.randomUUID(),
      expectedRevision: revision,
    }),
  ).toMatchObject({ outcome: "applied" });
  expect(await f.state()).toMatchObject({
    items: [],
    timer: { playback: "stop", currentItemId: null },
  });
});
it("enforces the server undo expiry after eviction", async () => {
  const f = await fixture(),
    request = await f.removal();
  await f.send(request);
  await runInDurableObject(f.stub, async (_instance, ctx) => {
    const saved = await ctx.storage.get<{
      removedItems: Array<{ expiresAt: number }>;
    }>("state");
    if (!saved) throw new Error("Missing relay state");
    saved.removedItems.forEach((item) => (item.expiresAt = 0));
    await ctx.storage.put("state", saved);
  });
  await evictDurableObject(f.stub);
  expect(
    await f.send({
      ...request,
      requestId: crypto.randomUUID(),
      action: "restore-item",
      itemId: "welcome",
      expectedRevision: (await f.state()).revision,
    }),
  ).toMatchObject({ outcome: "unavailable" });
  expect((await f.state()).items.map((i) => i.id)).toEqual(["next"]);
});
it.each(["session", "membership"])(
  "rechecks current %s authority before accepting removal",
  async (kind) => {
    const f = await fixture(),
      request = await f.removal();
    if (kind === "session")
      await env.DB.prepare("DELETE FROM session WHERE id=?")
        .bind(f.actor.sessionId)
        .run();
    else
      await env.DB.prepare(
        "DELETE FROM member WHERE organizationId=? AND userId=?",
      )
        .bind(f.actor.orgId, f.actor.userId)
        .run();
    await expect(f.send(request)).rejects.toThrow(/access changed/);
  },
);
it("forwards only the current actor PIN and still requires the relay to verify it", async () => {
  const f = await fixture(),
    request = await f.removal();
  await env.DB.prepare(
    "UPDATE member SET role='tm' WHERE organizationId=? AND userId=?",
  )
    .bind(f.actor.orgId, f.actor.userId)
    .run();
  await env.DB.prepare(
    "INSERT INTO app_setting (id,orgId,key,value) VALUES (?,?,?,?)",
  )
    .bind(
      crypto.randomUUID(),
      f.actor.orgId,
      RUNDOWN_PIN_SETTING_KEY,
      "pbkdf2-sha256:210000:MDEyMzQ1Njc4OWFiY2RlZg:dn1Cq81hnTfBlkh2maxSEZ3GzIkOQC9w2mVohTIJ_uo",
    )
    .run();
  await expect(f.send(request)).rejects.toThrow(/access changed/);
  f.actor.pin = "2468";
  expect(await f.send(request)).toMatchObject({ outcome: "applied" });
}, 30000);
it("does not cross actor, organization or show-date boundaries", async () => {
  const f = await fixture(),
    request = await f.removal();
  await expect(f.send({ ...request, userId: "other" })).rejects.toThrow(
    /account changed/,
  );
  expect(await f.send({ ...request, orgId: "other" })).toMatchObject({
    outcome: "unavailable",
  });
  expect(await f.send({ ...request, serviceDate: "2026-11-09" })).toMatchObject(
    { outcome: "conflict" },
  );
  expect((await f.state()).items).toHaveLength(2);
});

it("reset clears actual timing without deleting items or changing the show", async () => {
  const f = await fixture();
  await f.command("timer-start", { itemId: "welcome" });
  await f.command("timer-next");
  await f.command("timer-pause");
  const before = await f.state();
  expect(before.items[0].actualStart).toBeTruthy();
  expect(before.items[0].actualEnd).toBeTruthy();
  const request: RundownChangeCommand = {
    ...f.scope,
    requestId: crypto.randomUUID(),
    expectedRevision: before.revision,
    action: "reset",
  };
  expect(await f.send(request)).toMatchObject({ outcome: "applied" });
  const after = await f.state();
  expect(after.items.map(({ id, title }) => ({ id, title }))).toEqual(
    before.items.map(({ id, title }) => ({ id, title })),
  );
  expect(
    after.items.every(
      (item) =>
        item.status === "upcoming" &&
        item.actualStart === null &&
        item.actualEnd === null,
    ),
  ).toBe(true);
  expect(after.timer).toMatchObject({
    playback: "stop",
    currentItemId: null,
    elapsed: 0,
  });
  expect(
    await env.DB.prepare("SELECT name FROM rundown WHERE orgId=? AND id=?")
      .bind(f.scope.orgId, f.scope.showId)
      .first(),
  ).toMatchObject({ name: "Native removal show" });
});
it("reset rejects playing state and a stale reviewed revision", async () => {
  const f = await fixture();
  await f.command("timer-start", { itemId: "welcome" });
  const before = await f.state();
  const request: RundownChangeCommand = {
    ...f.scope,
    requestId: crypto.randomUUID(),
    expectedRevision: before.revision,
    action: "reset",
  };
  expect(await f.send(request)).toMatchObject({ outcome: "unavailable" });
  expect((await f.state()).items).toEqual(before.items);
  await f.command("timer-pause");
  expect(
    await f.send({ ...request, requestId: crypto.randomUUID() }),
  ).toMatchObject({ outcome: "conflict" });
  expect((await f.state()).timer.playback).toBe("pause");
});
it("replaying a reset after eviction preserves the timing of a later run", async () => {
  const f = await fixture();
  await f.command("timer-start", { itemId: "welcome" });
  await f.command("timer-pause");
  const request: RundownChangeCommand = {
    ...f.scope,
    requestId: crypto.randomUUID(),
    expectedRevision: (await f.state()).revision,
    action: "reset",
  };
  await f.send(request);
  await f.command("timer-start", { itemId: "next" });
  await f.command("timer-pause");
  const later = await f.state();
  await evictDurableObject(f.stub);
  expect(await f.send(request)).toMatchObject({ outcome: "applied" });
  const replayed = await f.state();
  expect(replayed.items).toEqual(later.items);
  expect(replayed.timer).toMatchObject({
    playback: "pause",
    currentItemId: "next",
  });
  expect(replayed.revision).toBe(later.revision);
});
it("reset preserves production-manager control access without granting item editing", async () => {
  const f = await fixture();
  await env.DB.prepare(
    "UPDATE member SET role='pm' WHERE organizationId=? AND userId=?",
  )
    .bind(f.scope.orgId, f.scope.userId)
    .run();
  const request: RundownChangeCommand = {
    ...f.scope,
    requestId: crypto.randomUUID(),
    expectedRevision: (await f.state()).revision,
    action: "reset",
  };
  expect(await f.send(request)).toMatchObject({ outcome: "applied" });
  await expect(f.send(await f.removal())).rejects.toThrow(/access changed/);
});

const editFields = {
  title: "Edited welcome",
  type: "segment" as const,
  duration: 30000,
  notes: "Operator notes",
  assignee: "Host",
  cue: "Stand by",
  hardStop: true,
};
it("a native add retry after eviction adds exactly one item", async () => {
  const f = await fixture();
  const request: RundownChangeCommand = {
    ...f.scope,
    requestId: crypto.randomUUID(),
    expectedRevision: (await f.state()).revision,
    action: "add-item",
    itemId: "native-new",
    fields: editFields,
  };
  expect(await f.send(request)).toMatchObject({ outcome: "applied" });
  const before = await f.state();
  await evictDurableObject(f.stub);
  expect(await f.send(request)).toMatchObject({ outcome: "applied" });
  expect((await f.state()).revision).toBe(before.revision);
  expect(
    (await f.state()).items.filter((i) => i.id === "native-new"),
  ).toHaveLength(1);
});
it("native edit replay preserves a later operator edit and stale new edits conflict", async () => {
  const f = await fixture();
  const request: RundownChangeCommand = {
    ...f.scope,
    requestId: crypto.randomUUID(),
    expectedRevision: (await f.state()).revision,
    action: "update-item",
    itemId: "welcome",
    fields: editFields,
  };
  await f.send(request);
  await f.command("update-item", {
    id: "welcome",
    updates: { title: "Other operator" },
  });
  const before = await f.state();
  await evictDurableObject(f.stub);
  expect(await f.send(request)).toMatchObject({ outcome: "applied" });
  expect(
    await f.send({ ...request, requestId: crypto.randomUUID() }),
  ).toMatchObject({ outcome: "conflict" });
  expect((await f.state()).items).toEqual(before.items);
});
it("native reorder retry preserves a later order and never changes item content", async () => {
  const f = await fixture();
  const before = await f.state();
  const request: RundownChangeCommand = {
    ...f.scope,
    requestId: crypto.randomUUID(),
    expectedRevision: before.revision,
    action: "reorder",
    order: ["next", "welcome"],
  };
  expect(await f.send(request)).toMatchObject({ outcome: "applied" });
  expect((await f.state()).items.map((i) => i.id)).toEqual(request.order);
  await f.command("reorder", { order: ["welcome", "next"] });
  await evictDurableObject(f.stub);
  expect(await f.send(request)).toMatchObject({ outcome: "applied" });
  expect((await f.state()).items).toEqual(before.items);
});
it("native editing rejects forged operational fields and changed actor before mutation", async () => {
  const f = await fixture();
  const before = await f.state();
  const request: RundownChangeCommand = {
    ...f.scope,
    requestId: crypto.randomUUID(),
    expectedRevision: before.revision,
    action: "update-item",
    itemId: "welcome",
    fields: editFields,
  };
  await expect(
    f.send({ ...request, fields: { ...editFields, ...{ status: "live" } } }),
  ).rejects.toThrow();
  await expect(f.send({ ...request, userId: "other" })).rejects.toThrow(
    /account changed/,
  );
  expect((await f.state()).items).toEqual(before.items);
});
