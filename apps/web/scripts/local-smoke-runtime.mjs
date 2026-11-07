// Runs the compiled Worker without Wrangler's development proxy. All bindings
// and persistence remain local, using the same installed workerd/Miniflare.
import assert from "node:assert/strict";
import { appendFile, readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const [configPath, state, portArgument, emailCaptureDirectory] = process.argv.slice(2);
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
