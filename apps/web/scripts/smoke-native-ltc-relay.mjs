// Native PCM capture fixture -> Rust decoder/queue -> compiled sidecar -> real
// authenticated Bridge/Timecode/Rundown relays -> operator clock and stage cue.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { poll } from "./real-browser-fixture.mjs";

const root = resolve(import.meta.dirname, "../../..");
const host = execFileSync("rustc", ["--print", "host-tuple"], { encoding:"utf8" }).trim();
const binary = resolve(root, `apps/bridge-desktop/src-tauri/binaries/showpilot-bridge-${host}${process.platform==="win32"?".exe":""}`);
await withLocalSmokeFixture(async ({ origin, orgId, date, browser, operatorEmail, operatorPassword, operatorCookie, capturedEmails }) => {
  const click = name => browser("find", "role", "button", "click", "--name", name, "--exact");
  const headers = { Cookie:operatorCookie, Origin:origin, "Content-Type":"application/json" };
  const read = async path => {
    const response = await fetch(`${origin}${path}`, { headers, signal:AbortSignal.timeout(8000) });
    assert.equal(response.status,200); return response.json();
  };
  const statePath = `/api/timecode/${orgId}/state?showId=smoke-show`;
  const eventsPath = `/api/timecode/${orgId}/events?showId=smoke-show`;
  await browser("open",`${origin}/login`);
  await browser("fill","#email",operatorEmail); await browser("fill","#password",operatorPassword);
  await click("Sign in"); await browser("wait","--url",`**/${orgId}/**`);
  await browser("open",`${origin}/${orgId}/settings?section=api`);
  await browser("fill",'input[placeholder="Main room computer"]',"Native LTC fixture");
  await click("Create key"); await browser("wait","text=Copy this key into the Bridge now.");
  const key = (await browser("eval","[...document.querySelectorAll('code')].map(n=>n.textContent).find(text=>/^sp_[a-f0-9]{64}$/.test(text))")).result;
  assert.match(key,/^sp_[a-f0-9]{64}$/); await click("Dismiss key");
  await browser("open",`${origin}/${orgId}/timecode`);
  await click("Take control"); await browser("wait","text=You control this show's timecode.");
  const cue = { id:"native-ltc-stage",label:"Native audio stage cue",action:"stage-message",enabled:true,
    triggerTimecode:{hours:0,minutes:0,seconds:1,frames:15},toleranceFrames:0,payload:{message:"NATIVE_LTC_REACHED_THE_REAL_RELAY"} };
  // The control lease belongs to this browser login, not the fixture's separate
  // read-only inspection session, even though both have the same user ID.
  const added = (await browser("eval", `fetch(${JSON.stringify(`/api/timecode/${orgId}/command?showId=smoke-show`)},{method:'POST',headers:{'Content-Type':'application/json'},body:${JSON.stringify(JSON.stringify({action:"add-event",payload:cue}))},signal:AbortSignal.timeout(8000)}).then(async response=>({status:response.status,body:await response.text()}))`)).result;
  assert.equal(added.status,200,added.body);
  assert.equal((await read(eventsPath)).find(event=>event.id===cue.id).fired,false);
  assert.equal((await read(statePath)).source,"internal-freerun");
  let child;
  let timer;
  let output="";
  try {
    const exitCode = await new Promise((resolve,reject) => {
      child=spawn("cargo",["test","--release","--locked","--manifest-path","apps/bridge-desktop/src-tauri/Cargo.toml","--lib","ltc_audio::tests::decoded_pcm_reaches_compiled_sidecar","--","--ignored","--exact","--nocapture"],{
        cwd:root,
        env:{...process.env,SHOWPILOT_TIMECODE_PROBE_BINARY:binary,SHOWPILOT_SITE_URL:origin,SHOWPILOT_ORG:orgId,
          SHOWPILOT_BRIDGE_URL:`${origin.replace("http:","ws:")}/api/bridge/${orgId}/ws?role=bridge`,
          SHOWPILOT_BRIDGE_KEY:key,SHOWPILOT_PARENT_PID:String(process.pid),SHOWPILOT_PROPRESENTER_HOST:"",
          SHOWPILOT_LOCAL_CONTROL_TOKEN:"",SHOWPILOT_LOCAL_SHOW_DIRECTORY:""},
        stdio:["ignore","pipe","pipe"],
      });
      const collect=bytes=>{output+=bytes.toString();}; child.stdout.on("data",collect);child.stderr.on("data",collect);
      child.once("error",reject);child.once("exit",resolve);
      timer=setTimeout(()=>{child.kill();reject(new Error("Native PCM probe exceeded five minutes"));},300000);
    });
    assert.equal(exitCode,0,output.replaceAll(key,"[fixture key]"));
    await poll(async()=>{const state=await read(statePath);return state.source==="ltc-bridge"&&state.totalFrames===52;},"decoded native PCM reaches actual TimecodeRelay");
    const state=await read(statePath);
    assert.deepEqual(state.timecode,{hours:0,minutes:0,seconds:1,frames:22});
    await poll(async()=>(await read(eventsPath)).find(event=>event.id===cue.id)?.fired,"native audio crosses the stage cue");
    const fired=(await read(eventsPath)).find(event=>event.id===cue.id);
    assert.equal(fired.executionStatus,"acknowledged");
    const rundown=await read(`/api/rundown/${orgId}/state?showId=smoke-show&serviceDate=${date}`);
    assert.equal(rundown.stageMessage,cue.payload.message);
    await browser("wait","--fn","document.querySelector('[data-timecode-display=large]')?.textContent==='00:00:01:22'");
    await poll(async()=>!(await read(statePath)).running,"native input stop holds the actual relay clock");
    assert.equal((await read(eventsPath)).find(event=>event.id===cue.id).executionId,fired.executionId);
    assert.equal((await capturedEmails()).length,0);
    console.log(JSON.stringify({passed:true,nativePcmDecoder:true,compiledSidecar:true,realBridgeAuthentication:true,realTimecodeRelay:true,operatorClock:"00:00:01:22",stageCue:"acknowledged",inputStopHoldsClock:true,capture:"synthetic PCM; no physical audio interface",externalEmail:0}));
  } finally {
    clearTimeout(timer);
    if(child&&child.exitCode===null&&child.signalCode===null){const exited=new Promise(resolve=>child.once("exit",resolve));child.kill();await exited;}
  }
}, {captureEmail:true});
