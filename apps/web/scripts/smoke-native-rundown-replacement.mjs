// Render the exported Expo web app with the native rundown replacement form. All API traffic is
// sent to disposable local fixtures; no request reaches a production API.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
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
await withLocalSmokeFixture(
  async ({ origin, orgId, operatorCookie, queryFixture }) => {
    const activated = await fetch(
      `${origin}/api/auth/organization/set-active`,
      {
        method: "POST",
        headers: {
          Cookie: operatorCookie,
          Origin: origin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ organizationId: orgId }),
      },
    );
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
    const errors = [],
      calls = [],
      held = [],
      deliveries = [],
      sockets = new Set();
    let mode = "normal",
      failTemplates = false,
      failShow = false,
      holdInitialShow = false,
      holdInitialTemplates = false, holdReplacementRead = true;
    const showId = "smoke-show",
      base = `/api/mobile/v1/rundowns/${showId}`;
    page.on("pageerror", (error) => errors.push(error.message));
    // Forward real relay traffic to the disposable Worker with the fixture session.
    // No production socket is opened. Native hydration and broadcasts remain real.
    await page.routeWebSocket("**/*", (route) => {
      const url = new URL(route.url());
      if (!url.pathname.startsWith(`/api/rundown/${orgId}/`))
        return route.close();
      const local = new URL(`${origin}${url.pathname}${url.search}`);
      local.protocol = "ws:";
      const socket = new WebSocket(local, {
        headers: { Cookie: cookie, Origin: origin },
      });
      sockets.add(socket);
      const queue = [];
      route.onMessage((message) =>
        socket.readyState === WebSocket.OPEN
          ? socket.send(message)
          : queue.push(message),
      );
      route.onClose(() => socket.close());
      socket.on("open", () =>
        queue.splice(0).forEach((message) => socket.send(message)),
      );
      socket.on("message", (message) => route.send(message.toString()));
      socket.on("error", (error) => errors.push(error.message));
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
      if (
        request.method() === "GET" &&
        url.pathname === base &&
        holdInitialShow
      ) {
        holdInitialShow = false;
        await new Promise((done) => held.push(done));
      }
      if (
        request.method() === "GET" &&
        url.pathname === `${base}/templates` &&
        holdInitialTemplates
      ) {
        holdInitialTemplates = false;
        await new Promise((done) => held.push(done));
      }
      if(request.method() === "GET" && url.pathname === `${base}/replacement` && holdReplacementRead) {
        holdReplacementRead=false;
        await new Promise(done=>held.push(done));
      }
      const headers = {
        "content-type": "application/json",
        "access-control-allow-origin": nativeOrigin,
        "access-control-allow-credentials": "true",
      };
      if (
        request.method() === "GET" &&
        ((failTemplates && url.pathname === `${base}/templates`) ||
          (failShow && url.pathname === base))
      )
        return route.fulfill({
          status: 503,
          headers,
          body: JSON.stringify({ error: "Fixture show refresh failed" }),
        });
      const command = url.pathname === `${base}/replacement/command`,
        review = url.pathname === `${base}/replacement/review`,
        delivery = mode;
      if (command || review) calls.push({ review, command: JSON.parse(body) });
      if (command && delivery === "before")
        await new Promise((done) => held.push(done));
      const result = await fetch(`${origin}${url.pathname}${url.search}`, {
        method: request.method(),
        headers: {
          Cookie: cookie,
          Origin: origin,
          "Content-Type": "application/json",
        },
        ...(body ? { body } : {}),
      });
      if(request.method() === "GET" && url.pathname === `${base}/replacement`) assert.equal(result.headers.get("cache-control"),"private, no-store, max-age=0");
      const bytes = Buffer.from(await result.arrayBuffer());
      if (command || review)
        deliveries.push({
          review,
          status: result.status,
          result: JSON.parse(bytes),
        });
      if (command && delivery === "after")
        await new Promise((done) => held.push(done));
      await route
        .fulfill({ status: result.status, headers, body: bytes })
        .catch(() => {});
    });
    const button = (name) => page.getByRole("button", { name, exact: true });
    const field = (name) => page.getByRole("textbox", { name, exact: true });
    const title = () => field("Template name");
    const wait = async (check, label) => {
      const end = Date.now() + 20000;
      while (!(await check())) {
        if (Date.now() > end) throw new Error(`Timed out: ${label}`);
        await new Promise((done) => setTimeout(done, 50));
      }
    };
    async function api(path = "/details", data) {
      const response = await fetch(
        `${origin}${base}${path}?orgId=${orgId}&userId=smoke-operator`,
        {
          method: data ? "POST" : "GET",
          headers: {
            Cookie: cookie,
            Origin: origin,
            "Content-Type": "application/json",
          },
          ...(data ? { body: JSON.stringify(data) } : {}),
        },
      );
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    }
    async function laterEdit() {
      const current = await api();
      return api("/details/command", {
        orgId,
        userId: "smoke-operator",
        showId,
        requestId: crypto.randomUUID(),
        serviceDate: current.snapshot.serviceDate,
        expectedRevision: current.revision,
        expectedUpdatedAt: current.snapshot.updatedAt,
        name: "Another operator",
        location: "Other venue",
        startTime: "",
        callTime: "",
        timeZone: current.timeZone,
      });
    }
    async function operatorChange(action, payload) {
      const current = await api();
      const response = await fetch(
        `${origin}/api/rundown/${orgId}/command?showId=${showId}&serviceDate=${current.snapshot.serviceDate}`,
        {
          method: "POST",
          headers: {
            Cookie: cookie,
            Origin: origin,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            id: crypto.randomUUID(),
            expectedRevision: current.revision,
            action,
            payload,
          }),
        },
      );
      assert.equal(response.status, 200, await response.clone().text());
      await response.arrayBuffer();
    }
    async function widths(kind, controls) {
      for (const [width, height] of [
        [320, 480],
        [768, 1024],
        [1440, 1000],
      ]) {
        await page.setViewportSize({ width, height });
        for (const name of controls) {
          await button(name).scrollIntoViewIfNeeded();
          const bounds = await button(name).boundingBox();
          assert.ok(
            bounds &&
              bounds.height >= 44 &&
              bounds.x >= 0 &&
              bounds.x + bounds.width <= width + 1,
            `${name} reachable at ${width}`,
          );
        }
        assert.ok(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth + 1,
          ),
        );
        await page.screenshot({
          path: `/tmp/showpilot-native-replacement-${kind}-${width}.png`,
          fullPage: true,
        });
      }
    }
    try {
      const sourceItem={id:"source-item",title:"Reviewed item",type:"segment",duration:60000,notes:"",assignee:"Host",cue:"GO",status:"upcoming",sortOrder:0,hardStop:false};
      await operatorChange("add-item",sourceItem);
      const templateId=crypto.randomUUID();
      await api("/templates/command",{orgId,userId:"smoke-operator",showId,requestId:templateId,name:"Replacement fixture",serviceName:"Copied show",scheduledStartTime:"09:00",items:[sourceItem]});
      const originalName=(await api()).snapshot.name;
      const showCard=()=>page.getByRole("button").filter({has:page.getByText(originalName,{exact:true})});
      await page.goto(`${nativeOrigin}/shows`);await showCard().click();
      await wait(()=>button("Edit show details").isEnabled(),"relay hydration");
      await button("Open rundown templates").click();await button("Load").click();
      await button("Retry loading replacement").waitFor({timeout:12000});
      held.splice(0).forEach(done=>done());await button("Retry loading replacement").click();
      await button("Confirm rundown replacement").waitFor();
      await widths("reviewed",["Confirm rundown replacement","Close rundown templates"]);
      await button("Close rundown templates").click();await button("Back to shows").click();await showCard().click();await button("Resume rundown replacement").click();
      await button("Confirm rundown replacement").waitFor();
      mode="after";failShow=true;await button("Confirm rundown replacement").click();
      await wait(()=>held.length===1,"committed replacement with held reply");
      assert.equal(deliveries.at(-1).result.outcome,"applied");
      const original=calls.at(-1).command;
      const current=await api("");assert.equal(current.items.length,1);
      await operatorChange("update-item",{id:current.items[0].id,updates:{title:"Later operator edit"}});
      await button("Retry original replacement").waitFor({timeout:20000});
      await widths("unknown",["Retry original replacement","Review original replacement"]);
      mode="normal";await button("Retry original replacement").click();
      await button("Refresh show only").waitFor();
      await wait(()=>deliveries.at(-1).result.outcome === "superseded","superseded acknowledgement");
      await wait(()=>button("Refresh show only").isEnabled(),"failed refresh");
      assert.deepEqual(calls.at(-1).command,original);
      assert.equal((await api("")).items[0].title,"Later operator edit");
      held.splice(0).forEach(done=>done());await widths("refresh",["Refresh show only"]);
      const writes=calls.length;failShow=false;await button("Refresh show only").click();await button("Finish replacement").waitFor();assert.equal(calls.length,writes);await button("Finish replacement").click();
      await button("Load").click();await button("Confirm rundown replacement").waitFor();
      mode="before";await button("Confirm rundown replacement").click();await wait(()=>held.length===1,"undelivered replacement");
      await button("Review original replacement").waitFor({timeout:20000});mode="normal";await button("Review original replacement").click();await button("Finish replacement").waitFor();
      assert.equal(deliveries.at(-1).result.outcome,"cancelled");const count=deliveries.length;held.splice(0).forEach(done=>done());await wait(()=>deliveries.length>count,"late cancelled delivery");assert.equal(deliveries.at(-1).result.outcome,"cancelled");assert.equal((await api("")).items[0].title,"Later operator edit");
      await widths("cancelled",["Finish replacement","Review current copy…"]);await button("Finish replacement").click();
      await button("Load").click();await button("Confirm rundown replacement").waitFor();await laterEdit();await button("Confirm rundown replacement").click();await button("Finish replacement").waitFor();assert.equal(deliveries.at(-1).result.outcome,"conflict");
      await button("Review current copy…").click();await button("Load current replacement").click();await button("Confirm rundown replacement").click();await button("Finish replacement").waitFor();assert.equal(deliveries.at(-1).result.outcome,"applied");assert.equal((await api("")).items[0].title,"Reviewed item");
      assert.deepEqual(errors,[]);
      console.log(JSON.stringify({result:"pass",realRelay:true,stalledRead:true,navigationRetained:true,exactRetry:true,newerEditPreserved:true,refreshOnly:true,cancelBeforeDelivery:true,conflictRequiresReview:true,viewports:[320,768,1440],errors}));
    } catch (error) {
      console.error(
        JSON.stringify({
          body: await page.locator("body").innerText(),
          errors,
          calls,
          deliveries,
        }),
      );
      throw error;
    } finally {
      held.splice(0).forEach((done) => done());
      for (const socket of sockets) socket.close();
      await browser.close();
      await new Promise((done) => server.close(done));
    }
  },
);
