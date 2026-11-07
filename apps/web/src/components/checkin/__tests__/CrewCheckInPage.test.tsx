import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CrewCheckInPage } from "../CrewCheckInPage";
import { getCheckInMembers, changeCrewAttendance } from "@/lib/crew-attendance";
import { crewAttendanceWriteSchema, type CrewAttendanceMember, type CrewAttendanceResult } from "@/lib/crew-attendance-writes";
vi.mock("@tanstack/react-router", () => ({ useBlocker: () => ({ status: "idle" }), Link: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }));
vi.mock("@/lib/crew-attendance", () => ({ getCheckInMembers: vi.fn(), changeCrewAttendance: vi.fn() }));
const initial: CrewAttendanceMember[] = [
  { id: "crew-a", memberId: "TD1", name: "Taylor", role: "Director", photoUrl: "", isOnline: false, revision: "a".repeat(64) },
  { id: "crew-b", memberId: "CAM2", name: "Casey", role: "Camera", photoUrl: "", isOnline: false, revision: "b".repeat(64) },
];
let roster: CrewAttendanceMember[];
beforeEach(() => {
  roster = structuredClone(initial);
  vi.mocked(getCheckInMembers).mockImplementation(async () => structuredClone(roster));
  vi.mocked(changeCrewAttendance).mockImplementation(async options => {
    const input = crewAttendanceWriteSchema.parse(options && "data" in options ? options.data : undefined);
    roster = roster.map(member => input.members.some(target => target.id === member.id) ? { ...member, isOnline: input.isOnline, revision: "c".repeat(64) } : member);
    return { requestId: input.requestId, outcome: "applied", changedCount: input.members.length };
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.resetAllMocks(); vi.useRealTimers(); });
function setup() { return render(<CrewCheckInPage key="org-a" orgId="org-a" slug="fixture" initialMembers={initial} />); }
const flush = () => act(async () => { await Promise.resolve(); });
it("shows row write failures and retries the original change across view switches", async () => {
  vi.mocked(changeCrewAttendance).mockRejectedValueOnce(new Error("Network failed"));
  setup(); fireEvent.click(screen.getByRole("button", { name: "Browse crew" }));
  fireEvent.click(await screen.findByRole("button", { name: "Check Taylor in" }));
  const alert = await screen.findByRole("alert"); expect(alert.querySelector("time")).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Enter member ID" }));
  expect(screen.getByRole("button", { name: "Retry attendance" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry attendance" }));
  expect(await screen.findByText("Taylor: checked in")).toBeTruthy();
  const calls = vi.mocked(changeCrewAttendance).mock.calls;
  expect(calls[1][0]).toEqual(expect.objectContaining({ data: calls[0][0] && "data" in calls[0][0] ? calls[0][0].data : undefined }));
});
it("never repeats a confirmed write when its follow-up read times out", async () => {
  vi.useFakeTimers(); setup(); await flush();
  vi.mocked(getCheckInMembers).mockImplementationOnce(() => new Promise(() => {}));
  fireEvent.click(screen.getByRole("button", { name: "Browse crew" })); fireEvent.click(screen.getByRole("button", { name: "Check Taylor in" })); await flush();
  await act(async () => { await vi.advanceTimersByTimeAsync(8_000); });
  expect(screen.getByText(/Attendance change saved/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Retry crew list" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Check Taylor in" })).toHaveProperty("disabled", true);
  fireEvent.click(screen.getByRole("button", { name: "Retry crew list" })); await flush();
  expect(screen.getByRole("button", { name: "Check Taylor out" })).toHaveProperty("disabled", false);
  expect(changeCrewAttendance).toHaveBeenCalledTimes(1);
});
it("requires confirmation for the captured whole roster even with a filtered search", async () => {
  setup(); fireEvent.click(screen.getByRole("button", { name: "Browse crew" }));
  fireEvent.change(screen.getByLabelText("Search crew"), { target: { value: "Taylor" } });
  fireEvent.click(screen.getByRole("button", { name: "Check all 2 crew in" }));
  fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }));
  expect(changeCrewAttendance).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Check all 2 crew in" }));
  fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Check crew in" }));
  await waitFor(() => expect(changeCrewAttendance).toHaveBeenCalledTimes(1));
  expect(changeCrewAttendance).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ members: initial.map(member => ({ id: member.id, expectedRevision: member.revision })) }) }));
});
it("keeps a conflict until the operator reviews refreshed attendance", async () => {
  vi.mocked(changeCrewAttendance).mockImplementationOnce(async options => {
    const input = crewAttendanceWriteSchema.parse(options && "data" in options ? options.data : undefined);
    roster[0] = { ...roster[0], isOnline: true, revision: "d".repeat(64) };
    return { requestId: input.requestId, outcome: "conflict", changedCount: 0 };
  });
  setup(); fireEvent.click(screen.getByRole("button", { name: "Browse crew" })); fireEvent.click(screen.getByRole("button", { name: "Check Taylor in" }));
  const review = await screen.findByRole("button", { name: "Review updated crew" });
  await waitFor(() => expect(review).toHaveProperty("disabled", false));
  expect(screen.getByRole("button", { name: "Check Taylor out" })).toHaveProperty("disabled", true);
  fireEvent.click(review); expect(screen.getByRole("button", { name: "Check Taylor out" })).toHaveProperty("disabled", false);
  expect(changeCrewAttendance).toHaveBeenCalledTimes(1);
});
it("uses the member-ID flow to select an explicit attendance intent instead of toggling on every submit", async () => {
  setup(); fireEvent.change(screen.getByLabelText("Member ID"), { target: { value: "td1" } });
  fireEvent.click(screen.getByRole("button", { name: "Find crew member" }));
  expect(changeCrewAttendance).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Check Taylor in" }));
  expect(await screen.findByText("Taylor: checked in")).toBeTruthy();
  expect(screen.getByText("Join Production Chat")).toBeTruthy();
  expect(changeCrewAttendance).toHaveBeenCalledTimes(1);
});
it("retains a missing-ID explanation instead of clearing it after four seconds", async () => {
  vi.useFakeTimers(); setup(); await flush(); fireEvent.change(screen.getByLabelText("Member ID"), { target: { value: "MISSING" } });
  fireEvent.click(screen.getByRole("button", { name: "Find crew member" }));
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(screen.getByRole("alert").textContent).toContain("Member not found");
  expect(screen.getByLabelText("Member ID")).toHaveProperty("value", "MISSING");
});
it("does not display another organization's pending result after a route switch", async () => {
  let acknowledge: (value: CrewAttendanceResult) => void = () => {};
  vi.mocked(changeCrewAttendance).mockReturnValueOnce(new Promise(resolve => { acknowledge = resolve; }));
  const rendered = setup(); fireEvent.click(screen.getByRole("button", { name: "Browse crew" })); fireEvent.click(screen.getByRole("button", { name: "Check Taylor in" }));
  const options = vi.mocked(changeCrewAttendance).mock.calls[0][0];
  const attempt = crewAttendanceWriteSchema.parse(options && "data" in options ? options.data : undefined);
  roster = []; rendered.rerender(<CrewCheckInPage key="org-b" orgId="org-b" slug="other" initialMembers={[]} />);
  await act(async () => acknowledge({ requestId: attempt.requestId, outcome: "applied", changedCount: 1 }));
  expect(screen.queryByText(/Attendance change saved/)).toBeNull(); expect(screen.queryByText("Taylor: checked in")).toBeNull();
});


