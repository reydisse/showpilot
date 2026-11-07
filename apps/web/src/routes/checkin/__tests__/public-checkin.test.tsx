import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Route, CheckInKiosk } from "../$slug";
import { getPublicCrewMemberByMemberId, publicCheckInByMemberId } from "@/lib/data";
import { publicAttendanceWriteSchema, type PublicAttendanceResult, type PublicCrewMember } from "@/lib/public-checkin";
const routeData = vi.hoisted(() => ({ slug: "fixture", orgName: "Fixture" as string | null }));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: object) => ({ options, useLoaderData: () => routeData }),
  useBlocker: () => ({ status: "idle" }),
}));
vi.mock("@/lib/data", () => ({ getPublicCheckInOrg: vi.fn(), getPublicCrewMemberByMemberId: vi.fn(), publicCheckInByMemberId: vi.fn() }));
const member: PublicCrewMember = { memberId: "TD3917", name: "Fixture person", role: "Director", photoUrl: "", isOnline: false, revision: "a".repeat(64) };
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>(done => { resolve = done; });
  return { resolve, promise };
}
const flush = () => act(async () => { await Promise.resolve(); });
function page() {
  const Component = Route.options.component;
  if (!Component) throw new Error("Missing check-in page");
  return render(<Component />);
}
function enter() {
  fireEvent.change(screen.getByLabelText("Member ID"), { target: { value: "td3917" } });
  fireEvent.click(screen.getByRole("button", { name: "Find my name" }));
}
beforeEach(() => {
  routeData.orgName = "Fixture";
  vi.mocked(getPublicCrewMemberByMemberId).mockResolvedValue(member);
  vi.mocked(publicCheckInByMemberId).mockImplementation(async options => {
    const input = publicAttendanceWriteSchema.parse(options && "data" in options ? options.data : undefined);
    return { requestId: input.requestId, outcome: "applied", member: { ...member, isOnline: input.intent === "check-in" } };
  });
});
afterEach(() => { cleanup(); localStorage.clear(); vi.resetAllMocks(); vi.useRealTimers(); });
it("never restores another person's identity or attendance action from local storage", async () => {
  localStorage.setItem("showpilot-checkin:fixture:memberId", "TD3917");
  vi.mocked(getPublicCrewMemberByMemberId).mockResolvedValue({ ...member, name: "Previous person", isOnline: true });
  page();
  await waitFor(() => expect(localStorage.getItem("showpilot-checkin:fixture:memberId")).toBeNull());
  expect(getPublicCrewMemberByMemberId).not.toHaveBeenCalled(); expect(publicCheckInByMemberId).not.toHaveBeenCalled();
  expect(screen.queryByText("Previous person")).toBeNull(); expect(screen.queryByRole("button", { name: /check me out/i })).toBeNull();
});
it("requires fresh ID lookup and explicit identity confirmation before writing", async () => {
  page(); enter();
  expect(await screen.findByText("Is this you, Fixture person?")).toBeTruthy();
  expect(publicCheckInByMemberId).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Not me · use another ID" }));
  expect(screen.getByLabelText("Member ID")).toHaveProperty("value", "");
  enter(); fireEvent.click(await screen.findByRole("button", { name: "Yes, check me in" }));
  expect(await screen.findByText("Checked in")).toBeTruthy();
  expect(publicCheckInByMemberId).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ slug: "fixture", memberId: member.memberId, intent: "check-in", expectedRevision: member.revision }) }));
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(screen.getByLabelText("Member ID")).toHaveProperty("value", "");
  expect(localStorage.getItem("showpilot-checkin:fixture:memberId")).toBeNull();
});
it("keeps lookup errors visible with a timestamp and bounded Retry, ignoring the old reply", async () => {
  vi.useFakeTimers(); const old = deferred<PublicCrewMember | null>();
  vi.mocked(getPublicCrewMemberByMemberId).mockReturnValueOnce(old.promise);
  page(); enter(); await flush();
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  const alert = screen.getByRole("alert"); expect(alert.querySelector("time")).not.toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); old.resolve(member); });
  expect(screen.getByRole("alert")).toBe(alert);
  expect(screen.queryByText("Is this you, Fixture person?")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry lookup" })); await flush();
  expect(screen.getByText("Is this you, Fixture person?")).toBeTruthy();
  expect(getPublicCrewMemberByMemberId).toHaveBeenCalledTimes(2); expect(publicCheckInByMemberId).not.toHaveBeenCalled();
});
it("retries the exact uncertain attendance request and does not misreport later attendance", async () => {
  vi.useFakeTimers(); const old = deferred<PublicAttendanceResult>();
  vi.mocked(publicCheckInByMemberId).mockReturnValueOnce(old.promise);
  page(); enter(); await flush(); fireEvent.click(screen.getByRole("button", { name: "Yes, check me in" })); await flush();
  const first = vi.mocked(publicCheckInByMemberId).mock.calls[0][0];
  const input = publicAttendanceWriteSchema.parse(first && "data" in first ? first.data : undefined);
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(first?.signal?.aborted).toBe(true);
  await act(async () => old.resolve({ requestId: input.requestId, outcome: "applied", member: { ...member, isOnline: true } }));
  expect(screen.getByRole("button", { name: "Retry attendance" })).toBeTruthy();
  vi.mocked(publicCheckInByMemberId).mockResolvedValueOnce({ requestId: input.requestId, outcome: "applied", member });
  fireEvent.click(screen.getByRole("button", { name: "Retry attendance" })); await flush();
  expect(publicCheckInByMemberId).toHaveBeenLastCalledWith(expect.objectContaining({ data: input }));
  expect(screen.getByText("Attendance changed")).toBeTruthy(); expect(screen.queryByText("Checked in")).toBeNull();
});
it("requires confirmation before discarding an uncertain retry and retains it on Cancel", async () => {
  vi.mocked(publicCheckInByMemberId).mockRejectedValueOnce(new Error("Connection lost"));
  page(); enter(); fireEvent.click(await screen.findByRole("button", { name: "Yes, check me in" }));
  await screen.findByRole("button", { name: "Retry attendance" });
  fireEvent.click(screen.getByRole("button", { name: "Start over" }));
  fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }));
  expect(screen.getByRole("button", { name: "Retry attendance" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Start over" }));
  fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Start over" }));
  await screen.findByLabelText("Member ID");
  expect(publicCheckInByMemberId).toHaveBeenCalledTimes(1);
});
it("ignores a cancelled lookup and isolates the next organization's identity", async () => {
  const old = deferred<PublicCrewMember | null>(); vi.mocked(getPublicCrewMemberByMemberId).mockReturnValueOnce(old.promise);
  const rendered = render(<CheckInKiosk key="a" slug="a" orgName="A" />); enter(); await flush();
  fireEvent.click(screen.getByRole("button", { name: "Cancel lookup" }));
  await act(async () => old.resolve(member)); expect(screen.queryByText("Is this you, Fixture person?")).toBeNull();
  enter(); await screen.findByText("Is this you, Fixture person?");
  rendered.rerender(<CheckInKiosk key="b" slug="b" orgName="B" />);
  expect(screen.getByLabelText("Member ID")).toHaveProperty("value", "");
  expect(screen.queryByText("Is this you, Fixture person?")).toBeNull();
  expect(publicCheckInByMemberId).not.toHaveBeenCalled();
});
it("clears completed and abandoned identities without restoring them", async () => {
  vi.useFakeTimers(); page(); enter(); await flush();
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(screen.getByLabelText("Member ID")).toHaveProperty("value", "");
  enter(); await flush(); fireEvent.click(screen.getByRole("button", { name: "Yes, check me in" })); await flush();
  expect(screen.getByText("Checked in")).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
  expect(screen.getByLabelText("Member ID")).toHaveProperty("value", "");
  expect(publicCheckInByMemberId).toHaveBeenCalledTimes(1);
});
it("shows an organization-not-found page instead of redirecting to sign-in or Show Flow", () => {
  routeData.orgName = null; page();
  expect(screen.getByRole("heading", { name: "Organization not found" })).toBeTruthy();
  expect(getPublicCrewMemberByMemberId).not.toHaveBeenCalled();
});
