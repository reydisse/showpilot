import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ScheduleProviderControl } from "../ScheduleProviderControl";
import {
  scheduleProviderCommandSchema,
  type ScheduleProviderSnapshot,
  type ScheduleProviderResult,
} from "@/lib/schedule-provider-contract";
const api = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("@/lib/schedule-provider", () => ({
  getScheduleProvider: api.read,
  saveScheduleProvider: api.write,
}));
let saved: ScheduleProviderSnapshot;
const clients: QueryClient[] = [];
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
async function tick(ms = 30) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
function mount() {
  const client = new QueryClient();
  clients.push(client);
  const ui = (id: string | null) => (
    <QueryClientProvider client={client}>
      {id && (
        <ScheduleProviderControl
          key={id}
          userId={id}
          orgId="org-1"
          refresh={api.refresh}
          workspaceSettingsLink={<a href="/settings">Workspace settings</a>}
        />
      )}
    </QueryClientProvider>
  );
  const view = render(ui("user-1"));
  return { show: (id: string | null) => view.rerender(ui(id)) };
}
const click = (name: string) =>
  fireEvent.click(screen.getByRole("button", { name }));
async function open() {
  click("Manage source");
  await tick();
}
function edit(url = "https://draft.example.test") {
  fireEvent.change(screen.getByLabelText("Source"), {
    target: { value: "other" },
  });
  fireEvent.change(screen.getByLabelText("Platform name"), {
    target: { value: "Draft platform" },
  });
  fireEvent.change(screen.getByLabelText("Scheduling workspace URL"), {
    target: { value: url },
  });
}
function call(index: number) {
  return scheduleProviderCommandSchema.parse(
    api.write.mock.calls[index][0].data,
  );
}
beforeEach(() => {
  vi.useFakeTimers();
  HTMLElement.prototype.scrollIntoView = vi.fn();
  saved = {
    orgId: "org-1",
    userId: "user-1",
    revision: null,
    config: { provider: "native", url: "", label: "" },
  };
  api.read.mockImplementation(async () => saved);
  api.refresh.mockResolvedValue(undefined);
  api.write.mockImplementation(async ({ data }) => {
    const command = scheduleProviderCommandSchema.parse(data);
    saved = { ...saved, config: command.config, revision: crypto.randomUUID() };
    return {
      requestId: command.requestId,
      outcome: "applied",
      snapshot: saved,
    };
  });
});
afterEach(() => {
  cleanup();
  for (const c of clients.splice(0)) c.clear();
  vi.resetAllMocks();
  vi.useRealTimers();
});

it("bounds the initial source check and ignores a late response", async () => {
  const held = deferred<ScheduleProviderSnapshot>();
  api.read.mockReturnValueOnce(held.promise);
  mount();
  await open();
  expect(screen.queryByLabelText("Source")).toBeNull();
  await tick(8_100);
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  expect(api.read.mock.calls[0][0].signal.aborted).toBe(true);
  held.resolve(saved);
  await tick();
  expect(screen.queryByLabelText("Source")).toBeNull();
  click("Retry");
  await tick();
  expect(screen.getByLabelText("Source")).toBeTruthy();
  expect(api.write).not.toHaveBeenCalled();
});

it("keeps an uncertain request across navigation and replays it exactly without accepting its late acknowledgement", async () => {
  const held = deferred<ScheduleProviderResult>();
  api.write.mockReturnValueOnce(held.promise);
  const view = mount();
  await open();
  edit();
  click("Save source");
  await tick();
  const first = call(0);
  view.show(null);
  await tick(8_100);
  view.show("user-1");
  await open();
  expect(screen.getByDisplayValue(first.config.url)).toBeTruthy();
  held.resolve({
    requestId: first.requestId,
    outcome: "applied",
    snapshot: { ...saved, config: first.config, revision: "late" },
  });
  await tick();
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  expect(api.refresh).not.toHaveBeenCalled();
  saved = {
    ...saved,
    revision: "newer",
    config: {
      provider: "faithteams",
      url: "https://newer.example.test",
      label: "",
    },
  };
  api.write.mockResolvedValueOnce({
    requestId: first.requestId,
    outcome: "superseded",
    snapshot: saved,
  });
  click("Retry");
  await tick();
  expect(call(1)).toEqual(first);
  expect(screen.getByText(/A newer source is saved/)).toBeTruthy();
  expect(screen.getByDisplayValue(first.config.url)).toBeTruthy();
  click("Save reviewed source");
  await tick();
  expect(call(2).expectedRevision).toBe("newer");
  expect(call(2).requestId).not.toBe(first.requestId);
  expect(screen.getByText("Source saved.")).toBeTruthy();
});

it("retries only the view refresh after an acknowledged write", async () => {
  api.refresh.mockRejectedValueOnce(new Error("refresh offline"));
  mount();
  await open();
  edit();
  click("Save source");
  await tick();
  expect(screen.getByText(/Schedule view could not refresh/)).toBeTruthy();
  click("Close Scheduling source");
  await tick();
  expect(screen.getByText(/Scheduling source needs attention/)).toBeTruthy();
  await open();
  click("Retry");
  await tick();
  expect(api.write).toHaveBeenCalledTimes(1);
  expect(api.refresh).toHaveBeenCalledTimes(2);
  expect(screen.getByText("Source saved.")).toBeTruthy();
});

it("bounds a stalled refresh and leaves the acknowledged write intact", async () => {
  const held = deferred<void>();
  api.refresh.mockReturnValueOnce(held.promise);
  mount();
  await open();
  edit();
  click("Save source");
  await tick(12_100);
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  held.resolve();
  await tick();
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  click("Retry");
  await tick();
  expect(api.write).toHaveBeenCalledTimes(1);
});

it.each(["http://example.test", "not a URL", ""])(
  "shows validation without sending invalid URL %s",
  async (url) => {
    mount();
    await open();
    edit(url);
    click("Save source");
    await tick();
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(api.write).not.toHaveBeenCalled();
  },
);

it("saves the last typed character and keeps unsaved drafts across close", async () => {
  mount();
  await open();
  edit("https://draft.example.test/latest");
  click("Close Scheduling source");
  await tick();
  await open();
  expect(
    screen.getByDisplayValue("https://draft.example.test/latest"),
  ).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Scheduling workspace URL"), {
    target: { value: "https://draft.example.test/latest2" },
  });
  click("Save source");
  await tick();
  expect(call(0).config.url).toBe("https://draft.example.test/latest2");
});

it("refreshes a pristine form on reopening, without overwriting a typed draft", async () => {
  mount();
  await open();
  click("Close Scheduling source");
  await tick();
  saved = {
    ...saved,
    revision: "remote",
    config: {
      provider: "other",
      url: "https://remote.example.test",
      label: "Remote",
    },
  };
  await open();
  expect(screen.getByDisplayValue("https://remote.example.test")).toBeTruthy();
  edit();
  click("Close Scheduling source");
  await tick();
  saved = {
    ...saved,
    revision: "remote2",
    config: { provider: "native", url: "", label: "" },
  };
  await open();
  expect(screen.getByDisplayValue("https://draft.example.test")).toBeTruthy();
});

it("does not expose one account's draft to another account", async () => {
  const view = mount();
  await open();
  edit();
  view.show(null);
  saved = { ...saved, userId: "user-2" };
  view.show("user-2");
  await open();
  expect(screen.queryByDisplayValue("https://draft.example.test")).toBeNull();
  expect(screen.getByLabelText("Source").getAttribute("disabled")).toBeNull();
});
