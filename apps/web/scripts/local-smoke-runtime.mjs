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
  options.outboundService = async request => {
    assert.equal(request.url, "https://api.resend.com/emails", "Unexpected outbound request");
    assert.equal(request.method, "POST");
    const email = await request.json();
    assert.ok(typeof email.to === "string" && /^[a-z0-9-]+@display-smoke\.invalid$/.test(email.to), "Only disposable fixture recipients are allowed");
    const mode = (await readFile(join(emailCaptureDirectory, "email-mode"), "utf8")).trim();
    assert.ok(mode === "success" || mode === "fail");
    await appendFile(join(emailCaptureDirectory, "emails.jsonl"), JSON.stringify({ ...email, delivered: mode === "success" }) + "\n");
    return Response.json(mode === "success" ? { id: "fixture-email" } : { message: "Fixture provider unavailable" }, { status: mode === "success" ? 200 : 503 });
  };
}
if (streamOutputDirectory) {
  assert.equal(resolve(streamOutputDirectory), resolve(dirname(configPath)), "Stream status is confined to the disposable fixture");
  assert.equal(options.bindings?.CLOUDFLARE_STREAM_API_TOKEN, "local-stream-status-only");
  assert.equal(Boolean(emailCaptureDirectory), false);
  const commands = (await readFile(join(streamOutputDirectory,"stream-output-fixture-kind"),"utf8")).trim() === "commands";
  const outputs = new Map(); let sequence = 0; let snapshotWrite = Promise.resolve();
  // Both fixtures block external network access. Only the explicit command
  // fixture accepts writes, and those mutate this disposable in-memory map.
  options.outboundService = async request => {
    const url = new URL(request.url), base = "/client/v4/accounts/fixture-account/stream/live_inputs/fixture-input/outputs";
    assert.equal(url.origin,"https://api.cloudflare.com");
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
