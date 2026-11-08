import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NewShowModal } from "../NewShowModal";
const mocks = vi.hoisted(() => ({ create: vi.fn(), review: vi.fn() }));
vi.mock("@/lib/pm-actions", () => ({ createNextService: mocks.create }));
vi.mock("@/lib/show-creation-review", () => ({
  reviewShowCreation: mocks.review,
}));
const clients: QueryClient[] = [];
beforeEach(() => {
  mocks.create
    .mockReset()
    .mockImplementation(async ({ data }) => ({
      ok: true,
      showId: data.requestId,
      serviceDate: data.serviceDate,
    }));
  mocks.review.mockReset();
});
afterEach(() => {
  for (const client of clients) client.clear();
  clients.length = 0;
  vi.useRealTimers();
});
function setup(props: Partial<React.ComponentProps<typeof NewShowModal>> = {}) {
  const client = new QueryClient();
  clients.push(client);
  const onCreated = vi.fn().mockResolvedValue(undefined);
  const modal = (
    <NewShowModal
      orgId="org"
      userId="user"
      currentDate="2026-09-07"
      currentStartTime="18:30"
      currentShowId="current"
      timeZone="UTC"
      onCreated={onCreated}
      beforeCreate={async () => {}}
      onClose={vi.fn()}
      {...props}
    />
  );
  const view = render(
    <QueryClientProvider client={client}>{modal}</QueryClientProvider>,
  );
  return {
    client,
    onCreated,
    ...view,
    hide: () =>
      view.rerender(
        <QueryClientProvider client={client}>{null}</QueryClientProvider>,
      ),
    show: () =>
      view.rerender(
        <QueryClientProvider client={client}>{modal}</QueryClientProvider>,
      ),
  };
}
it("starts on the current date and proposes the next start time", () => {
  setup();
  expect(screen.getByLabelText<HTMLInputElement>("Date").value).toBe(
    "2026-09-07",
  );
  expect(screen.getByLabelText<HTMLInputElement>("Start time").value).toBe(
    "19:30",
  );
  expect(
    screen
      .getByLabelText("Rundown source")
      .querySelector("option:checked")
      ?.getAttribute("value"),
  ).toBe("show:current");
});
it("submits a separate same-day show with a retained identity and latest typed fields", async () => {
  setup();
  fireEvent.change(screen.getByLabelText("Show name"), {
    target: { value: "Late service" },
  });
  fireEvent.change(screen.getByLabelText(/Crew call time/), {
    target: { value: "18:45" },
  });
  fireEvent.change(screen.getByLabelText("Start time"), {
    target: { value: "20:00" },
  });
  fireEvent.change(screen.getByLabelText("Venue or location"), {
    target: { value: "Main room" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create show" }));
  await waitFor(() =>
    expect(mocks.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orgId: "org",
        userId: "user",
        requestId: expect.any(String),
        serviceDate: "2026-09-07",
        name: "Late service",
        callTime: "18:45",
        startTime: "20:00",
        location: "Main room",
        copyFrom: "2026-09-07",
        copyFromShowId: "current",
      }),
      signal: expect.any(AbortSignal),
    }),
  );
});
it("retains a new-show draft when navigation unmounts and remounts the form", () => {
  const view = setup();
  fireEvent.change(screen.getByLabelText("Show name"), {
    target: { value: "Retained evening show" },
  });
  fireEvent.change(screen.getByLabelText("Venue or location"), {
    target: { value: "Studio B" },
  });
  view.hide();
  view.show();
  expect(screen.getByLabelText<HTMLInputElement>("Show name").value).toBe(
    "Retained evening show",
  );
  expect(
    screen.getByLabelText<HTMLInputElement>("Venue or location").value,
  ).toBe("Studio B");
});
it("stops showing an indefinite creation spinner when the response stalls", async () => {
  vi.useFakeTimers();
  mocks.create.mockImplementation(() => new Promise(() => {}));
  setup();
  fireEvent.change(screen.getByLabelText("Show name"), {
    target: { value: "Stalled show" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create show" }));
  await act(async () => {
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(16000);
  });
  expect(screen.queryByRole("alert")).not.toBeNull();
  expect(screen.queryByText(/Creating show…/)).toBeNull();
  expect(screen.getByRole("button", { name: "Retry creation" })).not.toBeNull();
});
it("retries the exact request after navigation without using changed source props", async () => {
  mocks.create.mockRejectedValueOnce(new Error("Lost response"));
  const view = setup();
  fireEvent.click(screen.getByRole("button", { name: "Create show" }));
  await screen.findByRole("button", { name: "Retry creation" });
  const original = mocks.create.mock.calls[0][0].data;
  view.hide();
  view.show();
  fireEvent.click(screen.getByRole("button", { name: "Retry creation" }));
  await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(2));
  expect(mocks.create.mock.calls[1][0].data).toEqual(original);
});
it("an acknowledged creation stays available after navigation without opening the abandoned page", async () => {
  let release!: (value: unknown) => void;
  mocks.create.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const view = setup();
  fireEvent.click(screen.getByRole("button", { name: "Create show" }));
  await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
  const command = mocks.create.mock.calls[0][0].data;
  view.hide();
  await act(async () =>
    release({
      ok: true,
      showId: command.requestId,
      serviceDate: command.serviceDate,
    }),
  );
  expect(view.onCreated).not.toHaveBeenCalled();
  view.show();
  expect(screen.getByRole("button", { name: "Open show" })).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Open show" }));
  await waitFor(() => expect(view.onCreated).toHaveBeenCalledTimes(1));
  expect(mocks.create).toHaveBeenCalledTimes(1);
});
it("retry opening never resubmits an acknowledged creation", async () => {
  const onCreated = vi
    .fn()
    .mockRejectedValueOnce(new Error("Refresh offline"))
    .mockResolvedValue(undefined);
  setup({ onCreated });
  fireEvent.click(screen.getByRole("button", { name: "Create show" }));
  await screen.findByRole("button", { name: "Retry opening show" });
  fireEvent.click(screen.getByRole("button", { name: "Retry opening show" }));
  await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(2));
  expect(mocks.create).toHaveBeenCalledTimes(1);
});
it("editing an uncertain request first fences it and then gives the reviewed save a new ID", async () => {
  mocks.create.mockRejectedValueOnce(new Error("Lost response"));
  mocks.review.mockResolvedValue({ kind: "cancelled" });
  setup();
  fireEvent.change(screen.getByLabelText("Show name"), {
    target: { value: "Original" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create show" }));
  await screen.findByRole("button", { name: "Edit request" });
  const original = mocks.create.mock.calls[0][0].data;
  fireEvent.click(screen.getByRole("button", { name: "Edit request" }));
  await screen.findByRole("button", { name: "Create show" });
  expect(mocks.review.mock.calls[0][0].data).toEqual(original);
  fireEvent.change(screen.getByLabelText("Show name"), {
    target: { value: "Reviewed" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create show" }));
  await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(2));
  expect(mocks.create.mock.calls[1][0].data.requestId).not.toBe(
    original.requestId,
  );
  expect(mocks.create.mock.calls[1][0].data.name).toBe("Reviewed");
});
it("review finds an already-created show and keeps editing locked", async () => {
  mocks.create.mockRejectedValue(new Error("Lost response"));
  mocks.review.mockImplementation(async ({ data }) => ({
    kind: "created",
    result: { ok: true, showId: data.requestId, serviceDate: data.serviceDate },
  }));
  setup();
  fireEvent.click(screen.getByRole("button", { name: "Create show" }));
  await screen.findByRole("button", { name: "Edit request" });
  fireEvent.click(screen.getByRole("button", { name: "Edit request" }));
  await screen.findByRole("button", { name: "Open show" });
  expect(screen.getByLabelText("Show name").closest("fieldset")?.disabled).toBe(
    true,
  );
  expect(mocks.create).toHaveBeenCalledTimes(1);
});
