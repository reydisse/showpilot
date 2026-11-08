import { env } from "cloudflare:workers";
import {
  abortAllDurableObjects,
  evictDurableObject,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import { seedRelayMember, withRelayMember } from "@/test/relay-fixtures";
import { rundownInternalRequest } from "../rundown-internal-request.server";
import { replacementCommandSchema } from "../rundown-replacement-contract";
import {
  replacementReadSchema,
  replacementReplySchema,
} from "../../../../mobile/src/lib/rundown-replacement-recovery";
import { writeRundownReplacement } from "../rundown-replacement-write.server";
afterEach(async () => {
  await abortAllDurableObjects();
});
const item = {
  id: "source-item",
  title: "Reviewed item",
  type: "segment",
  duration: 10000,
  notes: "Reviewed note",
  assignee: "Host",
  cue: "GO",
  status: "upcoming",
  sortOrder: 0,
  hardStop: false,
};
async function fixture() {
  const actor = await seedRelayMember(crypto.randomUUID()),
    showId = crypto.randomUUID(),
    sourceId = crypto.randomUUID(),
    serviceDate = "2026-11-08";
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO rundown(id,orgId,serviceDate,name,location,updatedAt) VALUES(?,?,?,'Target','Room','2026-01-01T00:00:00.000Z')",
    ).bind(showId, actor.orgId, serviceDate),
    env.DB.prepare(
      "INSERT INTO app_setting(id,orgId,key,value) VALUES(?,?,?,?)",
    ).bind(
      crypto.randomUUID(),
      actor.orgId,
      `rundown-saved:${sourceId}`,
      JSON.stringify({
        id: sourceId,
        name: "Reviewed template",
          createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
        serviceName: "Copied title",
        scheduledStartTime: "09:00",
        items: [item],
      }),
    ),
  ]);
  const relay = env.RUNDOWN_RELAY.getByName(`${actor.orgId}:show:${showId}`),
    scope = {
      orgId: actor.orgId,
      userId: actor.userId,
      showId,
      source: { kind: "template" as const, id: sourceId },
    };
  const call = (body: unknown) =>
    relay.fetch(
      new Request(
        `https://rundown.test/internal/rundown-replacement?orgId=${actor.orgId}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-showpilot-internal-secret": env.BETTER_AUTH_SECRET,
          },
          body: JSON.stringify(body),
        },
      ),
    );
  const read = async () => {
    const response = await call({
      mode: "read",
      scope,
      sessionId: actor.sessionId,
      pin: null,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    return replacementReadSchema.parse(await response.json());
  };
  const base = await read();
  const command = replacementCommandSchema.parse({
    orgId: actor.orgId,
    userId: actor.userId,
    showId,
    source: scope.source,
    serviceDate,
    expectedRevision: base.expectedRevision,
    expectedUpdatedAt: base.expectedUpdatedAt,
    copy: base.copy,
    requestId: crypto.randomUUID(),
  });
  const save = async (input = command, mode: "save" | "review" = "save") => {
    const response = await call({
      mode,
      command: input,
      sessionId: actor.sessionId,
      pin: null,
    });
    expect(response.status).toBe(200);
    return replacementReplySchema.parse(await response.json());
  };
  const state = async () => {
    const url = await withRelayMember(
      `https://rundown.test/state?orgId=${actor.orgId}&showId=${showId}&serviceDate=${serviceDate}&access=edit`,
    );
    return (await relay.fetch(url)).json<{
      revision: number;
      items: Array<typeof item>;
      serviceName: string;
      timer: { playback: string };
    }>();
  };
  const raw = async (action: string, payload: unknown) => {
    const response = await relay.fetch(
      rundownInternalRequest(
        `https://rundown.test/command?orgId=${actor.orgId}&showId=${showId}&serviceDate=${serviceDate}&access=edit`,
        env.BETTER_AUTH_SECRET,
        { method: "POST", body: JSON.stringify({ action, payload }) },
      ),
    );
    expect(response.status).toBe(200);
    await response.arrayBuffer();
  };
  return {
    ...actor,
    showId,
    sourceId,
    serviceDate,
    relay,
    scope,
    base,
    command,
    call,
    read,
    save,
    state,
    raw,
    row: () =>
      env.DB.prepare("SELECT name,status FROM rundown WHERE orgId=? AND id=?")
        .bind(actor.orgId, showId)
        .first(),
    receipts: () =>
      env.DB.prepare("SELECT * FROM rundown_replacement_request WHERE orgId=?")
        .bind(actor.orgId)
        .all(),
  };
}
it("applies the reviewed copy, stops the timer, resets timing and retries without replacing later edits", async () => {
  const f = await fixture();
  await env.DB.prepare("UPDATE app_setting SET value=? WHERE orgId=? AND key=?")
    .bind(
      JSON.stringify({
        id: f.sourceId,
        name: "New template",
        serviceName: "New title",
        scheduledStartTime: "10:00",
        items: [],
      }),
      f.orgId,
      `rundown-saved:${f.sourceId}`,
    )
    .run();
  const applied = await f.save();
  expect(applied.outcome).toBe("applied");
  expect(await f.row()).toEqual({ name: "Copied title", status: "stopped" });
  const state = await f.state();
  expect(state.items).toHaveLength(1);
  expect(state.items[0]).toMatchObject({
    ...item,
    id: `${f.command.requestId}-item-0`,
    actualStart: null,
    actualEnd: null,
  });
  expect(await f.save()).toEqual(applied);
  await f.raw("update-item", {
    id: state.items[0].id,
    updates: { title: "Later edit" },
  });
  expect((await f.save()).outcome).toBe("superseded");
  expect((await f.state()).items[0].title).toBe("Later edit");
});
it("review fences an undelivered replacement and an exact late request", async () => {
  const f = await fixture();
  expect((await f.save(f.command, "review")).outcome).toBe("cancelled");
  expect((await f.save()).outcome).toBe("cancelled");
  expect(await f.row()).toMatchObject({ name: "Target" });
  expect((await f.state()).items).toEqual([]);
});
it("changed content under an existing ID cannot be acknowledged", async () => {
  const f = await fixture();
  await f.save();
  const response = await f.call({
    mode: "save",
    command: {
      ...f.command,
      copy: { ...f.command.copy, serviceName: "Changed" },
    },
    sessionId: f.sessionId,
    pin: null,
  });
  expect(response.status).toBe(503);
  expect(await response.text()).toContain("different reviewed copy");
  expect(await f.row()).toMatchObject({ name: "Copied title" });
});
it("a changed target revision conflicts durably instead of accepting a fresh revision on retry", async () => {
  const f = await fixture();
  await f.raw("stage-message", { message: "Changed" });
  expect((await f.save()).outcome).toBe("conflict");
  expect((await f.save(f.command, "review")).outcome).toBe("conflict");
  expect(await f.row()).toMatchObject({ name: "Target" });
});
it("metadata changed outside the relay conflicts without replacing items", async () => {
  const f = await fixture();
  await env.DB.prepare(
    "UPDATE rundown SET name='Other',updatedAt='2026-11-08T10:00:00.000Z' WHERE id=?",
  )
    .bind(f.showId)
    .run();
  expect((await f.save()).outcome).toBe("conflict");
  expect(await f.row()).toMatchObject({ name: "Other" });
});
it("concurrent save and review agree on one durable outcome", async () => {
  const f = await fixture();
  const results = await Promise.all([f.save(), f.save(f.command, "review")]);
  expect(results[0]).toEqual(results[1]);
  expect((await f.receipts()).results).toHaveLength(1);
});
it.each(["session", "role", "deleting"])(
  "checks %s at the atomic commit",
  async (change) => {
    const f = await fixture();
    await expect(
      writeRundownReplacement(
        env.DB,
        f.command,
        { sessionId: f.sessionId, pin: null },
        "save",
        { revision: 0, stopped: true },
        async () => {
          if (change === "session")
            await env.DB.prepare("DELETE FROM session WHERE id=?")
              .bind(f.sessionId)
              .run();
          if (change === "role")
            await env.DB.prepare(
              "UPDATE member SET role='member' WHERE organizationId=?",
            )
              .bind(f.orgId)
              .run();
          if (change === "deleting")
            await env.DB.prepare(
              "INSERT INTO app_setting(id,orgId,key,value) VALUES(?,?,'organization-deleting','true')",
            )
              .bind(crypto.randomUUID(), f.orgId)
              .run();
        },
      ),
    ).rejects.toThrow("permission");
    expect((await f.receipts()).results).toEqual([]);
    expect(await f.row()).toMatchObject({ name: "Target" });
  },
);
it("rolls back receipt, rows, timer and metadata together on storage failure", async () => {
  const f = await fixture();
  await env.DB.exec(
    "CREATE TRIGGER fail_replacement BEFORE INSERT ON rundown_item BEGIN SELECT RAISE(ABORT,'fixture replacement failure'); END",
  );
  try {
    const response = await f.call({
      mode: "save",
      command: f.command,
      sessionId: f.sessionId,
      pin: null,
    });
    expect(response.status).toBe(503);
    await response.arrayBuffer();
    expect((await f.receipts()).results).toEqual([]);
    expect(await f.row()).toMatchObject({ name: "Target" });
  } finally {
    await env.DB.exec("DROP TRIGGER fail_replacement");
  }
  expect((await f.save()).outcome).toBe("applied");
});
it("recovers committed rows after eviction between D1 commit and DO persistence", async () => {
  const f = await fixture();
  await writeRundownReplacement(
    env.DB,
    f.command,
    { sessionId: f.sessionId, pin: null },
    "save",
    { revision: 0, stopped: true },
    async () => {
      await runInDurableObject(f.relay, async (_instance, ctx) => {
        await ctx.storage.put("pending-rundown-replacement", {
          orgId: f.orgId,
          showId: f.showId,
          actorId: f.userId,
          requestId: f.command.requestId,
        });
      });
    },
  );
  await evictDurableObject(f.relay);
  expect((await f.state()).serviceName).toBe("Copied title");
  expect((await f.state()).items[0].title).toBe("Reviewed item");
  expect((await f.save()).outcome).toBe("applied");
});
it("rejects a replacement when the show is not stopped", async () => {
  const f = await fixture();
  expect(
    (
      await writeRundownReplacement(
        env.DB,
        f.command,
        { sessionId: f.sessionId, pin: null },
        "save",
        { revision: 0, stopped: false },
        async () => {},
      )
    ).outcome,
  ).toBe("conflict");
  expect(await f.row()).toMatchObject({ name: "Target" });
});
it("loads a previous show's metadata and reset items together", async () => {
  const f = await fixture();
  const prior = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO rundown(id,orgId,serviceDate,name,location,scheduledStartTime) VALUES(?,?,'2026-11-01','Previous','Old venue','2026-11-01T09:00:00.000Z')",
    ).bind(prior, f.orgId),
    env.DB.prepare(
      "INSERT INTO rundown_item(id,orgId,showId,serviceDate,itemId,title,type,duration,notes,assignee,cue,status,sortOrder,hardStop) VALUES(?,?,?,'2026-11-01','old-item','Old item','segment',1000,'','','','live',0,0)",
    ).bind(crypto.randomUUID(), f.orgId, prior),
  ]);
  const response = await f.call({
    mode: "read",
    scope: { ...f.scope, source: { kind: "show", id: prior } },
    sessionId: f.sessionId,
    pin: null,
  });
  expect(response.status).toBe(200);
  const read = replacementReadSchema.parse(await response.json());
  expect(read.copy).toMatchObject({
    serviceName: "Previous",
    location: "Old venue",
    scheduledStartTime: "2026-11-08T09:00:00.000Z",
    items: [{ title: "Old item", status: "upcoming" }],
  });
});
it("review reports a removed target without recreating its rows", async () => {
  const f = await fixture();
  await f.save();
  await env.DB.prepare("DELETE FROM rundown WHERE orgId=? AND id=?")
    .bind(f.orgId, f.showId)
    .run();
  expect((await f.save(f.command, "review")).outcome).toBe("removed");
  expect(await f.row()).toBeNull();
});
it("uses current PIN authority and rejects a rotation at commit", async () => {
  const f = await fixture();
  const stored =
    "pbkdf2-sha256:210000:MDEyMzQ1Njc4OWFiY2RlZg:dn1Cq81hnTfBlkh2maxSEZ3GzIkOQC9w2mVohTIJ_uo";
  await env.DB.batch([
    env.DB.prepare("UPDATE member SET role='tm' WHERE organizationId=?").bind(
      f.orgId,
    ),
    env.DB.prepare(
      "INSERT INTO app_setting(id,orgId,key,value) VALUES(?,?,'rundown-pin',?)",
    ).bind(crypto.randomUUID(), f.orgId, stored),
  ]);
  await expect(
    writeRundownReplacement(
      env.DB,
      f.command,
      { sessionId: f.sessionId, pin: "2468" },
      "save",
      { revision: 0, stopped: true },
      async () => {
        await env.DB.prepare(
          "UPDATE app_setting SET value='rotated' WHERE orgId=? AND key='rundown-pin'",
        )
          .bind(f.orgId)
          .run();
      },
    ),
  ).rejects.toThrow("permission");
  expect((await f.receipts()).results).toEqual([]);
}, 30000);
it("an org-scoped source cannot read a template from another organization", async () => {
  const f = await fixture(),
    other = await fixture();
  const response = await f.call({
    mode: "read",
    scope: { ...f.scope, source: { kind: "template", id: other.sourceId } },
    sessionId: f.sessionId,
    pin: null,
  });
  expect(response.status).toBe(503);
  expect(await response.text()).toContain("removed");
});
it("replaces 500 items without a single large database value or parameter cliff", async () => {
  const f = await fixture(),
    copy = {
      ...f.command.copy,
      items: Array.from({ length: 500 }, (_, index) => ({
        ...item,
        id: `source-${index}`,
        sortOrder: index,
        notes: "n".repeat(4000),
      })),
    };
  expect((await f.save(replacementCommandSchema.parse({ ...f.command, copy }))).outcome).toBe("applied");
  const state = await f.state();
  expect(state.items).toHaveLength(500);
  expect(state.items[499].title).toBe("Reviewed item");
});
it("accepts a Prisma millisecond metadata version and advances it monotonically",async()=>{
  const f=await fixture(),version=Date.parse(f.command.expectedUpdatedAt);
  await env.DB.prepare("UPDATE rundown SET updatedAt=? WHERE orgId=? AND id=?").bind(version,f.orgId,f.showId).run();
  expect((await f.read()).expectedUpdatedAt).toBe(f.command.expectedUpdatedAt);
  expect((await f.save()).outcome).toBe("applied");
  expect(Date.parse((await f.read()).expectedUpdatedAt)).toBeGreaterThan(version);
});
