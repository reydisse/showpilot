import { env } from "cloudflare:workers";
import { beforeEach, expect, it, vi } from "vitest";
import { seedRelayMember } from "@/test/relay-fixtures";
import { getPrisma } from "../db";
import { hashPassword } from "better-auth/crypto";
import { getAuth } from "../auth";
import { changeScheduleAssignment } from "../schedule-assignment";
import {
  readScheduleAssignment,
  writeScheduleAssignment,
} from "../schedule-assignment.server";
import type { ScheduleAssignmentCommand } from "../schedule-assignment-contract";

const mail = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../email", async (original) => ({
  ...(await original<typeof import("../email")>()),
  sendEmail: mail.send,
}));
beforeEach(() => {
  mail.send.mockReset().mockResolvedValue(undefined);
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

async function assignmentFixture() {
  const actor = await fixture();
  const showId = crypto.randomUUID();
  const serviceDate = new Date(Date.now() + 20 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  await getPrisma().rundown.create({
    data: {
      id: showId,
      orgId: actor.orgId,
      serviceDate,
      name: "Assignment recovery fixture",
    },
  });
  return {
    ...actor,
    input: {
      showId,
      serviceDate,
      role: "Audio",
      department: "Production",
      crewMemberId: null,
      notes: "Original draft",
      callTime: "",
      timeZone: "UTC",
    },
  };
}

function create(
  f: Awaited<ReturnType<typeof assignmentFixture>>,
): ScheduleAssignmentCommand {
  return {
    orgId: f.orgId,
    userId: f.userId,
    requestId: crypto.randomUUID(),
    operation: { kind: "create", fields: f.input },
  };
}
async function saved(f: Awaited<ReturnType<typeof assignmentFixture>>) {
  const result = await changeScheduleAssignment({ data: create(f) });
  expect(result.outcome).toBe("applied");
  expect(result.snapshot).not.toBeNull();
  return result.snapshot!;
}
it("retries an acknowledged assignment create without creating a second position", async () => {
  const f = await assignmentFixture(),
    command = create(f);
  const first = await changeScheduleAssignment({ data: command });
  const replay = await changeScheduleAssignment({ data: command });
  expect(replay.assignmentId).toBe(first.assignmentId);
  expect(replay.outcome).toBe("applied");
  expect(
    await getPrisma().serviceAssignment.count({
      where: { orgId: f.orgId, showId: f.input.showId },
    }),
  ).toBe(1);
});
it("does not replay an older assignment edit over newer details", async () => {
  const f = await assignmentFixture(),
    initial = await saved(f);
  const firstEdit: ScheduleAssignmentCommand = {
    ...create(f),
    operation: {
      kind: "edit",
      id: initial.id,
      expectedRevision: initial.revision,
      fields: { ...f.input, notes: "First edit" },
    },
  };
  const first = await changeScheduleAssignment({ data: firstEdit });
  const newer = await changeScheduleAssignment({
    data: {
      ...firstEdit,
      requestId: crypto.randomUUID(),
      operation: {
        ...firstEdit.operation,
        kind: "edit",
        id: initial.id,
        expectedRevision: first.snapshot!.revision,
        fields: { ...f.input, notes: "Newer edit" },
      },
    },
  });
  expect(newer.outcome).toBe("applied");
  const replay = await changeScheduleAssignment({ data: firstEdit });
  expect(replay.outcome).toBe("superseded");
  expect(replay.snapshot?.notes).toBe("Newer edit");
});
it("lets only one of two concurrent edits consume a reviewed revision", async () => {
  const f = await assignmentFixture(),
    initial = await saved(f);
  const results = await Promise.all(
    ["Manager A", "Manager B"].map((notes) =>
      changeScheduleAssignment({
        data: {
          ...create(f),
          operation: {
            kind: "edit",
            id: initial.id,
            expectedRevision: initial.revision,
            fields: { ...f.input, notes },
          },
        },
      }),
    ),
  );
  expect(results.map((result) => result.outcome).sort()).toEqual([
    "applied",
    "conflict",
  ]);
  const state = await readScheduleAssignment(f.headers, f.orgId, initial.id);
  expect(state.snapshot?.notes).toBe(
    results.find((result) => result.outcome === "applied")?.snapshot?.notes,
  );
});
it("coalesces simultaneous retries and rejects a different payload using the same request id", async () => {
  const f = await assignmentFixture(),
    command = create(f);
  const results = await Promise.all([
    changeScheduleAssignment({ data: command }),
    changeScheduleAssignment({ data: command }),
  ]);
  expect(results[0].assignmentId).toBe(results[1].assignmentId);
  await expect(
    changeScheduleAssignment({
      data: {
        ...command,
        operation: { kind: "create", fields: { ...f.input, role: "Lighting" } },
      },
    }),
  ).rejects.toThrow("different assignment change");
  expect(
    await getPrisma().serviceAssignment.count({ where: { orgId: f.orgId } }),
  ).toBe(1);
});
it("detects writes from legacy callers, including changing back to the original value", async () => {
  const f = await assignmentFixture(),
    initial = await saved(f);
  await getPrisma().serviceAssignment.update({
    where: { id: initial.id },
    data: { notes: "Other device" },
  });
  await getPrisma().serviceAssignment.update({
    where: { id: initial.id },
    data: { notes: initial.notes },
  });
  const result = await changeScheduleAssignment({
    data: {
      ...create(f),
      operation: {
        kind: "edit",
        id: initial.id,
        expectedRevision: initial.revision,
        fields: { ...f.input, role: "Stale role" },
      },
    },
  });
  expect(result.outcome).toBe("conflict");
  expect(result.snapshot?.role).toBe("Audio");
  expect(result.snapshot?.revision).not.toBe(initial.revision);
});
it("rejects stale deletion and makes a successful deletion retryable", async () => {
  const f = await assignmentFixture(),
    initial = await saved(f);
  const remove: ScheduleAssignmentCommand = {
    ...create(f),
    operation: {
      kind: "delete",
      id: initial.id,
      expectedRevision: initial.revision,
    },
  };
  await getPrisma().serviceAssignment.update({
    where: { id: initial.id },
    data: { status: "confirmed" },
  });
  const stale = await changeScheduleAssignment({ data: remove });
  expect(stale.outcome).toBe("conflict");
  expect(stale.snapshot?.status).toBe("confirmed");
  const reviewed: ScheduleAssignmentCommand = {
    ...remove,
    requestId: crypto.randomUUID(),
    operation: {
      ...remove.operation,
      kind: "delete",
      id: initial.id,
      expectedRevision: stale.snapshot!.revision,
    },
  };
  const first = await changeScheduleAssignment({ data: reviewed });
  expect(first.outcome).toBe("applied");
  expect(first.snapshot).toBeNull();
  expect(await changeScheduleAssignment({ data: reviewed })).toEqual(first);
  await getPrisma().serviceAssignment.create({
    data: {
      id: initial.id,
      orgId: f.orgId,
      showId: f.input.showId,
      serviceDate: f.input.serviceDate,
      role: "Restored position",
    },
  });
  const replay = await changeScheduleAssignment({ data: reviewed });
  expect(replay.outcome).toBe("superseded");
  expect(replay.snapshot?.role).toBe("Restored position");
});
it("preserves a declined response and creates only one replacement", async () => {
  const f = await assignmentFixture(),
    initial = await saved(f);
  const crew = await getPrisma().crewMember.create({
    data: {
      orgId: f.orgId,
      memberId: crypto.randomUUID(),
      name: "Declined person",
      role: "Audio",
      email: "declined@example.test",
    },
  });
  await getPrisma().serviceAssignment.update({
    where: { id: initial.id },
    data: {
      crewMemberId: crew.id,
      status: "declined",
      responseNote: "Unavailable",
    },
  });
  const state = await readScheduleAssignment(f.headers, f.orgId, initial.id);
  const command: ScheduleAssignmentCommand = {
    ...create(f),
    operation: {
      kind: "edit",
      id: initial.id,
      expectedRevision: state.snapshot!.revision,
      fields: f.input,
    },
  };
  const first = await changeScheduleAssignment({ data: command });
  expect(first.outcome).toBe("applied");
  expect(first.assignmentId).not.toBe(initial.id);
  expect(first.snapshot?.status).toBe("assigned");
  expect((await changeScheduleAssignment({ data: command })).assignmentId).toBe(
    first.assignmentId,
  );
  expect(
    (
      await changeScheduleAssignment({
        data: { ...command, requestId: crypto.randomUUID() },
      })
    ).outcome,
  ).toBe("conflict");
  const original = await getPrisma().serviceAssignment.findUniqueOrThrow({
    where: { id: initial.id },
  });
  expect(original.status).toBe("declined");
  expect(original.responseNote).toBe("Unavailable");
  expect(
    await getPrisma().serviceAssignment.count({ where: { orgId: f.orgId } }),
  ).toBe(2);
});
it("preserves crew responses when editing notes and ignores delivery-only timestamps", async () => {
  const f = await assignmentFixture(),
    initial = await saved(f);
  await getPrisma().serviceAssignment.update({
    where: { id: initial.id },
    data: {
      status: "confirmed",
      responseNote: "See you there",
      respondedAt: new Date(),
    },
  });
  const state = await readScheduleAssignment(f.headers, f.orgId, initial.id);
  await getPrisma().serviceAssignment.update({
    where: { id: initial.id },
    data: { invitedAt: new Date() },
  });
  const result = await changeScheduleAssignment({
    data: {
      ...create(f),
      operation: {
        kind: "edit",
        id: initial.id,
        expectedRevision: state.snapshot!.revision,
        fields: { ...f.input, notes: "Updated manager note" },
      },
    },
  });
  expect(result.outcome).toBe("applied");
  expect(result.snapshot).toMatchObject({
    status: "confirmed",
    responseNote: "See you there",
    notes: "Updated manager note",
  });
});
it("checks the current account and permission even when recovering an existing receipt", async () => {
  const f = await assignmentFixture(),
    command = create(f);
  await changeScheduleAssignment({ data: command });
  await expect(
    writeScheduleAssignment(f.headers, {
      ...command,
      userId: "different-user",
    }),
  ).rejects.toThrow("account");
  await getPrisma().member.updateMany({
    where: { organizationId: f.orgId, userId: f.userId },
    data: { role: "member" },
  });
  await expect(writeScheduleAssignment(f.headers, command)).rejects.toThrow(
    "permission",
  );
});
it("does not use another organization's show, crew or assignment", async () => {
  const f = await assignmentFixture(),
    initial = await saved(f),
    other = await assignmentFixture();
  await expect(
    writeScheduleAssignment(f.headers, {
      ...create(f),
      operation: {
        kind: "create",
        fields: { ...f.input, showId: other.input.showId },
      },
    }),
  ).rejects.toThrow("show");
  const crew = await getPrisma().crewMember.create({
    data: {
      orgId: other.orgId,
      memberId: crypto.randomUUID(),
      name: "Other crew",
      role: "Audio",
      email: "other@example.test",
    },
  });
  expect(
    (
      await writeScheduleAssignment(f.headers, {
        ...create(f),
        operation: {
          kind: "create",
          fields: { ...f.input, crewMemberId: crew.id },
        },
      })
    ).outcome,
  ).toBe("conflict");
  const otherCommand: ScheduleAssignmentCommand = {
    ...create(other),
    operation: {
      kind: "delete",
      id: initial.id,
      expectedRevision: initial.revision,
    },
  };
  expect(
    (await writeScheduleAssignment(other.headers, otherCommand)).outcome,
  ).toBe("conflict");
  expect(
    await getPrisma().serviceAssignment.count({ where: { orgId: f.orgId } }),
  ).toBe(1);
});

it("rolls back the receipt when a database write fails, then recovers with the same request", async () => {
  const f = await assignmentFixture(),
    command = create(f);
  const failing = {
    prepare: env.DB.prepare.bind(env.DB),
    batch: <T>(statements: D1PreparedStatement[]) =>
      env.DB.batch<T>([
        ...statements,
        env.DB.prepare("INSERT INTO assignment_missing_table VALUES (1)"),
      ]),
  };
  await expect(
    writeScheduleAssignment(f.headers, command, failing),
  ).rejects.toThrow();
  expect(
    await getPrisma().serviceAssignment.count({ where: { orgId: f.orgId } }),
  ).toBe(0);
  expect(
    await env.DB.prepare(
      "SELECT requestId FROM schedule_assignment_request WHERE orgId=?",
    )
      .bind(f.orgId)
      .first(),
  ).toBeNull();
  expect((await writeScheduleAssignment(f.headers, command)).outcome).toBe(
    "applied",
  );
});
it("rechecks permission inside the mutation transaction", async () => {
  const f = await assignmentFixture(),
    command = create(f);
  const revoked = {
    prepare: env.DB.prepare.bind(env.DB),
    batch: async <T>(statements: D1PreparedStatement[]) => {
      await getPrisma().member.updateMany({
        where: { organizationId: f.orgId, userId: f.userId },
        data: { role: "member" },
      });
      return env.DB.batch<T>(statements);
    },
  };
  await expect(
    writeScheduleAssignment(f.headers, command, revoked),
  ).rejects.toThrow("permission");
  expect(
    await getPrisma().serviceAssignment.count({ where: { orgId: f.orgId } }),
  ).toBe(0);
});
it("retries the original invitation after an uncertain email result without creating another position", async () => {
  const f = await assignmentFixture();
  const crew = await getPrisma().crewMember.create({
    data: {
      orgId: f.orgId,
      memberId: crypto.randomUUID(),
      name: "External crew",
      role: "Audio",
      email: "recovery@example.test",
    },
  });
  const command: ScheduleAssignmentCommand = {
    ...create(f),
    operation: {
      kind: "create",
      fields: { ...f.input, crewMemberId: crew.id },
    },
  };
  mail.send.mockRejectedValueOnce(
    new TypeError("Provider accepted but reply lost"),
  );
  const first = await writeScheduleAssignment(f.headers, command);
  expect(first.outcome).toBe("applied");
  expect(first.invitation?.email).toBe("uncertain");
  const recovered = await writeScheduleAssignment(f.headers, command);
  expect(recovered.assignmentId).toBe(first.assignmentId);
  expect(recovered.invitation?.email).toBe("accepted");
  expect(mail.send).toHaveBeenCalledTimes(2);
  expect(mail.send.mock.calls[0][0]).toEqual(mail.send.mock.calls[1][0]);
  expect(mail.send.mock.calls[0][1]).toEqual(mail.send.mock.calls[1][1]);
  await writeScheduleAssignment(f.headers, command);
  expect(mail.send).toHaveBeenCalledTimes(2);
  expect(
    await getPrisma().serviceAssignment.count({ where: { orgId: f.orgId } }),
  ).toBe(1);
});
it("does not send an old invitation after another device reassigns the position", async () => {
  const f = await assignmentFixture();
  const crew = await getPrisma().crewMember.create({
    data: {
      orgId: f.orgId,
      memberId: crypto.randomUUID(),
      name: "Original crew",
      role: "Audio",
      email: "original@example.test",
    },
  });
  const command: ScheduleAssignmentCommand = {
    ...create(f),
    operation: {
      kind: "create",
      fields: { ...f.input, crewMemberId: crew.id },
    },
  };
  mail.send.mockRejectedValueOnce(new TypeError("Provider reply lost"));
  const first = await writeScheduleAssignment(f.headers, command);
  await getPrisma().serviceAssignment.update({
    where: { id: first.assignmentId },
    data: { crewMemberId: null },
  });
  const recovered = await writeScheduleAssignment(f.headers, command);
  expect(recovered.outcome).toBe("superseded");
  expect(recovered.invitation).toBeNull();
  expect(mail.send).toHaveBeenCalledTimes(1);
});
it("stores the custom call in venue time and rejects show changes during the save", async () => {
  const f = await assignmentFixture();
  await getPrisma().appSetting.create({
    data: { orgId: f.orgId, key: "org-timezone", value: "America/Toronto" },
  });
  const command: ScheduleAssignmentCommand = {
    ...create(f),
    operation: {
      kind: "create",
      fields: { ...f.input, callTime: "18:00", timeZone: "UTC" },
    },
  };
  const first = await writeScheduleAssignment(f.headers, command);
  expect(first.snapshot?.callTime).toMatch(/^1[34]:00$/);
  let changed = false;
  const changing = {
    prepare: env.DB.prepare.bind(env.DB),
    batch: async <T>(statements: D1PreparedStatement[]) => {
      if (!changed) {
        changed = true;
        await getPrisma().rundown.update({
          where: { id: f.input.showId },
          data: {
            scheduledCallTime: new Date(f.input.serviceDate + "T08:00:00Z"),
          },
        });
      }
      return env.DB.batch<T>(statements);
    },
  };
  const conflict = await writeScheduleAssignment(
    f.headers,
    { ...command, requestId: crypto.randomUUID() },
    changing,
  );
  expect(conflict.outcome).toBe("conflict");
  expect(
    await getPrisma().serviceAssignment.count({ where: { orgId: f.orgId } }),
  ).toBe(1);
});
