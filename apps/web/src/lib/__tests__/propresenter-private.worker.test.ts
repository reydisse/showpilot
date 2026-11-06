import { env } from "cloudflare:workers";
import { abortAllDurableObjects, evictDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { seedRelayMember } from "@/test/relay-fixtures";
import { openTestBridge, approveTestBridgeTarget, bridgeClientTestRequest } from "@/test/bridge-fixtures";
import { encryptSettingValue } from "../credential-settings.server";
const auth = vi.hoisted(() => ({ userId: "" }));
vi.mock("../auth", () => ({ getAuth: () => ({ api: { getSession: async () => ({ user: { id: auth.userId, name: "Fixture", email: "fixture@example.test" } }) } }) }));
vi.mock("@tanstack/react-start/server", () => ({ getRequestHeaders: () => new Headers() }));
vi.mock("@tanstack/react-start", () => {
  const builder = () => {
    let validate = (data: unknown) => data;
    const chain = { middleware: () => chain, inputValidator: (fn: typeof validate) => { validate = fn; return chain; }, handler: (fn: (input: { data: unknown }) => unknown) => (input: { data: unknown }) => fn({ data: validate(input.data) }), server: () => chain };
    return chain;
  };
  return { createServerFn: builder, createMiddleware: builder, createServerOnlyFn: <T>(fn: T): T => fn };
});
import { getProPresenterConfiguration, getDesktopBridgeAccess } from "../settings";
import { getProPresenterFeed } from "../rundown";
const secret = "private-pp-fixture";
const target = "propresenter:venue.local:50001";
afterEach(() => abortAllDurableObjects());
async function fixture() {
  const member = await seedRelayMember(`private-pp-${crypto.randomUUID()}`);
  auth.userId = member.userId;
  for (const [key, value] of Object.entries({ "propresenter-host": "venue.local", "propresenter-port": "50001", "propresenter-api-port": "1025", "propresenter-password": await encryptSettingValue(env.CREDENTIAL_ENCRYPTION_KEYS, member.orgId, "propresenter-password", secret) })) {
    await env.DB.prepare("INSERT INTO app_setting (id,orgId,key,value) VALUES (?,?,?,?)").bind(crypto.randomUUID(), member.orgId, key, value).run();
  }
  return member;
}
function next(socket: WebSocket, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.removeEventListener("message", handler); reject(new Error(`Missing ${type}`)); }, 3000);
    function handler(event: MessageEvent) {
      const message = JSON.parse(String(event.data));
      if (message.type !== type) return;
      clearTimeout(timer); socket.removeEventListener("message", handler); resolve(message);
    }
    socket.addEventListener("message", handler);
  });
}

it("returns only public configuration to operators and keeps desktop provisioning limited to API-key managers", async () => {
  const { orgId, userId } = await fixture();
  const owner = await getProPresenterConfiguration({ data: { orgId } });
  expect(owner).toEqual({ "propresenter-host": "venue.local", "propresenter-port": "50001", "propresenter-api-port": "1025" });
  expect(await getDesktopBridgeAccess({ data: { orgId } })).toEqual({ orgId });
  await env.DB.prepare("UPDATE member SET role='tm' WHERE organizationId=? AND userId=?").bind(orgId, userId).run();
  expect(await getProPresenterConfiguration({ data: { orgId } })).toEqual(owner);
  await expect(getDesktopBridgeAccess({ data: { orgId } })).rejects.toThrow("Forbidden");
  await fixture();
  await expect(getProPresenterConfiguration({ data: { orgId } })).rejects.toThrow("Forbidden");
  await expect(getProPresenterFeed({ data: { orgId } })).rejects.toThrow("Forbidden");
});

it("delivers stored ProPresenter credentials only to the selected native recipient, including after hibernation", async () => {
  const { orgId } = await fixture();
  const active = await openTestBridge(orgId);
  const standby = await openTestBridge(orgId);
  await approveTestBridgeTarget(orgId, "propresenter", target, { apiPort: 1025 });
  const response = await active.stub.fetch(await bridgeClientTestRequest(orgId));
  const client = response.webSocket!;
  const ready = next(client, "bridge-status"); client.accept(); await ready;
  const publicMessages: unknown[] = [];
  const standbyMessages: unknown[] = [];
  client.addEventListener("message", event => { publicMessages.push(JSON.parse(String(event.data))); });
  standby.socket.addEventListener("message", event => { standbyMessages.push(JSON.parse(String(event.data))); });
  for (const hibernate of [false, true]) {
    if (hibernate) await evictDurableObject(active.stub);
    const wire = next(active.socket, "connect-device");
    active.socket.send(JSON.stringify({ type: "configured-propresenter-requested", target: "attacker.local", password: "forged" }));
    const message = await wire;
    expect(message.target).toBe(target);
    expect(Object.keys(message).sort()).toEqual(["protectedSettings", "protocol", "target", "type"]);
    expect(JSON.stringify(message)).not.toMatch(/private-pp-fixture|spenc:|forged/);
    const context = { orgId, installationId: active.credential.installationId, protocol: "propresenter", target };
    await expect(standby.recipient.open(message.protectedSettings, context)).rejects.toThrow();
    expect(await active.recipient.open(message.protectedSettings, context)).toEqual({ host: "venue.local", port: 50001, apiPort: 1025, password: secret });
  }
  // A read-only browser cannot ask for native configuration delivery.
  client.send(JSON.stringify({ type: "configured-propresenter-requested" }));
  standby.socket.send(JSON.stringify({ type: "configured-propresenter-requested" }));
  await new Promise(resolve => setTimeout(resolve, 25));
  expect(JSON.stringify(publicMessages)).not.toMatch(/private-pp-fixture|protectedSettings|spenc:/);
  expect(standbyMessages.filter(message => JSON.stringify(message).includes("protectedSettings"))).toEqual([]);
  const audit = await env.DB.prepare("SELECT actorUserId,source,protocol,host,port FROM bridge_target_audit WHERE orgId=? AND action='connection-requested'").bind(orgId).all();
  expect(audit.results.length).toBeGreaterThanOrEqual(2);
  expect(JSON.stringify(audit)).not.toContain(secret);
});

