import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AssignmentEditor } from "../AssignmentEditor";
import {
  scheduleAssignmentCommandSchema,
  type AssignmentSnapshot,
  type ScheduleAssignmentCommand,
  type ScheduleAssignmentResult,
} from "@/lib/schedule-assignment-contract";
const api = vi.hoisted(() => ({
  read: vi.fn(),
  save: vi.fn(),
  refresh: vi.fn(),
  confirm: vi.fn(),
  userId: "user-1",
}));
vi.mock("@/lib/schedule-assignment", () => ({
  getScheduleAssignment: api.read,
  changeScheduleAssignment: api.save,
}));
const clients: QueryClient[] = [];
const initial: AssignmentSnapshot = {
  id: "assignment-1",
  revision: "revision-1",
  showId: "show-1",
  serviceDate: "2099-01-01",
  role: "Audio",
  department: "Production",
  crewMemberId: null,
  status: "assigned",
  callTime: "",
  notes: "Original note",
  responseNote: "",
};
function response(
  command: ScheduleAssignmentCommand,
): ScheduleAssignmentResult {
  const operation = command.operation;
  let snapshot: AssignmentSnapshot | null = null;
  if (operation.kind !== "delete") {
    const { timeZone: _timeZone, ...fields } = operation.fields;
    snapshot = { ...initial, ...fields, revision: command.requestId };
  }
  return {
    requestId: command.requestId,
    assignmentId: initial.id,
    outcome: "applied",
    snapshot,
    invitation: null,
  };
}
function mount(kind: "create" | "team" | "edit" | "delete" = "create") {
  const client = new QueryClient();
  clients.push(client);
  const ui = (visible: boolean) => (
    <QueryClientProvider client={client}>
      {visible && (
        <AssignmentEditor
          key={api.userId}
          orgId="org-1"
          userId={api.userId}
          target={
            kind === "edit" || kind === "delete"
              ? { kind, id: initial.id }
              : { kind, showId: "show-1", serviceDate: "2099-01-01" }
          }
          departments={["Production"]}
          crew={[
            {
              id: "crew-1",
              name: "Person One",
              role: "Audio",
              email: "person@example.test",
            },
          ]}
          venueTimeZone="UTC"
          confirm={api.confirm}
          onClose={() => {}}
          onSaved={api.refresh}
        />
      )}
    </QueryClientProvider>
  );
  const view = render(ui(true));
  return { show: (visible: boolean) => view.rerender(ui(visible)) };
}
const tick = async (ms = 30) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};
const click = (name: string) =>
  fireEvent.click(screen.getByRole("button", { name }));
const change = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
function sent(index = 0) {
  return scheduleAssignmentCommandSchema.parse(
    api.save.mock.calls[index][0].data,
  );
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.useFakeTimers();
  api.userId = "user-1";
  api.read.mockResolvedValue({
    orgId: "org-1",
    userId: "user-1",
    snapshot: initial,
  });
  api.save.mockImplementation(async ({ data }) => response(data));
  api.refresh.mockResolvedValue(undefined);
  api.confirm.mockResolvedValue(true);
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.resetAllMocks();
  vi.useRealTimers();
});

