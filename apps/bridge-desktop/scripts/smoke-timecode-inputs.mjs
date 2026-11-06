// Real production UI in Chromium; native IPC is a controlled device fixture.
// Native decoder/device/pipe tests verify the Rust side independently.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, extname } from 'node:path';
const run = promisify(execFile);
const root = resolve(import.meta.dirname, '../dist');
const session = `ltc-input-${process.pid}`;
const fixture = `
const empty={selected:null,connected:false,locked:false,timecode:null,lastFrameAgeMs:null,level:0,sampleRate:null,error:null};
window.audioFixture={available:true,denied:false,calls:[],ltc:{...empty},mtc:{connected:true,inputName:'DAW MIDI',timecode:'00:00:01:00'}};
window.__TAURI_INTERNALS__={invoke:async(command,args={})=>{
  const f=window.audioFixture;f.calls.push({command,args});
  if(command==='get_bridge_config')return {site:'https://example.invalid',org:'local-test',key:'',midiInputName:'DAW MIDI'};
  if(command==='bridge_status')return {configured:true,running:true,connection:'connected',pid:42,logs:[]};
  if(command==='list_midi_inputs')return [{id:'DAW MIDI',name:'DAW MIDI'}];
  if(command==='list_audio_inputs')return f.available?[{id:'fixture:audio',name:'USB audio interface with a long venue equipment label',channels:2}]:[];
  if(command==='mtc_status')return {...f.mtc};
  if(command==='ltc_status')return {...f.ltc};
  if(command==='start_ltc_input'){
    if(f.denied)throw new Error('Microphone access denied');
    f.ltc={...empty,selected:args.config,connected:true,sampleRate:48000};f.mtc={connected:false,inputName:null,timecode:null};return {...f.ltc};
  }
  if(command==='stop_ltc_input'){f.ltc={...empty};return;}
  if(command==='plugin:updater|check')return null;
  throw new Error('Unimplemented fixture command: '+command);
}};
`;
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, 'http://localhost').pathname;
    const file = resolve(root, path === '/' ? 'index.html' : '.' + path);
    if (!file.startsWith(root + '/')) { response.writeHead(403).end(); return; }
    const content = await readFile(file);
    const extension = extname(file);
    response.setHeader('Content-Type', {'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'}[extension] ?? 'application/octet-stream');
    response.end(extension === '.html' ? content.toString().replace('<head>', '<head><script>'+fixture+'</script>') : content);
  } catch { response.writeHead(404).end(); }
});
async function browser(...args) {
  const {stdout} = await run('agent-browser', ['--session',session,'--json',...args], {timeout:45000});
  const result=JSON.parse(stdout);assert.equal(result.success,true,result.error);return result.data;
}
const click = name => browser('find','role','button','click','--name',name,'--exact');
try {
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  await browser('open', `http://127.0.0.1:${server.address().port}`);
  await browser('select','label:has-text("Audio input") select','fixture:audio');
  await browser('find','label','Audio channel','fill','2');
  await browser('select','label:has-text("LTC frame rate") select','29.97-df');
  await browser('eval','audioFixture.denied=true');
  await click('Switch to LTC');
  await browser('wait','text=Microphone access denied');
  assert.equal((await browser('eval','audioFixture.mtc.connected')).result,true);
  await browser('eval','audioFixture.denied=false');
  await click('Switch to LTC');
  await browser('wait','text=Waiting for LTC');
  assert.deepEqual((await browser('eval','audioFixture.ltc.selected')).result,{deviceId:'fixture:audio',deviceName:'USB audio interface with a long venue equipment label',channel:2,rate:'29.97-df'});
  await browser('eval',`Object.assign(audioFixture.ltc,{locked:true,timecode:'01:02:03;04',lastFrameAgeMs:30,level:0.7})`);
  await click('Rescan inputs');
  await browser('wait','text=01:02:03;04');
  for (const [width,height] of [[320,640],[560,680],[680,790],[2560,1440]]) {
    await browser('set','viewport',String(width),String(height));
    const geometry=(await browser('eval',`({width:innerWidth,scroll:document.documentElement.scrollWidth,controls:[...document.querySelectorAll('.timecode-inputs button,.timecode-inputs input,.timecode-inputs select')].map(e=>({tag:e.tagName,height:e.getBoundingClientRect().height}))})`)).result;
    assert.ok(geometry.scroll<=geometry.width+1,JSON.stringify(geometry));
    for(const control of geometry.controls)assert.ok(control.height>=44,JSON.stringify(control));
  }
  await browser('screenshot','/tmp/showpilot-ltc-inputs-wide.png','--full');
  await browser('eval',`audioFixture.available=false;Object.assign(audioFixture.ltc,{connected:false,locked:false,level:0,lastFrameAgeMs:2500,error:'Audio input disconnected. Waiting to reconnect.'})`);
  await click('Rescan inputs');
  await browser('wait','text=Audio input disconnected. Waiting to reconnect.');
  await browser('wait','text=Last valid frame 2.5s ago');
  await browser('eval',`audioFixture.available=true;Object.assign(audioFixture.ltc,{connected:true,error:null})`);
  await click('Rescan inputs');
  await browser('wait','text=Waiting for LTC');
  assert.equal((await browser('eval',`audioFixture.calls.filter(c=>c.command==='start_ltc_input').length`)).result,2);
  await click('Stop LTC');
  await browser('wait','--fn',`![...document.querySelectorAll('button')].some(b=>b.textContent==='Stop LTC')`);
  assert.equal((await browser('eval','audioFixture.ltc.selected')).result,null);
  console.log('Built Bridge UI passed LTC permission retry, channel/rate selection, lock, unplug/replug, stop, and 320–2560px layout checks.');
} finally {
  await browser('close').catch(()=>{});
  await new Promise(resolve=>server.close(resolve));
}
