import { env } from "cloudflare:workers";
import { beforeEach, expect, it, vi } from "vitest";
import { getPrisma } from "../db";
import { EmailDeliveryRejected } from "../email";
import {
  getCrewSchedulePortal,
  sendCrewScheduleInvite,
} from "../crew-schedule";

const delivery = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../email", async (original) => ({
  ...(await original<typeof import("../email")>()),
  sendEmail: delivery.send,
}));
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    const chain = {
      inputValidator: () => chain,
      handler: (handler: unknown) => handler,
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
  const serviceDate = new Date(Date.now() + 20 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  await prisma.organization.create({
    data: {
      id: orgId,
      name: "Invitation recovery fixture",
      slug: orgId,
      createdAt: new Date(),
    },
  });
  await prisma.crewMember.create({
    data: {
      id: crewMemberId,
      orgId,
      memberId: crewMemberId,
      name: "Fixture crew",
      email: "fixture@example.test",
      role: "Audio",
    },
  });
  await prisma.serviceAssignment.create({
    data: { id: assignmentId, orgId, crewMemberId, serviceDate, role: "Audio" },
  });
  return {
    orgId,
    crewMemberId,
    assignmentId,
    serviceDate,
    role: "Audio",
    origin: "https://app.showpilot.tech",
    reminder: true,
    requestId: crypto.randomUUID(),
  };
}
it("keeps an invitation usable when email acceptance is uncertain", async () => {
  const f = await fixture();
  const { orgId, assignmentId } = f;
  let receivedToken = "";
  // The provider may have accepted this exact email before its reply was lost.
  // Capture its rendered link without sending any external email.
  delivery.send.mockImplementationOnce(async (message: { html: string }) => {
    receivedToken =
      message.html.match(
        /https:\/\/app\.showpilot\.tech\/crew\/schedule\/([A-Za-z0-9_-]+)/,
      )?.[1] ?? "";
    throw new TypeError("Email provider reply lost after acceptance");
  });
  await expect(sendCrewScheduleInvite(f)).resolves.toMatchObject({
    delivered: false,
    emailState: "uncertain",
  });
  expect(receivedToken).toHaveLength(43);
  expect(
    await env.DB.prepare(
      "SELECT id FROM crew_schedule_access WHERE orgId=? AND assignmentId=?",
    )
      .bind(orgId, assignmentId)
      .first(),
  ).not.toBeNull();
  await expect(
    getCrewSchedulePortal({ data: { token: receivedToken } }),
  ).resolves.toMatchObject({ initialAssignmentId: assignmentId });
});

it("reuses the frozen email, provider key and link after an uncertain reply, then never resends an accepted attempt", async () => {
  const f = await fixture();
  delivery.send.mockRejectedValueOnce(new TypeError("lost reply"));
  expect(await sendCrewScheduleInvite(f)).toMatchObject({
    emailState: "uncertain",
  });
  const first = delivery.send.mock.calls[0][0];
  expect(await sendCrewScheduleInvite(f)).toMatchObject({
    emailState: "accepted",
  });
  const second = delivery.send.mock.calls[1][0];
  expect({ ...first, signal: undefined }).toEqual({
    ...second,
    signal: undefined,
  });
  expect(await sendCrewScheduleInvite(f)).toMatchObject({
    emailState: "accepted",
  });
  expect(delivery.send).toHaveBeenCalledTimes(2);
  const rows = await env.DB.prepare(
    "SELECT payload,fingerprint FROM schedule_invitation_delivery WHERE orgId=?",
  )
    .bind(f.orgId)
    .all<{ payload: string; fingerprint: string }>();
  expect(rows.results).toHaveLength(1);
  expect(rows.results[0].payload).toMatch(/^spenc:v1:/);
  expect(rows.results[0].payload).not.toContain(first.to);
  expect(rows.results[0].payload).not.toContain("crew/schedule/");
  expect(rows.results[0].fingerprint).toHaveLength(64);
  const tokens = await env.DB.prepare(
    "SELECT id FROM crew_schedule_access WHERE orgId=?",
  )
    .bind(f.orgId)
    .all();
  expect(tokens.results).toHaveLength(1);
});

it("reports a definite rejection separately and retries the same prepared link", async () => {
  const f = await fixture();
  delivery.send.mockRejectedValueOnce(new EmailDeliveryRejected("rejected"));
  expect(await sendCrewScheduleInvite(f)).toMatchObject({
    emailState: "failed",
    delivered: false,
  });
  expect(await sendCrewScheduleInvite(f)).toMatchObject({
    emailState: "accepted",
  });
  expect(delivery.send.mock.calls[1][0].html).toBe(
    delivery.send.mock.calls[0][0].html,
  );
});

it("coalesces concurrent execution of the same email attempt", async () => {
  const f = await fixture();
  let finish!: () => void;
  delivery.send.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const pending = sendCrewScheduleInvite(f);
  await vi.waitFor(() => expect(delivery.send).toHaveBeenCalledTimes(1));
  expect(await sendCrewScheduleInvite(f)).toMatchObject({
    emailState: "sending",
  });
  finish();
  expect(await pending).toMatchObject({ emailState: "accepted" });
  expect(delivery.send).toHaveBeenCalledTimes(1);
});

it("does not replay stale assignment details or another recipient", async () => {
  const f = await fixture();
  delivery.send.mockRejectedValueOnce(new TypeError("lost reply"));
  await sendCrewScheduleInvite(f);
  await env.DB.prepare(
    "UPDATE crew_member SET email='new@example.test' WHERE orgId=? AND id=?",
  )
    .bind(f.orgId, f.crewMemberId)
    .run();
  expect(await sendCrewScheduleInvite(f)).toMatchObject({
    emailState: "changed",
  });
  expect(delivery.send).toHaveBeenCalledTimes(1);
});

it("refuses automatic retry after the provider deduplication window", async () => {
  const f = await fixture();
  delivery.send.mockRejectedValueOnce(new TypeError("lost reply"));
  await sendCrewScheduleInvite(f);
  await env.DB.prepare(
    "UPDATE schedule_invitation_delivery SET firstSentAt=? WHERE orgId=?",
  )
    .bind(Date.now() - 24 * 3600_000, f.orgId)
    .run();
  expect(await sendCrewScheduleInvite(f)).toMatchObject({
    emailState: "expired",
  });
  expect(delivery.send).toHaveBeenCalledTimes(1);
});

it("bounds a hung provider and ignores its late acknowledgement", async () => {
  const f = await fixture();
  let finish!: () => void;
  delivery.send.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  expect(await sendCrewScheduleInvite(f)).toMatchObject({
    emailState: "uncertain",
    delivered: false,
  });
  expect(delivery.send.mock.calls[0][0].signal.aborted).toBe(true);
  finish();
  await Promise.resolve();
  const row = await env.DB.prepare(
    "SELECT state FROM schedule_invitation_delivery WHERE orgId=?",
  )
    .bind(f.orgId)
    .first<{ state: string }>();
  expect(row?.state).toBe("uncertain");
}, 15_000);

it("fails closed when authority changes before preparation", async () => {
  const f = await fixture();
  expect(
    await sendCrewScheduleInvite({ ...f, authority: { sql: "0", args: [] } }),
  ).toMatchObject({ emailState: "changed" });
  expect(delivery.send).not.toHaveBeenCalled();
  expect(
    await env.DB.prepare("SELECT id FROM crew_schedule_access WHERE orgId=?")
      .bind(f.orgId)
      .first(),
  ).toBeNull();
});

it("does not mark newer assignment details invited after a late email acknowledgement", async () => {
  const f = await fixture();
  delivery.send.mockImplementationOnce(async () => {
    await env.DB.prepare(
      "UPDATE service_assignment SET role='Changed duty',invitedAt=NULL WHERE orgId=? AND id=?",
    )
      .bind(f.orgId, f.assignmentId)
      .run();
  });
  expect(await sendCrewScheduleInvite(f)).toMatchObject({
    emailState: "accepted",
  });
  const row = await env.DB.prepare(
    "SELECT invitedAt FROM service_assignment WHERE orgId=? AND id=?",
  )
    .bind(f.orgId, f.assignmentId)
    .first<{ invitedAt: string | null }>();
  expect(row?.invitedAt).toBeNull();
});
