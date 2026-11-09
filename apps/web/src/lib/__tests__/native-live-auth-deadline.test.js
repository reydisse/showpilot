import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as deadline from "../../../../mobile/src/lib/request-deadline.ts";

const platform = { OS: "ios" };
const cookie = vi.fn();
const pin = vi.fn();
const opened = [];
class Socket {
  constructor(...args) { opened.push(args); }
}
const modules = {
  "react-native": { Platform: platform },
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
const { createAuthenticatedWebSocket } = exported;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", Socket);
  platform.OS = "ios";
  opened.length = 0;
  cookie.mockReset().mockResolvedValue("session=fixture");
  pin.mockReset().mockResolvedValue("1234");
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it.each(["ios", "android"])("preserves cookie and org PIN headers on %s", async (os) => {
  platform.OS = os;
  await createAuthenticatedWebSocket("wss://native.test", "org");
  expect(pin).toHaveBeenCalledWith("org");
  expect(opened).toEqual([["wss://native.test", null, { headers: { Cookie: "session=fixture", "x-showpilot-rundown-pin": "1234" } }]]);
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
});
it("does not read credentials or open a socket for an already cancelled request", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(createAuthenticatedWebSocket("wss://native.test", "org", controller.signal)).rejects.toThrow();
  expect(cookie).not.toHaveBeenCalled();
  expect(pin).not.toHaveBeenCalled();
  expect(opened).toEqual([]);
});
it("lets the browser send its own cookie without waiting on native storage", async () => {
  platform.OS = "web";
  await createAuthenticatedWebSocket("wss://native.test", "org");
  expect(opened).toEqual([["wss://native.test"]]);
  expect(cookie).not.toHaveBeenCalled();
  expect(pin).not.toHaveBeenCalled();
});
