import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getPrisma } from "../db";
import { getCrewScheduleCalendar } from "../crew-schedule-calendar.server";
import { writeCrewScheduleResponse } from "../crew-response.server";
import {
  crewResponseCommandSchema,
  crewResponseResultSchema,
} from "../crew-response-contract";
import { seedRelayMember } from "@/test/relay-fixtures";
import {
  getCrewSchedulePortal,
  sendCrewScheduleInvite,
  respondToCrewScheduleInvite,
  reviewCrewScheduleResponse,
} from "../crew-schedule";

// Exercise the actual database and email renderer without sending mail.
const delivery = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../email")>()),
  sendEmail: delivery.send,
}));
vi.mock("../assignment-notifications.server", () => ({
  notifyAssignmentRecipient: async () => ({ notified: false }),
}));
// Only the transport wrapper is replaced; handlers use real D1 and Prisma.
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate = (value: unknown) => value;
    const chain = {
      inputValidator: (fn: typeof validate) => {
        validate = fn;
        return chain;
      },
      handler:
        (handler: (input: { data: unknown }) => unknown) =>
        (input: { data: unknown }) =>
          handler({ data: validate(input.data) }),
    };
    return chain;
  },
}));

beforeEach(() => {
  delivery.send.mockReset().mockResolvedValue(undefined);
});

