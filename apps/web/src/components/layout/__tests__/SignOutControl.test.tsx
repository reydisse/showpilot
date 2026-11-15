import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SignOutControl } from "../SignOutControl";
import { SignOutRecovery } from "@/components/auth/SignOutRecovery";
import { stopSignOutReconciliation, reconcileSignOut } from "@/lib/sign-out-reconciliation";
import { accountExitRequested, unlockLocalAccount } from "@/lib/local-account-exit";
const api = vi.hoisted(() => ({ read: vi.fn(), signOut: vi.fn(), navigate: vi.fn(), session: { data: { user: { id: "user-1" }, session: { id: "session-1" } } as unknown } }));
vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: api.read, signOut: api.signOut, $store: { atoms: { session: { get: () => api.session, set: (value: typeof api.session) => Object.assign(api.session, value) } } } } }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => api.navigate, useRouter: () => ({ routesById: {} }) }));
const current = { data: { user: { id: "user-1" }, session: { id: "session-1" } }, error: null };
const success = { data: { success: true }, error: null };
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
let client: QueryClient;
function mount() {
  client = new QueryClient(); client.setQueryData(["private-profile"], { name: "Fixture" });
  return render(<QueryClientProvider client={client}><SignOutControl userId="user-1" /><SignOutRecovery /></QueryClientProvider>);
}
const click = () => fireEvent.click(screen.getByRole("button", { name: "Sign Out" }));
const tick = async (ms = 20) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
beforeEach(() => { vi.useFakeTimers(); api.read.mockResolvedValue(current); api.signOut.mockResolvedValue(success); api.session.data = current.data; });
afterEach(() => { cleanup(); stopSignOutReconciliation(); unlockLocalAccount(); client?.clear(); vi.resetAllMocks(); vi.useRealTimers(); });
it("clears private state and goes to login on the first click without waiting for a session read", async () => {
  const held = deferred<typeof current>(); api.read.mockReturnValue(held.promise); mount(); click();
  expect(api.session.data).toBeNull(); expect(client.getQueryData(["private-profile"])).toBeUndefined();
  expect(accountExitRequested(document.cookie)).toBe(true);
  expect(api.navigate).toHaveBeenCalledWith({ to: "/login", replace: true, ignoreBlocker: true });
  click(); await tick(); expect(api.read).toHaveBeenCalledTimes(1); expect(api.signOut).not.toHaveBeenCalled();
  expect(screen.queryByRole("alert")).toBeNull();
  held.resolve(current); await tick(); expect(api.signOut).toHaveBeenCalledTimes(1);
});
it("keeps the local account closed on server failure and offers one plain recovery sentence", async () => {
  api.signOut.mockResolvedValueOnce({ data: null, error: { status: 503 } }); mount(); click(); await tick();
  expect(api.navigate).toHaveBeenCalledTimes(1); expect(client.getQueryData(["private-profile"])).toBeUndefined();
  expect(screen.getAllByRole("alert")).toHaveLength(1); expect(screen.getByText("Sign-out could not finish.")).toBeTruthy(); expect(document.querySelector("time")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry sign-out" })); await tick();
  expect(api.signOut).toHaveBeenLastCalledWith({ fetchOptions: { body: { expectedSessionId: "session-1" }, headers: { "X-ShowPilot-Local-Exit": "1" }, retry: 0, signal: expect.any(AbortSignal) } });
  expect(screen.queryByRole("alert")).toBeNull(); expect(accountExitRequested(document.cookie)).toBe(true);
});
it("bounds a stuck read and never sends a late sign-out after timeout", async () => {
  const held = deferred<typeof current>(); api.read.mockReturnValue(held.promise); mount(); click(); await tick(8100);
  expect(api.read.mock.calls[0][0].fetchOptions.signal.aborted).toBe(true); expect(screen.getByRole("alert")).toBeTruthy();
  held.resolve(current); await tick(); expect(api.signOut).not.toHaveBeenCalled(); expect(api.navigate).toHaveBeenCalledTimes(1);
});
it("retires a background attempt before a new explicit login can begin", async () => {
  const held = deferred<typeof current>(); api.read.mockReturnValue(held.promise); mount(); click(); await tick();
  stopSignOutReconciliation(); held.resolve(current); await tick(); expect(api.signOut).not.toHaveBeenCalled(); expect(screen.queryByRole("alert")).toBeNull();
});
it("never revokes a replacement session, including another sign-in by the same user", async () => {
  api.read.mockResolvedValue({ ...current, data: { ...current.data, session: { id: "session-2" } } }); mount(); click(); await tick(); expect(api.signOut).not.toHaveBeenCalled();
  expect(screen.getByRole("alert")).toBeTruthy(); expect(api.navigate).toHaveBeenCalledTimes(1);
});
it("keeps the exact session guard after an unacknowledged revocation and rejects a later login", async () => {
  api.signOut.mockResolvedValueOnce({ data: null, error: { status: 503 } }); mount(); click(); await tick();
  api.read.mockResolvedValueOnce({ ...current, data: { ...current.data, session: { id: "session-2" } } }); fireEvent.click(screen.getByRole("button", { name: "Retry sign-out" })); await tick();
  expect(api.signOut).toHaveBeenCalledTimes(1); expect(api.session.data).toBeNull();
});
it.each([null, {}, { success: false }])("does not treat a malformed acknowledgement as successful: %j", async data => {
  api.signOut.mockResolvedValue({ data, error: null }); mount(); click(); await tick(); expect(screen.getByRole("alert")).toBeTruthy(); expect(accountExitRequested(document.cookie)).toBe(true);
});
it("does not repeat work when account-menu and profile callbacks share a pending attempt", async () => {
  const held = deferred<typeof current>(); api.read.mockReturnValue(held.promise); mount(); click(); reconcileSignOut({ userId: "user-1", expectedSessionId: "session-1" }); await tick(); expect(api.read).toHaveBeenCalledTimes(1);
});
