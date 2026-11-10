// Built browser/Worker and protocol-compatible Bridge fixture; no physical ProPresenter or production data.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createBridgeSettingsRecipient } from "../../../packages/shared/src/bridge-settings.mjs";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
const { WebSocket } = createRequire(new URL("../../bridge/package.json", import.meta.url))("ws");
await withLocalSmokeFixture(async ({ origin, orgId, date, browser, operatorEmail, operatorPassword }) => {
  const recipient = await createBridgeSettingsRecipient();
  const target = "propresenter:192.0.2.99:50001";
  const evaluate = async expression => (await browser("eval", expression)).result;
  const click = name => browser("find", "role", "button", "click", "--name", name, "--exact");
  const bridgeMessages = [];
  let bridge; let heartbeat; let currentText = "Opening fixture lyric"; let connected = false;
  const publish = text => bridge.send(JSON.stringify({ type: "device-event", target, eventName: "slide", data: text === null ? "null" : JSON.stringify({ text, nextText: "Upcoming fixture lyric", slideId: text, presentationName: "Fixture service" }) }));
  try {
    await browser("open", `${origin}/login`); await browser("fill", "#email", operatorEmail); await browser("fill", "#password", operatorPassword);
    await click("Sign in"); await browser("wait", "--url", `**/${orgId}/**`);
    await browser("open", `${origin}/${orgId}/settings?section=integrations`);
    await browser("wait", 'h3:text-is("ProPresenter")');
    await evaluate(`(() => { const heading = [...document.querySelectorAll('h3')].find(el => el.textContent === 'ProPresenter'); [...heading.parentElement.parentElement.querySelectorAll('button')].find(el => el.textContent.trim() === 'Connect').click(); return true; })()`);
    await browser("fill", 'input[placeholder="192.168.1.100"]', "192.0.2.99"); await browser("press", "Tab");
    await browser("open", `${origin}/${orgId}/settings?section=api`);
    await browser("wait", 'input[placeholder="Main room computer"]');
    await browser("fill", 'input[placeholder="Main room computer"]', "ProPresenter recovery fixture");
    await click("Create key"); await browser("wait", "text=Copy this key into the Bridge now.");
    const key = await evaluate("[...document.querySelectorAll('code')].map(el => el.textContent).find(text => /^sp_[a-f0-9]{64}$/.test(text))");
    assert.match(key, /^sp_[a-f0-9]{64}$/); await click("Dismiss key");
    for (const port of [50001, 1025]) {
    await browser("find", "label", "Destination name", "fill", `Fixture ProPresenter ${port}`);
    await browser("find", "label", "Host or IP address", "fill", "192.0.2.99");
    await browser("find", "label", "Port", "fill", String(port));
    await browser("select", 'label:has-text("Protocol") select', "propresenter");
    await click("Approve destination"); await browser("wait", `text=192.0.2.99:${port}`);
    }
    const openBridge = async () => {
      connected = false;
      bridge = new WebSocket(`${origin.replace("http:", "ws:")}/api/bridge/${orgId}/ws?role=bridge`, { headers: { "x-showpilot-api-key": key, "x-showpilot-bridge-policy": "3", "x-showpilot-settings-key": recipient.publicKey } });
      await new Promise((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error("Fixture Bridge activation timed out")), 10000);
        bridge.on("error", reject);
        bridge.on("message", data => {
          const message = JSON.parse(String(data));
          bridgeMessages.push({type:message.type,target:message.target,role:message.role,error:message.error});
          if (message.type === "bridge-role") {
            if (message.selectionId) bridge.send(JSON.stringify({ type: "bridge-role-applied", role: message.role, selectionId: message.selectionId }));
            clearTimeout(deadline); resolve();
          }
          if (message.type === "bridge-policy") bridge.send(JSON.stringify({ type: "bridge-policy-applied", policyId: message.policyId }));
          if (message.type === "connect-device") {
            assert.equal(message.target, target);
            connected = true;
            bridge.send(JSON.stringify({ type: "device-status", target, connected: true }));
            publish(currentText);
          }
        });
      });
    };
    await openBridge();
    heartbeat = setInterval(() => { if (bridge.readyState === WebSocket.OPEN) bridge.send(JSON.stringify({ type: "bridge-status", devices: connected ? 1 : 0, targets: connected ? [target] : [], version: "fixture" })); }, 2000);
    await browser("open", `${origin}/${orgId}/streaming/graphics`);
    await click("Connect ProPresenter"); await browser("wait", "text=Opening fixture lyric");
    currentText = "Retained fixture lyric"; publish(currentText);
    await browser("wait", "text=Retained fixture lyric");
    bridge.terminate();
    await browser("wait", '[role="alert"][aria-label="Reconnect ProPresenter feed"] time');
    assert.equal(await evaluate("document.body.textContent.includes('Retained fixture lyric')"), true);
    const section = 'section:has(h2:text-is("ProPresenter import"))';
    assert.equal(await evaluate("[...document.querySelectorAll('section')].find(el => el.querySelector('h2')?.textContent === 'ProPresenter import').textContent.includes('Connected through')"), false);
    await browser("set", "viewport", "320", "740");
    await browser("scrollintoview", 'button[aria-label="Reconnect ProPresenter feed"]');
    const bounds = await evaluate("(() => { const el = document.querySelector('button[aria-label=\"Reconnect ProPresenter feed\"]'); const r = el.getBoundingClientRect(); return {left:r.left,right:r.right,height:r.height,reachable:document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)?.closest('button')===el}; })()");
    assert.ok(bounds.left >= 0 && bounds.right <= 320 && bounds.height >= 44 && bounds.reachable, JSON.stringify(bounds));
    assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
    assert.ok(await evaluate("document.querySelector('[aria-label=\"ProPresenter slide text\"]').getBoundingClientRect().width >= 180"), "Mobile preview must retain space for readable lyrics");
    await browser("screenshot", "/tmp/showpilot-pp-feed-recovery-320.png");
    await browser("scrollintoview", '[aria-label="ProPresenter slide text"]');
    await browser("screenshot", "/tmp/showpilot-pp-feed-slide-320.png");
    const beforeRetry = await evaluate("document.querySelector('[role=\"alert\"][aria-label=\"Reconnect ProPresenter feed\"] time').dateTime");
    await click("Reconnect ProPresenter feed");
    await browser("wait", "--fn", `document.querySelector('[role="alert"][aria-label="Reconnect ProPresenter feed"] time')?.dateTime !== ${JSON.stringify(beforeRetry)} && !document.querySelector('button[aria-label="Reconnect ProPresenter feed"]')?.disabled`);
    await openBridge();
    await browser("wait", `${section} >> text=Connected through venue Bridge`);
    await browser("wait", "--fn", "!document.querySelector('[role=\"alert\"][aria-label=\"Reconnect ProPresenter feed\"]')");
    assert.equal(await evaluate("document.body.textContent.includes('Retained fixture lyric')"), true);
    currentText = null; publish(null);
    await browser("wait", "--fn", "!document.body.textContent.includes('Retained fixture lyric')");
    currentText = "Rundown fixture lyric"; publish(currentText);
    await browser("set", "viewport", "1440", "900");
    await browser("open", `${origin}/${orgId}/rundown?show=smoke-show&date=${date}`);
    await browser("wait", 'button:text-is("Off")'); await click("Off");
    await browser("wait", "text=Rundown fixture lyric");
    bridge.terminate();
    await browser("wait", '[role="alert"][aria-label="Reconnect ProPresenter feed"] time');
    assert.equal(await evaluate("document.body.textContent.includes('Rundown fixture lyric')"), true);
    assert.equal(await evaluate("[...document.querySelectorAll('button')].some(el=>el.textContent.trim()==='Streaming')"), false);
    await click("Reconnect ProPresenter feed");
    await openBridge();
    await browser("wait", 'button:text-is("Streaming")');
    await browser("wait", "--fn", "!document.querySelector('[role=\"alert\"][aria-label=\"Reconnect ProPresenter feed\"]')");
    console.log(JSON.stringify({passed:true,graphicsDisconnectHonesty:true,retainedSlide:true,timestampedRetry:true,manualReconnect:true,explicitClear:true,rundownRecovery:true,fits320:true,physicalProPresenter:false}));
  } catch (error) {
    console.error(JSON.stringify({ bridgeMessages, page: await evaluate("document.body.innerText") }));
    await browser("screenshot", "/tmp/showpilot-pp-feed-diagnostic.png");
    throw error;
  } finally { clearInterval(heartbeat); bridge?.terminate(); }
}, { paidPlan: true });
