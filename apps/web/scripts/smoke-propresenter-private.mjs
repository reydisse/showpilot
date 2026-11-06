// Real browser -> built Worker/D1 -> compiled Bridge -> password-protected Stage Display fixture.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { once } from "node:events";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
const { WebSocket, WebSocketServer } = createRequire(new URL("../../bridge/package.json", import.meta.url))("ws");
const executable = process.argv[2];
if (!executable) throw new Error("Pass the compiled native Bridge executable path.");
async function until(check, label) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 30)); }
  throw new Error(`Timed out: ${label}`);
}
await withLocalSmokeFixture(async ({ origin, orgId, browser, operatorEmail, operatorPassword, operatorCookie, queryFixture }) => {
  const password = randomUUID();
  let expectedPassword = password;
  let authenticatedCount = 0;
  let rejectedCount = 0;
  let currentText = "Opening lyric";
  const api = http.createServer((_request, response) => { response.statusCode = 404; response.end("{}"); });
  const stage = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const proxy = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const upstreams = [];
  const nativeMessages = [];
  const serverMessages = [];
  const slideMessages = [];
  let stageAuthenticated = false;
  let child;
  let observer;
  const publish = (text, nextText = "Upcoming lyric") => {
    currentText = text;
    for (const socket of stage.clients) socket.send(JSON.stringify({ acn: "sd", text, nextText, slideId: text, pn: "Fixture presentation" }));
  };
  try {
    await Promise.all([once(stage, "listening"), once(proxy, "listening")]);
    api.listen(0, "127.0.0.1"); await once(api, "listening");
    const stagePort = stage.address().port;
    const apiPort = api.address().port;
    const target = `propresenter:127.0.0.1:${stagePort}`;
    stage.on("connection", socket => socket.on("message", data => {
      const message = JSON.parse(String(data));
      if (message.acn !== "ath") return;
      stageAuthenticated = message.pwd === expectedPassword;
      if (stageAuthenticated) authenticatedCount++; else rejectedCount++;
      socket.send(JSON.stringify({ acn: "ath", ath: stageAuthenticated }));
      if (stageAuthenticated) publish(currentText);
      else socket.close();
    }));
    const click = name => browser("find", "role", "button", "click", "--name", name, "--exact");
    await browser("open", `${origin}/login`);
    await browser("fill", "#email", operatorEmail);
    await browser("fill", "#password", operatorPassword);
    await click("Sign in");
    await browser("wait", "--url", `**/${orgId}/**`);
    await browser("open", `${origin}/${orgId}/settings?section=integrations`);
    await browser("wait", 'h3:text-is("ProPresenter")');
    await browser("eval", `(() => {
      const heading = [...document.querySelectorAll('h3')].find(node => node.textContent === 'ProPresenter');
      [...heading.parentElement.parentElement.querySelectorAll('button')].find(node => node.textContent.trim() === 'Connect').click();
    })()`);
    for (const [placeholder, value] of [["192.168.1.100", "127.0.0.1"], ["50001", String(stagePort)], ["1025", String(apiPort)]]) {
      await browser("fill", `input[placeholder="${placeholder}"]`, value);
      await browser("press", "Tab");
    }
    await browser("fill", 'input[aria-label="ProPresenter password"]', password);
    await browser("click", '[role="group"][aria-label="ProPresenter password credential"] button:text-is("Save credential")');
    await browser("wait", "--fn", "document.querySelector('input[aria-label=\"ProPresenter password\"]').value === ''");
    const [stored] = await queryFixture(`SELECT value FROM app_setting WHERE orgId='${orgId}' AND key='propresenter-password'`);
    assert.ok(stored.value.startsWith("spenc:v1:") && !stored.value.includes(password));
    await browser("open", `${origin}/${orgId}/settings?section=api`);
    await browser("wait", 'input[placeholder="Main room computer"]');
    await browser("fill", 'input[placeholder="Main room computer"]', "Private ProPresenter fixture");
    await click("Create key");
    await browser("wait", "text=Copy this key into the Bridge now.");
    const key = (await browser("eval", "[...document.querySelectorAll('code')].map(node => node.textContent).find(text => /^sp_[a-f0-9]{64}$/.test(text))")).result;
    assert.match(key, /^sp_[a-f0-9]{64}$/);
    await click("Dismiss key");
    for (const port of [stagePort, apiPort]) {
      await browser("find", "label", "Destination name", "fill", `Fixture PP ${port}`);
      await browser("find", "label", "Host or IP address", "fill", "127.0.0.1");
      await browser("find", "label", "Port", "fill", String(port));
      await browser("select", 'label:has-text("Protocol") select', "propresenter");
      await click("Approve destination");
      await browser("wait", `text=Fixture PP ${port}`);
    }
    proxy.on("connection", (socket, request) => {
      const upstream = new WebSocket(`${origin.replace("http:", "ws:")}/api/bridge/${orgId}/ws?role=bridge`, {
        headers: { "x-showpilot-api-key": key, "x-showpilot-bridge-policy": request.headers["x-showpilot-bridge-policy"], "x-showpilot-settings-key": request.headers["x-showpilot-settings-key"] },
      });
      upstreams.push(upstream);
      const pending = [];
      socket.on("message", data => {
        nativeMessages.push(JSON.parse(String(data)));
        if (upstream.readyState === WebSocket.OPEN) upstream.send(String(data)); else pending.push(String(data));
      });
      upstream.on("open", () => { for (const data of pending.splice(0)) upstream.send(data); });
      upstream.on("message", data => { serverMessages.push(JSON.parse(String(data))); socket.send(String(data)); });
      upstream.on("error", () => socket.close(1011, "Fixture upstream failed"));
      upstream.on("close", () => socket.close());
      socket.on("close", () => upstream.terminate());
    });
    child = spawn(resolve(executable), ["--desktop", "--no-open"], {
      env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, SHOWPILOT_BRIDGE_URL: `ws://127.0.0.1:${proxy.address().port}`, SHOWPILOT_BRIDGE_KEY: key, SHOWPILOT_PARENT_PID: String(process.pid) },
      stdio: ["pipe", "ignore", "ignore"],
    });
    // No ProPresenter host/password is passed to the process: native asks the authorized server.
    await until(() => stageAuthenticated, "native Stage Display authentication");
    assert.ok(nativeMessages.some(message => message.type === "configured-propresenter-requested"));
    assert.ok(serverMessages.some(message => message.type === "connect-device" && message.target === target && message.protectedSettings));
    assert.equal(JSON.stringify([...nativeMessages, ...serverMessages]).includes(password), false);
    // A production manager may read the feed but has no generic device-control permission.
    const changedRole = await fetch(`${origin}/api/auth/organization/update-member-role`, {
      method: "POST", headers: { Cookie: operatorCookie, Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ organizationId: orgId, memberId: "smoke-second-member", role: "pm" }),
    });
    assert.equal(changedRole.status, 200); await changedRole.text();
    const signedIn = await fetch(`${origin}/api/auth/sign-in/email`, {
      method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ email: "second@display-smoke.invalid", password: operatorPassword }),
    });
    assert.equal(signedIn.status, 200); await signedIn.text();
    const viewerCookie = signedIn.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    observer = new WebSocket(`${origin.replace("http:", "ws:")}/api/bridge/${orgId}/ws?role=propresenter-viewer`, { headers: { Cookie: viewerCookie, Origin: origin } });
    observer.on("message", data => { slideMessages.push(JSON.parse(String(data))); });
    await once(observer, "open");
    const deniedStatus = await fetch(`${origin}/api/bridge/${orgId}/status?role=propresenter-viewer`, { headers: { Cookie: viewerCookie } });
    assert.equal(deniedStatus.status, 401); await deniedStatus.text();
    // The separate PM observer exercises restricted access. The owner browser
    // exercises graphics import, which additionally requires lowerthird:configure.
    await browser("open", `${origin}/${orgId}/streaming/graphics`);
    await browser("wait", 'button:text-is("Connect ProPresenter")');
    await browser("eval", `(() => {
      window.__feedReplies = [];
      const original = window.fetch;
      window.fetch = async (...args) => { const response = await original(...args); window.__feedReplies.push(await response.clone().text()); return response; };
    })()`);
    await click("Connect ProPresenter");
    await browser("wait", "text=Opening lyric");
    publish("Second lyric", "Third lyric");
    await browser("wait", "text=Second lyric");
    await until(() => slideMessages.some(message => message.type === "device-event" && message.data.includes("Second lyric")), "restricted viewer receives slide");
    const replies = (await browser("eval", "window.__feedReplies")).result;
    assert.ok(replies.length > 0 && replies.every(reply => !reply.includes(password) && !reply.includes("spenc:v1:")));
    assert.equal(JSON.stringify(slideMessages).includes(password), false);
    assert.equal((await browser("eval", `document.documentElement.outerHTML.includes(${JSON.stringify(password)})`)).result, false);
    // Apply a saved replacement to an already connected native target, then
    // prove that clearing and failed authentication cannot falsely report success.
    await browser("open", `${origin}/${orgId}/settings?section=integrations`);
    await browser("wait", 'input[aria-label="ProPresenter password"]');
    const replacement = randomUUID();
    const incorrect = randomUUID();
    async function replaceCredential(value) {
      await browser("fill", 'input[aria-label="ProPresenter password"]', value);
      await browser("click", '[role="group"][aria-label="ProPresenter password credential"] button:text-is("Save replacement")');
      await browser("wait", "--fn", "document.querySelector('input[aria-label=\"ProPresenter password\"]').value === ''");
    }
    const apply = () => browser("click", 'button[title="Apply & test"]');
    expectedPassword = replacement;
    await replaceCredential(replacement);
    await apply();
    await browser("wait", 'button[title="Apply & test"]:text-is("Connected")');
    assert.equal(authenticatedCount, 2);
    await replaceCredential(incorrect);
    await apply();
    await browser("wait", 'button[title="Apply & test"]:text-is("Failed")');
    assert.ok(rejectedCount > 0);
    await replaceCredential(replacement);
    await apply();
    await browser("wait", 'button[title="Apply & test"]:text-is("Connected")');
    assert.equal(authenticatedCount, 3);
    await browser("click", '[role="group"][aria-label="ProPresenter password credential"] button:text-is("Clear credential")');
    await browser("wait", '[role="dialog"]');
    expectedPassword = "";
    await browser("click", '[role="dialog"] button:text-is("Clear credential")');
    await browser("wait", "--fn", "document.querySelector('[role=dialog]') === null");
    await apply();
    await browser("wait", 'button[title="Apply & test"]:text-is("Connected")');
    assert.equal(authenticatedCount, 4);
    for (const secret of [password, replacement, incorrect]) {
      assert.equal(JSON.stringify([...nativeMessages, ...serverMessages, ...slideMessages]).includes(secret), false);
      assert.equal((await browser("eval", `document.body.textContent.includes(${JSON.stringify(secret)})`)).result, false);
    }
    await browser("open", `${origin}/${orgId}/streaming/graphics`);
    await browser("wait", 'button:text-is("Connect ProPresenter")');
    await click("Connect ProPresenter");
    await browser("wait", "text=Second lyric");
    // An explicit Clear removes the preview; a transport failure after a later slide preserves it.
    publish("");
    await browser("wait", "--fn", "!document.body.textContent.includes('Second lyric')");
    publish("Held lyric");
    await browser("wait", "text=Held lyric");
    const exited = once(child, "exit"); child.kill("SIGTERM"); await exited;
    await browser("wait", "text=Venue Bridge is offline");
    assert.equal((await browser("eval", "document.body.textContent.includes('Held lyric')")).result, true);
    console.log(JSON.stringify({ encryptedSetting: "passed", nativeAutoconfiguration: "passed", stagePasswordAuthentication: "passed", encryptedRelayDelivery: "passed", operatorWithoutDevicePermission: "passed", maskedReadResponses: "passed", savedPasswordReplacement: "passed", authenticationFailureAndRecovery: "passed", savedPasswordClearing: "passed", nextSlide: "passed", explicitClear: "passed", disconnectHoldsLastSlide: "passed" }, null, 2));
  } finally {
    observer?.terminate();
    if (child?.pid && child.exitCode === null && child.signalCode === null) { const stopped = once(child, "exit"); child.kill("SIGTERM"); await stopped; }
    for (const socket of upstreams) socket.terminate();
    for (const server of [proxy, stage]) { for (const socket of server.clients) socket.terminate(); await new Promise(resolve => server.close(resolve)); }
    api.closeAllConnections(); await new Promise(resolve => api.close(resolve));
  }
}, { paidPlan: true, secondOperator: true });
