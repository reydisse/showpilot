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
  let mode = "normal";
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
      if (chat && parsed.type === "mutation") sent.push({ room, ...parsed });
      if (socket.readyState === WebSocket.OPEN) socket.send(frame); else queue.push(frame);
    });
    let cancelled = false;
    route.onClose(() => { cancelled = socket.readyState === WebSocket.CONNECTING; socket.close(); });
    socket.on("open", () => queue.splice(0).forEach(frame => socket.send(frame)));
    socket.on("message", bytes => {
      const packet = JSON.parse(bytes.toString());
      if (chat && mode === "lost" && packet.type === "mutation-result") return;
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
    await page.getByText("Choose a conversation", {exact:true}).waitFor({state:"hidden"});
  }
  async function send(text) {
    await page.getByRole("textbox", { name: /^Message / }).fill(text); await button("Send message").click();
  }
  async function history() {
    const response = await fetch(`${origin}/api/chat/${orgId}/history?room=production`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200); return (await response.json()).messages;
  }
  const changes = page.locator('[data-testid^="chat-mutation-"]');
  const waitReady = () => page.waitForFunction(() => !document.body.textContent.includes("Connecting to chat") && !document.body.textContent.includes("Chat disconnected"));
  const actions = async text => {
    const control = button(`Message actions: ${text}`);
    await control.scrollIntoViewIfNeeded(); const bounds = await control.boundingBox(); assert.ok(bounds.height >= 44 && bounds.width >= 44);
    await control.focus(); await page.keyboard.press("Enter");
    await page.getByText("Message actions", {exact:true}).waitFor();
  };
  const widths = async kind => {
    for (const [width,height] of [[320,568],[768,1024],[1440,900]]) {
      await page.setViewportSize({width,height});
      await button("Recover original change").scrollIntoViewIfNeeded();
      const b=await button("Recover original change").boundingBox();
      assert.ok(b.height>=44 && b.x>=0 && b.x+b.width<=width && b.y>=0 && b.y+b.height<=height);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
      await page.screenshot({path:`/tmp/showpilot-native-mutation-${kind}-${width}.png`,fullPage:true});
    }
  };
  try {
    await page.goto(`${nativeOrigin}/chat`);
    await page.getByRole("textbox",{name:"Message Production Chat"}).waitFor(); await waitReady();
    await send("Mutation original");
    await page.getByLabel("You: Mutation original",{exact:true}).waitFor();
    await actions("Mutation original"); await page.getByText("Edit message",{exact:true}).click();
    await page.getByRole("textbox",{name:"Message Production Chat"}).fill("Captured native edit");
    mode="lost"; await button("Save edited message").click();
    await button("Recover original change").waitFor({timeout:15000});
    let stored=await history(); assert.equal(stored.length,1);assert.equal(stored[0].text,"Captured native edit");const editedAt=stored[0].editedAt;
    await widths("edit");
    await room("Planning Room"); assert.equal(await changes.count(),0);
    await room("Production Chat"); await button("Recover original change").waitFor();
    mode="normal";await button("Recover original change").click();
    await page.getByText("Your change was saved.",{exact:true}).waitFor();
    assert.equal((await history())[0].editedAt,editedAt);assert.deepEqual(sent[0],sent[1]);
    await button("Dismiss result").click();
    // An uncertain edit retains its captured draft. Cancel it explicitly before
    // opening another action; recovery must not silently erase that draft.
    if(await page.getByLabel("Cancel message action",{exact:true}).count()) await page.getByLabel("Cancel message action",{exact:true}).click();
    await page.setViewportSize({width:390,height:844});
    await actions("Captured native edit"); await page.getByText("Add reaction",{exact:true}).click();
    mode="lost";await page.getByLabel("React 👍",{exact:true}).click();
    await page.getByText("React to message", {exact:true}).waitFor({state:"hidden"});
    await button("Recover original change").waitFor({timeout:15000});
    stored=await history();assert.equal(stored[0].reactions[0].userIds.length,1);
    await widths("reaction");
    await room("Planning Room");await room("Production Chat");
    mode="normal";await button("Recover original change").click();
    await page.getByText("Your change was saved.",{exact:true}).waitFor();
    assert.deepEqual(sent[2],sent[3]);assert.equal((await history())[0].reactions[0].userIds.length,1);
    await button("Dismiss result").click();
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({result:"pass",realAuth:true,realRelay:true,compiledNativeWeb:true,editRecovery:true,reactionRecovery:true,exactCommandRecovery:true,widths:[320,768,1440],physicalDevice:false}));
  } catch (error) { await page.screenshot({path:"/tmp/showpilot-native-mutation-failure.png",fullPage:true}); console.error(JSON.stringify({ body: await page.locator("body").innerText(), errors,menus:await page.getByText("Message actions",{exact:true}).count() })); throw error; }
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
