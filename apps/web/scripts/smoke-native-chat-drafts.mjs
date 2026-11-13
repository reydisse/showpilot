// Exercise native Chat drafts and notification recovery with real local D1/ChatRelay.
// A recipient-specific D1 trigger and a lost HTTP reply expose partial delivery.
// All app API and socket traffic is intercepted; no production endpoint is contacted.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname, join } from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
const modules = execFileSync("npm", ["root", "-g"], {
  encoding: "utf8",
}).trim();
const { chromium } = createRequire(join(modules, "agent-browser/package.json"))(
  "playwright-core",
);
const WebSocket = createRequire(join(modules, "agent-browser/package.json"))(
  "ws",
);
const root = resolve(import.meta.dirname, "../../mobile/dist/web");
await withLocalSmokeFixture(async ({ origin, orgId, operatorCookie, queryFixture, restoreChatNotifications, readDeliveredChatNotification }) => {
  const activated = await fetch(`${origin}/api/auth/organization/set-active`, {
    method: "POST",
    headers: {
      Cookie: operatorCookie,
      Origin: origin,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ organizationId: orgId }),
  });
  assert.equal(activated.status, 200, await activated.clone().text());
  await activated.arrayBuffer();
  const cookies = new Map(
    operatorCookie.split("; ").map((value) => [value.split("=")[0], value]),
  );
  for (const value of activated.headers.getSetCookie()) {
    const cookie = value.split(";")[0];
    cookies.set(cookie.split("=")[0], cookie);
  }
  const cookie = [...cookies.values()].join("; ");
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(
        new URL(request.url, "http://fixture").pathname,
      );
      let file = resolve(root, `.${pathname}`);
      if (!file.startsWith(root + "/") && file !== root) {
        response.writeHead(403).end();
        return;
      }
      if (!extname(file))
        file = file === root ? join(root, "index.html") : file + ".html";
      const body = await readFile(file);
      response.writeHead(200, {
        "Content-Type":
          {
            ".html": "text/html",
            ".js": "application/javascript",
            ".css": "text/css",
            ".png": "image/png",
            ".woff2": "font/woff2",
            ".ttf": "font/ttf",
          }[extname(file)] ?? "application/octet-stream",
      });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const nativeOrigin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
  });
  const errors = [], sockets = new Set(), sent = [], httpRequests = new Set();
  let closing = false;
  // Keep an outer network guard until Chrome closes, including during teardown.
  await page.context().route("**/*", route => new URL(route.request().url()).origin === nativeOrigin ? route.continue() : route.abort());
  const notifications = []; let delayNotificationReply = false;
  page.on("pageerror", error => errors.push(error.message));
  await page.routeWebSocket("**/*", route => {
    const url = new URL(route.url());
    if (!url.pathname.startsWith(`/api/chat/${orgId}/`) && !url.pathname.startsWith(`/api/rundown/${orgId}/`)) return route.close();
    const local = new URL(`${origin}${url.pathname}${url.search}`); local.protocol = "ws:";
    const socket = new WebSocket(local, { headers: { Cookie: cookie, Origin: origin } });
    sockets.add(socket); const queue = [];
    const chat = url.pathname.includes("/chat/"), room = url.searchParams.get("room");
    route.onMessage(frame => {
      const parsed = JSON.parse(frame);
      if (chat && parsed.type === "message") {
        sent.push({ room, ...parsed });
      }
      if (socket.readyState === WebSocket.OPEN) socket.send(frame); else queue.push(frame);
    });
    let cancelled = false;
    route.onClose(() => { cancelled = socket.readyState === WebSocket.CONNECTING; socket.close(); });
    socket.on("open", () => queue.splice(0).forEach(frame => socket.send(frame)));
    socket.on("message", bytes => {
      const packet = JSON.parse(bytes.toString());
      route.send(JSON.stringify(packet));
    });
    socket.on("error", error => { if (!cancelled || error.message !== "WebSocket was closed before the connection was established") errors.push(error.message); });
    socket.on("close", () => { sockets.delete(socket); void route.close().catch(() => {}); });
  });
  async function forward(route) {
    const request = route.request(), url = new URL(request.url());
    if (!url.pathname.startsWith("/api/")) {
      try { return await (url.origin === nativeOrigin ? route.continue() : route.abort()); }
      catch (error) { if (!closing) throw error; return; }
    }
    const result = await fetch(`${origin}${url.pathname}${url.search}`, { method: request.method(), headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" }, ...(request.postData() ? { body: request.postData() } : {}) });
    if (url.pathname.endsWith("/chat/notify") || url.pathname.endsWith("/chat/reaction-notify")) {
      notifications.push({ body: JSON.parse(request.postData()), status: result.status });
      if (delayNotificationReply) await new Promise(resolve => setTimeout(resolve, 17000));
    }
    await route.fulfill({ status: result.status, headers: { "content-type": "application/json", "access-control-allow-origin": nativeOrigin, "access-control-allow-credentials": "true" }, body: Buffer.from(await result.arrayBuffer()) }).catch(() => {});
  }
  await page.route("**/*", route => {
    const task = forward(route); httpRequests.add(task);
    task.then(() => httpRequests.delete(task), () => httpRequests.delete(task));
    return task;
  });
  const button = name => page.getByRole("button", { name, exact: true });
  async function room(name) {
    await page.getByRole("button", { name: /^Switch chat room/ }).click();
    await page.getByRole("radio", { name: new RegExp(name) }).click();
    await page.getByRole("button", { name: `Switch chat room. Current room: ${name}` }).waitFor();
    await page.getByText("Choose a conversation", { exact: true }).waitFor({ state: "hidden" });
  }
  async function send(text) {
    await page.getByRole("textbox", { name: /^Message / }).fill(text); await button("Send message").click();
  }
  async function history() {
    const response = await fetch(`${origin}/api/chat/${orgId}/history?room=production`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200); return (await response.json()).messages;
  }
  try {
    await page.goto(`${nativeOrigin}/chat`);
    const composer = () => page.getByRole("textbox", { name: /^Message / });
    await composer().waitFor();
    await composer().fill("Production draft retained");
    await room("Planning Room"); assert.equal(await composer().inputValue(), "");
    await composer().fill("Planning draft retained");
    await room("Production Chat"); assert.equal(await composer().inputValue(), "Production draft retained");
    await room("Planning Room"); assert.equal(await composer().inputValue(), "Planning draft retained");
    await room("Production Chat");
    // The compiled hook must preserve a separate poll as well as the text draft.
    await button("Open message tools").click(); await page.getByText("Quick poll", { exact: true }).click();
    await page.getByPlaceholder("What should the team decide?").fill("Ready for rehearsal?");
    await page.getByPlaceholder("Option 1", { exact: true }).fill("Ready");
    await page.getByPlaceholder("Option 2", { exact: true }).fill("Need a minute");
    await page.getByLabel("Close poll", { exact: true }).click();
    await room("Planning Room"); await room("Production Chat");
    await button("Open message tools").click(); await page.getByText("Quick poll", { exact: true }).click();
    assert.equal(await page.getByPlaceholder("What should the team decide?").inputValue(), "Ready for rehearsal?");
    assert.equal(await page.getByPlaceholder("Option 2", { exact: true }).inputValue(), "Need a minute");
    await page.getByLabel("Close poll", { exact: true }).click();
    await button("Send message").click();
    await page.getByText("Delivered · notifications need attention", { exact: true }).waitFor({ timeout: 20000 });
    assert.equal(await composer().inputValue(), "");
    assert.equal(sent.length, 1); const id = sent[0].clientMessageId;
    assert.equal((await history()).filter(message => message.id === id).length, 1);
    assert.equal(notifications[0].status, 503);
    const rows = () => queryFixture("SELECT userId,source,readAt,dismissed FROM notification WHERE orgId='display-smoke' AND type='chat-group-message' ORDER BY userId,source");
    let inbox = await rows(); assert.equal(inbox.length, 1); assert.equal(inbox[0].userId, "smoke-third-operator");
    await readDeliveredChatNotification();
    await room("Planning Room"); assert.equal(await page.locator('[data-testid^="chat-delivery-"]').count(), 0);
    assert.equal(await composer().inputValue(), "Planning draft retained");
    await room("Production Chat"); await page.getByText("Delivered · notifications need attention", { exact: true }).waitFor();
    for (const [width, height] of [[320,568],[320,900],[768,1024],[1440,900]]) {
      await page.setViewportSize({ width, height });
      await button("Retry crew notifications").scrollIntoViewIfNeeded();
      await button("Retry crew notifications").click({ trial: true });
      const bounds = await button("Retry crew notifications").boundingBox();
      assert.ok(bounds.height >= 44 && bounds.x >= 0 && bounds.x + bounds.width <= width);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      await page.screenshot({ path: `/tmp/showpilot-chat-drafts-${height === 568 ? "short" : width}.png`, fullPage: true });
    }
    await restoreChatNotifications(); await button("Retry crew notifications").click();
    await page.waitForFunction(() => !document.querySelector('[data-testid^="chat-delivery-"]'));
    assert.equal(sent.length, 1); assert.deepEqual(notifications[1].body, notifications[0].body);
    inbox = await rows(); assert.equal(inbox.length, 2);
    assert.equal(inbox.find(row => row.userId === "smoke-third-operator").readAt, "2026-11-09T00:00:00.000Z");
    assert.equal(inbox.find(row => row.userId === "smoke-third-operator").dismissed, 1);
    // The server commits both inbox entries but its HTTP reply is lost.
    delayNotificationReply = true; await send("Notification reply lost");
    await page.getByText("Delivered · notifications need attention", { exact: true }).waitFor({ timeout: 25000 });
    delayNotificationReply = false;
    await room("Planning Room"); await room("Production Chat");
    await button("Retry crew notifications").click();
    await page.waitForFunction(() => !document.querySelector('[data-testid^="chat-delivery-"]'));
    assert.equal(sent.length, 2); assert.equal((await history()).length, 2); assert.equal((await rows()).length, 4);
    assert.deepEqual(notifications[3].body, notifications[2].body);
    // Sending text must not silently discard an unfinished poll.
    await button("Open message tools").click(); await page.getByText("Quick poll", { exact: true }).click();
    assert.equal(await page.getByPlaceholder("What should the team decide?").inputValue(), "Ready for rehearsal?");
    await page.getByLabel("Close poll", { exact: true }).click();
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ result: "pass", realAuth: true, realRelay: true, realInboxFailure: true, partialInboxRecovery: true, preservedReadAndDismissed: true, notificationOnlyRetry: true, lostReplyRecovery: true, retainedTextAndPollDrafts: true, widths: [320,768,1440] }));
  } catch (error) { console.error(JSON.stringify({ body: await page.locator("body").innerText(), errors })); throw error; }
  finally {
    closing = true;
    for (const socket of sockets) socket.close();
    await browser.close();
    // In-flight delayed requests still need the fixture Worker. No page remains
    // to start more work, and all API requests continue to target localhost.
    await Promise.all([...httpRequests]);
    await new Promise(resolve => server.close(resolve));
  }
}, { secondOperator: true, chatDeliveryNotifications: true });
