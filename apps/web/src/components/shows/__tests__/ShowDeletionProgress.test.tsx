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
import {
  useShowDeletions,
  type DeletionTarget,
} from "@/hooks/useShowDeletions";
import { ShowDeletionProgress } from "../ShowDeletionProgress";
import { ShowDetailsEditor } from "../ShowDetailsEditor";
const api = vi.hoisted(() => ({ remove: vi.fn(), save: vi.fn() }));
vi.mock("@/lib/schedule", () => ({
  deleteService: api.remove,
  saveServiceDetails: api.save,
}));
const target = {
  showId: "show",
  name: "Morning show",
  expectedUpdatedAt: "2026-11-08T00:00:00.000Z",
};
const key = ["show-deletions", "user", "org"];
let client: QueryClient;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
type Options = {
  userId?: string;
  target?: DeletionTarget;
  confirm?: () => Promise<boolean>;
  refresh?: (signal: AbortSignal) => Promise<void>;
  onConfirmed?: (id: string) => void;
};
function Harness(props: Options) {
  const scope = { userId: props.userId ?? "user", orgId: "org" },
    selected = props.target ?? target;
  const controller = useShowDeletions(scope, {
    refresh: props.refresh ?? (async () => {}),
    onConfirmed: props.onConfirmed ?? (() => {}),
  });
  return (
    <>
      <button
        onClick={() =>
          void controller.confirmDeletion(
            selected,
            props.confirm ?? (async () => true),
          )
        }
      >
        Request deletion
      </button>
      <ShowDeletionProgress controller={controller} />
      <ShowDetailsEditor
        scope={{ ...scope, showId: selected.showId }}
        initialDraft={{
          serviceDate: "2026-11-08",
          name: "Draft",
          location: "Room",
          startTime: "",
          callTime: "",
          expectedUpdatedAt: target.expectedUpdatedAt,
          timeZone: "UTC",
        }}
        nameLabel="Show name"
        callTimeNote="None"
        refresh={async () => {}}
        onRefreshed={() => {}}
      />
    </>
  );
}
function setup(options: Options = {}) {
  const component = (props: Options) => (
    <QueryClientProvider client={client}>
      <Harness {...props} />
    </QueryClientProvider>
  );
  const view = render(component(options));
  return {
    ...view,
    change: (props: Options) =>
      view.rerender(component({ ...options, ...props })),
  };
}
const click = (name: string) =>
  fireEvent.click(screen.getByRole("button", { name }));
const settleImports = () =>
  act(async () => {
    await vi.dynamicImportSettled();
  });
beforeEach(() => {
  client = new QueryClient();
  api.remove.mockReset().mockResolvedValue({ ok: true });
  api.save.mockReset();
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.useRealTimers();
});

