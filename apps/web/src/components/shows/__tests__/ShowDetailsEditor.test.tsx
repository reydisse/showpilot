import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ShowDetailsEditor } from "../ShowDetailsEditor";
import type { ShowDetailsCommand } from "@/lib/show-details-contract";
const mocks = vi.hoisted(() => ({ save: vi.fn(), review: vi.fn() }));
vi.mock("@/lib/schedule", () => ({
  saveServiceDetails: mocks.save,
  reviewServiceDetails: mocks.review,
}));
let client: QueryClient;
const draft = {
  name: "Original",
  startTime: "10:00",
  callTime: "09:00",
  location: "Main room",
  timeZone: "UTC",
  serviceDate: "2026-11-08",
  expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
};
function result(
  data: ShowDetailsCommand,
  outcome = "applied",
  name = data.name,
) {
  return {
    requestId: data.requestId,
    showId: data.showId,
    outcome,
    snapshot: {
      id: data.showId,
      serviceDate: data.serviceDate,
      name,
      location: data.location,
      scheduledStartTime: "2026-11-08T10:00:00.000Z",
      scheduledCallTime: "2026-11-08T09:00:00.000Z",
      updatedAt: "2026-11-08T10:00:00.000Z",
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function setup(
  options: {
    userId?: string;
    refresh?: (signal: AbortSignal) => Promise<void>;
    onRefreshed?: () => void;
  } = {},
) {
  const props = {
    scope: { orgId: "org", userId: options.userId ?? "user", showId: "show" },
    initialDraft: draft,
    nameLabel: "Show or service name",
    callTimeNote: "Organization default.",
    refresh: options.refresh ?? (async () => {}),
    onRefreshed: options.onRefreshed ?? (() => {}),
  };
  const component = (userId = props.scope.userId) => (
    <QueryClientProvider client={client}>
      <ShowDetailsEditor {...props} scope={{ ...props.scope, userId }}>
        {(locked) => <button disabled={locked}>Delete show</button>}
      </ShowDetailsEditor>
    </QueryClientProvider>
  );
  const view = render(component());
  return { ...view, account: (id: string) => view.rerender(component(id)) };
}
const click = (name: string) =>
  fireEvent.click(screen.getByRole("button", { name }));
const edit = (value: string) =>
  fireEvent.change(screen.getByLabelText("Show or service name"), {
    target: { value },
  });
beforeEach(() => {
  client = new QueryClient();
  mocks.save.mockReset().mockImplementation(async ({ data }) => result(data));
  mocks.review.mockReset();
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.useRealTimers();
});

it("retains the latest draft through navigation and does not replace it with refreshed props", () => {
  const first = setup();
  edit("Retained draft");
  first.unmount();
  setup();
  expect(
    (screen.getByLabelText("Show or service name") as HTMLInputElement).value,
  ).toBe("Retained draft");
});
it("submits the latest keystroke and claims repeated clicks once", async () => {
  mocks.save.mockReturnValue(new Promise(() => {}));
  setup();
  act(() => {
    edit("Latest keystroke");
    click("Save show details");
    click("Save show details");
  });
  await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
  expect(mocks.save.mock.calls[0][0].data).toMatchObject({
    name: "Latest keystroke",
    userId: "user",
    orgId: "org",
    showId: "show",
  });
  expect(
    (screen.getByRole("button", { name: "Delete show" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});
it("times out a held reply and retries the original request after navigation", async () => {
  vi.useFakeTimers();
  const held = deferred<unknown>();
  mocks.save.mockReturnValueOnce(held.promise);
  const first = setup();
  edit("Retained save");
  click("Save show details");
  await act(async () => {
    await vi.dynamicImportSettled();
  });
  const command = mocks.save.mock.calls[0][0].data;
  first.unmount();
  setup();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15000);
  });
  expect(screen.getByRole("alert").textContent).toMatch(/retained/);
  expect(mocks.save.mock.calls[0][0].signal.aborted).toBe(true);
  expect(screen.getByRole("alert").textContent).toMatch(
    /save response timed out/,
  );
  await act(async () => {
    click("Retry original save");
    await vi.dynamicImportSettled();
  });
  expect(mocks.save).toHaveBeenCalledTimes(2);
  expect(mocks.save.mock.calls[1][0].data).toEqual(command);
  await act(async () => {
    held.resolve(result(command));
  });
  expect(
    screen.queryByRole("button", { name: "Retry original save" }),
  ).toBeNull();
});
it("confirmation after closing is retained without refreshing or closing another page", async () => {
  const held = deferred<unknown>();
  mocks.save.mockReturnValueOnce(held.promise);
  const refresh = vi.fn(),
    closed = vi.fn();
  const first = setup({ refresh, onRefreshed: closed });
  click("Save show details");
  await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
  const command = mocks.save.mock.calls[0][0].data;
  first.unmount();
  await act(async () => {
    held.resolve(result(command));
  });
  setup({ refresh, onRefreshed: closed });
  expect(screen.getByRole("status").textContent).toContain("saved");
  expect(refresh).not.toHaveBeenCalled();
  expect(closed).not.toHaveBeenCalled();
});
it("a failed page refresh retries only the refresh", async () => {
  const refresh = vi
      .fn()
      .mockRejectedValueOnce(new Error("Refresh offline"))
      .mockResolvedValue(undefined),
    closed = vi.fn();
  setup({ refresh, onRefreshed: closed });
  click("Save show details");
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain("Refresh offline"),
  );
  await act(async () => {
    click("Refresh show");
  });
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(mocks.save).toHaveBeenCalledTimes(1);
  expect(closed).toHaveBeenCalledTimes(1);
});
it("bounds refresh and ignores late completion", async () => {
  vi.useFakeTimers();
  const held = deferred<void>(),
    closed = vi.fn();
  const refresh = vi
    .fn()
    .mockReturnValueOnce(held.promise)
    .mockResolvedValue(undefined);
  setup({ refresh, onRefreshed: closed });
  click("Save show details");
  await act(async () => {
    await vi.dynamicImportSettled();
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(12000);
  });
  expect(screen.getByRole("alert").textContent).toMatch(/timed out/);
  await act(async () => {
    held.resolve();
  });
  expect(closed).not.toHaveBeenCalled();
  await act(async () => {
    click("Refresh show");
  });
  expect(mocks.save).toHaveBeenCalledTimes(1);
  expect(closed).toHaveBeenCalledTimes(1);
});
it("review cancels the undelivered request before unlocking edits with a new request ID", async () => {
  mocks.save.mockRejectedValueOnce(new Error("Reply lost"));
  mocks.review.mockImplementation(async ({ data }) => ({
    ...result(data, "cancelled"),
    snapshot: { ...result(data).snapshot, updatedAt: draft.expectedUpdatedAt },
  }));
  setup();
  click("Save show details");
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Review save" })).toBeTruthy(),
  );
  const first = mocks.save.mock.calls[0][0].data;
  await act(async () => {
    click("Review save");
  });
  expect(mocks.review.mock.calls[0][0].data).toEqual(first);
  edit("Reviewed request");
  await act(async () => {
    click("Save show details");
  });
  expect(mocks.save.mock.calls[1][0].data.requestId).not.toBe(first.requestId);
  expect(mocks.save.mock.calls[1][0].data.name).toBe("Reviewed request");
});
it("a conflict shows current details before retaining edits against the reviewed version", async () => {
  mocks.save.mockImplementationOnce(async ({ data }) =>
    result(data, "conflict", "Another operator"),
  );
  setup();
  edit("My intended title");
  click("Save show details");
  await waitFor(() =>
    expect(screen.getByLabelText("Current show details").textContent).toContain(
      "Another operator",
    ),
  );
  expect(
    (screen.getByLabelText("Show or service name") as HTMLInputElement).value,
  ).toBe("My intended title");
  expect(screen.queryByRole("button", { name: "Refresh show" })).toBeNull();
  click("Keep my edits");
  await act(async () => {
    click("Save show details");
  });
  expect(mocks.save.mock.calls[1][0].data).toMatchObject({
    name: "My intended title",
    expectedUpdatedAt: "2026-11-08T10:00:00.000Z",
  });
  expect(mocks.save.mock.calls[1][0].data.requestId).not.toBe(
    mocks.save.mock.calls[0][0].data.requestId,
  );
});
it("can replace a superseded draft with the explicitly reviewed current details", async () => {
  mocks.save.mockImplementationOnce(async ({ data }) =>
    result(data, "superseded", "Newest title"),
  );
  setup();
  click("Save show details");
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Use current details" }),
    ).toBeTruthy(),
  );
  click("Use current details");
  expect(
    (screen.getByLabelText("Show or service name") as HTMLInputElement).value,
  ).toBe("Newest title");
});
it("a removed show cannot be saved again", async () => {
  mocks.save.mockImplementationOnce(async ({ data }) => ({
    ...result(data, "removed"),
    snapshot: null,
  }));
  setup();
  click("Save show details");
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toMatch(/removed/),
  );
  expect(
    screen.queryByRole("button", { name: "Save show details" }),
  ).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Retry original save" }),
  ).toBeNull();
});
it("changing accounts hides the old draft and prevents its reply from refreshing the new account", async () => {
  const held = deferred<unknown>();
  mocks.save.mockReturnValueOnce(held.promise);
  const refresh = vi.fn();
  const first = setup({ refresh });
  edit("Private draft");
  click("Save show details");
  await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
  const command = mocks.save.mock.calls[0][0].data;
  first.account("other");
  await act(async () => {
    held.resolve(result(command));
  });
  expect(
    (screen.getByLabelText("Show or service name") as HTMLInputElement).value,
  ).toBe("Original");
  expect(refresh).not.toHaveBeenCalled();
});
it("a cleared query cache is not restored by a late successful save", async () => {
  const held = deferred<unknown>();
  mocks.save.mockReturnValueOnce(held.promise);
  const refresh = vi.fn();
  const view = setup({ refresh });
  click("Save show details");
  await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
  const command = mocks.save.mock.calls[0][0].data;
  view.unmount();
  act(() => client.clear());
  await act(async () => {
    held.resolve(result(command));
  });
  expect(
    client.getQueryData(["show-details", "user", "org", "show"]),
  ).toBeUndefined();
  expect(refresh).not.toHaveBeenCalled();
});

it("review has a deadline, coalesces clicks and keeps the original request on failure", async () => {
  vi.useFakeTimers();
  mocks.save.mockRejectedValueOnce(new Error("Reply lost"));
  mocks.review.mockReturnValue(new Promise(() => {}));
  setup();
  click("Save show details");
  await act(async () => {
    await vi.dynamicImportSettled();
  });
  act(() => {
    click("Review save");
    click("Review save");
  });
  await act(async () => {
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(15000);
  });
  expect(mocks.review).toHaveBeenCalledTimes(1);
  expect(mocks.review.mock.calls[0][0].data).toEqual(
    mocks.save.mock.calls[0][0].data,
  );
  expect(
    screen.getByRole("button", { name: "Retry original save" }),
  ).toBeTruthy();
});