it("keeps the draft and exact create request across navigation, a timeout and a late response", async () => {
  const held = deferred<ScheduleAssignmentResult>();
  api.save.mockReturnValueOnce(held.promise);
  const view = mount();
  change("Position", "Camera");
  change("Manager note", "Bring the long lens");
  view.show(false);
  view.show(true);
  await tick();
  expect((screen.getByLabelText("Position") as HTMLInputElement).value).toBe(
    "Camera",
  );
  click("Add position");
  await tick();
  const command = sent();
  view.show(false);
  await tick(15_100);
  view.show(true);
  await tick();
  expect(screen.getByText(/Save not confirmed/)).toBeTruthy();
  held.resolve(response(command));
  await tick();
  expect(api.refresh).not.toHaveBeenCalled();
  click("Retry unconfirmed saves or invitations");
  await tick();
  expect(sent(1)).toEqual(command);
  expect(screen.getByText("Assignment saved.")).toBeTruthy();
});
it("retries only the unconfirmed team row and preserves the successful position", async () => {
  api.save
    .mockImplementationOnce(async ({ data }) => response(data))
    .mockRejectedValueOnce(new TypeError("Lost reply"));
  mount("team");
  change("Position 1", "Audio");
  click("Add another person");
  await tick();
  change("Position 2", "Camera");
  click("Add team & send invitations");
  await tick();
  const second = sent(1);
  expect(screen.getByText(/Audio: Assignment saved/)).toBeTruthy();
  expect(screen.getByText(/Camera: Save not confirmed/)).toBeTruthy();
  click("Retry unconfirmed saves or invitations");
  await tick();
  expect(api.save).toHaveBeenCalledTimes(3);
  expect(sent(2)).toEqual(second);
  expect(screen.getByText(/Camera: Assignment saved/)).toBeTruthy();
});
it("retains the operator's edit and requires review before applying against a newer revision", async () => {
  const latest = {
    ...initial,
    revision: "revision-2",
    notes: "Newer manager note",
  };
  api.save.mockImplementationOnce(async ({ data }) => ({
    ...response(data),
    outcome: "conflict",
    snapshot: latest,
  }));
  mount("edit");
  await tick();
  change("Manager note", "My unsaved note");
  click("Save assignment");
  await tick();
  expect(screen.getByText(/Latest:.*Newer manager note/)).toBeTruthy();
  expect(
    (screen.getByLabelText("Manager note") as HTMLTextAreaElement).value,
  ).toBe("My unsaved note");
  api.read.mockResolvedValue({
    orgId: "org-1",
    userId: "user-1",
    snapshot: latest,
  });
  click("Review latest details");
  await tick();
  expect(api.save).toHaveBeenCalledTimes(1);
  click("Save assignment");
  await tick();
  const command = sent(1);
  expect(command.requestId).not.toBe(sent().requestId);
  expect(command.operation).toMatchObject({
    expectedRevision: "revision-2",
    fields: { notes: "My unsaved note" },
  });
});
it("bounds an assignment read and ignores its late result until Retry loading succeeds", async () => {
  const held = deferred<{
    orgId: string;
    userId: string;
    snapshot: AssignmentSnapshot;
  }>();
  api.read.mockReturnValueOnce(held.promise);
  mount("edit");
  await tick(8_100);
  expect(screen.getByRole("button", { name: "Retry loading" })).toBeTruthy();
  held.resolve({ orgId: "org-1", userId: "user-1", snapshot: initial });
  await tick();
  expect(screen.queryByLabelText("Manager note")).toBeNull();
  click("Retry loading");
  await tick();
  expect(screen.getByLabelText("Manager note")).toBeTruthy();
});
it("retries a failed view refresh without saving the assignment again", async () => {
  const held = deferred<void>();
  api.refresh.mockReturnValueOnce(held.promise);
  mount();
  change("Position", "Lighting");
  click("Add position");
  await tick(12_100);
  expect(screen.getByText(/Schedule could not refresh/)).toBeTruthy();
  held.resolve();
  await tick();
  click("Retry refresh");
  await tick();
  expect(api.save).toHaveBeenCalledTimes(1);
  expect(api.refresh).toHaveBeenCalledTimes(2);
});
it("requires explicit removal and renewed review when a response changes", async () => {
  const confirmed = {
    ...initial,
    revision: "confirmed-revision",
    status: "confirmed" as const,
    crewMemberId: "crew-1",
  };
  api.save.mockImplementationOnce(async ({ data }) => ({
    ...response(data),
    outcome: "conflict",
    snapshot: confirmed,
  }));
  mount("delete");
  await tick();
  expect(api.save).not.toHaveBeenCalled();
  click("Remove assignment");
  await tick();
  expect(screen.getByText(/Latest:.*confirmed/)).toBeTruthy();
  api.read.mockResolvedValue({
    orgId: "org-1",
    userId: "user-1",
    snapshot: confirmed,
  });
  click("Review latest details");
  await tick();
  expect(api.save).toHaveBeenCalledTimes(1);
  click("Remove assignment");
  await tick();
  expect(sent(1).operation).toEqual({
    kind: "delete",
    id: initial.id,
    expectedRevision: "confirmed-revision",
  });
  expect(screen.getByText("Assignment removed.")).toBeTruthy();
});
it("keeps drafts and in-flight saves isolated when the account changes", async () => {
  const held = deferred<ScheduleAssignmentResult>();
  api.save.mockReturnValueOnce(held.promise);
  const view = mount();
  change("Position", "Private draft");
  click("Add position");
  await tick();
  const command = sent();
  api.userId = "user-2";
  view.show(true);
  await tick();
  expect((screen.getByLabelText("Position") as HTMLInputElement).value).toBe(
    "",
  );
  held.resolve(response(command));
  await tick();
  expect(screen.queryByText("Assignment saved.")).toBeNull();
});
it("retries an invitation against the original saved command", async () => {
  api.save.mockImplementationOnce(async ({ data }) => ({
    ...response(data),
    invitation: {
      id: initial.id,
      label: "Audio",
      email: "uncertain",
      inAppDelivered: true,
      reason: null,
      updatedAt: Date.now(),
    },
  }));
  mount();
  change("Position", "Audio");
  change("Roster contact", "crew-1");
  click("Add position");
  await tick();
  expect(screen.getByText(/Email acceptance is unknown/)).toBeTruthy();
  expect(screen.getByText("Assignment saved.")).toBeTruthy();
  click("Retry unconfirmed saves or invitations");
  await tick();
  expect(sent(1)).toEqual(sent());
});
