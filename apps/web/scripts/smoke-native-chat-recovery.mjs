// Exercise compiled native Chat with disposable real auth/D1/ChatRelay.
// Only delayed or missing network frames are simulated; message persistence is real.
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
await withLocalSmokeFixture(async ({ origin, orgId, operatorCookie, date }) => {
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
  let mode = "silent", lostId = null, historyMode = "normal";
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
        if (mode === "lost" && !lostId) lostId = parsed.clientMessageId;
      }
      if (socket.readyState === WebSocket.OPEN) socket.send(frame); else queue.push(frame);
    });
    let cancelled = false;
    route.onClose(() => { cancelled = socket.readyState === WebSocket.CONNECTING; socket.close(); });
    socket.on("open", () => queue.splice(0).forEach(frame => socket.send(frame)));
    socket.on("message", bytes => {
      const packet = JSON.parse(bytes.toString());
      if (chat && mode === "silent") return;
      if (chat && mode === "lost") {
        if (packet.type === "message" && packet.message.id === lostId) return;
        if (packet.type === "hydrate") packet.messages = packet.messages.filter(message => message.id !== lostId);
      }
      // A long-history fixture exposes pagination; its existing message remains
      // real and HTTP paging still goes through the authenticated Worker.
      if (chat && mode === "history" && packet.type === "hydrate" && room === "production") {
        const real = packet.messages;
        packet.messages = [...Array.from({ length: 2000 - real.length }, (_, i) => ({ id: `history-${i}`, senderId: "fixture-crew", senderName: "Fixture Crew", text: `History ${i}`, type: "text", timestamp: 1000 + i })), ...real];
      }
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
    if (url.pathname.endsWith("/history") && historyMode === "delay") await new Promise(resolve => setTimeout(resolve, 12000));
    const result = await fetch(`${origin}${url.pathname}${url.search}`, { method: request.method(), headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" }, ...(request.postData() ? { body: request.postData() } : {}) });
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
    await page.getByRole("textbox", { name: "Message Production Chat" }).waitFor();
    await send("Queued before history");
    await page.getByText("Queued, not sent", { exact: true }).waitFor(); assert.equal(sent.length, 0);
    assert.equal(await page.getByText("No messages yet. Start the conversation.", { exact: true }).count(), 0);
    await page.getByText(/Chat connection timed out before history arrived/).waitFor({ timeout: 20000 });
    for (const [width, height] of [[320, 568], [320, 900], [768, 1024], [1440, 900]]) {
      await page.setViewportSize({ width, height });
      await button("Retry chat connection").scrollIntoViewIfNeeded();
      const bounds = await button("Retry chat connection").boundingBox(); assert.ok(bounds.height >= 44);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      await button("Remove from outbox").scrollIntoViewIfNeeded();
      const removeBounds = await button("Remove from outbox").boundingBox();
      assert.ok(removeBounds.height >= 44 && removeBounds.x >= 0 && removeBounds.x + removeBounds.width <= width);
      await page.screenshot({ path: `/tmp/showpilot-native-chat-${height === 568 ? "short" : width}.png`, fullPage: true });
    }
    mode = "normal"; await button("Retry chat connection").click();
    await page.waitForFunction(() => !document.querySelector('[data-testid^="chat-delivery-"]'));
    assert.equal((await history()).filter(message => message.text === "Queued before history").length, 1);
    mode = "lost"; await send("Lost reply remains recoverable");
    await page.getByText("Delivery not confirmed", { exact: true }).waitFor({ timeout: 20000 });
    assert.equal((await history()).filter(message => message.id === lostId).length, 1);
    await room("Planning Room");
    assert.equal(await page.locator('[data-testid^="chat-delivery-"]').count(), 0);
    assert.equal(await page.getByText("Queued before history", { exact: true }).count(), 0);
    await room("Production Chat");
    await page.getByText("Delivery not confirmed", { exact: true }).waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(el => el.textContent === "Retry original message" && !el.disabled));
    mode = "normal"; await button("Retry original message").click();
    await page.waitForFunction(() => !document.querySelector('[data-testid^="chat-delivery-"]'));
    assert.equal(sent.filter(message => message.clientMessageId === lostId).length, 2);
    assert.equal((await history()).filter(message => message.id === lostId).length, 1);
    // Discard only a queued local entry, with explicit confirmation.
    mode = "silent"; await room("Planning Room"); await send("Remove only this queued message");
    await button("Remove from outbox").click(); await button("Keep tracking message").click();
    assert.equal(await page.locator('[data-testid^="chat-delivery-"]').count(), 1);
    await button("Remove from outbox").click(); await button("Confirm remove from outbox").click();
    await page.waitForFunction(() => !document.querySelector('[data-testid^="chat-delivery-"]'));
    assert.equal(sent.some(message => message.text === "Remove only this queued message"), false);
    mode = "history"; historyMode = "delay"; await room("Production Chat");
    await page.waitForFunction(() => document.body.textContent.includes("History 1990"));
    await page.evaluate(() => { for (const el of document.querySelectorAll('div')) { const style = getComputedStyle(el); if (['auto','scroll'].includes(style.overflowY) && el.scrollHeight > el.clientHeight + 20) el.scrollTop = el.scrollHeight; } });
    await button("Load earlier messages").click();
    await page.getByText(/Earlier messages timed out/).waitFor({ timeout: 20000 });
    historyMode = "normal"; await button("Retry loading earlier messages").click();
    await page.getByText(/Earlier messages timed out/).waitFor({ state: "hidden" });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ result: "pass", realAuth: true, realRelay: true, historyHandshakeDeadline: true, queuedUntilHydrated: true, lostReplyNavigation: true, sameIdentityRetryOneStoredMessage: true, confirmedLocalDiscard: true, historyDeadlineRetry: true, widths: [320, 768, 1440] }));
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
});
