import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import ts from "typescript";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as deadline from "../../../../mobile/src/lib/request-deadline.ts";

// Use the signal implementation RN actually installs, rather than Node's newer
// AbortSignal API. Otherwise a native-only missing method passes this suite.
const mobileRequire = createRequire(resolve(process.cwd(), "../mobile/package.json"));
const nativeRequire = createRequire(mobileRequire.resolve("react-native/package.json"));
const { AbortController: NativeAbortController, AbortSignal: NativeAbortSignal } =
  nativeRequire("abort-controller/dist/abort-controller");

const platform = { OS: "ios" };
const cookie = vi.fn();
const pin = vi.fn();
const opened = [];
const sentCookies = [];
let ambientCookies = [];
const clearCookies = vi.fn();
const nativeNetworking = vi.fn();
class Socket {
  constructor(...args) {
    opened.push(args);
    // Mirrors RN iOS: native jar first, then addValue of the supplied Cookie.
    // Foundation's actual comma concatenation is covered by the native probe.
    if (args[2]?.headers.Cookie) sentCookies.push([...ambientCookies, args[2].headers.Cookie].join(","));
  }
}
const modules = {
  "react-native": { Platform: platform, TurboModuleRegistry: { get: nativeNetworking } },
  "@/lib/auth-client": { authClient: { getCookie: cookie } },
  "@/lib/rundown-pin": { getStoredRundownPin: pin },
  "./request-deadline": deadline,
};
const exported = {};
const code = ts.transpileModule(readFileSync(resolve(process.cwd(), "../mobile/src/lib/auth-transport.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
new Function("require", "exports", code)((name) => {
  if (!(name in modules)) throw new Error(`Missing native module ${name}`);
  return modules[name];
}, exported);
const { createAuthenticatedWebSocket, getAuthenticatedFetchCredentials } = exported;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("AbortController", NativeAbortController);
  vi.stubGlobal("AbortSignal", NativeAbortSignal);
  vi.stubGlobal("WebSocket", Socket);
  platform.OS = "ios";
  opened.length = 0;
  sentCookies.length = 0;
  ambientCookies = ["session=stale-account"];
  clearCookies.mockReset().mockImplementation(callback => { ambientCookies = []; callback(true); });
  nativeNetworking.mockReset().mockReturnValue({ clearCookies });
  cookie.mockReset().mockResolvedValue("session=fixture");
  pin.mockReset().mockResolvedValue("1234");
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it.each(["ios", "android"])("preserves cookie and org PIN headers on %s", async (os) => {
  platform.OS = os;
  await createAuthenticatedWebSocket("wss://native.test", "org");
  expect(pin).toHaveBeenCalledWith("org");
  expect(opened).toEqual([["wss://native.test", null, { headers: { Cookie: "session=fixture", "x-showpilot-rundown-pin": "1234" } }]]);
  expect(nativeNetworking).toHaveBeenCalledWith("Networking");
  expect(clearCookies).toHaveBeenCalledOnce();
  expect(sentCookies).toEqual(["session=fixture"]);
  expect(getAuthenticatedFetchCredentials()).toBe("omit");
});
it("bounds stalled native cookie cleanup, ignores its late callback and permits a fresh retry", async () => {
  let finish;
  clearCookies.mockImplementationOnce(callback => { finish = callback; });
  const result = createAuthenticatedWebSocket("wss://native.test", "org").catch(error => error);
  await vi.advanceTimersByTimeAsync(10001);
  expect((await result).message).toMatch(/authentication timed out/i);
  finish(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(opened).toEqual([]);
  await createAuthenticatedWebSocket("wss://native.test", "org");
  expect(sentCookies).toEqual(["session=fixture"]);
});
it("treats an already empty native store as successful cleanup", async () => {
  ambientCookies = [];
  clearCookies.mockImplementationOnce(callback => callback(false));
  await createAuthenticatedWebSocket("wss://native.test", "org");
  expect(sentCookies).toEqual(["session=fixture"]);
});
it.each([["module", null], ["method", {}]])("does not connect without the native cookie isolation %s", async (_, networking) => {
  nativeNetworking.mockReturnValueOnce(networking);
  await expect(createAuthenticatedWebSocket("wss://native.test", "org")).rejects.toThrow(/cookie isolation is unavailable/);
  expect(opened).toEqual([]);
});
it("cancels during native cookie cleanup without opening a late socket", async () => {
  let finish;
  clearCookies.mockImplementationOnce(callback => { finish = callback; });
  const controller = new AbortController();
  const result = createAuthenticatedWebSocket("wss://native.test", "org", controller.signal).catch(error => error);
  await vi.advanceTimersByTimeAsync(1);
  controller.abort();
  expect(await result).toBeInstanceOf(Error);
  finish(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(opened).toEqual([]);
});
it.each(["cookie", "pin"])("bounds a stalled %s read and never opens a socket from its late result", async (kind) => {
  let finish;
  (kind === "cookie" ? cookie : pin).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const result = createAuthenticatedWebSocket("wss://native.test", "org").catch(error => error);
  await vi.advanceTimersByTimeAsync(10001);
  expect((await result).message).toMatch(/authentication timed out/i);
  finish("late-secret");
  await vi.advanceTimersByTimeAsync(1);
  expect(opened).toEqual([]);
});
it("cancels a pending credential read on navigation before it can open a socket", async () => {
  let finish;
  cookie.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const controller = new AbortController();
  const result = createAuthenticatedWebSocket("wss://native.test", "org", controller.signal).catch(error => error);
  await vi.advanceTimersByTimeAsync(1);
  controller.abort();
  expect(await result).toBeInstanceOf(Error);
  finish("late-secret");
  await vi.advanceTimersByTimeAsync(1);
  expect(opened).toEqual([]);
  expect(clearCookies).not.toHaveBeenCalled();
});
it("does not read credentials or open a socket for an already cancelled request", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(createAuthenticatedWebSocket("wss://native.test", "org", controller.signal)).rejects.toThrow();
  expect(cookie).not.toHaveBeenCalled();
  expect(pin).not.toHaveBeenCalled();
  expect(opened).toEqual([]);
  expect(clearCookies).not.toHaveBeenCalled();
});
it("lets the browser send its own cookie without waiting on native storage", async () => {
  platform.OS = "web";
  await createAuthenticatedWebSocket("wss://native.test", "org");
  expect(opened).toEqual([["wss://native.test"]]);
  expect(cookie).not.toHaveBeenCalled();
  expect(pin).not.toHaveBeenCalled();
  expect(nativeNetworking).not.toHaveBeenCalled();
  expect(getAuthenticatedFetchCredentials()).toBe("include");
});
