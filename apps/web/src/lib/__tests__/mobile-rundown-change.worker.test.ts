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
      items: Array<{ id: string; status: string }>;
      timer: { playback: string; currentItemId: string | null };
    }>();
  async function command(action: string, payload: unknown = {}) {
    const commandQuery = new URLSearchParams(query);
    if (action.startsWith("timer-")) commandQuery.set("access", "control");
    const response = await stub.fetch(`https://rundown.test/command?${commandQuery}`, {
      method: "POST",
      body: JSON.stringify({ id: crypto.randomUUID(), action, payload }),
    });
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
