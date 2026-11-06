// Independently generated PCM -> native decoder/queue -> compiled sidecar -> WS.
// Replaces only the OS audio capture stream and remote server with local fixtures.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { resolve as resolvePath } from 'node:path';
import { WebSocketServer } from 'ws';
const root = resolvePath(import.meta.dirname, '../../..');
const host = execFileSync('rustc', ['--print','host-tuple'], {encoding:'utf8'}).trim();
const binary = process.argv[2] ?? resolvePath(root, `apps/bridge-desktop/src-tauri/binaries/showpilot-bridge-${host}${process.platform === 'win32' ? '.exe' : ''}`);
const server = createServer((_request,response)=>response.end('Local timecode test'));
const sockets = new WebSocketServer({server});
const frames=[];
let failure;
sockets.on('connection',(socket,request)=>{
  try {
    assert.equal(request.headers['x-showpilot-bridge-policy'],'3');
    assert.equal(request.headers['x-showpilot-api-key'],'sp_local_pcm_fixture');
  } catch(error) { failure=error; socket.close(); return; }
  socket.on('message',bytes=>{
    const message=JSON.parse(bytes.toString());
    if(message.type==='timecode-feed')frames.push(message);
  });
  socket.send(JSON.stringify({type:'bridge-role',role:'active',orgId:'ltc-fixture',installationId:'local-native',activeInstallation:{installationId:'local-native',label:'Local native'},approvedTargets:[]}));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let child;
let timer;
try {
  const logs=[];
  const code=await new Promise((resolve,reject)=>{
    child=spawn('cargo',['test','--release','--locked','--manifest-path','apps/bridge-desktop/src-tauri/Cargo.toml','--lib','ltc_audio::tests::decoded_pcm_reaches_compiled_sidecar','--','--ignored','--exact','--nocapture'],{
      cwd:root,env:{...process.env,SHOWPILOT_TIMECODE_PROBE_BINARY:resolvePath(binary),SHOWPILOT_SITE_URL:`http://127.0.0.1:${server.address().port}`,SHOWPILOT_ORG:'ltc-fixture',SHOWPILOT_BRIDGE_KEY:'sp_local_pcm_fixture',SHOWPILOT_PARENT_PID:String(process.pid),SHOWPILOT_PROPRESENTER_HOST:''},stdio:['ignore','pipe','pipe'],
    });
    child.stdout.on('data',bytes=>logs.push(bytes.toString()));child.stderr.on('data',bytes=>logs.push(bytes.toString()));
    child.on('error',reject);child.on('exit',resolve);
    timer=setTimeout(()=>{child.kill();reject(new Error('Native timecode probe exceeded five minutes'));},300000);
  });
  assert.equal(code,0,logs.join(''));
  if(failure)throw failure;
  assert.ok(frames.length>=10,`Expected coherent LTC frames, received ${frames.length}`);
  assert.ok(frames.every(frame=>frame.source==='ltc-bridge'&&frame.format.frameRate===30&&frame.format.dropFrame==='ndf'));
  assert.equal(frames.at(-1).totalFrames,52);
  assert.deepEqual(frames.at(-1).timecode,{hours:0,minutes:0,seconds:1,frames:22});
  assert.ok(frames.every((frame,index)=>index===0||frame.totalFrames>frames[index-1].totalFrames));
  assert.ok(frames.every(frame=>!('expiresAt' in frame)),'Native deadline must be stripped before network forwarding');
  console.log(`Native PCM -> compiled sidecar -> authenticated WebSocket passed (${frames.length} LTC frames, final 00:00:01:22).`);
} finally {
  clearTimeout(timer);
  if(child&&child.exitCode===null)child.kill();
  for(const socket of sockets.clients)socket.terminate();
  await new Promise(resolve=>sockets.close(resolve));
  await new Promise(resolve=>server.close(resolve));
}
