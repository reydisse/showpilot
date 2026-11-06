// Built UI, real auth/D1/relay and real Tauri Channel serialization, with IPC simulated.
// The companion Rust CoreMIDI test exercises actual OS ports and native cleanup.
import assert from "node:assert/strict";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";

await withLocalSmokeFixture(async ({ origin, orgId, browser, operatorEmail, operatorPassword }) => {
  const click = name => browser("find", "role", "button", "click", "--name", name, "--exact");
  const api = `/api/timecode/${orgId}`;
  const waitCue = (id, fired) => browser("wait", "--fn", `fetch('${api}/events?showId=smoke-show').then(r=>r.json()).then(events=>events.some(e=>e.id==='${id}'&&e.fired===${fired}))`);
  const press = note => browser("eval", `nativeMidi.message([0x90,${note},127]);nativeMidi.message([0x80,${note},127])`);
  await browser("open", `${origin}/login`); await browser("fill", "#email", operatorEmail); await browser("fill", "#password", operatorPassword); await click("Sign in"); await browser("wait", "--url", `**/${orgId}/**`);
  await browser("open", `${origin}/${orgId}/timecode`);
  await click("Take control"); await browser("wait", "text=You control this show's timecode.");
  const install = () => browser("eval", `(() => {
    const input={id:'native:pads',name:'APC mini mk2',manufacturer:null};
    const output={id:'native:lights',name:'APC mini mk2',manufacturer:null};
    const callbacks=new Map(); let callbackId=0,channel=null,index=0;
    let status={sessionId:'',revision:0,generation:0,inputs:[input],outputs:[output],inputConnected:false,outputConnected:false,error:null};
    const fixture={calls:[],lights:[],expired:false,closed:0,
      emit(event){if(channel)callbacks.get(channel.id)({index:index++,message:event});},
      message(data){this.emit({type:'message',sessionId:status.sessionId,generation:status.generation,data});},
      unplug(){status={...status,generation:status.generation+1,inputs:[],inputConnected:false};this.emit({type:'ports',status:{...status}});},
      replug(){status={...status,generation:status.generation+1,inputs:[{...input,id:'native:replug'}],inputConnected:true};this.emit({type:'ports',status:{...status}});},
    };
    const invoke=async(command,args={})=>{
      fixture.calls.push(command);
      if(command==='midi_controller_open'){
        channel=args.channel;index=0;fixture.expired=false;
        status={...status,sessionId:args.sessionId,revision:0,generation:0,inputConnected:false,outputConnected:false};
      }else if(command==='midi_controller_close'){
        if(args.sessionId===status.sessionId){fixture.closed++;fixture.lights=[];}
      }else if(command.startsWith('midi_controller_')){
        if(fixture.expired)throw new Error('MIDI session expired. Connect and arm the controller again.');
        if(command==='midi_controller_select')status={...status,revision:args.revision,generation:status.generation+1,inputConnected:!!args.input,outputConnected:!!args.output};
        if(command==='midi_controller_feedback')fixture.lights=args.messages;
      }else throw new Error('Fixture does not implement '+command);
      return {...status};
    };
    window.__TAURI_INTERNALS__={invoke,transformCallback:fn=>{callbacks.set(++callbackId,fn);return callbackId;},unregisterCallback:id=>callbacks.delete(id),metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}}};
    window.__TAURI__={core:{invoke}};window.nativeMidi=fixture;
    Object.defineProperty(navigator,'requestMIDIAccess',{configurable:true,value:()=>{throw new Error('Desktop must use native MIDI');}});
    return true;
  })()`);
  await install();
  await browser("eval", `fetch('${api}/command?showId=smoke-show',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'replace-event-group',payload:{sourceKey:'native-fixture',events:[0,1,2].map(i=>({id:'native-'+i,label:'Native cue '+i,action:'lyrics-goto',triggerTimecode:{hours:0,minutes:1,seconds:i,frames:0},payload:{songId:'song',songTitle:'Native MIDI',sectionId:String(i),sectionLabel:String(i),lyrics:'Native cue '+i,nextLabel:''}}))}})}).then(async r=>{if(!r.ok)throw new Error(await r.text());return r.json();})`);
  await click("Connect controller"); await browser("wait", "text=MIDI available");
  await browser("select", '[aria-label="Controller input"]', "native:pads");
  await browser("select", '[aria-label="Controller output"]', "native:lights");
  await click("Map APC cue grid"); await click("Save mappings");
  await browser("wait", "text=Input connected.");
  await press(0); await waitCue("native-0", false);
  await click("Arm controller"); await press(0); await waitCue("native-0", true);
  await browser("wait", "--fn", "nativeMidi.lights.some(m=>m[0]===0x96&&m[1]===0&&m[2]===21)");
  await browser("eval", "nativeMidi.unplug()"); await browser("wait", "text=Selected input disconnected.");
  await press(1); await waitCue("native-1", false);
  await browser("eval", "nativeMidi.replug()"); await browser("wait", "text=Input connected.");
  await press(1); await waitCue("native-1", true);
  await browser("eval", "nativeMidi.expired=true");
  await browser("wait", "text=MIDI session expired. Connect and arm the controller again.");
  await browser("wait", "--fn", "[...document.querySelectorAll('button')].some(b=>b.textContent==='Connect controller'&&!b.disabled)");
  assert.equal((await browser("eval", "nativeMidi.closed")).result, 1);
  await click("Connect controller"); await browser("wait", "text=Input connected.");
  await press(2); await waitCue("native-2", false);
  await click("Arm controller"); await press(2); await waitCue("native-2", true);
  await click("Disarm controller"); await browser("wait", "--fn", "nativeMidi.lights.length===0");
  const calls = (await browser("eval", "nativeMidi.calls")).result;
  for (const command of ["open", "select", "feedback", "refresh", "close"]) assert.ok(calls.includes(`midi_controller_${command}`));
  console.log(JSON.stringify({ builtAuthRelay: "passed", nativeChannelToLyrics: "passed", explicitArm: "passed", nativeLights: "passed", disconnectRejectsInput: "passed", replug: "passed", expiredSessionReconnectAndRearm: "passed", disarmClearsLights: "passed", transport: "simulated IPC; real CoreMIDI tested by Rust probe", physicalController: "not exercised" }, null, 2));
});
