import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SignOutControl } from "../SignOutControl";

const api = vi.hoisted(() => ({
  read: vi.fn(),
  signOut: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock("@/lib/auth-client", () => ({
  authClient: { getSession: api.read, signOut: api.signOut },
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => api.navigate }));
const session = {
  data: { user: { id: "user-1" }, session: { id: "session-1" } },
  error: null,
};
const success = { data: { success: true }, error: null };
const clients: QueryClient[] = [];
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
function mount() {
  const client = new QueryClient();
  clients.push(client);
  client.setQueryData(["private-profile"], { name: "Fixture" });
  const ui = (userId: string | null) => (
    <QueryClientProvider client={client}>
      {userId ? <SignOutControl userId={userId} /> : null}
    </QueryClientProvider>
  );
  const view = render(ui("user-1"));
  return { client, show: (userId: string | null) => view.rerender(ui(userId)) };
}
async function tick(ms = 20) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
function confirm() {
  fireEvent.click(screen.getByRole("button", { name: "Sign Out" }));
  expect(api.signOut).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "Tap again to sign out" }),
  );
}
beforeEach(() => {
  vi.useFakeTimers();
  api.read.mockResolvedValue(session);
  api.signOut.mockResolvedValue(success);
  api.navigate.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.resetAllMocks();
  vi.useRealTimers();
});

it("keeps the account visible on an error and clears private caches only after confirmation", async () => {
  api.signOut.mockResolvedValueOnce({ data: null, error: { status: 503 } });
  const view = mount();
  confirm();
  await tick();
  expect(screen.getByRole("button", { name: "Retry sign-out" })).toBeTruthy();
  expect(
    document.querySelector('[aria-label="Sign-out recovery"] time'),
  ).toBeTruthy();
  expect(api.navigate).not.toHaveBeenCalled();
  expect(view.client.getQueryData(["private-profile"])).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry sign-out" }));
  await tick();
  expect(api.signOut).toHaveBeenLastCalledWith({
    fetchOptions: {
      body: { expectedSessionId: "session-1" },
      retry: 0,
      signal: expect.any(AbortSignal),
    },
  });
  expect(view.client.getQueryData(["private-profile"])).toBeUndefined();
  expect(api.navigate).toHaveBeenCalledWith({
    to: "/login",
    reloadDocument: true,
    replace: true,
  });
});

it("bounds the session read and never sends a late sign-out after that read times out", async () => {
  const held = deferred<typeof session>();
  api.read.mockReturnValueOnce(held.promise);
  mount();
  confirm();
  await tick(8_100);
  expect(api.read.mock.calls[0][0].fetchOptions.signal.aborted).toBe(true);
  expect(screen.getByRole("button", { name: "Retry sign-out" })).toBeTruthy();
  held.resolve(session);
  await tick();
  expect(api.signOut).not.toHaveBeenCalled();
  expect(api.navigate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Retry sign-out" }));
  await tick();
  expect(api.signOut).toHaveBeenCalledTimes(1);
});

it("retains an uncertain write across unmount and retries a lost success with a read only", async () => {
  const held = deferred<typeof success>();
  api.signOut.mockReturnValueOnce(held.promise);
  const view = mount();
  confirm();
  await tick();
  view.show(null);
  await tick(8_100);
  view.show("user-2");
  await tick();
  expect(screen.queryByRole("button", { name: "Retry sign-out" })).toBeNull();
  view.show("user-1");
  await tick();
  expect(screen.getByRole("button", { name: "Retry sign-out" })).toBeTruthy();
  held.resolve(success);
  await tick();
  expect(api.navigate).not.toHaveBeenCalled();
  api.read.mockResolvedValue({ data: null, error: null });
  fireEvent.click(screen.getByRole("button", { name: "Retry sign-out" }));
  await tick();
  expect(api.signOut).toHaveBeenCalledTimes(1);
  expect(api.navigate).toHaveBeenCalledTimes(1);
});

it("does not replay an uncertain sign-out against a newer session", async () => {
  api.signOut.mockRejectedValueOnce(new Error("offline"));
  mount();
  confirm();
  await tick();
  api.read.mockResolvedValue({
    data: { ...session.data, session: { id: "new-sign-in" } },
    error: null,
  });
  fireEvent.click(screen.getByRole("button", { name: "Retry sign-out" }));
  await tick();
  expect(
    screen.getByRole("link", { name: "Review current sign-in" }),
  ).toBeTruthy();
  expect(api.signOut).toHaveBeenCalledTimes(1);
  expect(api.navigate).not.toHaveBeenCalled();
});

it("shows a changed session rejected by the server between the read and write", async () => {
  api.signOut.mockResolvedValue({ data: null, error: { status: 409 } });
  mount();
  confirm();
  await tick();
  expect(
    screen.getByRole("link", { name: "Review current sign-in" }),
  ).toBeTruthy();
  expect(api.navigate).not.toHaveBeenCalled();
});

it("expires confirmation and coalesces clicks while a sign-out is pending", async () => {
  const held = deferred<typeof success>();
  api.signOut.mockReturnValueOnce(held.promise);
  mount();
  fireEvent.click(screen.getByRole("button", { name: "Sign Out" }));
  await tick(4_100);
  expect(screen.getByRole("button", { name: "Sign Out" })).toBeTruthy();
  confirm();
  await tick();
  fireEvent.click(screen.getByRole("button", { name: "Signing out…" }));
  await tick();
  expect(api.signOut).toHaveBeenCalledTimes(1);
  held.resolve(success);
  await tick();
  expect(api.navigate).toHaveBeenCalledTimes(1);
});

it("does not treat an empty or malformed response as a confirmed sign-out", async () => {
  api.signOut.mockResolvedValue({ data: {}, error: null });
  mount();
  confirm();
  await tick();
  expect(screen.getByRole("button", { name: "Retry sign-out" })).toBeTruthy();
  expect(api.navigate).not.toHaveBeenCalled();
});
