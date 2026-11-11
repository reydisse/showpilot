// Actual app preparation -> compiled native engine/OS vault -> shipped offline
// page -> real revision-checked cloud reconciliation. Only Tauri IPC is bridged
// through Chrome's automation channel; no engine or relay state is manufactured.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deleteCredential } from "../../bridge/dist/credential-store.js";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { withRealBrowser, poll } from "./real-browser-fixture.mjs";
import { LINUX_ENGINE_FILENAME } from "../../../scripts/linux-bridge-sidecar.mjs";

const root = resolve(import.meta.dirname, "../../..");
const host = execFileSync("rustc", ["--print", "host-tuple"], {encoding:"utf8"}).trim();
const binary = resolve(root, `apps/bridge-desktop/src-tauri/binaries/${process.platform === "linux" ? LINUX_ENGINE_FILENAME : `showpilot-bridge-${host}${process.platform === "win32" ? ".exe" : ""}`}`);
await withLocalSmokeFixture(async ({origin, orgId, date, browser, operatorEmail, operatorPassword, operatorCookie, queryFixture, stopServer, startServer, capturedEmails}) => {
  const directory = await mkdtemp(join(tmpdir(), "showpilot-native-handoff-"));
  const token = randomBytes(32).toString("hex");
  const secret = randomBytes(32).toString("hex");
  const commands = [];
  let discoveryCount = 0;
  const equipment = http.createServer(async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${secret}`);
    response.setHeader("Content-Type", "application/json");
    if (request.method === "GET" && request.url === "/api/states") {
      discoveryCount++;
      response.end(JSON.stringify([{entity_id:"light.room",state:"off",attributes:{friendly_name:"Fixture room"}}]));
    } else {
      let body = ""; for await (const chunk of request) body += chunk;
      commands.push({method:request.method, path:request.url, body:JSON.parse(body)});
      response.end("[]");
    }
  });
  const offline = http.createServer(async (request, response) => {
    const name = new URL(request.url, "http://fixture").pathname.slice(1) || "index.html";
    if (!["index.html", "offline.js", "styles.css"].includes(name)) {response.writeHead(404); response.end(); return;}
    response.setHeader("Content-Type", name.endsWith("js") ? "text/javascript" : name.endsWith("css") ? "text/css" : "text/html");
    response.end(await readFile(join(root, "apps/desktop/offline", name)));
  });
  let child, key, controlPort;
  let diagnostics = "";
  const headers = {Cookie:operatorCookie, Origin:origin, "Content-Type":"application/json"};
  const path = `/api/rundown/${orgId}`;
  const query = `showId=smoke-show&serviceDate=${date}`;
  const readCloud = async () => {
    const response = await fetch(`${origin}${path}/state?${query}`, {headers, signal:AbortSignal.timeout(8000)});
    assert.equal(response.status, 200); return response.json();
  };
  const cloudCommand = async (action, payload) => {
    const response = await fetch(`${origin}${path}/command?${query}`, {method:"POST",headers,body:JSON.stringify({id:randomUUID(),action,payload}),signal:AbortSignal.timeout(8000)});
    assert.equal(response.status, 200, await response.text());
  };
  const native = async request => {
    const response = await fetch(`http://127.0.0.1:${controlPort}/local-show`, {
      method:"POST",headers:{authorization:`Bearer ${token}`},body:JSON.stringify(request),signal:AbortSignal.timeout(16000),
    });
    const reply = await response.json();
    if (!response.ok || !reply.ok) throw new Error(reply.error || "Native local request failed");
    assert.equal(JSON.stringify(reply).includes(secret), false);
    return reply.result;
  };
  const status = () => native({operation:"status"});
  try {
    equipment.listen(0,"127.0.0.1"); await once(equipment,"listening");
    offline.listen(0,"127.0.0.1"); await once(offline,"listening");
    const offlineUrl = `http://127.0.0.1:${offline.address().port}/?local=1`;
    const devicePort = equipment.address().port;
    const click = name => browser("find","role","button","click","--name",name,"--exact");
    await browser("open",`${origin}/login`);
    await browser("fill","#email",operatorEmail); await browser("fill","#password",operatorPassword);
    await click("Sign in"); await browser("wait","--url",`**/${orgId}/**`);
    await browser("open",`${origin}/${orgId}/settings?section=api`);
    await browser("fill",'input[placeholder="Main room computer"]',"Native local handoff fixture");
    await click("Create key"); await browser("wait","text=Copy this key into the Bridge now.");
    key = (await browser("eval","[...document.querySelectorAll('code')].map(n=>n.textContent).find(text=>/^sp_[a-f0-9]{64}$/.test(text))")).result;
    assert.match(key,/^sp_[a-f0-9]{64}$/); await click("Dismiss key");
    await browser("find","label","Destination name","fill","Local fixture equipment");
    await browser("find","label","Host or IP address","fill","127.0.0.1");
    await browser("find","label","Port","fill",String(devicePort));
    await browser("select",'label:has-text("Protocol") select',"http-command");
    await click("Approve destination"); await browser("wait",`text=127.0.0.1:${devicePort} · HTTP`);
    child = spawn(binary,["--desktop","--no-open"],{cwd:root,env:{...process.env,
      SHOWPILOT_SITE_URL:origin,SHOWPILOT_ORG:orgId,SHOWPILOT_BRIDGE_KEY:key,
      SHOWPILOT_BRIDGE_URL:`${origin.replace("http:","ws:")}/api/bridge/${orgId}/ws?role=bridge`,
      SHOWPILOT_PARENT_PID:String(process.pid),SHOWPILOT_LOCAL_CONTROL_TOKEN:token,
      SHOWPILOT_LOCAL_SHOW_DIRECTORY:directory,SHOWPILOT_PROPRESENTER_HOST:"",
    },stdio:["ignore","pipe","pipe"]});
    child.stdout.on("data",chunk=>{diagnostics+=chunk;const match=/\[bridge-local-control\] (\d+)/.exec(diagnostics);if(match) controlPort=Number(match[1]);});
    child.stderr.on("data",chunk=>{diagnostics+=chunk;});
    await poll(()=>{assert.equal(child.exitCode,null);return controlPort;},"native local endpoint");
    await poll(async()=>(await status()).installationId,"real Bridge authentication");
    await browser("open",`${origin}/${orgId}/dashboard/devices`);
    await browser("click",'button:text-is("Add Device") >> nth=0');
    await browser("select","#device-adapter","homeassistant");
    await browser("fill","#device-name","Local fixture light");
    await browser("fill","#device-field-baseUrl",`http://127.0.0.1:${devicePort}`);
    await browser("fill","#device-field-accessToken",secret);
    await browser("click",'form button:text-is("Add Device")');
    await browser("wait",'button:text-is("Fixture room On")');
    const [device] = await queryFixture("SELECT id FROM device WHERE orgId='display-smoke' AND name='Local fixture light'");
    assert.ok(device);
    for (const [id,title] of [["local-first","First local segment"],["local-second","Second local segment"]]) {
      await cloudCommand("add-item",{id,title,type:"segment",duration:60000,notes:"Venue rehearsal",assignee:"Operator",cue:"",hardStop:false});
    }
    await browser("open",`${origin}/${orgId}/timecode`);
    await click("Take control"); await browser("wait","text=You control this show's timecode.");
    const cue = {id:"local-light",label:"Local room light",action:"device-action",enabled:true,targetDeviceId:device.id,
      targetActionId:"ha:light:turn_on:light.room",triggerTimecode:{hours:0,minutes:10,seconds:0,frames:0},payload:{},toleranceFrames:2};
    const add = (await browser("eval",`fetch('/api/timecode/${orgId}/command?showId=smoke-show',{method:'POST',headers:{'Content-Type':'application/json'},body:${JSON.stringify(JSON.stringify({action:"add-event",payload:cue}))}}).then(async r=>({status:r.status,body:await r.text()}))`)).result;
    assert.equal(add.status,200,add.body);
    await browser("close");
    await withRealBrowser({origin,cookie:operatorCookie},async({page,evaluate,onPageEvent})=>{
      const ipcFailures=[];
      onPageEvent(message=>{
        if(message.method==="Runtime.exceptionThrown")console.error("Browser exception",message.params.exceptionDetails.exception?.description);
        if(message.method==="Runtime.consoleAPICalled"&&message.params.type==="error")console.error("Browser error",message.params.args.map(arg=>arg.description??arg.value));
        if(message.method!=="Runtime.bindingCalled" || message.params.name!=="fixtureNative")return;
        const {id,command,args}=JSON.parse(message.params.payload);
        const execute=async()=>{
          if(command==="local_show_command")return native(args.request);
          if(command==="open_local_show")return null;
          if(command==="engine_info")return {native:true,version:"fixture",platform:process.platform};
          if(command==="bridge_status"||command==="start_bridge")return {
            configured:true,secureCredentials:true,configuredSite:origin,configuredOrg:orgId,
            running:child.exitCode===null,connection:"connected",localDevicesEnabled:true,
            pid:child.pid,logs:[],lastError:null,installationId:(await status()).installationId,
          };
          // Unrelated desktop decorations do not supply local-show state.
          if(command.startsWith("plugin:")||command==="cache_service")return null;
          throw new Error(`Unsupported fixture IPC: ${command}`);
        };
        void execute().then(result=>({result}),error=>({error:error.message})).then(reply=>page("Runtime.evaluate",{
          expression:`window.fixtureResolve(${JSON.stringify(id)},${JSON.stringify(reply)})`,contextId:message.params.executionContextId,
        })).catch(error=>ipcFailures.push(error.message));
      });
      await page("Page.enable"); await page("Runtime.enable"); await page("Runtime.addBinding",{name:"fixtureNative"});
      await page("Emulation.setFocusEmulationEnabled",{enabled:true});
      await page("Page.addScriptToEvaluateOnNewDocument",{source:`(()=>{
        let id=0;const pending=new Map();
        window.fixtureResolve=(id,reply)=>{const p=pending.get(id);if(!p)return;pending.delete(id);reply.error?p.reject(new Error(reply.error)):p.resolve(reply.result);};
        const invoke=(command,args={})=>new Promise((resolve,reject)=>{pending.set(++id,{resolve,reject});window.fixtureNative(JSON.stringify({id,command,args}));});
        window.__TAURI__={core:{invoke}};
        window.__TAURI_INTERNALS__={invoke,metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},transformCallback:()=>0,unregisterCallback:()=>{}};
      })()`});
      const text = async value => {
        try { return await poll(()=>evaluate(`document.body?.innerText.includes(${JSON.stringify(value)})`),value); }
        catch(error) { throw new Error(`${error.message}\n${await evaluate("location.href+'\\n'+document.body?.innerText")}`); }
      };
      const press = async (name,selector="button") => {
        try { await poll(()=>evaluate(`(()=>{const b=[...document.querySelectorAll(${JSON.stringify(selector)})].find(n=>n.textContent.trim()===${JSON.stringify(name)}&&!n.disabled);if(!b)return false;b.click();return true;})()`),`click ${name}`); }
        catch(error) { throw new Error(`${error.message}\n${await evaluate("document.body?.innerText")}`); }
      };
      const navigate = url => page("Page.navigate",{url});
      const rundownUrl=`${origin}/${orgId}/rundown?show=smoke-show&date=${date}`;
      await navigate(rundownUrl); await text("Prepare this show");
      const beforeDiscovery=discoveryCount;
      await press("Prepare this show");
      await poll(async()=>{
        const local=await status(); if(local.mode==="prepared")return true;
        const errors=await evaluate("[...document.querySelectorAll('[role=alert]')].map(n=>n.textContent).filter(Boolean)");
        if(errors.length)throw new Error(`Preparation failed: ${errors.join(' | ')}`);
        return false;
      },"app confirms native preparation");
      await text("Saved on this computer.");
      assert.ok(discoveryCount>beforeDiscovery,"Preparation must discover current Home Assistant actions");
      const prepared=await status(); assert.equal(prepared.actions.length,1); assert.equal(prepared.items.length,2);
      assert.equal(commands.length,0,"Preparation must not execute a device cue");
      console.log("Actual app preparation and Home Assistant discovery passed.");
      await press("Open local controls"); await stopServer();
      await assert.rejects(fetch(`${origin}/api/health`,{signal:AbortSignal.timeout(1000)}));
      await navigate(offlineUrl); await text("PREPARED");
      await press("Enable local control"); await press("Enable local control","dialog button");
      await text("LOCAL CONTROL");
      await press("Next item"); await poll(async()=>(await status()).timer.currentItemId==="local-first","local first item");
      await press("Next item"); await poll(async()=>(await status()).timer.currentItemId==="local-second","local next item");
      await press("Local room light"); await press("Send cue","dialog button");
      await text("Device acknowledged");
      assert.deepEqual(commands,[{method:"POST",path:"/api/services/light/turn_on",body:{entity_id:"light.room"}}]);
      await press("Finish local control"); await press("Finish local control","dialog button");
      await text("AWAITING REVIEW");
      const finished=await status(); assert.equal(finished.mode,"finished"); assert.equal(finished.timer.playback,"pause");
      assert.equal(finished.journal.operations.length,2); assert.equal(finished.results.length,1);
      console.log("Cloud stopped: native rundown advance and authenticated device cue passed.");
      await startServer();
      const unchanged=await readCloud(); assert.equal(unchanged.revision,prepared.baseRevision); assert.equal(unchanged.timer.currentItemId,null);
      await navigate(rundownUrl); await text("Review and sync");
      // Drop the first response after the actual cloud commit. The saved local
      // journal must remain, and retry must acknowledge the existing receipt.
      await evaluate(`(()=>{const original=window.fetch;window.lostSync=0;window.fetch=async(...args)=>{const response=await original(...args);if(!window.lostSync&&String(args[0]).includes('/api/rundown/')&&String(args[1]?.body).includes('reconcile-local')){window.lostSync++;await response.arrayBuffer();throw new TypeError('Fixture lost sync response');}return response;};})()`);
      await press("Review and sync"); await press("Sync timer progress",'[role="dialog"] button');
      await text("Cloud sync could not be confirmed.");
      const committed=await readCloud(); assert.equal(committed.timer.currentItemId,"local-second"); assert.equal(committed.timer.playback,"pause");
      assert.equal((await status()).mode,"finished");
      await press("Review and retry saved sync"); await press("Sync timer progress",'[role="dialog"] button');
      await text("Timer progress synced. Device actions were not replayed.");
      assert.equal((await status()).mode,"reconciled");
      assert.equal((await readCloud()).revision,committed.revision); assert.equal(commands.length,1);
      console.log("Lost cloud sync response: actual app retry confirmed one commit without device replay.");
      // A subsequent local session conflicts with another cloud operator.
      await poll(()=>(diagnostics.match(/\[bridge\] ACTIVE\./g)||[]).length>=2,"venue engine reconnects before another preparation");
      await press("Refresh preparation"); await press("Replace preparation",'[role="dialog"] button');
      await text("Saved on this computer.");
      const second=await status(); assert.notEqual(second.sessionId,prepared.sessionId);
      await stopServer(); await navigate(offlineUrl); await text("PREPARED");
      await press("Enable local control"); await press("Enable local control","dialog button");
      await press("Previous item"); await poll(async()=>(await status()).timer.currentItemId==="local-first","second local session progress");
      await press("Finish local control"); await press("Finish local control","dialog button");
      await text("AWAITING REVIEW"); const conflictRecord=await status();
      await startServer(); await cloudCommand("stage-message",{message:"NEWER_CLOUD_DECISION"});
      const conflictCloud=await readCloud(); assert.ok(conflictCloud.revision>second.baseRevision);
      await navigate(rundownUrl); await text("Review and retry saved sync");
      await press("Review and retry saved sync"); await press("Sync timer progress",'[role="dialog"] button');
      await text("Both versions are preserved.");
      const preserved=await status(); assert.equal(preserved.mode,"finished"); assert.deepEqual(preserved.journal,conflictRecord.journal);
      const finalCloud=await readCloud(); assert.equal(finalCloud.revision,conflictCloud.revision); assert.equal(finalCloud.stageMessage,"NEWER_CLOUD_DECISION");
      assert.equal(finalCloud.timer.currentItemId,"local-second"); assert.equal(commands.length,1);
      assert.deepEqual(ipcFailures,[]);
      assert.equal((await capturedEmails()).length,0);
      console.log(JSON.stringify({passed:true,actualPreparation:true,nativeEngine:true,osVault:true,shippedOfflinePage:true,cloudStopped:true,localRundownAdvance:true,authenticatedDeviceCommand:true,lostSyncReplyRetry:true,revisionConflictPreservesBoth:true,deviceCommands:commands.length,externalEmail:0}));
    });
  } catch(error) {
    console.error(diagnostics.replaceAll(key||"unused-key","[fixture key]").replaceAll(secret,"[fixture secret]").replaceAll(token,"[local token]").slice(-5000));
    throw error;
  } finally {
    if(child&&child.exitCode===null&&child.signalCode===null){const exited=once(child,"exit");child.kill();await exited;}
    for(const server of [equipment,offline]){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    for(const file of (await readdir(directory)).filter(name=>name.endsWith(".json"))){
      const saved=JSON.parse(await readFile(join(directory,file),"utf8"));
      if(typeof saved.keyReference==="string")deleteCredential(saved.keyReference);
    }
    await rm(directory,{recursive:true,force:true});
  }
},{captureEmail:true});
