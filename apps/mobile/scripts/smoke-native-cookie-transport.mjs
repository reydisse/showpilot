// macOS-only diagnostic. Real Foundation headers + production JS transport +
// real Demo HTTP/WebSocket authentication. It does not run the iOS app binary.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { EventEmitter } from "node:events";

const { values } = parseArgs({ options: {
  account: { type: "string" }, before: { type: "string" }, after: { type: "string" }, output: { type: "string" },
} });
assert.equal(process.platform, "darwin");
for (const name of ["account", "before", "after", "output"]) assert.ok(values[name], `--${name} is required`);
const origin = "https://app.showpilot.tech", slug = "showpilot-demo-nov04";
const account = JSON.parse(await readFile(resolve(values.account), "utf8"));
assert.equal(new URL(account.url).origin, origin); assert.equal(account.slug, slug);
const require = createRequire(new URL("../package.json", import.meta.url));
const ts = require("typescript"), WebSocket = require("ws");
const native = spawn("swift", [new URL("fixtures/native-cookie-store.swift", import.meta.url).pathname], { stdio: ["pipe", "pipe", "inherit"] });
const pending = new Map(); let sequence = 0;
createInterface({ input: native.stdout }).on("line", line => {
  const result = JSON.parse(line), task = pending.get(result.id);
  if (!task) throw new Error("Native fixture returned an unexpected result");
  pending.delete(result.id); task.resolve(result);
});
const rpc = (operation, data = {}) => new Promise((resolve, reject) => {
  const id = ++sequence; pending.set(id, { resolve, reject });
  native.stdin.write(JSON.stringify({ id, operation, ...data }) + "\n");
});
native.on("exit", () => { for (const task of pending.values()) task.reject(new Error("Native fixture exited")); pending.clear(); });
const proof = { org: slug, verifiedAt: new Date().toISOString(), sameSession: true, realOrgRequests: 0, cookiesLogged: false, cookiesPersisted: false, phases: [] };
let validCookie = ""; const permittedOrgs = new Set([slug]);
function allowed(path) {
  const url = new URL(path, origin);
  return url.origin === origin && (url.pathname.startsWith("/api/auth/") ||
    (url.pathname.startsWith("/api/mobile/v1/") && permittedOrgs.has(url.searchParams.get("orgId"))) ||
    [...permittedOrgs].some(id => url.pathname.startsWith(`/api/chat/${encodeURIComponent(id)}/`)));
}
async function http(path, headers = {}, init = {}) {
  assert.ok(allowed(path), "Request left the authorized Demo scope");
  return fetch(new URL(path, origin), { ...init, redirect: "manual", signal: AbortSignal.timeout(15000), headers: { Origin: origin, ...headers } });
}
async function loadTransport(source) {
  const filename = resolve(source, "apps/mobile/src/lib/auth-transport.ts");
  const deadline = {};
  const deadlineCode = ts.transpileModule(await readFile(resolve(source, "apps/mobile/src/lib/request-deadline.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function("exports", deadlineCode)(deadline);
  const exports = {};
  const modules = {
    "react-native": { Platform: { OS: "ios" }, TurboModuleRegistry: { get: name => {
      assert.equal(name, "Networking");
      return { clearCookies: callback => { rpc("clear").then(result => callback(result.hadCookies)); } };
    } } },
    "@/lib/auth-client": { authClient: { getCookie: async () => validCookie } },
    "@/lib/rundown-pin": { getStoredRundownPin: async () => null },
    "./request-deadline": deadline,
  };
  const transportSource = await readFile(filename, "utf8");
  const code = ts.transpileModule(transportSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function("require", "exports", code)(name => { assert.ok(name in modules, "Unexpected transport dependency"); return modules[name]; }, exports);
  return { ...exports, sourceHead: execFileSync("git", ["rev-parse", "HEAD"], { cwd: resolve(source), encoding: "utf8" }).trim(), transportSha256: createHash("sha256").update(transportSource).digest("hex") };
}
const originalWebSocket = globalThis.WebSocket;
class NativeSocket extends EventEmitter {
  constructor(url, _protocols, options) {
    super(); this.closed = false;
    const https = new URL(url); https.protocol = "https:"; assert.ok(allowed(https));
    // RN always loads its native jar before adding the explicit headers.
    rpc("headers", { url: https.toString(), credentials: "include", headers: options.headers }).then(result => {
      if (this.closed) return;
      this.socket = new WebSocket(url, { headers: { ...result.headers, Origin: origin } });
      for (const event of ["open", "message", "error", "close"]) this.socket.on(event, (...args) => this.emit(event, ...args));
      this.socket.on("unexpected-response", (_request, response) => { response.resume(); this.emit("denied", response.statusCode); });
    }).catch(error => this.emit("error", error));
  }
  close() { this.closed = true; this.socket?.close(); }
}
globalThis.WebSocket = NativeSocket;
try {
  const login = await http("/api/auth/sign-in/email", { "Content-Type": "application/json" }, { method: "POST", body: JSON.stringify({ email: account.email, password: account.password }) });
  assert.equal(login.status, 200); await login.arrayBuffer();
  const pairs = login.headers.getSetCookie().map(value => value.split(";")[0]);
  const session = pairs.find(pair => /^(?:__Secure-)?better-auth\.session_token=/.test(pair)); assert.ok(session);
  validCookie = [session, ...pairs.filter(pair => pair !== session)].join("; ");
  const cookieName = session.slice(0, session.indexOf("="));
  const bootstrapResponse = await http(`/api/mobile/v1/bootstrap?orgId=${slug}`, { Cookie: validCookie });
  assert.equal(bootstrapResponse.status, 200); const bootstrap = await bootstrapResponse.json();
  assert.equal(bootstrap.organization.slug, slug); const orgId = bootstrap.organization.id; permittedOrgs.add(orgId);
  const cueResponse = await http(`/api/mobile/v1/cue-sheets?orgId=${orgId}`, { Cookie: validCookie });
  assert.equal(cueResponse.status, 200); const cue = await cueResponse.json();
  const showId = bootstrap.shows[0]?.id ?? cue.show?.id ?? cue.shows[0]?.id; assert.ok(showId, "Demo show is required; this diagnostic never creates one");
  const paths = [
    ["cue-sheets", `/api/mobile/v1/cue-sheets?orgId=${orgId}`], ["chat-members", `/api/mobile/v1/chat/members?orgId=${orgId}`],
    ["chat-history", `/api/chat/${orgId}/history?room=production`], ["rundown", `/api/mobile/v1/rundowns/${showId}?orgId=${orgId}`],
  ];
  for (const [label, source] of [["before", values.before], ["after", values.after]]) {
    const transport = await loadTransport(source), phase = { label, source: resolve(source), sourceHead: transport.sourceHead, transportSha256: transport.transportSha256, calls: [], socket: {} };
    await rpc("poison", { url: origin, cookieName });
    const battery = [...Array.from({ length: label === "before" ? 1 : 4 }, () => paths).flat(), ...(label === "after" ? [paths[0]] : [])];
    for (const [endpoint, path] of battery) {
      const result = await rpc("headers", { url: origin + path, credentials: transport.getAuthenticatedFetchCredentials() ?? "include", headers: await transport.getNativeCookieHeader() });
      const response = await http(path, result.headers); await response.arrayBuffer();
      phase.calls.push({ endpoint, status: response.status }); assert.equal(response.status, label === "before" ? 401 : 200);
    }
    // Poison again so the socket must isolate the store itself, independently
    // of HTTP credentials:omit. No messages or operator commands are sent.
    await rpc("poison", { url: origin, cookieName });
    const socket = await transport.createAuthenticatedWebSocket(`wss://app.showpilot.tech/api/chat/${orgId}/ws?room=production`);
    phase.socket = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error("Demo socket did not produce an initial result")); }, 10000);
      const finish = result => { clearTimeout(timer); socket.close(); resolve(result); };
      socket.on("denied", status => finish({ status, hydrated: false }));
      socket.on("message", raw => { const message = JSON.parse(raw.toString()); if (message.type === "hydrate") finish({ status: 101, hydrated: true }); });
      socket.on("error", reject);
    });
    assert.equal(phase.socket.status, label === "before" ? 401 : 101); assert.equal(phase.socket.hydrated, label === "after");
    proof.phases.push(phase);
  }
  const sessionResponse = await http("/api/auth/get-session", { Cookie: validCookie });
  assert.equal(sessionResponse.status, 200); const current = await sessionResponse.json(); assert.equal(current.user.email, account.email);
  await writeFile(resolve(values.output), JSON.stringify(proof, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify(proof, null, 2));
} finally {
  globalThis.WebSocket = originalWebSocket;
  native.stdin.end();
}
