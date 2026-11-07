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
}));
vi.mock("@/lib/session", () => ({
  getOrgMembers: api.members,
  getOrgInvitations: api.invitations,
  updateMemberRole: api.role,
  removeMember: api.remove,
  cancelInvitation: api.cancel,
  inviteMember: vi.fn(),
}));
vi.mock("@/lib/content-moderation", () => ({
  getContentReports: api.reports,
  closeContentReport: api.close,
}));
vi.mock("@/lib/access-grants", () => ({
  getAccessManagementSnapshot: api.access,
}));
vi.mock("@/lib/data", () => ({ getCrewMembers: api.crew }));
vi.mock("@/components/admin/AccessManagementTab", () => ({
  AccessManagementTab: () => <p>Access editor</p>,
}));
vi.mock("@/components/admin/MemberTable", () => ({
  MemberTable: () => <p>Crew editor</p>,
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
const invitation = {
  id: "invitation-id",
  organizationId: "org-id",
  inviterId: "actor",
  email: "invited@example.test",
  role: "member",
  status: "pending",
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
  canViewCrew: false,
  orgMembers: [member],
  invitations: [invitation],
  contentReports: [report],
  crewMembers: [],
  accessManagement: {
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
  api.crew.mockResolvedValue([]);
  api.role.mockResolvedValue({});
  api.remove.mockResolvedValue({});
  api.cancel.mockResolvedValue({});
  api.close.mockResolvedValue({ ok: true });
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.useRealTimers();
});
async function open() {
  render(<TeamWorkspace initial={initial} />);
  await act(async () => {});
}

it("keeps the exact failed role command available after switching tabs", async () => {
  api.role.mockRejectedValueOnce(new Error("Reply lost"));
  await open();
  fireEvent.change(
    screen.getByRole("combobox", { name: "Role for Casey Crew" }),
    { target: { value: "tm" } },
  );
  await act(async () => {});
  expect(
    screen.getByRole("alert", { name: "Team change" }).textContent,
  ).toContain("Reply lost");
  const original = api.role.mock.calls[0][0].data;
  expect(original).toMatchObject({
    orgId: "org-id",
    memberId: "membership-id",
    role: "tm",
    expectedRevision: 3,
    requestId: expect.any(String),
  });
  fireEvent.click(screen.getByRole("tab", { name: /Reports/ }));
  expect(
    screen
      .getByRole("button", { name: "Mark resolved" })
      .hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Retry change" }));
  await act(async () => {});
  expect(api.role).toHaveBeenCalledTimes(2);
  expect(api.role.mock.calls[1][0].data).toEqual(original);
  expect(screen.queryByRole("alert", { name: "Team change" })).toBeNull();
});

it("retries only the read after a confirmed change whose refresh fails", async () => {
  await open();
  api.members.mockRejectedValueOnce(new Error("Read failed"));
  fireEvent.change(
    screen.getByRole("combobox", { name: "Role for Casey Crew" }),
    { target: { value: "tm" } },
  );
  await act(async () => {});
  expect(
    screen.getByRole("alert", { name: "Team change" }).textContent,
  ).toContain("Change saved.");
  fireEvent.click(screen.getByRole("button", { name: "Retry refresh" }));
  await act(async () => {});
  expect(api.role).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("alert", { name: "Team change" })).toBeNull();
});

it("confirms removal by name and sends the membership ID and displayed revision", async () => {
  await open();
  fireEvent.click(screen.getByRole("button", { name: "Remove Casey Crew" }));
  expect(api.remove).not.toHaveBeenCalled();
  const dialog = screen.getByRole("dialog");
  expect(dialog.textContent).toContain("casey@example.test");
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Remove member" }),
  );
  await act(async () => {});
  expect(api.remove.mock.calls[0][0].data).toMatchObject({
    memberIdOrEmail: "membership-id",
    expectedRevision: 3,
    orgId: "org-id",
    requestId: expect.any(String),
  });
});

it("requires invitation cancellation confirmation and recovers a failed cancellation", async () => {
  api.cancel.mockRejectedValueOnce(new Error("Cancellation not confirmed"));
  await open();
  fireEvent.click(
    screen.getByRole("button", {
      name: "Cancel invitation for invited@example.test",
    }),
  );
  expect(api.cancel).not.toHaveBeenCalled();
  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: "Keep invitation",
    }),
  );
  expect(api.cancel).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", {
      name: "Cancel invitation for invited@example.test",
    }),
  );
  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: "Cancel invitation",
    }),
  );
  await act(async () => {});
  expect(
    screen.getByRole("alert", { name: "Team change" }).textContent,
  ).toContain("Cancellation not confirmed");
  fireEvent.click(screen.getByRole("button", { name: "Retry change" }));
  await act(async () => {});
  expect(api.cancel.mock.calls[1][0].data).toEqual(
    api.cancel.mock.calls[0][0].data,
  );
});

it("confirms moderation and retains its decision for Retry", async () => {
  api.close.mockRejectedValueOnce(new Error("Decision not confirmed"));
  await open();
  fireEvent.click(screen.getByRole("tab", { name: /Reports/ }));
  fireEvent.click(screen.getByRole("button", { name: "Mark resolved" }));
  expect(api.close).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog").textContent).toContain("Casey Crew");
  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: "Resolve report",
    }),
  );
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Retry change" }));
  await act(async () => {});
  expect(api.close.mock.calls[0][0].data).toMatchObject({
    reportId: "report-id",
    status: "resolved",
    requestId: expect.any(String),
  });
  expect(api.close.mock.calls[1][0].data).toEqual(
    api.close.mock.calls[0][0].data,
  );
});

it("bounds a hanging write and retains a failed team read without showing an empty team", async () => {
  vi.useFakeTimers();
  await open();
  api.role.mockImplementationOnce(() => new Promise(() => {}));
  fireEvent.change(
    screen.getByRole("combobox", { name: "Role for Casey Crew" }),
    { target: { value: "tm" } },
  );
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  expect(screen.getByRole("button", { name: "Retry change" })).toBeTruthy();
  expect(screen.getByText("Casey Crew")).toBeTruthy();
  api.members.mockImplementationOnce(() => new Promise(() => {}));
  fireEvent.click(screen.getByRole("button", { name: "Retry change" }));
  await act(() => vi.advanceTimersByTimeAsync(8_000));
  expect(screen.getByRole("button", { name: "Retry team" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Retry refresh" })).toBeTruthy();
  expect(screen.getByText("Casey Crew")).toBeTruthy();
  expect(screen.queryByText(/Refreshing team/)).toBeNull();
});

it("supports arrow, Home and End navigation with one focusable selected tab", async () => {
  await open();
  const members = screen.getByRole("tab", { name: /Members/ }),
    reports = screen.getByRole("tab", { name: /Reports/ });
  members.focus();
  fireEvent.keyDown(members, { key: "ArrowRight" });
  expect(document.activeElement).toBe(reports);
  expect(reports.getAttribute("aria-selected")).toBe("true");
  expect(members.tabIndex).toBe(-1);
  expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(
    reports.id,
  );
  fireEvent.keyDown(reports, { key: "Home" });
  expect(document.activeElement).toBe(members);
  fireEvent.keyDown(members, { key: "End" });
  expect(document.activeElement).toBe(reports);
  fireEvent.keyDown(reports, { key: "ArrowRight" });
  expect(document.activeElement).toBe(members);
});
