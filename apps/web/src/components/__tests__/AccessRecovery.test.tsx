import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TeamWorkspace } from "@/routes/$slug/team";

const api = vi.hoisted(() => ({
  members: vi.fn(),
  invitations: vi.fn(),
  reports: vi.fn(),
  access: vi.fn(),
  crew: vi.fn(),
  role: vi.fn(),
  remove: vi.fn(),
  cancel: vi.fn(),
  close: vi.fn(),
  invite: vi.fn(),
  retryEmail: vi.fn(),
  grant: vi.fn(),
  revoke: vi.fn(),
  retryNotice: vi.fn(),
  createCrew: vi.fn(),
  updateCrew: vi.fn(),
  deleteCrew: vi.fn(),
}));
vi.mock("@/lib/session", () => ({
  getOrgMembers: api.members,
  getOrgInvitations: api.invitations,
  updateMemberRole: api.role,
  removeMember: api.remove,
  cancelInvitation: api.cancel,
  inviteMember: api.invite,
  retryTeamInvitationDelivery: api.retryEmail,
}));
vi.mock("@/lib/content-moderation", () => ({
  getContentReports: api.reports,
  closeContentReport: api.close,
}));
vi.mock("@/lib/access-grants", () => ({
  getAccessManagementSnapshot: api.access,
  grantMemberAccess: api.grant,
  revokeMemberAccess: api.revoke,
  retryAccessGrantNotification: api.retryNotice,
}));
vi.mock("@/lib/data", () => ({
  getCrewMembers: api.crew,
  addCrewMember: api.createCrew,
  updateCrewMember: api.updateCrew,
  deleteCrewMember: api.deleteCrew,
}));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => () => ({}),
  useBlocker: () => ({ status: "idle" }),
}));

const member = {
  id: "membership-id",
  userId: "user-id",
  organizationId: "org-id",
  managementRevision: 3,
  role: "member",
  createdAt: new Date(),
  user: {
    id: "user-id",
    name: "Casey Crew",
    email: "casey@example.test",
    image: null,
  },
};
const invitation: React.ComponentProps<
  typeof TeamWorkspace
