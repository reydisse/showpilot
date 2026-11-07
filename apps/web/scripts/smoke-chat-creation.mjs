// Real creation, committed-but-lost replies, clipboard denial and notification recovery.
import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { poll, withRealBrowser } from "./real-browser-fixture.mjs";
const assets = resolve(import.meta.dirname, "../dist/server/assets");
const ids = {};
for (const name of (await readdir(assets)).filter(name => name.endsWith(".js"))) {
  const source = await readFile(resolve(assets, name), "utf8");
  for (const fn of ["createCrewChatPass", "createPlanningChatPass"]) {
    ids[fn] ??= source.match(new RegExp(`const ${fn}_createServerFn_handler = createServerRpc\\(\\{\\s*id: "([^"]+)"`))?.[1];
  }
}
assert.ok(ids.createCrewChatPass); assert.ok(ids.createPlanningChatPass);
await withLocalSmokeFixture(async ({ origin, orgId, operatorCookie, stopServer, startServer, queryFixture, restoreChatNotifications, capturedEmails }) => {
  let crewLink, planningLink, crewCommands, planningCommands;
  await withRealBrowser({ origin, cookie: operatorCookie }, async ({ page, evaluate }) => {
    // This rehearsal checks foreground controls. macOS can occlude the disposable
    // window during resizing; keep visibility foreground so paint callbacks run.
    await page("Emulation.setFocusEmulationEnabled", { enabled: true });
    await page("Page.enable");
    await page("Page.addScriptToEvaluateOnNewDocument", { source: `window.shareErrors=[];window.shareHold=false;window.shareCommitted=0;window.shareRequests=[];window.shareCopyFails=true;
      addEventListener('error',e=>window.shareErrors.push(e.message));addEventListener('unhandledrejection',e=>window.shareErrors.push(String(e.reason)));
      Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{if(window.shareCopyFails)throw new Error('Fixture clipboard denied');window.shareCopied=text;}}});
      const original=window.fetch;window.fetch=(input,options)=>{const url=input instanceof Request?input.url:String(input);if(!Object.values(${JSON.stringify(ids)}).some(id=>url.includes(id)))return original(input,options);window.shareRequests.push({url,body:options?.body});const held=window.shareHold;const reply=original(input,options);if(held)return reply.then(async r=>{await r.text();window.shareCommitted++;return new Promise(()=>{});});return reply;};` });
    const check = (expression, description) => poll(() => evaluate(expression), description).catch(async error => {
      console.log(JSON.stringify({ description, body: await evaluate("document.body?.innerText"), errors: await evaluate("window.shareErrors"), point: await evaluate("window.sharePointReason") }));
      await writeFile("/tmp/showpilot-chat-creation-failure.png", Buffer.from((await page("Page.captureScreenshot", { format: "png" })).data, "base64")); throw error;
    });
    const text = value => check(`document.body?.innerText.includes(${JSON.stringify(value)})`, value);
    const control = name => `[...document.querySelectorAll('button,a,label')].find(n=>n.textContent.trim()===${JSON.stringify(name)}&&!n.disabled&&n.getBoundingClientRect().height>0)`;
    const point = name => `(async()=>{const n=${control(name)};if(!n){window.sharePointReason='missing';return null;}n.scrollIntoView({block:'center'});const painted=await Promise.race([new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true)))),new Promise(r=>setTimeout(()=>r(false),500))]);if(!painted){window.sharePointReason={reason:'no animation frame',visibility:document.visibilityState,focus:document.hasFocus()};return null;}for(let p=n;p;p=p.parentElement)if(p.getAnimations().some(a=>a.playState==='running')){window.sharePointReason={reason:'animation',element:p.tagName,animations:p.getAnimations().map(a=>({state:a.playState,timing:a.effect.getComputedTiming()}))};return null;}const r=n.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;window.sharePointReason={reason:'hit test',rect:r.toJSON(),hit:document.elementFromPoint(x,y)?.outerHTML};return !n.disabled&&n.contains(document.elementFromPoint(x,y))?{x,y}:null;})()`;
    const click = async name => {
      await page("Page.bringToFront");
      const p = await check(point(name), `reachable ${name}`);
      await page("Input.dispatchMouseEvent", { type:"mousePressed",...p,button:"left",clickCount:1 });
      await page("Input.dispatchMouseEvent", { type:"mouseReleased",...p,button:"left",clickCount:1 });
    };
    const geometry = async (name, file) => {
      for (const [width,height] of [[320,568],[768,1024],[1440,900]]) {
        await page("Emulation.setDeviceMetricsOverride", { width,height,deviceScaleFactor:1,mobile:false });
        await page("Page.bringToFront");
        await check(point(name), `${file} hit ${width}`);
        await check(`(()=>{const r=(${control(name)}).getBoundingClientRect(),d=document.querySelector('[role=dialog]').getBoundingClientRect();return document.documentElement.scrollWidth<=innerWidth+1&&r.height>=44&&r.width>=44&&r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight&&d.left>=0&&d.right<=innerWidth+1&&d.top>=0&&d.bottom<=innerHeight+1;})()`, `${file} bounds ${width}`);
        if (width===320) await writeFile(`/tmp/showpilot-chat-creation-${file}-320.png`,Buffer.from((await page("Page.captureScreenshot",{format:"png"})).data,"base64"));
      }
    };
    await page("Emulation.setDeviceMetricsOverride", { width:1440,height:900,deviceScaleFactor:1,mobile:false });
    await page("Page.navigate", { url:`${origin}/${orgId}/chat` });
    await text("Production Chat"); await click("Invite crew");
    await geometry("Create crew pass","crew-form");
    await evaluate("document.querySelector('[role=dialog] input').focus()");
    for (let index=0;index<8;index++) {
      await page("Input.dispatchKeyEvent",{type:"keyDown",key:"Tab",code:"Tab",windowsVirtualKeyCode:9});
      await page("Input.dispatchKeyEvent",{type:"keyUp",key:"Tab",code:"Tab",windowsVirtualKeyCode:9});
      assert.equal(await evaluate("!!document.activeElement?.closest('[role=dialog]')"),true,"Tab stays inside shared dialog");
    }
    await click("24h");
    await evaluate("window.shareHold=true"); await click("Create crew pass");
    await check("window.shareCommitted===1","actual crew creation reply withheld");
    await text("The link result is unconfirmed"); await geometry("Retry link","crew-retry");
    await click("Close"); await click("Invite crew"); await text("The link result is unconfirmed");
    await evaluate("window.shareHold=false"); await click("Retry link"); await text("Crew pass is ready");
    crewLink = await evaluate("document.querySelector('[role=dialog] textarea').value");
    await click("Copy link"); await text("Could not copy."); await geometry("Retry copy","copy-failure");
    await evaluate("window.shareCopyFails=false"); await click("Retry copy"); await text("Copied");
    assert.equal(await evaluate("window.shareCopied"),crewLink);
    // Escape closes; reopening preserves the ready link without creating again.
    await page("Input.dispatchKeyEvent",{type:"keyDown",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});
    await page("Input.dispatchKeyEvent",{type:"keyUp",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});
    await check("!document.querySelector('[role=dialog]')","Escape closes share");
    await click("Invite crew"); await text("Crew pass is ready");
    assert.equal(await evaluate("document.querySelector('[role=dialog] textarea').value"),crewLink);
    await click("Close"); await click("Planning Room"); await text("Plan together before the show"); await click("Share with members");
    await text("Choose up to 50 members");
    await click("Second fixture operator owner");
    await geometry("Create Planning link","planning-form");
    await click("Create Planning link"); await text("Planning link is ready"); await text("1 inbox notification(s) could not be confirmed");
    planningLink = await evaluate("document.querySelector('[role=dialog] textarea').value");
    await geometry("Retry notifications","notification-failure");
    await stopServer(); await restoreChatNotifications(); await startServer();
    await click("Retry notifications"); await text("Inbox notifications saved for 1 members");
    assert.equal(await evaluate("document.querySelector('[role=dialog] textarea').value"),planningLink);
    // A second new grant closed while its committed response is lost remains recoverable.
    await click("Start a new link"); await evaluate("window.shareHold=true"); await click("Create Planning link");
    await check("window.shareCommitted===2","second Planning reply withheld"); await click("Close");
    await click("Share with members"); await text("The link result is unconfirmed");
    await evaluate("window.shareHold=false"); await click("Retry link"); await text("Planning link is ready");
    const secondPlanningLink = await evaluate("document.querySelector('[role=dialog] textarea').value"); assert.notEqual(secondPlanningLink,planningLink);
    const requests=await evaluate("window.shareRequests");
    crewCommands=requests.filter(r=>r.url.includes(ids.createCrewChatPass)).map(r=>r.body);
    planningCommands=requests.filter(r=>r.url.includes(ids.createPlanningChatPass)).map(r=>r.body);
    assert.equal(crewCommands.length,2);assert.equal(crewCommands[0],crewCommands[1]);
    assert.equal(planningCommands.length,4);assert.equal(planningCommands[0],planningCommands[1]);assert.equal(planningCommands[2],planningCommands[3]);assert.notEqual(planningCommands[0],planningCommands[2]);
    assert.deepEqual(await evaluate("window.shareErrors"),[]);
  });
  const crew=await fetch(crewLink);assert.equal(crew.status,200);assert.ok((await crew.text()).includes("Join production chat"));
  // This link targets the second member, so the creating operator must not be treated as its recipient.
  const planning=await fetch(planningLink,{headers:{Cookie:operatorCookie},redirect:"manual"});assert.equal(planning.status,200);assert.ok((await planning.text()).includes("another member"));
  assert.equal((await capturedEmails()).length,0);await stopServer();
  const receipts=await queryFixture("SELECT orgId,actorId,requestId,payload FROM chat_pass_creation_receipt");
  assert.equal(receipts.length,3);assert.equal(new Set(receipts.map(r=>JSON.parse(r.payload).nonce)).size,3);
  for(const r of receipts){assert.equal(r.orgId,orgId);assert.equal(r.actorId,"smoke-operator");assert.ok(r.requestId.length>=16);assert.equal(r.payload.includes("signature"),false);}
  const notifications=await queryFixture("SELECT orgId,userId,source FROM notification WHERE type='chat-planning-invite'");
  assert.equal(notifications.length,2);for(const n of notifications){assert.equal(n.orgId,orgId);assert.equal(n.userId,"smoke-second-operator");}
  console.log(JSON.stringify({result:"passed",receipts:3,notifications:2,lostReplyRetry:true,closeRetry:true,notificationRetry:true,clipboardRecovery:true,widths:[320,768,1440],browserErrors:[],externalEmail:0}));
},{captureEmail:true,secondOperator:true,chatNotificationFailure:true});