it("refreshes and unlocks controls when a write completes while the tab is hidden", async () => {
  let acknowledge: (value: CrewAttendanceResult) => void = () => {};
  vi.mocked(changeCrewAttendance).mockReturnValueOnce(new Promise(resolve => { acknowledge = resolve; }));
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  setup(); await flush(); fireEvent.click(screen.getByRole("button", { name: "Browse crew" })); fireEvent.click(screen.getByRole("button", { name: "Check Taylor in" }));
  const options = vi.mocked(changeCrewAttendance).mock.calls[0][0];
  const attempt = crewAttendanceWriteSchema.parse(options && "data" in options ? options.data : undefined);
  visibility.mockReturnValue("hidden"); fireEvent(document, new Event("visibilitychange"));
  roster[0] = { ...roster[0], isOnline: true, revision: "e".repeat(64) };
  await act(async () => acknowledge({ requestId: attempt.requestId, outcome: "applied", changedCount: 1 }));
  expect(screen.getByText(/Latest attendance has not yet been confirmed/)).toBeTruthy();
  visibility.mockReturnValue("visible"); fireEvent(document, new Event("visibilitychange"));
  await waitFor(() => expect(screen.getByRole("button", { name: "Check Taylor out" })).toHaveProperty("disabled", false));
  expect(changeCrewAttendance).toHaveBeenCalledTimes(1);
});