>["initial"]["invitations"][number] = {
  id: "invitation-id",
  organizationId: "org-id",
  inviterId: "actor",
  email: "invited@example.test",
  role: "member",
  status: "pending",
  delivery: { id: null, state: "unknown", retryable: false, updatedAt: null },
  createdAt: new Date(),
  expiresAt: new Date(Date.now() + 3600_000),
};
const report = {
  id: "report-id",
  reporterName: "Casey Crew",
  targetType: "chat-message" as const,
  targetId: "message-id",
  targetAuthorName: "Alex",
  reason: "other",
  details: "Please review this message.",
  status: "open" as const,
  createdAt: new Date().toISOString(),
};
const initial = {
  orgId: "org-id",
  canManageMembers: true,
  canViewCrew: true,
  orgMembers: [member],
  invitations: [invitation],
  contentReports: [report],
  crewMembers: [
    {
      id: "crew-id",
      orgId: "org-id",
      memberId: "CAM42",
      name: "Casey Crew",
      role: "Camera Operator",
      email: "casey@example.test",
      photoUrl: "",
      isOnline: false,
      profileRevision: 4,
      createdAt: new Date(),
      lastCheckIn: null,
      lastCheckOut: null,
    },
  ],
  accessManagement: {
    notices: [],
    currentUserId: "actor",
    authority: {
      canManage: true,
      kind: "permanent" as const,
      today: "2026-11-07",
      weekStart: "2026-11-01",
      weekEndExclusive: "2026-11-08",
    },
    members: [{ userId: member.userId, role: member.role, user: member.user }],
    grants: [
      {
        id: "grant-id",
        userId: member.userId,
        capability: "device-operator",
        permissions: '["devices:access"]',
        startsOn: "2026-11-01",
        expiresOn: null,
        reason: "Device cover",
        grantedByUserId: "actor",
        createdAt: new Date(),
        grantedBy: { name: "Owner" },
        canRevoke: true,
      },
    ],
  },
} satisfies React.ComponentProps<typeof TeamWorkspace>["initial"];
beforeEach(() => {
  api.grant.mockImplementation(async ({ data }) => ({
    ok: true,
    id: "new-grant",
    requestId: data.requestId,
    kind: "grant",
    state: "active",
    notification: "created",
  }));
  api.revoke.mockImplementation(async ({ data }) => ({
    ok: true,
    id: data.grantId,
    requestId: data.requestId,
    kind: "revoke",
    state: "revoked",
    notification: "created",
  }));
  api.retryNotice.mockImplementation(async ({ data }) => ({
    ok: true,
    id: "new-grant",
    requestId: data.requestId,
    kind: "grant",
    state: "active",
    notification: "created",
  }));
  api.members.mockResolvedValue(initial.orgMembers);
  api.invitations.mockResolvedValue(initial.invitations);
  api.reports.mockResolvedValue(initial.contentReports);
  api.access.mockResolvedValue(initial.accessManagement);
  api.crew.mockResolvedValue(initial.crewMembers);
  api.createCrew.mockImplementation(async ({ data }) => ({
    id: "new-id",
    requestId: data.requestId,
    kind: "create",
  }));
  api.updateCrew.mockImplementation(async ({ data }) => ({
    id: data.id,
    requestId: data.requestId,
    kind: "update",
  }));
  api.deleteCrew.mockImplementation(async ({ data }) => ({
    id: data.id,
    requestId: data.requestId,
    kind: "delete",
  }));
  api.role.mockResolvedValue({});
  api.remove.mockResolvedValue({});
  api.cancel.mockResolvedValue({});
  api.close.mockResolvedValue({ ok: true });
  api.invite.mockResolvedValue(invitation);
  api.retryEmail.mockResolvedValue(invitation);
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.useRealTimers();
});
async function open() {
  render(<TeamWorkspace initial={initial} />);
  await act(async () => {});
  fireEvent.click(screen.getByRole("tab", { name: /Access/ }));
}
async function fillGrant() {
  fireEvent.click(screen.getByRole("button", { name: "Grant access" }));
  fireEvent.change(screen.getByLabelText("Capability"), {
    target: { value: "rundown-operator" },
  });
  fireEvent.change(screen.getByLabelText(/Reason/), {
    target: { value: "Covering Sunday" },
  });
}
async function click(label: string) {
  fireEvent.click(screen.getByRole("button", { name: label }));
  await act(async () => {});
}

it("keeps a grant draft across closing and tabs and retries the exact reviewed week", async () => {
  api.grant.mockRejectedValueOnce(new Error("Grant reply lost"));
  await open();
  await fillGrant();
  await click("Close grant form");
  fireEvent.click(screen.getByRole("tab", { name: /Members/ }));
  fireEvent.click(screen.getByRole("tab", { name: /Access/ }));
  await click("Resume access draft");
  expect(screen.getByLabelText(/Reason/)).toHaveProperty(
    "value",
    "Covering Sunday",
  );
  await click("Grant access");
  const original = api.grant.mock.calls[0][0].data;
  expect(original).toMatchObject({
    reason: "Covering Sunday",
    expectedWeekStart: "2026-11-01",
    requestId: expect.any(String),
  });
  expect(
    screen.getByRole("alert", { name: "Team change" }).textContent,
  ).toContain("Grant reply lost");
  fireEvent.click(screen.getByRole("tab", { name: /Members/ }));
  await click("Retry change");
  expect(api.grant.mock.calls[1][0].data).toEqual(original);
  fireEvent.click(screen.getByRole("tab", { name: /Access/ }));
  expect(
    screen.queryByRole("button", { name: "Resume access draft" }),
  ).toBeNull();
});

it("retries only the read after confirmed access and reports a pending member notification", async () => {
  api.grant.mockImplementation(async ({ data }) => ({
    ok: true,
    id: "new-grant",
    requestId: data.requestId,
    kind: "grant",
    state: "active",
    notification: "pending",
  }));
  await open();
  await fillGrant();
  api.access.mockRejectedValueOnce(new Error("Access list unavailable"));
  await click("Grant access");
  expect(
    screen.getByRole("alert", { name: "Team change" }).textContent,
  ).toContain("Change saved.");
  expect(screen.getByText(/The member notification is pending/)).toBeTruthy();
  await click("Retry refresh");
  expect(api.grant).toHaveBeenCalledTimes(1);
});

