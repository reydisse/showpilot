import { env } from "cloudflare:workers";
import { beforeEach, expect, it, vi } from "vitest";
import { seedRelayMember } from "@/test/relay-fixtures";
import {
  defaultTmLayout,
  type TmManagementCommand,
} from "../tm-management-contract";
const auth = vi.hoisted(() => ({ userId: "", sessionId: "" }));
const notify = vi.hoisted(() => vi.fn(async () => ({ notified: 1 })));
vi.mock("../auth", () => ({
  getAuth: () => ({
    api: {
      getSession: async () => ({
        user: { id: auth.userId, name: "Operator" },
        session: { id: auth.sessionId },
      }),
    },
  }),
}));
vi.mock("../operational-notifications.server", () => ({
  notifyOperationalEvent: notify,
}));
import {
  readTmManagement,
  retryTmManagementNotifications,
  writeTmManagement,
} from "../tm-management.server";
const headers = new Headers();
beforeEach(() => {
  notify.mockReset().mockResolvedValue({ notified: 1 });
});
async function fixture() {
  const actor = await seedRelayMember(`tm-${crypto.randomUUID()}`);
  const other = await seedRelayMember(actor.orgId, crypto.randomUUID());
  Object.assign(auth, actor);
  const id = crypto.randomUUID(),
    scope = { orgId: actor.orgId, userId: actor.userId };
  const insert = () =>
    env.DB.prepare(
      "INSERT INTO incident(id,orgId,category,severity,description,reportedBy,serviceDate) VALUES(?,?,'audio','high','Carried forward','Reporter','2000-01-01')",
    )
      .bind(id, actor.orgId)
      .run();
  await insert();
  const incident = () =>
    env.DB.prepare(
      "SELECT i.status,i.assignedTo,i.acknowledgedAt,r.revision FROM incident i JOIN incident_management_revision r ON r.orgId=i.orgId AND r.incidentId=i.id WHERE i.orgId=? AND i.id=?",
    )
      .bind(actor.orgId, id)
      .first<{
        status: string;
        assignedTo: string | null;
        acknowledgedAt: string | null;
        revision: number;
      }>();
  const command = (
    operation: TmManagementCommand["operation"],
  ): TmManagementCommand => ({
    ...scope,
    requestId: crypto.randomUUID(),
    expiresAt: Date.now() + 25_000,
    operation,
  });
  const claim = async () =>
    command({
      kind: "assign",
      id,
      expectedRevision: (await incident())!.revision,
      assignedTo: actor.userId,
    });
  const read = () => readTmManagement(headers, scope, env.DB);
  const layout = async () =>
    command({
      kind: "layout",
      expectedRevision: (await read()).layoutRevision,
      layout: {
        ...defaultTmLayout(),
        sections: ["workspace", "operations", "overview", "signal-path"],
      },
    });
  const send = (
    value: TmManagementCommand,
    mode: "write" | "review" = "write",
  ) => writeTmManagement(headers, value, mode, env.DB);
  return {
    ...actor,
    other,
    scope,
    id,
    insert,
    incident,
    command,
    claim,
    layout,
    read,
    send,
  };
}
it("retries a date-only incident receipt without overwriting a newer assignment", async () => {
  const f = await fixture(),
    claim = await f.claim();
  expect(await f.send(claim)).toMatchObject({
    outcome: "applied",
    notification: "delivered",
  });
  expect(await f.incident()).toMatchObject({
    revision: 2,
    assignedTo: f.userId,
  });
  await env.DB.prepare(
    "UPDATE incident SET assignedTo=?,acknowledgedAt=NULL WHERE orgId=? AND id=?",
  )
    .bind(f.other.userId, f.orgId, f.id)
    .run();
  expect((await f.send(claim)).outcome).toBe("applied");
  expect(await f.incident()).toMatchObject({
    revision: 3,
    assignedTo: f.other.userId,
    acknowledgedAt: null,
  });
  expect(notify).toHaveBeenCalledTimes(1);
  expect(notify.mock.calls[0]).toEqual([
    expect.objectContaining({
      once: true,
      requireInbox: true,
      dedupeKey: `tm-management:${f.userId}:${claim.requestId}`,
    }),
  ]);
});
it("claims one receipt and applies one revision under concurrent exact retries", async () => {
  const f = await fixture(),
    command = await f.claim();
  expect(
    (await Promise.all([f.send(command), f.send(command)])).map(
      (item) => item.outcome,
    ),
  ).toEqual(["applied", "applied"]);
  expect((await f.incident())?.revision).toBe(2);
  // The notification boundary deduplicates the same event under concurrent delivery.
  expect(
    new Set(notify.mock.calls.map((call) => JSON.stringify(call))),
  ).toHaveProperty("size", 1);
});
it("allows only one incident or layout writer based on the same revision", async () => {
  const f = await fixture(),
    a = await f.claim(),
    b = { ...a, requestId: crypto.randomUUID() };
  expect(
    (await Promise.all([f.send(a), f.send(b)])).map((r) => r.outcome).sort(),
  ).toEqual(["applied", "conflict"]);
  const layout = await f.layout();
  expect(
    (
      await Promise.all([
        f.send(layout),
        f.send({ ...layout, requestId: crypto.randomUUID() }),
      ])
    )
      .map((r) => r.outcome)
      .sort(),
  ).toEqual(["applied", "conflict"]);
});
it("recovers a layout reply while retaining the current arrangement", async () => {
  const f = await fixture(),
    first = await f.layout();
  await f.send(first);
  const second = f.command({
    kind: "layout",
    expectedRevision: 1,
    layout: defaultTmLayout(),
  });
  await f.send(second);
  expect(await f.send(first)).toMatchObject({
    outcome: "applied",
    snapshot: { layout: defaultTmLayout(), layoutRevision: 2 },
  });
});
it.each(["incident", "layout"])(
  "fences %s requests reviewed before arrival and expires delayed requests",
  async (kind) => {
    const f = await fixture(),
      request = kind === "incident" ? await f.claim() : await f.layout();
    expect((await f.send(request, "review")).outcome).toBe("cancelled");
    expect((await f.send(request)).outcome).toBe("cancelled");
    expect(
      (
        await f.send({
          ...request,
          requestId: crypto.randomUUID(),
          expiresAt: Date.now() - 100,
        })
      ).outcome,
    ).toBe("expired");
    await expect(
      f.send({
        ...request,
        requestId: crypto.randomUUID(),
        expiresAt: Date.now() + 60_000,
      }),
    ).rejects.toThrow("Refresh");
    expect((await f.incident())?.revision).toBe(1);
    expect((await f.read()).layoutRevision).toBe(0);
    expect(notify).not.toHaveBeenCalled();
  },
);
it("rejects changed fingerprints and cross-account/workspace commands", async () => {
  const f = await fixture(),
    request = await f.claim();
  await f.send(request);
  await expect(
    f.send({ ...request, expiresAt: request.expiresAt + 1 }),
  ).rejects.toThrow("different dashboard change");
  await expect(f.send({ ...request, userId: f.other.userId })).rejects.toThrow(
    "permission changed",
  );
  await expect(
    f.send({ ...request, orgId: crypto.randomUUID() }),
  ).rejects.toThrow("permission changed");
});
it("keeps saved incident changes separate from failed notification delivery", async () => {
  const f = await fixture(),
    command = await f.claim();
  notify.mockImplementation(async () => {
    throw new Error("Inbox unavailable");
  });
  expect(await f.send(command)).toMatchObject({
    outcome: "applied",
    notification: "pending",
    snapshot: { pendingNotifications: 1 },
  });
  expect((await f.incident())?.revision).toBe(2);
  notify.mockResolvedValue({ notified: 1 });
  expect(
    (await retryTmManagementNotifications(headers, f.scope, env.DB))
      .pendingNotifications,
  ).toBe(0);
  expect((await f.send(command)).notification).toBe("delivered");
  expect(notify).toHaveBeenCalledTimes(2);
  expect((await f.incident())?.revision).toBe(2);
});
it("skips delayed notification work superseded by a newer incident revision", async () => {
  const f = await fixture();
  notify.mockImplementation(async () => {
    throw new Error("Inbox unavailable");
  });
  const command = await f.claim();
  await f.send(command);
  await env.DB.prepare(
    "UPDATE incident SET assignedTo=NULL WHERE orgId=? AND id=?",
  )
    .bind(f.orgId, f.id)
    .run();
  notify.mockClear();
  expect(
    (await retryTmManagementNotifications(headers, f.scope, env.DB))
      .pendingNotifications,
  ).toBe(0);
  expect((await f.send(command)).notification).toBe("skipped");
  expect(notify).not.toHaveBeenCalled();
});
it("uses tombstones for incident and layout deletion/recreation", async () => {
  const f = await fixture(),
    claim = await f.claim();
  await env.DB.prepare("DELETE FROM incident WHERE orgId=? AND id=?")
    .bind(f.orgId, f.id)
    .run();
  await f.insert();
  expect((await f.send(claim)).outcome).toBe("conflict");
  await f.send(await f.layout());
  const stale = await f.layout();
  await env.DB.prepare(
    "DELETE FROM dashboard_layout WHERE orgId=? AND userId=?",
  )
    .bind(f.orgId, f.userId)
    .run();
  await f.send(await f.layout());
  expect((await f.send(stale)).outcome).toBe("conflict");
});
it("acknowledges only the current assignee and does not report missing incidents as saved", async () => {
  const f = await fixture();
  expect(
    (
      await f.send(
        f.command({ kind: "acknowledge", id: f.id, expectedRevision: 1 }),
      )
    ).outcome,
  ).toBe("conflict");
  await f.send(await f.claim());
  expect(
    (
      await f.send(
        f.command({ kind: "acknowledge", id: f.id, expectedRevision: 2 }),
      )
    ).outcome,
  ).toBe("applied");
  expect(
    (
      await f.send(
        f.command({
          kind: "resolve",
          id: crypto.randomUUID(),
          expectedRevision: 1,
        }),
      )
    ).outcome,
  ).toBe("conflict");
  expect(
    (
      await f.send(
        f.command({ kind: "resolve", id: f.id, expectedRevision: 3 }),
      )
    ).outcome,
  ).toBe("applied");
  expect((await f.incident())?.status).toBe("resolved");
});
it("requires administration to assign others and current incident access for the recipient", async () => {
  const f = await fixture();
  await env.DB.prepare(
    "UPDATE member SET role='tm' WHERE organizationId=? AND userId=?",
  )
    .bind(f.orgId, f.userId)
    .run();
  await expect(
    f.send(
      f.command({
        kind: "assign",
        id: f.id,
        expectedRevision: 1,
        assignedTo: f.other.userId,
      }),
    ),
  ).rejects.toThrow("administrator");
  expect((await f.send(await f.claim())).outcome).toBe("applied");
  await env.DB.prepare(
    "UPDATE member SET role='owner' WHERE organizationId=? AND userId=?",
  )
    .bind(f.orgId, f.userId)
    .run();
  await env.DB.prepare(
    "UPDATE member SET role='member' WHERE organizationId=? AND userId=?",
  )
    .bind(f.orgId, f.other.userId)
    .run();
  await expect(
    f.send(
      f.command({
        kind: "assign",
        id: f.id,
        expectedRevision: 2,
        assignedTo: f.other.userId,
      }),
    ),
  ).rejects.toThrow("permission");
});
function atCommit(
  change: () => Promise<unknown>,
): Pick<D1Database, "prepare" | "batch"> {
  return {
    prepare: (sql) => env.DB.prepare(sql),
    batch: async (statements) => {
      await change();
      return env.DB.batch(statements);
    },
  };
}
it.each(["session", "member", "deleting"])(
  "rechecks %s authority atomically before saving",
  async (kind) => {
    const f = await fixture(),
      request = await f.claim();
    const db = atCommit(() =>
      kind === "session"
        ? env.DB.prepare("DELETE FROM session WHERE id=?")
            .bind(f.sessionId)
            .run()
        : kind === "member"
          ? env.DB.prepare(
              "UPDATE member SET role='member' WHERE organizationId=? AND userId=?",
            )
              .bind(f.orgId, f.userId)
              .run()
          : env.DB.prepare(
              "INSERT INTO app_setting(id,orgId,key,value) VALUES(?,?,'organization-deleting','true')",
            )
              .bind(crypto.randomUUID(), f.orgId)
              .run(),
    );
    await expect(
      writeTmManagement(headers, request, "write", db),
    ).rejects.toThrow("permission changed");
    expect((await f.incident())?.revision).toBe(1);
    expect(
      (
        await env.DB.prepare(
          "SELECT * FROM tm_management_request WHERE orgId=?",
        )
          .bind(f.orgId)
          .all()
      ).results,
    ).toEqual([]);
  },
);
it("rechecks the recipient capability at commit", async () => {
  const f = await fixture(),
    request = f.command({
      kind: "assign",
      id: f.id,
      expectedRevision: 1,
      assignedTo: f.other.userId,
    });
  const db = atCommit(() =>
    env.DB.prepare(
      "UPDATE member SET role='member' WHERE organizationId=? AND userId=?",
    )
      .bind(f.orgId, f.other.userId)
      .run(),
  );
  expect((await writeTmManagement(headers, request, "write", db)).outcome).toBe(
    "conflict",
  );
  expect((await f.incident())?.revision).toBe(1);
});
it("rejects guessed future revisions even if they arrive during commit", async () => {
  const f = await fixture(),
    request = f.command({ kind: "resolve", id: f.id, expectedRevision: 2 });
  const db = atCommit(() =>
    env.DB.prepare(
      "UPDATE incident SET description='New' WHERE orgId=? AND id=?",
    )
      .bind(f.orgId, f.id)
      .run(),
  );
  expect((await writeTmManagement(headers, request, "write", db)).outcome).toBe(
    "conflict",
  );
  expect((await f.incident())?.status).toBe("open");
});
it("rolls the receipt back if the business write fails", async () => {
  const f = await fixture(),
    request = await f.layout();
  // A real SQLite constraint failure inside the same batch must roll back its receipt.
  const db: Pick<D1Database, "prepare" | "batch"> = {
    prepare: (sql: string) => env.DB.prepare(sql),
    batch: (statements: D1PreparedStatement[]) =>
      env.DB.batch([
        ...statements,
        env.DB.prepare(
          "INSERT INTO dashboard_layout(id,orgId,userId,dashboard,layout) VALUES('fail',NULL,NULL,'tech-manager','{}')",
        ),
      ]),
  };
  await expect(
    writeTmManagement(headers, request, "write", db),
  ).rejects.toThrow();
  expect((await f.read()).layoutRevision).toBe(0);
  expect(
    (
      await env.DB.prepare("SELECT * FROM tm_management_request WHERE orgId=?")
        .bind(f.orgId)
        .all()
    ).results,
  ).toEqual([]);
});
it("shows malformed stored layouts and propagates database failures", async () => {
  const f = await fixture();
  await f.send(await f.layout());
  await env.DB.prepare(
    "UPDATE dashboard_layout SET layout='broken' WHERE orgId=? AND userId=?",
  )
    .bind(f.orgId, f.userId)
    .run();
  expect(await f.read()).toMatchObject({
    layoutUnknown: true,
    layout: defaultTmLayout(),
    layoutRevision: 2,
  });
  await expect(
    readTmManagement(headers, f.scope, {
      prepare: (sql) => {
        if (sql.includes("AS pendingNotifications"))
          throw new Error("Unavailable");
        return env.DB.prepare(sql);
      },
      batch: (s) => env.DB.batch(s),
    }),
  ).rejects.toThrow("Unavailable");
});
