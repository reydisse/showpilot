// Runs the compiled Worker without Wrangler's development proxy. All bindings
// and persistence remain local, using the same installed workerd/Miniflare.
import assert from "node:assert/strict";
import { appendFile, readFile, readdir, writeFile, rename } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const [configPath, state, portArgument, emailCaptureDirectory, streamOutputDirectory] = process.argv.slice(2);
const port = Number(portArgument);
assert.ok(configPath && state && Number.isInteger(port) && port > 0 && port <= 65535);
const require = createRequire(new URL("../package.json", import.meta.url));
const wrangler = require("wrangler");
const { Miniflare, convertV4MiniflareOptions } = createRequire(require.resolve("wrangler"))("miniflare");
const { workerOptions, main, externalWorkers } = wrangler.unstable_getMiniflareWorkerOptions(configPath);
assert.ok(main, "Built Worker entry is required");
const root = dirname(main);
// The v4→v5 converter cannot expand scriptPath + module rules. Enumerate the
// production build's modules explicitly; do not rebundle or change the app.
const { modulesRules: _rules, ...options } = workerOptions;
const modules = [
  { type: "ESModule", path: main },
  ...(await readdir(join(root, "assets"))).filter(file => file.endsWith(".js") || file.endsWith(".wasm"))
    .map(file => ({ type: file.endsWith(".wasm") ? "CompiledWasm" : "ESModule", path: join(root, "assets", file) })),
];
if (emailCaptureDirectory) {
  assert.equal(resolve(emailCaptureDirectory), resolve(dirname(configPath)), "Email capture is confined to the disposable fixture");
  assert.equal(options.bindings?.RESEND_API_KEY, "local-email-capture-only");
  // Intercept every outbound fetch. This fixture can never send real mail or
  // fall through to an external network, even for an unexpected recipient.
  const acceptedEmails = new Map();
  options.outboundService = async request => {
    assert.equal(request.url, "https://api.resend.com/emails", "Unexpected outbound request");
    assert.equal(request.method, "POST");
    const email = await request.json();
    assert.ok(typeof email.to === "string" && /^[a-z0-9-]+@display-smoke\.invalid$/.test(email.to), "Only disposable fixture recipients are allowed");
    const mode = (await readFile(join(emailCaptureDirectory, "email-mode"), "utf8")).trim();
    assert.ok(["success", "fail", "lose-reply"].includes(mode));
    const key = request.headers.get("Idempotency-Key"), payload = JSON.stringify(email);
    const previous = key ? acceptedEmails.get(key) : null;
    if (previous) assert.equal(previous.payload, payload, "An idempotent retry must preserve its email body");
    const accepted = mode !== "fail", replayed = !!previous;
    const id = previous?.id ?? `fixture-email-${acceptedEmails.size + 1}`;
    if (key && accepted && !previous) acceptedEmails.set(key, { id, payload });
    await appendFile(join(emailCaptureDirectory, "emails.jsonl"), JSON.stringify({ ...email, idempotencyKey: key, replayed, delivered: replayed || accepted }) + "\n");
    // A lost reply represents a provider accepting mail before returning an
    // unusable response. Replaying its frozen key recovers the original ID.
    if (previous) return Response.json({ id });
    if (mode === "lose-reply") return Response.json({ message: "Fixture acknowledgement lost" }, { status: 503 });
    return Response.json(accepted ? { id } : { message: "Fixture validation rejection" }, { status: accepted ? 200 : 422 });
  };
}
if (streamOutputDirectory) {
  assert.equal(resolve(streamOutputDirectory), resolve(dirname(configPath)), "Stream status is confined to the disposable fixture");
  assert.equal(options.bindings?.CLOUDFLARE_STREAM_API_TOKEN, "local-stream-status-only");
  assert.equal(Boolean(emailCaptureDirectory), false);
  const fixtureKind = (await readFile(join(streamOutputDirectory,"stream-output-fixture-kind"),"utf8")).trim();
  const commands = fixtureKind === "commands";
  const liveInputs = new Map();
  const outputs = new Map(); let sequence = 0; let snapshotWrite = Promise.resolve();
  // Every provider fixture blocks external network access. Explicit input and
  // output command fixtures accept writes only to their disposable maps.
  options.outboundService = async request => {
    const url = new URL(request.url), base = "/client/v4/accounts/fixture-account/stream/live_inputs/fixture-input/outputs";
    assert.equal(url.origin,"https://api.cloudflare.com");
    if (fixtureKind === "inputs") {
      const inputBase="/client/v4/accounts/fixture-account/stream/live_inputs";
      assert.ok(url.pathname===inputBase || /^\/client\/v4\/accounts\/fixture-account\/stream\/live_inputs\/fixture-ingest-\d+$/.test(url.pathname),"Unexpected input fixture request");
      const mode=(await readFile(join(streamOutputDirectory,"stream-output-mode"),"utf8")).trim();
      assert.ok(["success","error","slow","malformed","lose-create","lose-delete","lose-enable"].includes(mode));
      await appendFile(join(streamOutputDirectory,"stream-output-requests.jsonl"),JSON.stringify({method:request.method,mode,path:url.pathname})+"\n");
      if(mode==="slow")await new Promise(resolve=>setTimeout(resolve,12_000));
      if(mode==="error")return Response.json({success:false},{status:503});
      if(mode==="malformed")return Response.json({success:true,result:{}});
      const persist=()=>snapshotWrite=snapshotWrite.then(async()=>{
        const path=join(streamOutputDirectory,"stream-output-snapshot.json");
        await writeFile(`${path}.pending`,JSON.stringify([...liveInputs.values()].map(({uid,enabled,meta})=>({uid,enabled,meta}))));await rename(`${path}.pending`,path);
      });
      if(request.method==="POST") {
        assert.equal(url.pathname,inputBase);const body=await request.json();assert.equal(body.enabled,false);assert.equal(typeof body.meta.showpilotInputId,"string");
        const input={uid:`fixture-ingest-${++sequence}`,enabled:false,meta:body.meta,rtmps:{url:"rtmps://fixture.invalid/live",streamKey:"fixture-input-key"},srt:{url:"srt://fixture.invalid/live"},status:"connected"};
        liveInputs.set(input.uid,input);await persist();return mode==="lose-create"?Response.json({success:false},{status:503}):Response.json({success:true,result:input});
      }
      if(request.method==="GET"&&url.pathname===inputBase)return Response.json({success:true,result:{liveInputs:[...liveInputs.values()].map(({uid,enabled,meta})=>({uid,enabled,meta}))}});
      const input=liveInputs.get(url.pathname.slice(inputBase.length+1));if(!input)return new Response(null,{status:404});
      if(request.method==="GET")return Response.json({success:true,result:input});
      if(request.method==="DELETE") {liveInputs.delete(input.uid);await persist();return mode==="lose-delete"?Response.json({success:false},{status:503}):new Response(null,{status:204});}
      assert.equal(request.method,"PUT");const body=await request.json();assert.equal(body.enabled,true);input.enabled=true;await persist();
      return mode==="lose-enable"?Response.json({success:false},{status:503}):Response.json({success:true,result:input});
    }
    assert.ok(url.pathname === base || (commands && url.pathname.startsWith(`${base}/`)), "Unexpected Stream request");
    if (!commands) assert.equal(request.method,"GET","Status rehearsal cannot mutate provider resources");
    const mode = (await readFile(join(streamOutputDirectory, "stream-output-mode"), "utf8")).trim();
    assert.ok(["success", "error", "slow", "malformed", ...(commands ? ["lose-create","slow-create","fail-delete"] : [])].includes(mode));
    const outputId = url.pathname === base ? "" : url.pathname.slice(base.length+1);
    await appendFile(join(streamOutputDirectory, "stream-output-requests.jsonl"), JSON.stringify({ method: request.method, mode, outputId }) + "\n");
    if (mode === "slow") await new Promise(resolve => setTimeout(resolve, 12_000));
    if (mode === "error") return Response.json({ success: false }, { status: 503 });
    if (mode === "malformed") return Response.json({ result: "unreadable" });
    if (!commands) return Response.json({ success: true, result: [
      { uid: "fixture-output-enabled", enabled: true, streamKey: "fixture-private-provider-key" },
      { uid: "fixture-output-disabled", enabled: false },
    ] });
    const persist = () => snapshotWrite = snapshotWrite.then(async () => {
      const path=join(streamOutputDirectory,"stream-output-snapshot.json");
      await writeFile(`${path}.pending`,JSON.stringify([...outputs.values()].map(({uid,enabled})=>({uid,enabled}))));
      await rename(`${path}.pending`,path);
    });
    if (request.method === "GET") return Response.json({success:true,result:[...outputs.values()]});
    if (request.method === "POST") {
      assert.equal(outputId,"");const body = await request.json();
      assert.equal(body.url,"rtmp://fixture.invalid/live");assert.ok(["fixture-alpha-key","fixture-beta-key"].includes(body.streamKey));
      assert.equal(body.enabled,false,"New outputs must start disabled");
      const output={uid:`fixture-command-${++sequence}`,...body};outputs.set(output.uid,output);await persist();
      if(mode === "slow-create")await new Promise(resolve=>setTimeout(resolve,12_000));
      return mode === "lose-create" ? Response.json({success:false},{status:503}) : Response.json({success:true,result:output});
    }
    const output=outputs.get(outputId);
    if (!output) return new Response(null,{status:404});
    if(request.method === "DELETE") {
      if(mode === "fail-delete" && output.streamKey === "fixture-beta-key")return Response.json({success:false},{status:503});
      outputs.delete(outputId);await persist();return new Response(null,{status:204});
    }
    assert.equal(request.method,"PUT");const body=await request.json();assert.equal(typeof body.enabled,"boolean");
    output.enabled=body.enabled;await persist();return Response.json({success:true,result:output});
  };
}
const runtime = new Miniflare(convertV4MiniflareOptions({
  host: "127.0.0.1", port,
  // Matches `wrangler d1 execute --persist-to`. Per-binding v4 persistence
  // options are not carried by the installed converter.
  resourcePersistencePath: resolve(state, "v3"),
  workers: [{ ...options, modules, modulesRoot: root }, ...externalWorkers],
}));
await runtime.ready;
console.log("Direct local Worker ready");
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => { await runtime.dispose(); process.exit(0); });
}
