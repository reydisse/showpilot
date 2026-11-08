// Real built app/auth/relay with MIDI ports simulated at the browser boundary.
import assert from "node:assert/strict";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";

await withLocalSmokeFixture(async ({ origin, orgId, browser, operatorEmail, operatorPassword }) => {
  const click = name => browser("find", "role", "button", "click", "--name", name, "--exact");
  const api = `/api/timecode/${orgId}`;
  const read = async path => (await browser("eval", `fetch('${api}/${path}?showId=smoke-show').then(response => response.json())`)).result;
  const waitState = predicate => browser("wait", "--fn", `fetch('${api}/state?showId=smoke-show').then(response => response.json()).then(state => ${predicate})`);
  const waitCue = (id, predicate) => browser("wait", "--fn", `fetch('${api}/events?showId=smoke-show').then(response => response.json()).then(events => {const cue=events.find(cue => cue.id==='${id}'); return cue && (${predicate});})`);
  const press = note => browser("eval", `midi.pads.send([0x90, ${note}, 127]); midi.pads.send([0x80, ${note}, 127])`);
  const cc = (number, value) => browser("eval", `midi.pads.send([0xb0, ${number}, ${value}])`);
  const led = (note, status, value) => browser("wait", "--fn", `(()=>{const message=midi.output.messages.findLast(message=>message[1]===${note});return message?.[0]===${status}&&message[2]===${value};})()`);
  const save = async () => { await click("Save mappings"); await browser("wait", "--fn", "[...document.querySelectorAll('button')].find(button => button.textContent === 'Save mappings')?.disabled"); await browser("wait", "--fn", "![...document.querySelectorAll('button')].some(button => button.textContent === 'Saving mappings…')"); };
  await browser("open", `${origin}/login`); await browser("fill", "#email", operatorEmail); await browser("fill", "#password", operatorPassword); await click("Sign in"); await browser("wait", "--url", `**/${orgId}/**`);
  const installMidi = () => browser("eval", `(() => {
    class Input extends EventTarget {
      constructor(id, name) { super(); this.id=id; this.name=name; this.manufacturer='Fixture'; this.state='connected'; }
      send(bytes) { const event=new Event('midimessage'); Object.defineProperty(event,'data',{value:Uint8Array.from(bytes)}); this.dispatchEvent(event); }
    }
    const access=new EventTarget(); const pads=new Input('pads','APC mini mk2'); const daw=new Input('daw','DAW');
    const output={id:'led',name:'APC mini mk2',manufacturer:'Fixture',state:'connected',messages:[],send(bytes){this.messages.push([...bytes]);}};
    access.inputs=new Map([[pads.id,pads],[daw.id,daw]]); access.outputs=new Map([[output.id,output]]);
    window.midi={access,pads,daw,output,Input};
    Object.defineProperty(navigator,'requestMIDIAccess',{configurable:true,value:async()=>access});
    return true;
  })()`);
  await installMidi();
  await browser("open", `${origin}/${orgId}/timecode`);
  // A full navigation resets the synthetic ports; install before the explicit controller request.
  await installMidi();
  await click("Take control"); await browser("wait", "text=You control this show's timecode.");
  await browser("eval", `fetch('${api}/command?showId=smoke-show', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'replace-event-group',payload:{sourceKey:'controller-fixture',events:Array.from({length:65},(_,i)=>({id:'cue-'+i,label:'Cue '+(i+1),action:'lyrics-goto',triggerTimecode:{hours:0,minutes:Math.floor((i+10)/60),seconds:(i+10)%60,frames:0},payload:{songId:'song',songTitle:'Fixture',sectionId:String(i),sectionLabel:String(i),lyrics:'Cue '+(i+1),nextLabel:''}}))}})}).then(async response=>{if(!response.ok)throw new Error(await response.text());return response.json();})`);
  await click("Connect controller"); await browser("wait", "text=MIDI available");
  await browser("select", '[aria-label="Controller input"]', "pads"); await browser("select", '[aria-label="Controller output"]', "led");
  await click("Map APC cue grid"); await save(); await browser("wait", "text=Input connected.");
  const learn = async (kind, number, { cue, value, fader = false } = {}) => {
    try {
    await browser("select", '[aria-label="Controller action"]', kind);
    if (cue) await browser("select", '[aria-label="Mapped cue"]', cue);
    if (value !== undefined) await browser("fill", '[aria-label="MIDI controller"] input[type=number]', String(value));
    await click("Learn MIDI input");
    if (fader) await cc(number, 64); else await press(number);
    await save();
    } catch (error) {
      console.error("MIDI learn failed", kind, (await browser("eval", `({alerts:[...document.querySelectorAll('[role="alert"]')].map(node=>node.textContent),statuses:[...document.querySelectorAll('[role="status"]')].map(node=>node.textContent),action:document.querySelector('[aria-label="Controller action"]')?.value,disabled:document.querySelector('[aria-label="Controller action"]')?.matches(':disabled'),mappings:document.querySelector('[aria-label="Saved controller mappings"]')?.textContent})`)).result);
      throw error;
    }
  };
  await learn("start", 100); await learn("pause", 101); await learn("stop", 102);
  await learn("rearm", 103, { cue: "cue-0" }); await learn("skip", 104, { cue: "cue-1" });
  await learn("fire-next", 105); await learn("bank-next", 106); await learn("bank-prev", 107);
  await learn("reset", 108); await learn("seek", 109, { value: 45 });
  await learn("scrub", 48, { value: 90, fader: true }); await learn("jog", 49, { value: 1, fader: true }); await learn("offset", 50, { value: 30, fader: true });
  assert.ok((await read("events")).every(cue => !cue.fired), "Learning must never fire a cue");
  await click("Arm controller");
  await led(0, 0x96, 13); await led(1, 0x96, 45); // Next yellow, armed blue.
  await press(0); await waitCue("cue-0", "cue.fired");
  assert.equal((await read("state")).lyrics.lyrics, "Cue 1");
  await led(0, 0x96, 21); await led(1, 0x96, 13); // Fired green, next advances.
  await press(106); await browser("wait", "text=Bank 2 of 2"); await press(0); await waitCue("cue-64", "cue.fired");
  assert.equal((await read("state")).lyrics.lyrics, "Cue 65");
  await press(107); await browser("wait", "text=Bank 1 of 2");
  await press(103); await click("Cancel"); assert.equal((await read("events"))[0].fired, true);
  await press(103); await click("Re-arm cue"); await waitCue("cue-0", "!cue.fired");
  assert.equal((await read("state")).lyrics.lyrics, "Cue 65");
  await press(105); await waitCue("cue-0", "cue.fired"); await press(104); await waitCue("cue-1", "cue.skipped");
  await cc(48,127); await waitState("state.totalFrames===90"); assert.equal((await read("state")).triggersEnabled,false);
  await press(108); await click("Reset clock"); await waitState("state.totalFrames===0");
  await click("Review and resume automation"); await click("Resume automation");
  await press(100); await waitState("state.running && state.totalFrames>0");
  await led(100, 0x90, 2); // Transport button reports the running clock.
  await press(101); await waitState("state.signal.status==='paused'"); const held = (await read("state")).totalFrames;
  await led(100, 0x90, 1);
  await browser("wait", "text=Clock paused. Position and source ownership are held.");
  assert.equal((await read("state")).totalFrames,held);
  await press(100); await waitState(`state.running && state.totalFrames>${held}`);
  await press(102); await waitState("!state.running && state.signal.status==='idle'");
  await led(100, 0x90, 1);
  await press(109); await waitState("state.totalFrames===45");
  await cc(49,64); await new Promise(resolve=>setTimeout(resolve,100)); await cc(49,65); await waitState("state.totalFrames===46");
  await cc(50,64); await new Promise(resolve=>setTimeout(resolve,100)); await cc(50,127); await waitState("state.totalFrames===76");
  await browser("eval", "midi.pads.send([0xb0,48,80]);midi.pads.state='disconnected';midi.access.inputs.delete(midi.pads.id);midi.access.dispatchEvent(new Event('statechange'))");
  await browser("wait", "text=Selected input disconnected.");
  assert.equal((await read("state")).totalFrames,76,"Unplug cancels pending fader movement");
  await browser("eval", "midi.pads=new midi.Input('pads-new','APC mini mk2');midi.access.inputs.set(midi.pads.id,midi.pads)");
  await browser("wait", "text=Input connected.");
  await press(2); await waitCue("cue-2", "cue.fired");
  await click("Disarm controller"); await press(3); assert.equal((await read("events")).find(cue=>cue.id==='cue-3').fired,false);
  for (const width of [320,768,2560]) {
    await browser("set", "viewport", String(width), "900");
    const {result}=await browser("eval", "(()=>{const panel=document.querySelector('[aria-label=\"MIDI controller\"]');return {width:panel.clientWidth,content:panel.scrollWidth,targets:[...panel.querySelectorAll('button,select,input')].map(element=>element.getBoundingClientRect().height)};})()");
    assert.ok(result.content<=result.width+1,`Controller overflows at ${width}px`); assert.ok(result.targets.every(height=>height>=44),`Controller target below 44px at ${width}px`);
  }
  await browser("open", `${origin}/${orgId}/timecode`);
  await browser("wait", "--fn", "document.querySelector('[aria-label=\"Saved controller mappings\"]')?.children.length===77");
  assert.match((await browser("get","text",'[aria-label="MIDI controller"]')).text,/Controller disarmed/);
  await installMidi(); await click("Take control"); await browser("wait","text=You control this show's timecode.");
  await click("Connect controller"); await browser("wait","text=Input connected."); await click("Arm controller");
  await click("Refresh"); await browser("wait","--fn","document.querySelector('[aria-label=\"MIDI timecode input\"]')?.options.length===3");
  await browser("select",'[aria-label="MIDI timecode input"]',"daw"); await click("Start MTC"); await browser("wait","text=Stop Generator");
  const mtc = frame => browser("eval", `[${frame},0x10,0x20,0x30,0x40,0x50,0x60,0x76].forEach(value=>midi.daw.send([0xf1,value]))`);
  await mtc(1); await waitState("state.source==='mtc' && state.totalFrames===1");
  // A large backward locate can hold automation, so acknowledge the actual guard before firing.
  if (!(await read("state")).triggersEnabled) { await click("Review and resume automation"); await click("Resume automation"); }
  await press(3); await waitCue("cue-3","cue.fired"); assert.equal((await read("state")).totalFrames,1);
  await press(101); await waitState("state.signal.status==='paused'");
  await mtc(2); assert.equal((await read("state")).totalFrames,1);
  await press(100); await waitState("state.signal.status==='waiting'");
  await mtc(3); await waitState("state.totalFrames===3 && state.source==='mtc'");
  await press(102); await waitState("!state.running && state.signal.status==='idle'");
  console.log(JSON.stringify({ builtLogin:"passed", mappingsLearnAndPersist:"passed", learnNeverFires:"passed", explicitArming:"passed", cueBanks65:"passed", actualLyrics:"passed", ledFeedback:"armed/next/fired/running/paused/stopped passed", rearmConfirmation:"passed", pauseResume:"passed", seekScrubJogOffset:"passed", hotplugPreservesMappings:"passed", unplugCancelsPendingFader:"passed", simultaneousMtcAndController:"passed", mtcPauseKeepsSource:"passed", responsiveController:"320/768/2560 passed", physicalMidi:"not exercised" },null,2));
});
