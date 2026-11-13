// Exercise compiled native Timecode against disposable authenticated Worker rooms.
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
await withLocalSmokeFixture(async ({ origin, orgId, operatorCookie, operatorPassword, date }) => {
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
  // Native AbortSignal implementations need only the aborted flag/event.
  await page.addInitScript(() => {
    AbortSignal.prototype.throwIfAborted = undefined;
  });
  const errors = [], sockets = new Set(), commands = [], requests = [];
  let mode = "normal", loseSaveReply = false, loseChoiceReply = true;
  const saves = [];
  const showId = "smoke-show";
  page.on("pageerror", (error) => errors.push(error.message));
  // Forward real relay traffic to the disposable Worker with the fixture session.
  // No production socket is opened. Native hydration and broadcasts remain real.
  await page.routeWebSocket("**/*", (route) => {
    const url = new URL(route.url());
    if (!url.pathname.startsWith(`/api/timecode/${orgId}/`))
      return route.close();
    requests.push(url);
    const local = new URL(`${origin}${url.pathname}${url.search}`);
    local.protocol = "ws:";
    const socket = new WebSocket(local, {
      headers: { Cookie: cookie, Origin: origin },
    });
    sockets.add(socket);
    const queue = [];
    route.onMessage((message) => {
      const packet = JSON.parse(String(message));
      if (packet.type === "command") commands.push({ ...packet, showId: url.searchParams.get("showId") });
      if(socket.readyState === WebSocket.OPEN) socket.send(message);
      else queue.push(message);
    });
    let cancelledBeforeOpen = false;
    route.onClose(() => {
      cancelledBeforeOpen = socket.readyState === WebSocket.CONNECTING;
      socket.close();
    });
    socket.on("open", () =>
      queue.splice(0).forEach((message) => socket.send(message)),
    );
    socket.on("message", (message) => {
      if (mode === "silent" || mode === "drop-sync" && JSON.parse(message.toString()).syncId) return;
      route.send(message.toString());
    });
    socket.on("error", (error) => {
      // Navigation can cancel the proxy handshake, just as it cancels native
      // authentication. Only that intentional cancellation is expected.
      if (cancelledBeforeOpen && error.message === "WebSocket was closed before the connection was established") return;
      errors.push(error.message);
    });
    socket.on("close", () => {
      sockets.delete(socket);
      void route.close().catch(() => {});
    });
  });
  await page.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      body = request.postData();
    if (!url.pathname.startsWith("/api/"))
      return url.origin === nativeOrigin ? route.continue() : route.abort();
    if (url.pathname.startsWith(`/api/timecode/${orgId}/`)) requests.push(url);
    const headers = {
      "content-type": "application/json",
      "access-control-allow-origin": nativeOrigin,
      "access-control-allow-credentials": "true",
    };
    const result = await fetch(`${origin}${url.pathname}${url.search}`, {
      method: request.method(),
      headers: {
        Cookie: cookie,
        Origin: origin,
        "Content-Type": "application/json",
      },
      ...(body ? { body } : {}),
    });
    const bytes = Buffer.from(await result.arrayBuffer());
    if (loseChoiceReply && url.pathname.endsWith("/timecode/choices") && url.searchParams.get("kind") === "devices") {
      loseChoiceReply = false; await new Promise(resolve => setTimeout(resolve, 11000));
    }
    if (url.pathname.endsWith("/command") && body && ["add-event", "update-event"].includes(JSON.parse(body).action)) {
      saves.push(JSON.parse(body));
      if (loseSaveReply) {
        loseSaveReply = false;
        await new Promise(resolve => setTimeout(resolve, 17_000));
      }
    }
    await route
      .fulfill({ status: result.status, headers, body: bytes })
      .catch(() => {});
  });
  const button = (name) => page.getByRole("button", { name, exact: true });
  const wait = async (check, label, timeout = 20000) => {
    const end = Date.now() + timeout;
    while (!(await check())) {
      if (Date.now() > end) throw new Error(`Timed out: ${label}`);
      await new Promise((done) => setTimeout(done, 50));
    }
  };
  async function clockState() {
    const response = await fetch(`${origin}/api/timecode/${orgId}/state?showId=${showId}`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200); return response.json();
  }
  async function command(action, payload) {
    const response = await fetch(`${origin}/api/timecode/${orgId}/command?showId=${showId}`, {
      method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ action, payload }),
    });
    assert.equal(response.status, 200, await response.text());
  }
  async function events() {
    const response = await fetch(`${origin}/api/timecode/${orgId}/events?showId=${showId}`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200); return response.json();
  }
  async function cue(id, label = id, action = "lyrics-clear", payload = {}) {
    await command("add-event", { id, label, action, payload, triggerTimecode: { hours: 0, minutes: 0, seconds: 10, frames: 0 } });
  }
  try {
    await page.goto(`${nativeOrigin}/timecode`);
    await button(`Display test show · ${date}`).click();
    await wait(() => button("Claim control").isEnabled(), "hydrated show"); await button("Claim control").click();
    await wait(() => button("Start freerun").isEnabled(), "claimed control");

    const field = label => page.getByRole("textbox", { name: label, exact: true });
    const choose = async (label, value) => { await button(`Choose ${label.toLowerCase()}`).click(); await button(value).click(); };
    const add = async label => { await field("Event label").fill(label); await button("Add automation event").click(); await button("New cue").waitFor(); await button("New cue").click(); };
    await field("Event label").fill("Stage announcement");
    await field("Trigger timecode").fill("99:99:99:99"); await wait(() => button("Add automation event").isDisabled(), "inline time validation");
    await field("Trigger timecode").fill("00:00:15:00");
    await choose("Action", "Send Stage Message");
    await field("Stage message").fill("First line\nSecond line"); await field("Tolerance (frames)").fill("7"); await field("Cue lead (ms)").fill("250");
    await button("Add automation event").click(); await button("New cue").waitFor();
    let stage = (await events()).find(event => event.label === "Stage announcement");
    assert.equal(stage.payload.message, "First line\nSecond line"); assert.equal(stage.toleranceFrames, 7); assert.equal(stage.leadMs, 250);
    await button("New cue").click();
    await choose("Action", "Start Named Timer"); await field("Timer name").fill("Speaker"); await field("Duration (m:ss)").fill("3:45"); await add("Speaker timer");
    assert.equal((await events()).find(event => event.label === "Speaker timer").payload.durationMs, 225000);
    await choose("Action", "Trigger Device Action");
    await wait(() => button("Retry loading devices").count(), "bounded device catalog", 15000);
    assert.equal(await button("Add automation event").isDisabled(), true); await button("Retry loading devices").click();
    await choose("Device", "Rehearsal switcher");
    await button("Choose device action").click();
    // Pick the actual catalog label from the live device schema.
    const devicesResponse = await fetch(`${origin}/api/mobile/v1/timecode/choices?orgId=${orgId}&kind=devices`, { headers: { Cookie: cookie } });
    const device = (await devicesResponse.json()).devices[0];
    const action = device.actions.find(action => action.id === "set_program_input"); assert.ok(action);
    await button(action.label).click();
    for (const param of action.params) if (param.type === "number") await field(param.label).fill("2");
    await add("Switcher cue"); assert.equal((await events()).find(event => event.label === "Switcher cue").payload.deviceId, "smoke-switcher");
    await choose("Action", "Show Lyrics Section"); await choose("Song", "Rehearsal song"); await choose("Section", "Verse"); await add("Verse cue");
    assert.equal((await events()).find(event => event.label === "Verse cue").payload.lyrics, "First lyric line\nSecond lyric line");
    await choose("Action", "Trigger ProPresenter Slide"); await choose("ProPresenter song", "Rehearsal song"); await choose("Section", "Chorus"); await add("Presentation cue");
    assert.equal((await events()).find(event => event.label === "Presentation cue").payload.slideIndex, 1);
    assert.equal(await button("29.97 fps NDF").count(), 1); assert.equal(await button("29.97 fps DF").count(), 1);
    await button("Edit cue Stage announcement").click(); await button("Discard cue edit").waitFor();
    const editField = label => page.getByRole("textbox", { name: label, exact: true }).first();
    await editField("Event label").fill("Unsaved draft"); await wait(async () => await editField("Event label").inputValue() === "Unsaved draft", "retained draft text");
    await command("update-event", { id: stage.id, updates: { label: "Newer operator edit" } });
    await wait(() => button("Save cue changes").isDisabled(), "stale edit blocked");
    assert.equal(await editField("Event label").inputValue(), "Unsaved draft");
    await button("Replace draft with current cue").click(); await wait(async () => await editField("Event label").inputValue() === "Newer operator edit", "explicit reload");
    await button("Change action details").click(); await editField("Stage message").fill("Updated message\nKept line break");
    await editField("Event label").fill("Reviewed cue");
    for (const width of [320, 768, 1440]) {
      await page.setViewportSize({ width, height: 800 }); await button("Save cue changes").scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `No overflow at ${width}`);
      for (const name of ["Save cue changes", "Discard cue edit"]) { const bounds = await button(name).boundingBox(); assert.ok(bounds.height >= 44 && bounds.width >= 44); }
      await page.screenshot({ path: `/tmp/showpilot-native-cue-editor-${width}.png` });
    }
    await button("Save cue changes").click(); await button("Done editing cue").waitFor(); await button("Done editing cue").click();
    stage = (await events()).find(event => event.id === stage.id); assert.equal(stage.payload.message, "Updated message\nKept line break"); assert.equal(stage.fired, false);
    await button("Edit cue Reviewed cue").click(); await button("Discard cue edit").waitFor(); await editField("Event label").fill("Save whose reply is lost");
    const beforeLost = saves.length; loseSaveReply = true; await button("Save cue changes").click();
    await wait(() => saves.length === beforeLost + 1, "saved edit with dropped reply");
    await command("update-event", { id: stage.id, updates: { label: "Later edit must win" } });
    await button("Change show").click(); await button(`Evening test show · ${date}`).click();
    await button("Change show").click(); await button(`Display test show · ${date}`).click();
    if (await button("Claim control").count()) await button("Claim control").click();
    await wait(() => button("Retry original cue edit").isEnabled(), "retained failed edit", 25000); await button("Retry original cue edit").click();
    await button("Done editing cue").waitFor(); assert.deepEqual(saves[beforeLost].payload, saves[beforeLost + 1].payload);
    assert.equal((await events()).find(event => event.id === stage.id).label, "Later edit must win"); await button("Done editing cue").click();
    await button("Edit cue Later edit must win").click(); await button("Discard cue edit").waitFor(); await editField("Event label").fill("Refresh-only edit");
    mode = "drop-sync"; const beforeRefresh = saves.length; await button("Save cue changes").click();
    await wait(() => button("Retry edited timeline refresh").count(), "bounded edit refresh", 20000);
    mode = "normal"; await button("Retry edited timeline refresh").click(); await button("Done editing cue").waitFor();
    assert.equal(saves.length, beforeRefresh + 1); await button("Done editing cue").click();
    if (await button("Claim control").count()) await button("Claim control").click();
    await wait(() => button("Start freerun").isEnabled(), "reclaimed control after refresh reconnect");
    // Rejection must keep the room usable for the next legacy edit as well.
    const rejected = await fetch(`${origin}/api/timecode/${orgId}/command?showId=${showId}`, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ action: "update-event", payload: { id: stage.id, updates: { fired: true } } }) });
    assert.equal(rejected.status, 400); await rejected.arrayBuffer(); await command("update-event", { id: stage.id, updates: { label: "Room remains usable" } });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ result: "pass", realAuth: true, realRelay: true, structuredCreation: ["stage-message", "timer-start", "device-action", "lyrics-goto", "pp-trigger-slide"],
      inlineTimeValidation: true, fullFrameFormats: true, staleEditBlocked: true, explicitReload: true, retainedLostEdit: true, laterEditPreserved: true, refreshOnly: true, legacyRejectionRecovery: true, widths: [320, 768, 1440] }));

  } catch (error) {
    console.error(JSON.stringify({ body: await page.locator("body").innerText(), errors, saves })); throw error;
  } finally {
    for (const socket of sockets) socket.close(); await browser.close(); await new Promise(resolve => server.close(resolve));
  }
}, { secondShow: true, nativeCueEditor: true });
