import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAssignmentWork } from "../useAssignmentWork";
import type { ScheduleAssignmentCommand, ScheduleAssignmentResult } from "@/lib/schedule-assignment-contract";
const api = vi.hoisted(() => ({ read: vi.fn(), save: vi.fn() }));
vi.mock("@/lib/schedule-assignment", () => ({ getScheduleAssignment: api.read, changeScheduleAssignment: api.save }));
const scope = { orgId: "org", userId: "operator", editorId: "create:show" };
const operations: ScheduleAssignmentCommand["operation"][] = [{ kind: "delete", id: "position", expectedRevision: "revision" }];
function response(command: ScheduleAssignmentCommand): ScheduleAssignmentResult {
  return { requestId: command.requestId, assignmentId: "position", outcome: "applied", snapshot: null, invitation: null };
}
const clients: QueryClient[] = [];
function setup() {
  const client = new QueryClient(); clients.push(client);
  const refresh = vi.fn().mockResolvedValue(undefined);
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const mount = () => renderHook(s => useAssignmentWork(s, { note: "Original" }, undefined, refresh), { wrapper, initialProps: scope });
  return { ...mount(), mount, client, refresh };
}
beforeEach(() => { api.save.mockImplementation(async ({ data }) => response(data)); });
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.resetAllMocks(); });
async function settle(view: ReturnType<typeof setup>) {
  await waitFor(() => expect(view.result.current.attempt).toMatchObject({ pending: false, refresh: "done", results: [expect.objectContaining({ outcome: "applied" })] }));
}
it("ignores an old Retry after its result was reviewed and a newer save completed", async () => {
  const f = setup(); act(() => f.result.current.submit(operations)); await settle(f);
  const retryOld = f.result.current.retry;
  act(() => f.result.current.review({ note: "Newer draft" }));
  act(() => f.result.current.submit(operations)); await settle(f);
  const newer = f.result.current.attempt;
  await act(async () => retryOld());
  expect(f.result.current.attempt).toEqual(newer);
  expect(f.refresh).toHaveBeenCalledTimes(2);
});
it("ignores an old Review rather than clearing a newer save", async () => {
  const f = setup(); act(() => f.result.current.submit(operations)); await settle(f);
  const reviewOld = f.result.current.review;
  act(() => f.result.current.review({ note: "Newer draft" }));
  act(() => f.result.current.submit(operations)); await settle(f);
  const newer = f.result.current.attempt;
  act(() => reviewOld({ note: "Old review" }));
  expect(f.result.current.attempt).toEqual(newer);
  expect(f.result.current.draft).toEqual({ note: "Newer draft" });
});
it.each(["orgId", "userId", "editorId"] as const)("ignores callbacks from the preceding %s view", async field => {
  const f = setup(), oldSet = f.result.current.setDraft, oldSubmit = f.result.current.submit;
  f.rerender({ ...scope, [field]: "different" });
  act(() => { oldSet(() => ({ note: "Late write" })); oldSubmit(operations); });
  await act(async () => {});
  expect(api.save).not.toHaveBeenCalled();
  f.rerender(scope); expect(f.result.current.draft).toEqual({ note: "Original" });
});
it("ignores a confirmation that resolves after the editor unmounts", async () => {
  const f = setup(), submit = f.result.current.submit; f.unmount();
  await act(async () => submit(operations)); expect(api.save).not.toHaveBeenCalled();
  const next = f.mount(); expect(next.result.current.attempt).toBeNull();
});

it("refuses an old confirmation after newer typing in the same editor", () => {
  const f = setup(), oldSubmit = f.result.current.submit;
  act(() => f.result.current.setDraft(() => ({ note: "Newer typing" })));
  act(() => expect(oldSubmit(operations)).toBe(false));
  expect(api.save).not.toHaveBeenCalled();
  expect(f.result.current.draft).toEqual({ note: "Newer typing" });
});

function heldResponse() {
  let resolve!: (result: ScheduleAssignmentResult) => void;
  const promise = new Promise<ScheduleAssignmentResult>(done => { resolve = done; });
  return { promise, resolve };
}
it("does not replace a newer cache owner when an older request completes", async () => {
  const held = heldResponse(); api.save.mockReturnValueOnce(held.promise);
  const f = setup(); act(() => f.result.current.submit(operations));
  await waitFor(() => expect(api.save).toHaveBeenCalledOnce());
  const original: ScheduleAssignmentCommand = api.save.mock.calls[0][0].data;
  const command = { ...original, requestId: crypto.randomUUID() };
  const newer = { commands: [command], results: [response(command)], pending: false, refresh: "done" };
  act(() => f.client.setQueryData(["assignment-attempt", scope.userId, scope.orgId, scope.editorId], newer));
  await waitFor(() => expect(f.result.current.attempt).toEqual(newer));
  await act(async () => { held.resolve(response(original)); await held.promise; });
  expect(f.client.getQueryData(["assignment-attempt", scope.userId, scope.orgId, scope.editorId])).toEqual(newer);
  expect(f.result.current.attempt).toEqual(newer);
  expect(f.refresh).not.toHaveBeenCalled();
});
it("retains the original completion after unmount and protects the draft while saving", async () => {
  const held = heldResponse(); api.save.mockReturnValueOnce(held.promise);
  const f = setup(); act(() => f.result.current.submit(operations));
  await waitFor(() => expect(api.save).toHaveBeenCalledOnce());
  const command: ScheduleAssignmentCommand = api.save.mock.calls[0][0].data;
  act(() => f.result.current.setDraft(() => ({ note: "Do not mutate a frozen submission" })));
  expect(f.result.current.draft).toEqual({ note: "Original" });
  f.unmount(); await act(async () => { held.resolve(response(command)); await held.promise; });
  const next = f.mount();
  await waitFor(() => expect(next.result.current.attempt).toMatchObject({ pending: false, refresh: "done", results: [response(command)] }));
  expect(f.refresh).toHaveBeenCalledOnce();
});
