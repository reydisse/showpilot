// Built settings UI with a simulated native IPC boundary. Real OS-vault probes
// and Rust supervisor tests verify the corresponding native implementation.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { promisify } from "node:util";

const run = promisify(execFile);
const session = `bridge-private-config-${process.pid}`;
async function browser(...args) {
  const { stdout } = await run("agent-browser", ["--session", session, "--json", ...args], { timeout: 45_000 });
  const response = JSON.parse(stdout);
  assert.equal(response.success, true, response.error);
  return response.data;
}
const fixture = `<script>
  window.__fixture = { calls: [], failSave: false };
  let config = { site: 'https://fixture.invalid', org: 'fixture', key: '', propresenterHost: '192.0.2.1', propresenterPasswordConfigured: true };
  let status = { configured: true, running: false, connection: 'offline', pid: null, logs: [] };
  window.__TAURI_INTERNALS__ = {
    transformCallback: () => 1,
    unregisterCallback: () => {},
    invoke: async (command, args) => {
      switch (command) {
        case 'get_bridge_config': return config;
        case 'bridge_status': return status;
        case 'list_midi_inputs': return [];
        case 'get_mtc_status': return { connected: false, inputName: null, timecode: null };
        case 'plugin:autostart|enable': return;
        case 'plugin:updater|check': return null;
        case 'start_bridge': {
          window.__fixture.calls.push(args.config);
          if (window.__fixture.failSave) throw new Error('Fixture secure storage unavailable');
          const { key, propresenterPassword, clearPropresenterPassword, ...visible } = args.config;
          config = { ...visible, key: '', propresenterPasswordConfigured: !clearPropresenterPassword };
          status = { ...status, running: true, connection: 'connected' };
          return status;
        }
        default: throw new Error('Unexpected fixture IPC command: ' + command);
      }
    }
  };
</script>`;
const html = (await readFile(new URL("../dist/index.html", import.meta.url), "utf8")).replace("<head>", `<head>${fixture}`);
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  if (pathname === "/") { response.setHeader("Content-Type", "text/html"); response.end(html); return; }
  if (!/^\/assets\/[a-zA-Z0-9_.-]+$/.test(pathname)) { response.statusCode = 404; response.end(); return; }
  try {
    response.setHeader("Content-Type", pathname.endsWith(".css") ? "text/css" : "text/javascript");
    response.end(await readFile(new URL(`../dist${pathname}`, import.meta.url)));
  } catch { response.statusCode = 404; response.end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const password = 'input[autocomplete="new-password"]';
const save = () => browser("click", "button.primary:has-text('Save &')");
try {
  await browser("open", `http://127.0.0.1:${server.address().port}`);
  await browser("wait", "text=A password is stored securely on this computer.");
  assert.equal((await browser("eval", `document.querySelector('${password}').value`)).result, "");
  await save();
  await browser("wait", "text=Save & restart");
  const blank = (await browser("eval", "window.__fixture.calls.at(-1)")).result;
  assert.equal(blank.propresenterPassword, undefined);
  assert.notEqual(blank.clearPropresenterPassword, true);
  await browser("fill", password, "fixture-replacement");
  await browser("eval", "window.__fixture.failSave = true");
  await save();
  await browser("wait", "text=Fixture secure storage unavailable");
  assert.equal((await browser("eval", `document.querySelector('${password}').value`)).result, "fixture-replacement");
  await browser("eval", "window.__fixture.failSave = false");
  await save();
  await browser("wait", "--fn", `document.querySelector('${password}').value === ''`);
  assert.equal((await browser("eval", "window.__fixture.calls.at(-1).propresenterPassword")).result, "fixture-replacement");
  for (const width of [320, 620, 2560]) {
    await browser("set", "viewport", String(width), "900");
    const dimensions = (await browser("eval", "({ fits: document.documentElement.scrollWidth <= innerWidth, clearHeight: document.querySelector('.credential-clear').getBoundingClientRect().height })")).result;
    assert.equal(dimensions.fits, true, `Horizontal overflow at ${width}`);
    assert.ok(dimensions.clearHeight >= 44);
  }
  await browser("check", ".credential-clear input");
  assert.equal((await browser("eval", `document.querySelector('${password}').disabled`)).result, true);
  await browser("uncheck", ".credential-clear input");
  assert.equal((await browser("eval", `document.querySelector('${password}').disabled`)).result, false);
  await browser("check", ".credential-clear input");
  await save();
  await browser("wait", "--fn", "document.querySelector('.credential-clear') === null");
  assert.equal((await browser("eval", "window.__fixture.calls.at(-1).clearPropresenterPassword")).result, true);
  console.log("Built Bridge settings UI passed: blank preservation intent, failed draft retention, successful draft clearing, explicit removal/cancel, 320/620/2560px layout. Native IPC was simulated.");
} finally {
  await browser("close").catch(() => {});
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
