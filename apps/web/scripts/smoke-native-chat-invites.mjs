// Exercise native invite recovery with real local auth, D1 and chat pass issuance.
// Only the lost HTTP reply and native share outcomes are simulated.
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
await withLocalSmokeFixture(async ({ origin, orgId, operatorCookie, queryFixture, restoreChatNotifications }) => {
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
  const invites = []; let dropFirstCrewReply = true, wrongMemberIdentity = true;
  await page.addInitScript(() => {
    window.fixtureShareMode = "failed"; window.fixtureSharedLinks = [];
    Object.defineProperty(navigator, "share", { configurable: true, value: async payload => {
      window.fixtureSharedLinks.push(payload.url);
      if (window.fixtureShareMode === "failed") throw new Error("Fixture sharing is unavailable");
      if (window.fixtureShareMode === "pending") return new Promise(() => {});
      if (window.fixtureShareMode === "cancelled") throw new DOMException("Cancelled", "AbortError");
    } });
  });
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
    if (url.pathname.includes("/chat/passes/")) {
      invites.push({ body: JSON.parse(request.postData()), status: result.status, reply: await result.clone().json() });
      if (url.pathname.endsWith("/crew") && dropFirstCrewReply) {
        dropFirstCrewReply = false;
        await new Promise(resolve => setTimeout(resolve, 17000));
      }
    }
    if (url.pathname.endsWith("/chat/members") && wrongMemberIdentity) {
      const body = await result.json(); body.currentUserId = "previous-operator";
      await route.fulfill({ status: 200, headers: { "content-type": "application/json", "access-control-allow-origin": nativeOrigin, "access-control-allow-credentials": "true" }, body: JSON.stringify(body) });
      return;
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
  try {
    await page.goto(`${nativeOrigin}/chat`);
    await page.getByText(/Chat member data belongs to another account/).waitFor();
    assert.equal(await button("Invite guest crew").count(), 0);
    wrongMemberIdentity = false; await button("Retry chat members").click();
    await button("Invite guest crew").click();
    await page.getByRole("radio", { name: "8 hours", exact: true }).click();
    await button("Close invite").click(); await button("Invite guest crew").click();
    assert.equal(await page.getByRole("radio", { name: "8 hours", exact: true }).getAttribute("aria-checked"), "true");
    await button("Create crew pass").click();
    await page.getByText(/The link result is unconfirmed/).waitFor({ timeout: 25000 });
    assert.equal(invites.length, 1); assert.equal(invites[0].status, 200);
    await button("Close invite").click();
    await room("Planning Room"); await button("Share Planning Room").click();
    assert.equal(await page.getByRole("radio", { name: "4 hours", exact: true }).getAttribute("aria-checked"), "true");
    assert.equal(await button("Retry original invite").count(), 0);
    await button("Close invite").click(); await room("Production Chat"); await button("Invite guest crew").click();
    await button("Retry original invite").click();
    await page.getByText("Crew pass is ready", { exact: true }).waitFor();
    const crewLink = await page.getByRole("textbox", { name: "Chat invitation link", exact: true }).inputValue();
    assert.deepEqual(invites[1].body, invites[0].body); assert.deepEqual(invites[1].reply, invites[0].reply);
    assert.equal((await queryFixture("SELECT COUNT(*) AS count FROM chat_pass_creation_receipt WHERE orgId='display-smoke'"))[0].count, 1);
    await button("Share invite link").click(); await page.getByText(/Fixture sharing is unavailable/).waitFor();
    assert.equal(invites.length, 2);
    await page.evaluate(() => { window.fixtureShareMode = "pending"; });
    await button("Retry sharing invite").click(); await page.getByText(/Sharing was not confirmed/).waitFor({ timeout: 25000 });
    await page.evaluate(() => { window.fixtureShareMode = "cancelled"; });
    await button("Retry sharing invite").click(); await page.getByText("Sharing was cancelled. Your link is still available.", { exact: true }).waitFor();
    await page.evaluate(() => { window.fixtureShareMode = "success"; });
    await button("Share invite link").click(); await page.getByText("Share sheet completed. Your link is still available.", { exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.fixtureSharedLinks), [crewLink,crewLink,crewLink,crewLink]);
    assert.equal(invites.length, 2);
    await button("Close invite").click(); await room("Planning Room"); await button("Share Planning Room").click();
    await page.getByRole("checkbox", { name: "Second fixture operator", exact: true }).click();
    await button("Close invite").click(); await button("Share Planning Room").click();
    assert.equal(await page.getByRole("checkbox", { name: "Second fixture operator", exact: true }).getAttribute("aria-checked"), "true");
    await button("Clear selected members").click();
    assert.equal(await page.getByRole("checkbox", { name: "Second fixture operator", exact: true }).getAttribute("aria-checked"), "false");
    await page.getByRole("checkbox", { name: "Second fixture operator", exact: true }).click();
    await button("Create Planning link").click();
    await page.getByText(/1 inbox notification could not be confirmed/).waitFor();
    const planningLink = await page.getByRole("textbox", { name: "Chat invitation link", exact: true }).inputValue();
    await button("Close invite").click(); await button("Share Planning Room").click();
    assert.equal(await page.getByRole("textbox", { name: "Chat invitation link", exact: true }).inputValue(), planningLink);
    for (const [width, height] of [[320,568],[320,900],[768,1024],[1440,900]]) {
      await page.setViewportSize({ width, height });
      await button("Retry invite notifications").click({ trial: true });
      const bounds = await button("Retry invite notifications").boundingBox();
      assert.ok(bounds.height >= 44 && bounds.x >= 0 && bounds.x + bounds.width <= width);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      await page.screenshot({ path: `/tmp/showpilot-chat-invites-${height === 568 ? "short" : width}.png`, fullPage: true });
    }
    await restoreChatNotifications(); await button("Retry invite notifications").click();
    await page.getByText(/Inbox notifications saved for 1 member/).waitFor();
    assert.equal(await page.getByRole("textbox", { name: "Chat invitation link", exact: true }).inputValue(), planningLink);
    assert.deepEqual(invites[3].body, invites[2].body);
    assert.equal(invites[3].reply.token, invites[2].reply.token); assert.equal(invites[3].reply.expiresAt, invites[2].reply.expiresAt);
    assert.equal((await queryFixture("SELECT COUNT(*) AS count FROM chat_pass_creation_receipt WHERE orgId='display-smoke'"))[0].count, 2);
    assert.equal((await queryFixture("SELECT COUNT(*) AS count FROM notification WHERE orgId='display-smoke' AND type='chat-planning-invite'"))[0].count, 1);
    await button("Start a new invite").click(); await button("Keep current invite").click();
    assert.equal(await page.getByRole("textbox", { name: "Chat invitation link", exact: true }).inputValue(), planningLink);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ result: "pass", realAuth: true, memberIdentityGuard: true, realPassIssuance: true, lostReplyOneGrant: true, retainedChoicesAndLinks: true, shareFailureTimeoutCancellationRetry: true, partialNotificationsSameLink: true, widths: [320,768,1440] }));
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
}, { secondOperator: true, chatNotificationFailure: true });
