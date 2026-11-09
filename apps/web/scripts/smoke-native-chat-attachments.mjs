// Exercise compiled native Chat with disposable real auth/D1/ChatRelay.
// Upload and removal replies are lost after real storage changes.
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
await withLocalSmokeFixture(async ({ origin, orgId, operatorCookie }) => {
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
  const errors = [], sockets = new Set(), uploadReplies = [], httpRequests = new Set();
  let closing = false;
  const heldImages = new Set();
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
    route.onMessage(frame => {
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
    if (mode === "stall-image" && url.pathname.startsWith("/api/chat-file/") && request.method() === "GET") {
      await new Promise(resolve => heldImages.add(resolve));
    }
    const result = await fetch(`${origin}${url.pathname}${url.search}`, { method: request.method(), headers: { Cookie: cookie, Origin: origin, "Content-Type": request.headers()["content-type"] ?? "application/json" }, ...(request.postDataBuffer() ? { body: request.postDataBuffer() } : {}) });
    const upload = url.pathname.endsWith("/upload"), removal = url.pathname.endsWith("/cancel-upload");
    if (upload && result.ok) uploadReplies.push(await result.clone().json());
    if (result.ok && ((upload && mode === "lost-upload") || (removal && mode === "lost-removal"))) {
      mode = "normal"; await result.arrayBuffer(); return route.abort("failed");
    }
    await route.fulfill({ status: result.status, headers: { "content-type": result.headers.get("content-type") ?? "application/json", "access-control-allow-origin": nativeOrigin, "access-control-allow-credentials": "true" }, body: Buffer.from(await result.arrayBuffer()) }).catch(() => {});
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
  async function history() {
    const response = await fetch(`${origin}/api/chat/${orgId}/history?room=production`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200); return (await response.json()).messages;
  }
  const work = page.locator('[data-testid^="chat-attachment-"]');
  const waitReady = () => page.waitForFunction(() => !document.body.textContent.includes("Connecting to chat") && !document.body.textContent.includes("Chat disconnected"));
  async function pick(name, photo = false) {
    await button("Open message tools").click();
    const choosing = page.waitForEvent("filechooser");
    await page.getByText(photo ? "Photo" : "Document", {exact:true}).click();
    await (await choosing).setFiles({ name, mimeType: photo ? "image/png" : "text/plain", buffer: photo ? await readFile(resolve(import.meta.dirname,"../../mobile/assets/showpilot-app-icon.png")) : Buffer.from("Native stage notes") });
    await page.getByText("What are you sending?", {exact:true}).waitFor({state:"hidden"});
  }
  async function widths(kind, recovery) {
    for (const [width,height] of [[320,568],[768,1024],[1440,900]]) {
      await page.setViewportSize({width,height});
      await button(recovery).scrollIntoViewIfNeeded(); const b=await button(recovery).boundingBox();
      assert.ok(b.height>=44 && b.x>=0 && b.x+b.width<=width && b.y>=0 && b.y+b.height<=height);
      const composer=await page.getByRole("textbox",{name:"Message Production Chat"}).boundingBox();
      assert.ok(composer.y>=0&&composer.y+composer.height<=height,"reachable composer");
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
      await page.screenshot({path:`/tmp/showpilot-native-attachment-${kind}-${width}.png`,fullPage:true});
    }
  }
  try {
    await page.goto(`${nativeOrigin}/chat`);
    await page.getByRole("textbox",{name:"Message Production Chat"}).waitFor(); await waitReady();
    mode="lost-upload"; await pick("native notes.txt");
    await button("Retry uploading native notes.txt").waitFor();
    const original=uploadReplies[0];
    assert.equal(await (await fetch(`${origin}${original.url}`,{headers:{Cookie:cookie}})).text(),"Native stage notes");
    await widths("upload","Retry uploading native notes.txt");
    await room("Planning Room");assert.equal(await work.count(),0);
    await room("Production Chat");await button("Retry uploading native notes.txt").click();
    await page.getByText(/Ready to send/).waitFor();assert.deepEqual(uploadReplies[1],original);
    mode="lost-removal";await button("Remove native notes.txt").click();
    await button("Retry removing native notes.txt").waitFor();
    assert.equal((await fetch(`${origin}${original.url}`,{headers:{Cookie:cookie}})).status,404);
    await widths("removal","Retry removing native notes.txt");
    await room("Planning Room");await room("Production Chat");await button("Retry removing native notes.txt").click();
    await work.waitFor({state:"hidden"});
    await pick("native send.txt");await page.getByText(/Ready to send/).waitFor();
    await button("Send message").click();await work.waitFor({state:"hidden"});
    await button("Open native send.txt").waitFor();
    const messages=await history();assert.equal(messages.length,1);assert.equal(messages[0].attachments[0].name,"native send.txt");
    assert.equal(await (await fetch(`${origin}${messages[0].attachments[0].url}`,{headers:{Cookie:cookie}})).text(),"Native stage notes");
    await pick("preview.png",true);await page.getByText(/Ready to send/).waitFor();
    mode="stall-image";await button("Send message").click();await work.waitFor({state:"hidden"});
    await button("Open preview.png").click();
    await button("Retry loading image").waitFor({timeout:25000});
    await page.getByText("Opening the image timed out. Retry loading this image.",{exact:true}).waitFor();
    await page.setViewportSize({width:320,height:568});
    const contrast = await page.getByText("Opening the image timed out. Retry loading this image.",{exact:true}).evaluate(element => {
      const rgb = value => value.match(/[\d.]+/g).slice(0,3).map(Number);
      const luminance = values => values.map(value=>{value/=255;return value<=0.04045?value/12.92:((value+0.055)/1.055)**2.4;}).reduce((sum,value,index)=>sum+value*[0.2126,0.7152,0.0722][index],0);
      let parent=element,background="rgba(0, 0, 0, 0)";
      while(parent&&background==="rgba(0, 0, 0, 0)"){background=getComputedStyle(parent).backgroundColor;parent=parent.parentElement;}
      const foreground=luminance(rgb(getComputedStyle(element).color)),back=luminance(rgb(background));
      return (Math.max(foreground,back)+0.05)/(Math.min(foreground,back)+0.05);
    });
    assert.ok(contrast>=4.5,`readable image error contrast: ${contrast}`);
    const retryBounds=await button("Retry loading image").boundingBox();assert.ok(retryBounds.height>=44&&retryBounds.x>=0&&retryBounds.x+retryBounds.width<=320);
    await page.screenshot({path:"/tmp/showpilot-native-attachment-preview-timeout.png",fullPage:true});
    mode="normal";for(const release of heldImages)release();heldImages.clear();
    await button("Retry loading image").click();
    await page.waitForFunction(()=>{const button=document.querySelector('[aria-label="Share image"]');return button&&button.getAttribute('aria-disabled')!=='true'&&!button.hasAttribute('disabled')&&!document.body.textContent.includes('Opening image…');});
    assert.equal(await button("Retry loading image").count(),0);
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({result:"pass",compiledNativeWeb:true,realStorage:true,lostUploadReply:true,lostRemovalReply:true,roomRecovery:true,sendAttachment:true,previewTimeoutRecovery:true,widths:[320,768,1440],physicalDevice:false}));
  } catch(error) {
    await page.screenshot({path:"/tmp/showpilot-native-attachment-failure.png",fullPage:true});
    console.error(JSON.stringify({body:await page.locator("body").innerText(),errors,uploadReplies}));throw error;
  } finally {
    closing=true;for(const release of heldImages)release();heldImages.clear();for(const socket of sockets)socket.close();await browser.close();
    await Promise.all([...httpRequests]);await new Promise(resolve=>server.close(resolve));
  }
});
