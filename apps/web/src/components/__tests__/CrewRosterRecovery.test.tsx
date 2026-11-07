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
}));
vi.mock("@/lib/data", () => ({
  getCrewMembers: api.crew,
  addCrewMember: api.createCrew,
  updateCrewMember: api.updateCrew,
  deleteCrewMember: api.deleteCrew,
}));
vi.mock("@/components/admin/AccessManagementTab", () => ({
  AccessManagementTab: () => <p>Access editor</p>,
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
      canManage: false,
      kind: "none" as const,
      today: "2026-11-07",
      weekStart: "2026-11-02",
      weekEndExclusive: "2026-11-09",
    },
    members: [],
    grants: [],
  },
} satisfies React.ComponentProps<typeof TeamWorkspace>["initial"];
beforeEach(() => {
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
  fireEvent.click(screen.getByRole("tab", { name: /Crew/ }));
}

async function fillNew() {
  fireEvent.click(screen.getByRole("button", { name: "Add crew member" }));
  await act(async () => {});
  fireEvent.change(screen.getByLabelText("Member ID"), {
    target: { value: "cam99" },
  });
  fireEvent.change(screen.getByLabelText("Full Name"), {
    target: { value: "New Camera" },
  });
  fireEvent.change(screen.getByLabelText("Role"), {
    target: { value: "Camera Operator" },
  });
}
async function submit(label: string) {
  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", { name: label }),
  );
  await act(async () => {});
}

it("retains a creation draft after closing and switching tabs, then retries the exact lost request", async () => {
  api.createCrew.mockRejectedValueOnce(new Error("Reply lost"));
  await open();
  await fillNew();
  await submit("Close editor");
  fireEvent.click(screen.getByRole("tab", { name: /Members/ }));
  fireEvent.click(screen.getByRole("tab", { name: /Crew/ }));
  fireEvent.click(screen.getByRole("button", { name: "Resume draft" }));
  expect(screen.getByLabelText("Full Name")).toHaveProperty(
    "value",
    "New Camera",
  );
  await submit("Add crew member");
  expect(
    screen.getByRole("alert", { name: "Team change" }).textContent,
  ).toContain("Reply lost");
  const original = api.createCrew.mock.calls[0][0].data;
  expect(original).toMatchObject({
    memberId: "CAM99",
    requestId: expect.any(String),
  });
  fireEvent.click(screen.getByRole("tab", { name: /Members/ }));
  fireEvent.click(screen.getByRole("button", { name: "Retry change" }));
  await act(async () => {});
  expect(api.createCrew.mock.calls[1][0].data).toEqual(original);
  fireEvent.click(screen.getByRole("tab", { name: /Crew/ }));
  expect(screen.queryByRole("button", { name: "Resume draft" })).toBeNull();
});

it("sends the displayed profile revision and retries only the read after confirmed save", async () => {
  await open();
  fireEvent.click(screen.getByRole("button", { name: "Edit Casey Crew" }));
  await act(async () => {});
  fireEvent.change(screen.getByLabelText("Full Name"), {
    target: { value: "Casey Updated" },
  });
  api.crew.mockRejectedValueOnce(new Error("Roster unavailable"));
  await submit("Save crew member");
  expect(api.updateCrew.mock.calls[0][0].data).toMatchObject({
    id: "crew-id",
    expectedRevision: 4,
    updates: { name: "Casey Updated" },
  });
  expect(
    screen.getByRole("alert", { name: "Team change" }).textContent,
  ).toContain("Change saved.");
  fireEvent.click(screen.getByRole("button", { name: "Retry refresh" }));
  await act(async () => {});
  expect(api.updateCrew).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("alert", { name: "Team change" })).toBeNull();
});

it("requires named removal confirmation and retains the exact delete after a lost reply", async () => {
  api.deleteCrew.mockRejectedValueOnce(new Error("Delete reply lost"));
  await open();
  fireEvent.click(screen.getByRole("button", { name: "Remove Casey Crew" }));
  expect(api.deleteCrew).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog").textContent).toContain("Casey Crew");
  await submit("Remove crew member");
  const original = api.deleteCrew.mock.calls[0][0].data;
  expect(original).toMatchObject({ id: "crew-id", expectedRevision: 4 });
  fireEvent.click(screen.getByRole("button", { name: "Retry change" }));
  await act(async () => {});
  expect(api.deleteCrew.mock.calls[1][0].data).toEqual(original);
});

it("requires explicit discard before replacing an unsaved draft", async () => {
  await open();
  await fillNew();
  await submit("Close editor");
  fireEvent.click(screen.getByRole("button", { name: "Edit Casey Crew" }));
  await submit("Keep draft");
  fireEvent.click(screen.getByRole("button", { name: "Resume draft" }));
  expect(screen.getByLabelText("Full Name")).toHaveProperty(
    "value",
    "New Camera",
  );
  await submit("Close editor");
  fireEvent.click(screen.getByRole("button", { name: "Edit Casey Crew" }));
  await submit("Discard draft");
  expect(screen.getByLabelText("Full Name")).toHaveProperty(
    "value",
    "Casey Crew",
  );
});

it("bounds a stalled creation and ignores its late reply after retry succeeds", async () => {
  vi.useFakeTimers();
  let settle: (value: unknown) => void = () => {};
  api.createCrew.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        settle = resolve;
      }),
  );
  await open();
  await fillNew();
  await submit("Add crew member");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_001);
  });
  expect(
    screen.getByRole("alert", { name: "Team change" }).textContent,
  ).toContain("did not finish");
  const original = api.createCrew.mock.calls[0][0].data;
  fireEvent.click(screen.getByRole("button", { name: "Retry change" }));
  await act(async () => {});
  expect(api.createCrew.mock.calls[1][0].data).toEqual(original);
  const readsBeforeLateReply = api.crew.mock.calls.length;
  await act(async () => {
    settle({ id: "new-id", requestId: original.requestId, kind: "create" });
  });
  expect(screen.queryByRole("alert", { name: "Team change" })).toBeNull();
  expect(api.crew).toHaveBeenCalledTimes(readsBeforeLateReply);
});