it("rejects unapproved native configuration requests without delivering an envelope", async () => {
  const { orgId } = await fixture();
  const bridge = await openTestBridge(orgId);
  const rejected = next(bridge.socket, "configured-propresenter-unavailable");
  bridge.socket.send(JSON.stringify({ type: "configured-propresenter-requested" }));
  expect(await rejected).toEqual({ type: "configured-propresenter-unavailable" });
  const audit = await env.DB.prepare("SELECT action FROM bridge_target_audit WHERE orgId=?").bind(orgId).all();
  expect(audit.results).toContainEqual({ action: "rejected" });
});

it("returns confirmed slides and explicit clears, while offline results contain no clear event or credential", async () => {
  const { orgId } = await fixture();
  const bridge = await openTestBridge(orgId);
  await approveTestBridgeTarget(orgId, "propresenter", target, { apiPort: 1025 });
  bridge.socket.send(JSON.stringify({ type: "device-status", target, connected: true }));
  bridge.socket.send(JSON.stringify({ type: "device-event", target, eventName: "slide", data: JSON.stringify({ text: "Current", nextText: "Upcoming" }) }));
  await expect.poll(async () => (await bridge.stub.getBridgeStatus()).deviceEvents?.[target]?.eventName).toBe("slide");
  const feed = await getProPresenterFeed({ data: { orgId } });
  expect(feed).toMatchObject({ status: "connected", event: { kind: "slide", slide: { text: "Current", nextText: "Upcoming" } } });
  expect(JSON.stringify(feed)).not.toMatch(/private-pp-fixture|spenc:|password/);
  bridge.socket.send(JSON.stringify({ type: "device-event", target, eventName: "slide", data: "null" }));
  await expect.poll(async () => (await bridge.stub.getBridgeStatus()).deviceEvents?.[target]?.data).toBe("null");
  expect(await getProPresenterFeed({ data: { orgId } })).toMatchObject({ event: { kind: "clear" } });
  bridge.socket.close();
  await expect.poll(async () => (await bridge.stub.getBridgeStatus()).bridgeOnline).toBe(false);
  expect(await getProPresenterFeed({ data: { orgId } })).toMatchObject({ status: "error", event: null, bridgeOnline: false });
});

it("gives rundown operators a hibernation-safe slide-only socket without device-control authority", async () => {
  const { orgId } = await fixture();
  const bridge = await openTestBridge(orgId);
  const original = await bridgeClientTestRequest(orgId);
  await env.DB.prepare("UPDATE member SET role='pm' WHERE organizationId=? AND userId=?").bind(orgId, `${orgId}-operator`).run();
  const url = new URL(original.url); url.searchParams.set("role", "propresenter-viewer");
  const response = await bridge.stub.fetch(new Request(url, { headers: original.headers }));
  expect(response.status).toBe(101);
  const viewer = response.webSocket!;
  const ready = next(viewer, "bridge-status"); viewer.accept();
  expect(await ready).toEqual({ type: "bridge-status", online: true });
  const nativeMessages: unknown[] = [];
  const viewerMessages: unknown[] = [];
  bridge.socket.addEventListener("message", event => { nativeMessages.push(JSON.parse(String(event.data))); });
  viewer.addEventListener("message", event => { viewerMessages.push(JSON.parse(String(event.data))); });
  for (const hibernate of [false, true]) {
    if (hibernate) await evictDurableObject(bridge.stub);
    const slide = next(viewer, "device-event");
    bridge.socket.send(JSON.stringify({ type: "device-event", target: "obs.local:4455", eventName: "private-status", data: '{"scene":"private-device"}' }));
    bridge.socket.send(JSON.stringify({ type: "device-event", target, eventName: "slide", data: '{"text":"Viewer lyric","password":"never-visible"}' }));
    expect(await slide).toMatchObject({ type: "device-event", target, eventName: "slide" });
    viewer.send(JSON.stringify({ type: "command", id: "forbidden-control", protocol: "propresenter", target, command: "next" }));
    viewer.send(JSON.stringify({ type: "connect-device", protocol: "propresenter", target, settings: { password: "forged" } }));
  }
  await bridge.stub.refreshReadAuthority();
  expect(JSON.stringify(viewerMessages)).not.toMatch(/never-visible|private-device|obs.local|protectedSettings|password/);
  expect(JSON.stringify(nativeMessages)).not.toMatch(/forbidden-control|forged/);
  const closed = new Promise<number>(resolve => viewer.addEventListener("close", event => resolve(event.code), { once: true }));
  await env.DB.prepare("UPDATE member SET role='member' WHERE organizationId=? AND userId=?").bind(orgId, `${orgId}-operator`).run();
  await bridge.stub.refreshReadAuthority(`${orgId}-operator`);
  expect(await closed).toBe(4403);
});