it("confirms a named revoke and retains its identity after a lost response", async () => {
  api.revoke.mockRejectedValueOnce(new Error("Revoke reply lost"));
  await open();
  await click("Revoke");
  expect(api.revoke).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog").textContent).toContain("Casey Crew");
  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: "Revoke access",
    }),
  );
  await act(async () => {});
  const original = api.revoke.mock.calls[0][0].data;
  expect(original).toMatchObject({
    grantId: "grant-id",
    expectedWeekStart: "2026-11-01",
  });
  await click("Retry change");
  expect(api.revoke.mock.calls[1][0].data).toEqual(original);
});

it("confirms draft discard and preserves choices when cancelled", async () => {
  await open();
  await fillGrant();
  await click("Discard draft");
  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }),
  );
  await act(async () => {});
  expect(screen.getByLabelText(/Reason/)).toHaveProperty(
    "value",
    "Covering Sunday",
  );
  await click("Discard draft");
  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: "Discard draft",
    }),
  );
  await act(async () => {});
  expect(
    screen.queryByRole("button", { name: "Resume access draft" }),
  ).toBeNull();
});

it("bounds an unresponsive grant and ignores a late response after exact retry", async () => {
  vi.useFakeTimers();
  let settle: (value: unknown) => void = () => {};
  api.grant.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        settle = resolve;
      }),
  );
  await open();
  await fillGrant();
  await click("Grant access");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_001);
  });
  expect(
    screen.getByRole("alert", { name: "Team change" }).textContent,
  ).toContain("did not finish");
  const original = api.grant.mock.calls[0][0].data;
  await click("Retry change");
  expect(api.grant.mock.calls[1][0].data).toEqual(original);
  const reads = api.access.mock.calls.length;
  await act(async () => {
    settle({
      ok: true,
      id: "new-grant",
      requestId: original.requestId,
      kind: "grant",
      state: "active",
      notification: "created",
    });
  });
  expect(api.access).toHaveBeenCalledTimes(reads);
});

it("retries a pending notification separately without creating another grant or losing a draft", async () => {
  const requestId = "b5c6af94-c77c-43cd-a71a-d7349c7c9fd0";
  const notices = [
    {
      requestId,
      kind: "grant" as const,
      grantId: "new-grant",
      title: "Access granted",
      message: "The member notification is pending.",
    },
  ];
  const withNotice = {
    ...initial,
    accessManagement: { ...initial.accessManagement, notices },
  };
  api.access.mockResolvedValue(withNotice.accessManagement);
  api.retryNotice.mockRejectedValueOnce(new Error("Notification unavailable"));
  render(<TeamWorkspace initial={withNotice} />);
  await act(async () => {});
  fireEvent.click(screen.getByRole("tab", { name: /Access/ }));
  await fillGrant();
  await click("Retry notification");
  expect(api.grant).not.toHaveBeenCalled();
  expect(api.retryNotice.mock.calls[0][0].data).toEqual({
    orgId: initial.orgId,
    requestId,
  });
  await click("Retry change");
  expect(api.retryNotice.mock.calls[1][0].data).toEqual({
    orgId: initial.orgId,
    requestId,
  });
  expect(api.grant).not.toHaveBeenCalled();
  expect(screen.getByLabelText(/Reason/)).toHaveProperty(
    "value",
    "Covering Sunday",
  );
});

it("keeps the reviewed duty week when a refreshed snapshot advances to a new week", async () => {
  const view = render(<TeamWorkspace initial={initial} />);
  await act(async () => {});
  fireEvent.click(screen.getByRole("tab", { name: /Access/ }));
  await fillGrant();
  const next = {
    ...initial,
    accessManagement: {
      ...initial.accessManagement,
      authority: {
        ...initial.accessManagement.authority,
        today: "2026-11-08",
        weekStart: "2026-11-08",
        weekEndExclusive: "2026-11-15",
      },
    },
  };
  api.access.mockResolvedValue(next.accessManagement);
  view.rerender(<TeamWorkspace initial={next} />);
  await act(async () => {});
  expect(screen.getByText(/The duty week changed/)).toBeTruthy();
  await click("Grant access");
  expect(api.grant.mock.calls[0][0].data.expectedWeekStart).toBe("2026-11-01");
});
