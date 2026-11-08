import { z } from "zod";
import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { seedRelayMember } from "@/test/relay-fixtures";
import { getPrisma } from "../db";
import { hashPassword } from "better-auth/crypto";
import { getAuth } from "../auth";
import { handleMobileApi } from "../mobile-api.server";
import { writePersonalAssignmentResponse } from "../personal-assignment-response.server";
import {
  personalResponseCommandSchema,
  personalResponseResultSchema,
} from "../personal-assignment-response-contract";
import { assignmentResponseVersion } from "../assignment-response-version";
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

async function fixture() {
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

async function personalFixture() {
  const actor = await fixture();
  const serviceDate = "2098-01-01";
  const crew = await getPrisma().crewMember.create({
    data: {
      orgId: actor.orgId,
      memberId: actor.userId,
      name: "Fixture crew",
      role: "Audio",
      email: `${actor.userId}@example.test`,
    },
  });
  const show = await getPrisma().rundown.create({
    data: { orgId: actor.orgId, name: "Personal response", serviceDate },
  });
  const assignment = await getPrisma().serviceAssignment.create({
    data: {
      orgId: actor.orgId,
      showId: show.id,
      serviceDate,
      crewMemberId: crew.id,
      role: "Audio",
    },
  });
  const version = await env.DB.prepare(
    "SELECT revision FROM schedule_assignment_revision WHERE orgId=? AND assignmentId=?",
  )
    .bind(actor.orgId, assignment.id)
    .first<{ revision: string }>();
  if (!version) throw new Error("Missing assignment revision");
  return {
    ...actor,
    assignment,
    command: {
      orgId: actor.orgId,
      userId: actor.userId,
      requestId: String(crypto.randomUUID()),
      assignmentId: assignment.id,
      expectedRevision: version.revision,
      response: "confirmed",
      reason: "",
      reviewedVersion: assignmentResponseVersion({
        showId: show.id,
        serviceDate,
        role: "Audio",
        callTime: "",
        effectiveCallTime: null,
        scheduledStartTime: null,
      }),
    },
  };
}
async function respond(
  f: Awaited<ReturnType<typeof personalFixture>>,
  db?: Pick<D1Database, "prepare" | "batch">,
) {
  if (db)
    return Response.json(
      await writePersonalAssignmentResponse(
        f.headers,
        personalResponseCommandSchema.parse(f.command),
        false,
        db,
      ),
    );
  const result = await handleMobileApi(
    new Request("https://app.showpilot.tech/api/mobile/v1/schedule/respond", {
      method: "POST",
      headers: { Cookie: auth.cookie, "Content-Type": "application/json" },
      body: JSON.stringify(f.command),
    }),
    { DB: env.DB },
  );
  if (!result) throw new Error("Missing response route");
  return result;
}
it("recovers the same accepted response after its reply was lost", async () => {
  const f = await personalFixture();
  const first = await respond(f);
  expect(first.status, await first.clone().text()).toBe(200);
  const retry = await respond(f);
  expect(retry.status).toBe(200);
  expect(await retry.json()).toMatchObject({
    outcome: "applied",
    requestId: f.command.requestId,
  });
  expect(
    (
      await getPrisma().serviceAssignment.findUniqueOrThrow({
        where: { id: f.assignment.id },
      })
    ).status,
  ).toBe("confirmed");
});
it("does not accept changed duties between the reviewed read and the write", async () => {
  const f = await personalFixture();
  let changed = false;
  const change = async () => {
    if (changed) return;
    changed = true;
    await env.DB.prepare(
      "UPDATE service_assignment SET role='Camera' WHERE orgId=? AND id=?",
    )
      .bind(f.orgId, f.assignment.id)
      .run();
  };
  function wrap(
    statement: D1PreparedStatement,
    sql: string,
  ): D1PreparedStatement {
    return new Proxy(statement, {
      get(target, key) {
        if (key === "bind")
          return (...values: unknown[]) => wrap(target.bind(...values), sql);
        if (
          key === "run" &&
          sql.trimStart().startsWith("UPDATE service_assignment")
        )
          return async () => {
            await change();
            return target.run();
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
  const db = {
    prepare: (sql: string) => wrap(env.DB.prepare(sql), sql),
    batch: async <T>(statements: D1PreparedStatement[]) => {
      await change();
      return env.DB.batch<T>(statements);
    },
  };
  const response = await respond(f, db);
  expect(changed).toBe(true);
  const saved = await getPrisma().serviceAssignment.findUniqueOrThrow({
    where: { id: f.assignment.id },
  });
  expect(saved.role).toBe("Camera");
  expect(saved.status).toBe("assigned");
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ outcome: "conflict" });
});

function beforeBatch(change: () => Promise<unknown>) {
  let changed = false;
  return {
    prepare: env.DB.prepare.bind(env.DB),
    batch: async <T>(statements: D1PreparedStatement[]) => {
      if (!changed) {
        changed = true;
        await change();
      }
      return env.DB.batch<T>(statements);
    },
  };
}
async function current(f: Awaited<ReturnType<typeof personalFixture>>) {
  return getPrisma().serviceAssignment.findUniqueOrThrow({
    where: { id: f.assignment.id },
  });
}
async function review(f: Awaited<ReturnType<typeof personalFixture>>) {
  const response = await handleMobileApi(
    new Request(
      "https://app.showpilot.tech/api/mobile/v1/schedule/review-response",
      {
        method: "POST",
        headers: { Cookie: auth.cookie, "Content-Type": "application/json" },
        body: JSON.stringify(f.command),
      },
    ),
    { DB: env.DB },
  );
  if (!response) throw new Error("Missing review route");
  return response;
}
it("fences an undelivered response before allowing its draft to change", async () => {
  const f = await personalFixture();
  expect(await (await review(f)).json()).toMatchObject({
    outcome: "cancelled",
  });
  expect(await (await respond(f)).json()).toMatchObject({
    outcome: "cancelled",
  });
  expect((await current(f)).status).toBe("assigned");
});
it("review recovers a committed response and exact replay cannot overwrite newer work", async () => {
  const f = await personalFixture();
  expect(await (await respond(f)).json()).toMatchObject({ outcome: "applied" });
  expect(await (await review(f)).json()).toMatchObject({ outcome: "applied" });
  await getPrisma().serviceAssignment.update({
    where: { id: f.assignment.id },
    data: { status: "assigned", role: "New duties" },
  });
  expect(await (await respond(f)).json()).toMatchObject({
    outcome: "superseded",
  });
  expect((await current(f)).status).toBe("assigned");
  await getPrisma().serviceAssignment.delete({
    where: { id: f.assignment.id },
  });
  expect(await (await respond(f)).json()).toMatchObject({ outcome: "removed" });
});
it("allows only one of two simultaneous responses", async () => {
  const f = await personalFixture();
  const other = {
    ...f,
    command: {
      ...f.command,
      requestId: crypto.randomUUID(),
      response: "declined",
      reason: "Away",
    },
  };
  const results = await Promise.all([respond(f), respond(other)]);
  const bodies = await Promise.all(results.map((response) => response.json()));
  expect(
    bodies
      .map((body) => personalResponseResultSchema.parse(body).outcome)
      .sort(),
  ).toEqual(["applied", "conflict"]);
  expect(["confirmed", "declined"]).toContain((await current(f)).status);
});
it("does not accept different content under the same request identity", async () => {
  const f = await personalFixture();
  await respond(f);
  await expect(
    respond({
      ...f,
      command: { ...f.command, response: "declined", reason: "Different" },
    }),
  ).rejects.toThrow("different assignment response");
  expect((await current(f)).status).toBe("confirmed");
});
it("rejects old versions and an already answered assignment without changing either", async () => {
  const f = await personalFixture();
  await getPrisma().serviceAssignment.update({
    where: { id: f.assignment.id },
    data: { role: "Camera" },
  });
  expect(await (await respond(f)).json()).toMatchObject({
    outcome: "conflict",
  });
  expect((await current(f)).status).toBe("assigned");
  const g = await personalFixture();
  await getPrisma().serviceAssignment.update({
    where: { id: g.assignment.id },
    data: { status: "declined", responseNote: "Original" },
  });
  expect(await (await respond(g)).json()).toMatchObject({
    outcome: "conflict",
  });
  expect((await current(g)).responseNote).toBe("Original");
});
it.each(["show-time", "timezone", "duration", "crew-email"])(
  "rejects a linked %s change during the transaction",
  async (kind) => {
    const f = await personalFixture();
    const db = beforeBatch(async () => {
      if (kind === "show-time")
        await env.DB.prepare(
          "UPDATE rundown SET scheduledCallTime='2098-01-01T08:00:00.000Z' WHERE orgId=? AND id=?",
        )
          .bind(f.orgId, f.assignment.showId)
          .run();
      if (kind === "timezone")
        await env.DB.prepare(
          "INSERT INTO app_setting(id,orgId,key,value) VALUES(?,?,'org-timezone','America/Toronto')",
        )
          .bind(crypto.randomUUID(), f.orgId)
          .run();
      if (kind === "duration")
        await getPrisma().rundownItem.create({
          data: {
            orgId: f.orgId,
            showId: f.assignment.showId!,
            title: "New item",
            duration: 60000,
            sortOrder: 0,
            serviceDate: f.assignment.serviceDate,
            itemId: crypto.randomUUID(),
            type: "generic",
            notes: "",
            assignee: "",
            cue: "",
            status: "pending",
          },
        });
      if (kind === "crew-email")
        await getPrisma().crewMember.update({
          where: { id: f.assignment.crewMemberId! },
          data: { email: "someone-else@example.test" },
        });
    });
    expect(await (await respond(f, db)).json()).toMatchObject({
      outcome: "conflict",
    });
    expect((await current(f)).status).toBe("assigned");
  },
);
it("does not record a response after membership is revoked before commit", async () => {
  const f = await personalFixture();
  await expect(
    respond(
      f,
      beforeBatch(() =>
        env.DB.prepare("DELETE FROM member WHERE organizationId=? AND userId=?")
          .bind(f.orgId, f.userId)
          .run(),
      ),
    ),
  ).rejects.toThrow("account changed");
  expect((await current(f)).status).toBe("assigned");
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM personal_assignment_response WHERE orgId=?",
    )
      .bind(f.orgId)
      .first(),
  ).toEqual({ count: 0 });
});
it("records a closed window without applying a response", async () => {
  const f = await personalFixture();
  await getPrisma().serviceAssignment.update({
    where: { id: f.assignment.id },
    data: { serviceDate: "2020-01-01" },
  });
  const revision = await env.DB.prepare(
    "SELECT revision FROM schedule_assignment_revision WHERE orgId=? AND assignmentId=?",
  )
    .bind(f.orgId, f.assignment.id)
    .first<{ revision: string }>();
  if (!revision) throw new Error("Missing revision");
  f.command.expectedRevision = revision.revision;
  f.command.reviewedVersion = assignmentResponseVersion({
    showId: f.assignment.showId,
    serviceDate: "2020-01-01",
    role: "Audio",
    callTime: "",
    effectiveCallTime: null,
    scheduledStartTime: null,
  });
  expect(await (await respond(f)).json()).toMatchObject({ outcome: "closed" });
  expect((await current(f)).status).toBe("assigned");
});
it("does not expose or respond to someone else's position", async () => {
  const f = await personalFixture();
  await getPrisma().crewMember.update({
    where: { id: f.assignment.crewMemberId! },
    data: { email: "another@example.test" },
  });
  expect(await (await respond(f)).json()).toEqual({
    orgId: f.orgId,
    userId: f.userId,
    requestId: f.command.requestId,
    assignmentId: f.assignment.id,
    outcome: "unavailable",
  });
  expect((await current(f)).status).toBe("assigned");
});
it("requires the original actor and complete recovery identity", async () => {
  const f = await personalFixture();
  expect(
    (await respond({ ...f, command: { ...f.command, userId: "other-user" } }))
      .status,
  ).toBe(403);
  expect(
    (await respond({ ...f, command: { ...f.command, requestId: "bad" } }))
      .status,
  ).toBe(400);
  expect((await current(f)).status).toBe("assigned");
});
it("preserves the installed-client response shape despite revision triggers", async () => {
  const f = await personalFixture();
  const { userId, requestId, expectedRevision, ...body } = f.command;
  const send = async () =>
    handleMobileApi(
      new Request("https://app.showpilot.tech/api/mobile/v1/schedule/respond", {
        method: "POST",
        headers: { Cookie: auth.cookie, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      { DB: env.DB },
    );
  const first = await send();
  expect(first?.status).toBe(200);
  expect(await first?.json()).toEqual({ ok: true });
  expect((await send())?.status).toBe(409);
});
it("inserts one scheduler notification across replay and review", async () => {
  const f = await personalFixture();
  const scheduler = await seedRelayMember(f.orgId, crypto.randomUUID());
  await getPrisma().serviceAssignment.update({
    where: { id: f.assignment.id },
    data: { assignedByUserId: scheduler.userId },
  });
  const revision = await env.DB.prepare(
    "SELECT revision FROM schedule_assignment_revision WHERE orgId=? AND assignmentId=?",
  )
    .bind(f.orgId, f.assignment.id)
    .first<{ revision: string }>();
  if (!revision) throw new Error("Missing revision");
  f.command.expectedRevision = revision.revision;
  for (const send of [respond, respond, review])
    expect(await (await send(f)).json()).toMatchObject({ outcome: "applied" });
  const notifications = await getPrisma().notification.findMany({
    where: { orgId: f.orgId, source: f.assignment.id },
  });
  expect(notifications).toHaveLength(1);
  expect(notifications[0]).toMatchObject({
    userId: scheduler.userId,
    type: "assignment-confirmed",
    title: "Fixture crew accepted an assignment",
  });
});
it("accepts the exact version exposed by Schedule with stored show times", async () => {
  const f = await personalFixture();
  await getPrisma().rundown.update({
    where: { id: f.assignment.showId! },
    data: {
      scheduledStartTime: new Date("2098-01-01T10:00:00Z"),
      scheduledCallTime: new Date("2098-01-01T09:00:00Z"),
    },
  });
  const schedule = await handleMobileApi(
    new Request(
      `https://app.showpilot.tech/api/mobile/v1/schedule?orgId=${f.orgId}&date=2098-01-01`,
      { headers: { Cookie: auth.cookie } },
    ),
    { DB: env.DB },
  );
  if (!schedule) throw new Error("Missing schedule");
  const parsed = z
    .object({
      assignments: z.array(
        z.object({
          id: z.string(),
          responseVersion: z.string(),
          revision: z.string(),
        }),
      ),
    })
    .parse(await schedule.json());
  const own = parsed.assignments.find((a) => a.id === f.assignment.id);
  if (!own) throw new Error("Missing assignment");
  f.command.reviewedVersion = own.responseVersion;
  f.command.expectedRevision = own.revision;
  expect(await (await respond(f)).json()).toMatchObject({ outcome: "applied" });
});