it("requires confirmation and claims repeated clicks once", async () => {
  const confirmation = deferred<boolean>(),
    confirm = vi.fn(() => confirmation.promise),
    closed = vi.fn();
  setup({ confirm, onConfirmed: closed });
  act(() => {
    click("Request deletion");
    click("Request deletion");
  });
  expect(confirm).toHaveBeenCalledOnce();
  expect(api.remove).not.toHaveBeenCalled();
  await act(async () => {
    confirmation.resolve(true);
  });
  await waitFor(() => expect(api.remove).toHaveBeenCalledOnce());
  expect(api.remove.mock.calls[0][0].data).toEqual({
    orgId: "org",
    userId: "user",
    showId: "show",
    expectedUpdatedAt: target.expectedUpdatedAt,
  });
  expect(closed).toHaveBeenCalledWith("show");
});
it("cancelled confirmation leaves the show editable and sends nothing", async () => {
  setup({ confirm: async () => false });
  await act(async () => {
    click("Request deletion");
  });
  expect(api.remove).not.toHaveBeenCalled();
  expect(client.getQueryData(key)).toEqual({});
});
it("ignores confirmation completed after leaving Schedule", async () => {
  const confirmation = deferred<boolean>(),
    closed = vi.fn();
  const view = setup({
    confirm: () => confirmation.promise,
    onConfirmed: closed,
  });
  click("Request deletion");
  view.unmount();
  await act(async () => {
    confirmation.resolve(true);
  });
  expect(api.remove).not.toHaveBeenCalled();
  expect(closed).not.toHaveBeenCalled();
  expect(client.getQueryData(key)).toEqual({});
});
it("times out, aborts transport and retains the exact deletion through navigation", async () => {
  vi.useFakeTimers();
  const held = deferred<unknown>();
  api.remove.mockReturnValueOnce(held.promise);
  const first = setup();
  click("Request deletion");
  await settleImports();
  const request = api.remove.mock.calls[0][0];
  first.unmount();
  setup({
    target: { ...target, expectedUpdatedAt: "2026-11-09T00:00:00.000Z" },
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15_000);
  });
  expect(request.signal.aborted).toBe(true);
  expect(screen.getByRole("alert").textContent).toContain("timed out");
  await act(async () => {
    click("Retry deletion");
    await vi.dynamicImportSettled();
  });
  expect(api.remove.mock.calls[1][0].data).toEqual(request.data);
  await act(async () => {
    held.resolve({ ok: false, message: "Late old reply" });
  });
  expect(screen.queryByText(/Late old reply/)).toBeNull();
  expect(screen.getByText("Show deleted.")).toBeTruthy();
});
it("retains a completed result while away without refreshing another screen", async () => {
  const held = deferred<unknown>(),
    refresh = vi.fn(),
    closed = vi.fn();
  api.remove.mockReturnValueOnce(held.promise);
  const first = setup({ refresh, onConfirmed: closed });
  click("Request deletion");
  await waitFor(() => expect(api.remove).toHaveBeenCalledOnce());
  first.unmount();
  refresh.mockClear();
  closed.mockClear();
  await act(async () => {
    held.resolve({ ok: true });
  });
  setup({ refresh, onConfirmed: closed });
  expect(screen.getByText("Show deleted.")).toBeTruthy();
  expect(refresh).not.toHaveBeenCalled();
  expect(closed).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Refresh Schedule" })).toBeTruthy();
});
it("retries only refresh after deletion is confirmed, claiming duplicate refresh clicks once", async () => {
  const held = deferred<void>(),
    refresh = vi
      .fn()
      .mockRejectedValueOnce(new Error("Page offline"))
      .mockReturnValueOnce(held.promise);
  setup({ refresh });
  click("Request deletion");
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain("Page offline"),
  );
  const button = screen.getByRole("button", { name: "Refresh Schedule" });
  act(() => {
    fireEvent.click(button);
    fireEvent.click(button);
  });
  await act(async () => {
    held.resolve();
  });
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(api.remove).toHaveBeenCalledOnce();
  click("Dismiss");
  expect(
    screen.queryByRole("region", { name: "Show deletion progress" }),
  ).toBeNull();
});
it("bounds refresh and ignores its late completion", async () => {
  vi.useFakeTimers();
  const held = deferred<void>(),
    refresh = vi
      .fn()
      .mockReturnValueOnce(held.promise)
      .mockResolvedValue(undefined);
  setup({ refresh });
  click("Request deletion");
  await settleImports();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(12_000);
  });
  expect(screen.getByRole("alert").textContent).toContain(
    "Refreshing Schedule timed out",
  );
  expect(refresh.mock.calls[0][0].aborted).toBe(true);
  await act(async () => {
    held.resolve();
  });
  expect(screen.getByRole("button", { name: "Refresh Schedule" })).toBeTruthy();
  await act(async () => {
    click("Refresh Schedule");
  });
  expect(api.remove).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "Dismiss" })).toBeTruthy();
});
it("isolates account changes and does not run old completion callbacks", async () => {
  const held = deferred<unknown>(),
    refresh = vi.fn();
  api.remove.mockReturnValueOnce(held.promise);
  const view = setup({ refresh });
  click("Request deletion");
  await waitFor(() => expect(api.remove).toHaveBeenCalledOnce());
  view.change({ userId: "other" });
  await act(async () => {
    held.resolve({ ok: true });
  });
  expect(screen.queryByText("Show deleted.")).toBeNull();
  expect(refresh).not.toHaveBeenCalled();
  view.change({ userId: "user" });
  expect(screen.getByText("Show deleted.")).toBeTruthy();
});
it("does not recreate work after sign-out clears the query cache", async () => {
  const held = deferred<unknown>(),
    refresh = vi.fn();
  api.remove.mockReturnValueOnce(held.promise);
  const view = setup({ refresh });
  click("Request deletion");
  await waitFor(() => expect(api.remove).toHaveBeenCalledOnce());
  view.unmount();
  client.clear();
  await act(async () => {
    held.resolve({ ok: true });
  });
  expect(client.getQueryData(key)).toBeUndefined();
  expect(refresh).not.toHaveBeenCalled();
});
it("requires a fresh confirmation after an explicit rejection and keeps transport failure unconfirmed", async () => {
  api.remove
    .mockResolvedValueOnce({
      ok: false,
      message: "Stop the show before deleting it",
    })
    .mockRejectedValueOnce(new Error("Connection lost"));
  const confirm = vi.fn().mockResolvedValue(true);
  const view = setup({ confirm });
  click("Request deletion");
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain("not accepted"),
  );
  expect(screen.queryByRole("button", { name: "Retry deletion" })).toBeNull();
  const next = { ...target, expectedUpdatedAt: "2026-11-09T00:00:00.000Z" };
  view.change({ target: next });
  click("Request deletion");
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Retry deletion" })).toBeTruthy(),
  );
  expect(confirm).toHaveBeenCalledTimes(2);
  expect(api.remove.mock.calls[1][0].data.expectedUpdatedAt).toBe(
    next.expectedUpdatedAt,
  );
});
it("preserves independent show results when replies finish out of order", async () => {
  const first = deferred<unknown>(),
    second = deferred<unknown>();
  api.remove
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  const view = setup();
  click("Request deletion");
  await waitFor(() => expect(api.remove).toHaveBeenCalledTimes(1));
  view.change({
    target: { ...target, showId: "other-show", name: "Evening show" },
  });
  click("Request deletion");
  await waitFor(() => expect(api.remove).toHaveBeenCalledTimes(2));
  await act(async () => {
    second.resolve({ ok: true });
    first.resolve({ ok: true });
  });
  expect(screen.getAllByText("Show deleted.")).toHaveLength(2);
  expect(screen.getByText("Morning show")).toBeTruthy();
  expect(screen.getByText("Evening show")).toBeTruthy();
});
it("prevents a details save while deletion awaits confirmation", async () => {
  const held = deferred<boolean>();
  setup({ confirm: () => held.promise });
  click("Request deletion");
  click("Save show details");
  await settleImports();
  expect(api.save).not.toHaveBeenCalled();
  await act(async () => {
    held.resolve(false);
  });
});
it("prevents deletion while a details save is unresolved", () => {
  client.setQueryData(["show-details", "user", "org", "show"], {
    attempt: { kind: "saving" },
  });
  const confirm = vi.fn();
  // Only the hook needs this pending cache fixture; the editor requires a draft.
  function Pending() {
    const controller = useShowDeletions(
      { userId: "user", orgId: "org" },
      { refresh: async () => {}, onConfirmed: () => {} },
    );
    return (
      <button onClick={() => void controller.confirmDeletion(target, confirm)}>
        Request deletion
      </button>
    );
  }
  render(
    <QueryClientProvider client={client}>
      <Pending />
    </QueryClientProvider>,
  );
  click("Request deletion");
  expect(confirm).not.toHaveBeenCalled();
  expect(api.remove).not.toHaveBeenCalled();
});