async function fixture() {
  const prisma = getPrisma();
  const orgId = crypto.randomUUID();
  const crewMemberId = crypto.randomUUID();
  const assignmentId = crypto.randomUUID();
  const future = new Date(Date.now() + 20 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  await prisma.organization.create({
    data: {
      id: orgId,
      name: "Schedule link test",
      slug: orgId,
      createdAt: new Date(),
    },
  });
  await prisma.crewMember.create({
    data: {
      id: crewMemberId,
      orgId,
      memberId: crewMemberId,
      name: "Test Crew",
      email: "crew@example.test",
      role: "Audio",
    },
  });
  await prisma.serviceAssignment.create({
    data: {
      id: assignmentId,
      orgId,
      crewMemberId,
      serviceDate: future,
      role: "Audio",
    },
  });
  return {
    prisma,
    orgId,
    crewMemberId,
    assignmentId,
    serviceDate: future,
    role: "Audio",
    origin: "https://app.showpilot.tech",
  };
}

async function invite(f: Awaited<ReturnType<typeof fixture>>) {
  expect(await sendCrewScheduleInvite(f)).toMatchObject({
    delivered: true,
    reason: null,
    emailState: "accepted",
  });
  const message: unknown = delivery.send.mock.lastCall?.[0];
  if (
    !message ||
    typeof message !== "object" ||
    !("html" in message) ||
    typeof message.html !== "string"
  )
    throw new Error("Missing invitation email");
  const match = message.html.match(
    /https:\/\/app\.showpilot\.tech\/crew\/schedule\/([A-Za-z0-9_-]+)([^"\s<]*)/,
  );
  if (!match) throw new Error("Missing schedule link");
  expect(match[2]).toBe("");
  expect(message.html).not.toContain(f.assignmentId);
  expect(message.html).not.toContain(f.crewMemberId);
  expect(message.html).not.toContain(f.orgId);
  return match[1];
}

describe("private crew schedule invitation links", () => {
  it("opens the invited assignment without query IDs, even beyond the first twenty upcoming assignments", async () => {
    const f = await fixture();
    const earlier = new Date(Date.now() + 10 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    for (let i = 0; i < 21; i++)
      await f.prisma.serviceAssignment.create({
        data: {
          orgId: f.orgId,
          crewMemberId: f.crewMemberId,
          serviceDate: earlier,
          role: "Lighting",
        },
      });
    const token = await invite(f);
    expect(token).toHaveLength(43);
    const portal = await getCrewSchedulePortal({ data: { token } });
    expect(portal.initialAssignmentId).toBe(f.assignmentId);
    expect(portal.assignments[0].id).toBe(f.assignmentId);
    expect(portal.assignments).toHaveLength(20);
  });

  it("keeps legacy access records valid and does not rotate previously delivered tokens", async () => {
    const f = await fixture();
    const first = await invite(f);
    await env.DB.prepare(
      "UPDATE crew_schedule_access SET assignmentId = NULL WHERE orgId = ?",
    )
      .bind(f.orgId)
      .run();
    const second = await invite(f);
    expect(first).not.toBe(second);
    expect(
      (await getCrewSchedulePortal({ data: { token: first } }))
        .initialAssignmentId,
    ).toBeNull();
    expect(
      (await getCrewSchedulePortal({ data: { token: second } }))
        .initialAssignmentId,
    ).toBe(f.assignmentId);
  });

  it("never treats a stored assignment selection as authority to read another crew or organization", async () => {
    const f = await fixture();
    const other = await fixture();
    const token = await invite(f);
    await env.DB.prepare(
      "UPDATE crew_schedule_access SET assignmentId = ? WHERE orgId = ?",
    )
      .bind(other.assignmentId, f.orgId)
      .run();
    const portal = await getCrewSchedulePortal({ data: { token } });
    expect(portal.assignments.map((row) => row.id)).toEqual([f.assignmentId]);
  });

  it("rejects expired and revoked links", async () => {
    const f = await fixture();
    const token = await invite(f);
    await env.DB.prepare(
      "UPDATE crew_schedule_access SET expiresAt = '2000-01-01' WHERE orgId = ?",
    )
      .bind(f.orgId)
      .run();
    await expect(getCrewSchedulePortal({ data: { token } })).rejects.toThrow(
      "invalid, revoked or has expired",
    );
    await env.DB.prepare(
      "UPDATE crew_schedule_access SET expiresAt = '2099-01-01', revokedAt = CURRENT_TIMESTAMP WHERE orgId = ?",
    )
      .bind(f.orgId)
      .run();
    await expect(getCrewSchedulePortal({ data: { token } })).rejects.toThrow(
      "invalid, revoked or has expired",
    );
  });

  it("retains a prepared link for an exact retry after email delivery fails", async () => {
    const f = await fixture();
    delivery.send.mockRejectedValueOnce(new Error("Delivery unavailable"));
    await expect(sendCrewScheduleInvite(f)).resolves.toMatchObject({
      delivered: false,
      emailState: "uncertain",
    });
    expect(
      await env.DB.prepare(
        "SELECT id FROM crew_schedule_access WHERE orgId = ?",
      )
        .bind(f.orgId)
        .first(),
    ).not.toBeNull();
  });
});

it("reports a saved crew portal response honestly with assignment revision triggers", async () => {
  const f = await fixture(),
    token = await invite(f);
  const portal = await getCrewSchedulePortal({ data: { token } });
  const selected = portal.assignments.find((row) => row.id === f.assignmentId);
  if (!selected) throw new Error("Missing invited assignment");
  await expect(
    respondToCrewScheduleInvite({
      data: {
        token,
        assignmentId: f.assignmentId,
        reviewedVersion: selected.responseVersion,
        response: "confirmed",
        reason: "",
      },
    }),
  ).resolves.toEqual({ ok: true });
  expect(
    (
      await f.prisma.serviceAssignment.findUniqueOrThrow({
        where: { id: f.assignmentId },
      })
    ).status,
  ).toBe("confirmed");
});

async function responseFixture() {
  const f = await fixture(),
    token = await invite(f),
    portal = await getCrewSchedulePortal({ data: { token } });
  const row = portal.assignments.find((value) => value.id === f.assignmentId);
  if (!row?.revision) throw new Error("Missing assignment revision");
  return {
    ...f,
    token,
    command: crewResponseCommandSchema.parse({
      token,
      assignmentId: row.id,
      requestId: crypto.randomUUID(),
      expectedRevision: row.revision,
      reviewedVersion: row.responseVersion,
      response: "confirmed",
      reason: "",
    }),
  };
}
const send = (f: Awaited<ReturnType<typeof responseFixture>>) =>
  respondToCrewScheduleInvite({ data: f.command });
const saved = (f: Awaited<ReturnType<typeof responseFixture>>) =>
  f.prisma.serviceAssignment.findUniqueOrThrow({
    where: { id: f.assignmentId },
  });
function beforeResponseBatch(change: () => Promise<unknown>) {
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
it("recovers an exact public response without changing it twice", async () => {
  const f = await responseFixture();
  expect(await send(f)).toMatchObject({ outcome: "applied" });
  const first = await saved(f);
  expect(await send(f)).toMatchObject({
    outcome: "applied",
    requestId: f.command.requestId,
  });
  expect((await saved(f)).respondedAt).toEqual(first.respondedAt);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM crew_assignment_response WHERE orgId=?",
    )
      .bind(f.orgId)
      .first(),
  ).toEqual({ count: 1 });
});
it("cancels an undelivered public response before editing its note", async () => {
  const f = await responseFixture();
  expect(await reviewCrewScheduleResponse({ data: f.command })).toMatchObject({
    outcome: "cancelled",
  });
  expect(await send(f)).toMatchObject({ outcome: "cancelled" });
  expect((await saved(f)).status).toBe("assigned");
});
it("review and send racing agree on one original outcome", async () => {
  const f = await responseFixture();
  const [save, review] = await Promise.all([
    send(f),
    reviewCrewScheduleResponse({ data: f.command }),
  ]);
  expect(crewResponseResultSchema.parse(save).outcome).toBe(review.outcome);
  expect((await saved(f)).status).toBe(
    review.outcome === "applied" ? "confirmed" : "assigned",
  );
});
it("does not overwrite later changes or recreate removed assignments on retry", async () => {
  const f = await responseFixture();
  await send(f);
  await f.prisma.serviceAssignment.update({
    where: { id: f.assignmentId },
    data: { role: "Camera", status: "assigned" },
  });
  expect(await send(f)).toMatchObject({ outcome: "superseded" });
  expect((await saved(f)).status).toBe("assigned");
  await f.prisma.serviceAssignment.delete({ where: { id: f.assignmentId } });
  expect(await send(f)).toMatchObject({ outcome: "removed" });
});
it("rejects different response data under an already used request identity", async () => {
  const f = await responseFixture();
  await send(f);
  await expect(
    respondToCrewScheduleInvite({
      data: { ...f.command, response: "declined", reason: "Different" },
    }),
  ).rejects.toThrow("different assignment response");
  expect((await saved(f)).status).toBe("confirmed");
});
it("does not apply a response when duties change between reading and committing", async () => {
  const f = await responseFixture();
  const db = beforeResponseBatch(() =>
    f.prisma.serviceAssignment.update({
      where: { id: f.assignmentId },
      data: { role: "Camera" },
    }),
  );
  expect(
    await writeCrewScheduleResponse(f.token, f.command, false, db),
  ).toMatchObject({ outcome: "conflict" });
  expect((await saved(f)).status).toBe("assigned");
});
it.each(["revoke", "expire", "invalid-expiry", "delete-org"])(
  "checks public link authority at commit after %s",
  async (kind) => {
    const f = await responseFixture();
    const db = beforeResponseBatch(async () => {
      if (kind === "revoke")
        await env.DB.prepare(
          "UPDATE crew_schedule_access SET revokedAt=CURRENT_TIMESTAMP WHERE orgId=?",
        )
          .bind(f.orgId)
          .run();
      if (kind === "expire")
        await env.DB.prepare(
          "UPDATE crew_schedule_access SET expiresAt='2000-01-01' WHERE orgId=?",
        )
          .bind(f.orgId)
          .run();
      if (kind === "invalid-expiry")
        await env.DB.prepare(
          "UPDATE crew_schedule_access SET expiresAt='invalid' WHERE orgId=?",
        )
          .bind(f.orgId)
          .run();
      if (kind === "delete-org")
        await env.DB.prepare(
          "INSERT INTO app_setting(id,orgId,key,value) VALUES(?,?,'organization-deleting','true')",
        )
          .bind(crypto.randomUUID(), f.orgId)
          .run();
    });
    await expect(
      writeCrewScheduleResponse(f.token, f.command, false, db),
    ).rejects.toThrow("invalid, revoked or has expired");
    expect((await saved(f)).status).toBe("assigned");
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM crew_assignment_response WHERE orgId=?",
      )
        .bind(f.orgId)
        .first(),
    ).toEqual({ count: 0 });
  },
);
it("fails closed for an invalid expiry on portal reads", async () => {
  const f = await responseFixture();
  await env.DB.prepare(
    "UPDATE crew_schedule_access SET expiresAt='invalid' WHERE orgId=?",
  )
    .bind(f.orgId)
    .run();
  await expect(
    getCrewSchedulePortal({ data: { token: f.token } }),
  ).rejects.toThrow("invalid, revoked or has expired");
});
it("keeps another crew member and organization outside the link's authority", async () => {
  const f = await responseFixture(),
    other = await fixture();
  expect(
    await respondToCrewScheduleInvite({
      data: { ...f.command, assignmentId: other.assignmentId },
    }),
  ).toMatchObject({ outcome: "unavailable" });
  expect(
    (
      await other.prisma.serviceAssignment.findUniqueOrThrow({
        where: { id: other.assignmentId },
      })
    ).status,
  ).toBe("assigned");
});
it("keeps receipts separate for two links even when the request IDs match", async () => {
  const f = await responseFixture();
  const second = await invite(f);
  await send(f);
  expect(
    await respondToCrewScheduleInvite({
      data: { ...f.command, token: second },
    }),
  ).toMatchObject({ outcome: "conflict" });
  expect(await send(f)).toMatchObject({ outcome: "applied" });
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM crew_assignment_response WHERE orgId=?",
    )
      .bind(f.orgId)
      .first(),
  ).toEqual({ count: 2 });
});
it("notifies only the assigning scheduler once across public retry and review", async () => {
  const f = await responseFixture();
  const scheduler = await seedRelayMember(f.orgId, crypto.randomUUID());
  await f.prisma.serviceAssignment.update({
    where: { id: f.assignmentId },
    data: { assignedByUserId: scheduler.userId },
  });
  const portal = await getCrewSchedulePortal({ data: { token: f.token } }),
    row = portal.assignments.find((value) => value.id === f.assignmentId);
  if (!row?.revision) throw new Error("Missing revision");
  f.command.expectedRevision = row.revision;
  await send(f);
  await send(f);
  await reviewCrewScheduleResponse({ data: f.command });
  const rows = await f.prisma.notification.findMany({
    where: { orgId: f.orgId, source: f.assignmentId },
  });
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    userId: scheduler.userId,
    type: "assignment-confirmed",
  });
});

it("serves calendar data only for the link's crew and rejects revoked links", async () => {
  const f = await fixture();
  await f.prisma.serviceAssignment.update({
    where: { id: f.assignmentId },
    data: { callTime: "09:00" },
  });
  const token = await invite(f);
  const calendar = await getCrewScheduleCalendar(token, f.assignmentId);
  expect(calendar.content).toContain("BEGIN:VCALENDAR");
  expect(calendar.content).toContain("Audio");
  const other = await fixture();
  await expect(
    getCrewScheduleCalendar(token, other.assignmentId),
  ).rejects.toThrow("Assignment not found");
  await env.DB.prepare(
    "UPDATE crew_schedule_access SET revokedAt=CURRENT_TIMESTAMP WHERE orgId=?",
  )
    .bind(f.orgId)
    .run();
  await expect(getCrewScheduleCalendar(token, f.assignmentId)).rejects.toThrow(
    "revoked",
  );
});
