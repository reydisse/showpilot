import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import { seedRelayMember } from "@/test/relay-fixtures";
import { withDatabaseTask } from "../request-database.server";
const identity = vi.hoisted(() => ({ userId: "" }));
vi.mock("../org-access", () => ({
  assertOrgPermission: async () => ({
    user: { id: identity.userId, name: "Operator" },
    access: { role: "owner", grantedPermissions: [] },
  }),
}));
vi.mock("@tanstack/react-start/server", () => ({
  getRequestHeaders: () => new Headers(),
  setResponseHeader: vi.fn(),
}));
vi.mock("better-auth/tanstack-start", () => ({
  tanstackStartCookies: () => ({ id: "test-cookie-bridge" }),
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
          await fn({ data: validate(input.data) }),
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
import { getPrisma } from "../db";
import { getPmDashboard } from "../pm-dashboard";
import { getTmDashboard } from "../tm-dashboard";
afterEach(() => {
  vi.restoreAllMocks();
});
async function fixture() {
  const actor = await seedRelayMember(crypto.randomUUID());
  identity.userId = actor.userId;
  const showId = crypto.randomUUID(),
    priorShowId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO rundown(id,orgId,serviceDate,name,status) VALUES(?,?,'2099-01-01','Current','running'),(?,?,'2000-01-01','Prior','stopped')",
    ).bind(showId, actor.orgId, priorShowId, actor.orgId),
    env.DB.prepare(
      "INSERT INTO app_setting(id,orgId,key,value) VALUES(?,?,'active-show-id',?)",
    ).bind(crypto.randomUUID(), actor.orgId, showId),
  ]);
  const pm = () => getPmDashboard({ data: { orgId: actor.orgId } });
  const tm = () => getTmDashboard({ data: { orgId: actor.orgId } });
  return { ...actor, showId, priorShowId, pm, tm };
}
it("propagates rundown-list failures instead of reporting an empty calendar", async () => {
  const f = await fixture();
  await withDatabaseTask(env.DB, async () => {
    vi.spyOn(getPrisma().rundown, "findMany").mockRejectedValue(
      new Error("Fixture rundown read unavailable"),
    );
    await expect(f.pm()).rejects.toThrow("Fixture rundown read unavailable");
  });
});
it.each(["metadata", "roster"])(
  "propagates technical %s failures instead of defaulting to stopped or unused",
  async (kind) => {
    const f = await fixture(),
      prepare = env.DB.prepare.bind(env.DB);
    vi.spyOn(env.DB, "prepare").mockImplementation((sql) => {
      if (
        sql.includes(
          kind === "metadata"
            ? "SELECT scheduledStartTime, scheduledCallTime, status FROM rundown"
            : "SELECT 1 AS present FROM roster_assignment",
        )
      )
        throw new Error("Fixture technical read unavailable");
      return prepare(sql);
    });
    await expect(withDatabaseTask(env.DB, f.tm)).rejects.toThrow(
      "Fixture technical read unavailable",
    );
  },
);
it("retains the incident lifecycle status when building the production model", async () => {
  const f = await fixture();
  await env.DB.prepare(
    "INSERT INTO incident(id,orgId,showId,serviceDate,category,severity,description,reportedBy,status) VALUES(?,?,?,'2099-01-01','audio','high','Resolved fixture','Reporter','resolved')",
  )
    .bind(crypto.randomUUID(), f.orgId, f.showId)
    .run();
  const result = await withDatabaseTask(env.DB, f.pm);
  expect(result.model.incidents).toEqual([]);
  expect(
    result.model.readiness.factors.find((item) => item.id === "incidents"),
  ).toMatchObject({ status: "ok", detail: "None open" });
});
it("includes date-only carried-forward incidents even when prior shows exist", async () => {
  const f = await fixture(),
    id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO incident(id,orgId,serviceDate,category,severity,description,reportedBy) VALUES(?,?,'2000-01-01','audio','critical','Date-only unresolved incident','Reporter')",
  )
    .bind(id, f.orgId)
    .run();
  const result = await withDatabaseTask(env.DB, f.pm);
  expect(result.model.openItems.some((item) => item.id === id)).toBe(true);
  expect(
    result.model.readiness.factors.find((item) => item.id === "incidents")
      ?.status,
  ).toBe("fail");
});
it("counts defined technical checks without rows as unfinished checks", async () => {
  const f = await fixture();
  await env.DB.prepare(
    "INSERT INTO checklist_template(id,orgId,label,category,sortOrder) VALUES(?,?,'Line check','audio',0)",
  )
    .bind(crypto.randomUUID(), f.orgId)
    .run();
  const result = await withDatabaseTask(env.DB, f.tm);
  expect(
    result.model.checks.find((item) => item.key === "audio"),
  ).toMatchObject({ total: 1, outstanding: 1, status: "warn" });
});
it("does not hide a critical backlog behind recent low-severity incidents", async () => {
  const f = await fixture();
  await env.DB.batch(
    Array.from({ length: 30 }, (_, index) =>
      env.DB.prepare(
        "INSERT INTO incident(id,orgId,serviceDate,category,severity,description,reportedBy,timestamp) VALUES(?,?,'2000-01-01',?,?,?,'Reporter',?)",
      ).bind(
        crypto.randomUUID(),
        f.orgId,
        index === 0 ? "audio" : "video",
        index === 0 ? "critical" : "low",
        index === 0 ? "Older critical incident" : "Recent minor incident",
        index === 0 ? "2000-01-01" : "2026-01-01",
      ),
    ),
  );
  const tm = await withDatabaseTask(env.DB, f.tm),
    pm = await withDatabaseTask(env.DB, f.pm);
  expect(tm.model.faults).toHaveLength(25);
  expect(tm.model.incidentsTruncated).toBe(true);
  expect(tm.model.faults[0]).toMatchObject({
    description: "Older critical incident",
    severity: "critical",
  });
  expect(tm.model.readiness).toBe("fail");
  expect(pm.model.openItems).toHaveLength(6);
  expect(pm.model.openItemsTruncated).toBe(true);
  expect(pm.model.openItems[0].description).toBe("Older critical incident");
  expect(
    pm.model.readiness.factors.find((item) => item.id === "incidents"),
  ).toMatchObject({
    status: "fail",
    detail: "At least 1 high-severity incident",
  });
  expect(
    pm.model.departments.find((item) => item.key === "lighting"),
  ).toMatchObject({
    status: "warn",
    detail: "More incidents need review in the log",
  });
});
it("treats malformed legacy summaries as unavailable, while preserving supported legacy values", async () => {
  const f = await fixture(),
    key = `rundown-items:${f.showId}`;
  await env.DB.prepare(
    "INSERT INTO app_setting(id,orgId,key,value) VALUES(?,?,?,'broken')",
  )
    .bind(crypto.randomUUID(), f.orgId, key)
    .run();
  await expect(withDatabaseTask(env.DB, f.pm)).rejects.toThrow(
    "Saved rundown items could not be read",
  );
  await env.DB.prepare("UPDATE app_setting SET value=? WHERE orgId=? AND key=?")
    .bind(
      JSON.stringify([
        {
          id: "legacy",
          title: "Legacy",
          duration: 60000,
          assignee: "Operator",
        },
      ]),
      f.orgId,
      key,
    )
    .run();
  expect(
    (await withDatabaseTask(env.DB, f.pm)).model.rundownHealth,
  ).toMatchObject({ itemCount: 1, plannedMs: 60000 });
});
it("propagates carried-forward incident read failures instead of saying none remain", async () => {
  const f = await fixture(),
    prepare = env.DB.prepare.bind(env.DB);
  vi.spyOn(env.DB, "prepare").mockImplementation((sql) => {
    if (
      sql.includes(
        "SELECT id,serviceDate,category,severity,description FROM incident",
      )
    )
      throw new Error("Fixture history unavailable");
    return prepare(sql);
  });
  await expect(withDatabaseTask(env.DB, f.pm)).rejects.toThrow(
    "Fixture history unavailable",
  );
});
it("shows date-only current incidents without exposing another organization's incidents", async () => {
  const f = await fixture(),
    other = await seedRelayMember(crypto.randomUUID());
  const own = crypto.randomUUID(),
    foreign = crypto.randomUUID();
  for (const [id, orgId] of [
    [own, f.orgId],
    [foreign, other.orgId],
  ])
    await env.DB.prepare(
      "INSERT INTO incident(id,orgId,serviceDate,category,severity,description,reportedBy) VALUES(?,?,'2099-01-01','audio','critical','Same-date unlinked incident','Reporter')",
    )
      .bind(id, orgId)
      .run();
  expect(
    (await withDatabaseTask(env.DB, f.pm)).model.incidents.map(
      (item) => item.id,
    ),
  ).toEqual([own]);
});
it("rejects an unknown selected show instead of silently presenting another date", async () => {
  const f = await fixture();
  await expect(
    withDatabaseTask(env.DB, () =>
      getTmDashboard({ data: { orgId: f.orgId, showId: "not-a-show" } }),
    ),
  ).rejects.toThrow("Show not found");
});
it("does not count section headers as playable rundown items", async () => {
  const f = await fixture();
  await env.DB.prepare(
    "UPDATE rundown SET status='stopped' WHERE orgId=? AND id=?",
  )
    .bind(f.orgId, f.showId)
    .run();
  await getPrisma().rundownItem.create({
    data: {
      orgId: f.orgId,
      showId: f.showId,
      serviceDate: "2099-01-01",
      itemId: "header",
      title: "Section",
      type: "header",
      duration: 0,
      notes: "",
      assignee: "",
      cue: "",
      status: "upcoming",
      sortOrder: 0,
    },
  });
  expect(
    (await withDatabaseTask(env.DB, f.tm)).model.prep.some(
      (item) => item.id === "prep:no-rundown",
    ),
  ).toBe(true);
});
