// Build a fixture frontend with the source checkout's real notification adapter.
// The distinct app ID AND executable name isolate native/WebKit storage from
// installed ShowPilot profiles. No network, account or equipment is involved.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const { values } = parseArgs({ options: {
  source: { type: "string" }, output: { type: "string" }, label: { type: "string" },
} });
if (!values.source || !values.output || !["old", "new"].includes(values.label)) {
  throw new Error("Required: --source <checkout> --output <fixture-directory> --label old|new");
}
const source = resolve(values.source), output = resolve(values.output), label = values.label;
const require = createRequire(resolve(source, "apps/web/package.json"));
const { build } = await import(pathToFileURL(require.resolve("esbuild")).href);
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim();
const cargo = await readFile(resolve(source, "apps/desktop/src-tauri/Cargo.lock"), "utf8");
const pluginVersion = cargo.match(/name = "tauri-plugin-notification"\nversion = "([^"]+)"/)[1];
await mkdir(output, { recursive: true });
await build({
  stdin: {
    resolveDir: resolve(source, "apps/web/src/lib"), loader: "ts",
    contents: `
import { listenForDesktopNotificationActions, requestDesktopNotificationPermission, showDesktopNotification } from './desktop-runtime';
const status = document.querySelector('#status');
const send = document.querySelector('#send');
const register = document.querySelector('#register');
const fixture = { notificationId: 'notification-action-fixture', orgSlug: 'showpilot-demo-nov04', actionUrl: 'show' };
const log = (message) => { status.textContent = message; };
register.addEventListener('click', async () => {
  register.disabled = true;
  try {
    await listenForDesktopNotificationActions(payload => {
      if (payload.notificationId !== fixture.notificationId || payload.orgSlug !== fixture.orgSlug || payload.actionUrl !== fixture.actionUrl) {
        log('FAIL: notification action payload did not match the fixture'); return;
      }
      log('PASS: real notification click reached the production web adapter with the matching fixture payload');
    });
    log('Listener registered. Send a notification, then click its OS banner.');
    send.disabled = false;
  } catch (error) {
    log('REGISTRATION FAILED: ' + (error instanceof Error ? error.message : String(error)));
  }
});
send.addEventListener('click', async () => {
  send.disabled = true;
  try {
    const permission = await requestDesktopNotificationPermission();
    if (permission !== 'granted') throw new Error('OS notification permission is not granted');
    const accepted = await showDesktopNotification('ShowPilot notification fixture (${label})', 'Click this banner to verify the native-to-web action path. No org data is used.', fixture);
    if (!accepted) throw new Error('Native notification was not accepted');
    log('Notification submitted. Waiting for the real OS notification click.');
  } catch (error) {
    log('SEND FAILED: ' + (error instanceof Error ? error.message : String(error)));
  }
  send.disabled = false;
});
`,
  },
  outfile: resolve(output, "fixture.js"), bundle: true, platform: "browser", format: "esm", target: "es2022",
});
await writeFile(resolve(output, "index.html"), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'self' asset: http://asset.localhost; script-src 'self'; connect-src ipc: http://ipc.localhost; style-src 'unsafe-inline'"><title>ShowPilot notification action fixture (${label})</title><style>body{background:#101114;color:#f4f4f5;font:20px system-ui;padding:48px}button{font:inherit;padding:14px;margin:12px 12px 12px 0}pre{white-space:pre-wrap;font:inherit;padding:24px;border:1px solid #555}</style></head><body><h1>Notification action fixture: ${label}</h1><p>Source ${commit}; native notification plugin ${pluginVersion}.</p><p>No account, network requests, org data, device agent or equipment controls.</p><button id="register">Register real native listener</button><button id="send" disabled>Send fixture notification</button><pre id="status" role="status">Ready for native listener registration.</pre><script type="module" src="fixture.js"></script></body></html>`);
const config = {
  productName: `ShowPilot Notification Smoke ${label}`, mainBinaryName: `showpilot-notification-smoke-${label}`,
  identifier: `tech.showpilot.notification-smoke-${label}`,
  build: { frontendDist: output, beforeBuildCommand: "" },
  app: { windows: [{ label: "main", title: `ShowPilot Notification Smoke ${label}`, width: 1100, height: 720 }] },
  bundle: { externalBin: [], targets: ["app"] },
};
const configPath = resolve(output, "fixture-config.json");
await writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
console.log(JSON.stringify({ source, commit, pluginVersion, fixtureConfig: configPath, isolatedIdentifier: config.identifier, isolatedExecutable: config.mainBinaryName }));
