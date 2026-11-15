import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { afterEach, expect, it, vi } from "vitest";

const source = ts.transpileModule(readFileSync(resolve(process.cwd(), "../mobile/src/lib/account-exit.ts"), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
function fixture() {
  const values = new Map<string, string>();
  const session = { data: { user: { id: "fixture-user" }, session: { id: "fixture-session" } } as unknown, error: null, isPending: false };
  const getCookie = vi.fn(async () => "fixture-session-cookie");
  const storage = { getItem: (key: string) => values.get(key), setItem: (key: string, value: string) => { values.set(key, value); }, setItemAsync: vi.fn(async (key: string, value: string) => { values.set(key, value); }) };
  const getToken = vi.fn(async (): Promise<string | null> => null);
  const modules: Record<string, unknown> = {
    "react-native": { Platform: { OS: "ios" } },
    "@/lib/auth-client": { authClient: { getCookie, $store: { atoms: { session: { get: () => session, set: (state: typeof session) => Object.assign(session, state) } } } }, authStorage: storage },
    "@/lib/native-notifications": { getNativePushToken: getToken },
    "@/lib/env": { SHOWPILOT_URL: "https://fixture.invalid" },
  };
  const api: Record<string, any> = {};
  new Function("require", "exports", source)((name: string) => { if (!(name in modules)) throw Error(`Unexpected ${name}`); return modules[name]; }, api);
  const queries = { cancelQueries: vi.fn(async () => {}), clear: vi.fn() };
  return { api, session, storage, values, queries, getCookie, getToken };
}
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
it("leaves mobile locally before a stuck credential read or any network request", async () => {
  vi.useFakeTimers(); const f = fixture(); f.getCookie.mockReturnValue(new Promise(() => {})); const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  expect(f.api.exitMobileAccount(f.queries, "fixture-org")).toBeUndefined();
  expect(f.session.data).toBeNull(); expect(f.queries.cancelQueries).toHaveBeenCalledOnce(); expect(f.queries.clear).toHaveBeenCalledOnce(); expect(f.api.mobileAccountIsLocked()).toBe(true); expect(fetch).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(8000); expect(f.api.mobileSignOutRecovery.getSnapshot()).toBe(true);
});
it("clears persisted cookies and revokes only the captured session with no shared cookie jar", async () => {
  const f = fixture(), fetch = vi.fn(async () => new Response(JSON.stringify({ success: true }))); vi.stubGlobal("fetch", fetch);
  f.api.exitMobileAccount(f.queries, "fixture-org"); await flush();
  expect(f.values.get("showpilot_cookie")).toBe("{}"); expect(f.values.get("showpilot_session_data")).toBe("{}");
  expect(fetch).toHaveBeenCalledWith("https://fixture.invalid/api/auth/sign-out", expect.objectContaining({ credentials: "omit", headers: expect.objectContaining({ cookie: "fixture-session-cookie", "X-ShowPilot-Local-Exit": "1" }), body: JSON.stringify({ expectedSessionId: "fixture-session" }) }));
  expect(f.api.mobileAccountIsLocked()).toBe(true); expect(f.api.mobileSignOutRecovery.getSnapshot()).toBe(false);
});
it("retains a failed revocation for exact retry without restoring a private session", async () => {
  const f = fixture(), fetch = vi.fn().mockResolvedValueOnce(new Response("failure", { status: 503 })).mockResolvedValueOnce(new Response(JSON.stringify({ success: true }))); vi.stubGlobal("fetch", fetch);
  f.api.exitMobileAccount(f.queries, "fixture-org"); await flush(); expect(f.api.mobileSignOutRecovery.getSnapshot()).toBe(true); expect(f.api.mobileAccountIsLocked()).toBe(true);
  f.api.retryMobileSignOut(); await flush(); expect(fetch).toHaveBeenCalledTimes(2); expect(fetch.mock.calls[0][1].body).toBe(fetch.mock.calls[1][1].body); expect(f.getCookie).toHaveBeenCalledOnce(); expect(f.session.data).toBeNull();
});
it("retires old cleanup before a new login and never overwrites its credentials from a late response", async () => {
  const f = fixture(); let finish!: (response: Response) => void; const fetch = vi.fn((_url: string, _init: any) => new Promise<Response>(done => { finish = done; })); vi.stubGlobal("fetch", fetch);
  f.api.exitMobileAccount(f.queries, "fixture-org"); await flush(); const signal = fetch.mock.calls[0][1].signal;
  await f.api.prepareMobileSignIn(); expect(signal.aborted).toBe(true); f.storage.setItem("showpilot_cookie", "new-login-cookie"); f.api.finishMobileSignIn(); finish(new Response(JSON.stringify({ success: true }))); await flush();
  expect(f.values.get("showpilot_cookie")).toBe("new-login-cookie"); expect(f.api.mobileAccountIsLocked()).toBe(false); f.api.retryMobileSignOut(); expect(fetch).toHaveBeenCalledOnce();
});
it("removes push delivery using the captured account before revocation", async () => {
  const f = fixture(); f.getToken.mockResolvedValue("fixture-push"); const fetch = vi.fn(async (url: string, _init: any) => new Response(JSON.stringify(url.endsWith("/sign-out") ? { success: true } : { ok: true }))); vi.stubGlobal("fetch", fetch);
  f.api.exitMobileAccount(f.queries, "fixture-org"); await flush();
  expect(fetch.mock.calls[0][0]).toBe("https://fixture.invalid/api/mobile/v1/push-token"); expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ orgId: "fixture-org", token: "fixture-push", enabled: false }); expect(fetch.mock.calls[0][1].headers.cookie).toBe("fixture-session-cookie"); expect(fetch.mock.calls[1][0]).toBe("https://fixture.invalid/api/auth/sign-out");
});
