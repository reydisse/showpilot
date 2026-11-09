#!/usr/bin/env node

import { parseDesktopTimecode } from "./desktop-timecode.js";

import { spawn } from "child_process";
import { createInterface } from "readline";
import { Bridge } from "./bridge.js";
import { startParentProcessMonitor } from "./parent-process.js";
import { loadConfigFile, resolveBridgeUrl, startSetupServer, type BridgeConfig } from "./setup-server.js";
import { BRIDGE_VERSION } from "./version.js";
import { createHash } from "node:crypto";
import path from "node:path";
import { LocalShowStore } from "./local-show-store.js";
import { startLocalShowControl } from "./local-show-control.js";
import { acquireLocalShowOwnership } from "./local-show-ownership.js";

const args = process.argv.slice(2);

function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

const desktopMode = args.includes("--desktop");
// The native desktop app passes configuration through the supervised process
// environment. Never let a stale standalone config file in the working
// directory override those values.
let config: BridgeConfig | null = null;
if (!desktopMode) {
  try { config = loadConfigFile(); }
  catch { console.error("[bridge] Secure credential storage is unavailable. Unlock your system keychain before starting the Bridge."); }
}
const site = getArg("site") ?? process.env.SHOWPILOT_SITE_URL ?? config?.site;
const org = getArg("org") ?? process.env.SHOWPILOT_ORG ?? config?.org;
const key = getArg("key") ?? process.env.SHOWPILOT_BRIDGE_KEY ?? config?.key;
const noOpen = args.includes("--no-open");
const propresenterHost =
  getArg("propresenter-host") ?? process.env.SHOWPILOT_PROPRESENTER_HOST ?? config?.propresenterHost;
const propresenterPort = Number.parseInt(
  getArg("propresenter-port") ?? process.env.SHOWPILOT_PROPRESENTER_PORT ?? "",
  10,
);
const propresenterApiPort = Number.parseInt(
  getArg("propresenter-api-port") ?? process.env.SHOWPILOT_PROPRESENTER_API_PORT ?? "",
  10,
);
const propresenterPassword =
  getArg("propresenter-password") ?? process.env.SHOWPILOT_PROPRESENTER_PASSWORD ?? config?.propresenterPassword;

const localToken = process.env.SHOWPILOT_LOCAL_CONTROL_TOKEN;
const localDirectory = process.env.SHOWPILOT_LOCAL_SHOW_DIRECTORY;
if (desktopMode && (localToken || localDirectory)) {
  if (!localToken || !localDirectory || !path.isAbsolute(localDirectory) || !key)
    throw new Error("Native local show configuration is incomplete.");
  // The GUI lock alone disappears on a parent crash, before the old engine can
  // notice. Acquire in the actual journal/device owner, before opening the journal or connecting devices.
  await acquireLocalShowOwnership(localDirectory);
}

let bridge: Bridge | null = null;
let localControl:Awaited<ReturnType<typeof startLocalShowControl>>|null=null;
let currentConfig: BridgeConfig | null = config ?? null;
const parentMonitor = startParentProcessMonitor(
  process.env.SHOWPILOT_PARENT_PID,
  () => {
    console.log("[bridge] Desktop parent closed; shutting down local device engine.");
    bridge?.stop();
    process.exit(0);
  },
);

function openBrowser(targetUrl: string): void {
  if (noOpen) return;

  const opener =
    process.platform === "darwin" ? "open" :
    process.platform === "win32" ? "cmd" :
    "xdg-open";

  const args =
    process.platform === "darwin" ? [targetUrl] :
    process.platform === "win32" ? ["/c", "start", "", targetUrl] :
    [targetUrl];

  const child = spawn(opener, args, { detached: true, stdio: "ignore" });
  child.unref();
}

async function startBridge(nextConfig: BridgeConfig) {
  if(localControl){await localControl.close();localControl=null;}
  bridge?.stop();
  bridge = new Bridge({
    url: nextConfig.url ?? "",
    key: nextConfig.key,
    reconnect: true,
    propresenter: nextConfig.propresenterHost
      ? {
          host: nextConfig.propresenterHost,
          port: nextConfig.propresenterPort,
          apiPort: nextConfig.propresenterApiPort,
          password: nextConfig.propresenterPassword,
        }
      : undefined,
  });
  if (desktopMode && localToken && localDirectory) {
    // Changing the org endpoint or credential never opens another installation's cache.
    const cacheId=createHash('sha256').update(JSON.stringify([nextConfig.site,nextConfig.org,nextConfig.key])).digest('hex');
    bridge.configureLocalShow(new LocalShowStore(path.join(localDirectory,`${cacheId}.json`)));
    const owner=bridge;
    localControl=await startLocalShowControl(localToken,request=>owner.handleLocalShow(request));
    // Only the ephemeral port is announced. The authorization token remains in
    // the parent/child environment and must never enter a log or webview.
    console.log(`[bridge-local-control] ${localControl.port}`);
  }
  bridge.start();
}

function startDesktopControlInput(): void {
  if (!desktopMode) return;
  const lines = createInterface({ input: process.stdin, terminal: false });
  lines.on("line", (line) => {
    try {
      const value = parseDesktopTimecode(JSON.parse(line));
      if (value?.type === "timecode-transport") bridge?.transportTimecode(value.state);
      else if (value?.type === "timecode-feed") bridge?.feedTimecode(value);
    } catch {
      // Ignore malformed supervisor messages without interrupting devices.
    }
  });
}

// The native desktop supervisor owns configuration and does not need the
// standalone setup server. Avoid binding port 9450 so an older bridge process
// cannot make the packaged sidecar exit with EADDRINUSE.
if (!desktopMode) {
  startSetupServer(9450, () => ({
    config: currentConfig,
    bridgeRunning: Boolean(bridge),
    bridgeStatus: bridge ? "running" : "waiting",
    debug: bridge?.getStatus(),
  }), async (nextConfig) => {
    nextConfig.url = nextConfig.url ?? await resolveBridgeUrl(nextConfig.site, nextConfig.org);
    currentConfig = nextConfig;
    await startBridge(nextConfig);
  });
}

startDesktopControlInput();

const directUrl = getArg("url") ?? process.env.SHOWPILOT_BRIDGE_URL ?? config?.url;

if (!directUrl && !site && !org) {
  openBrowser("http://localhost:9450");
}

if (!directUrl && !site && !org) {
  console.log("[bridge] No settings found. Open http://localhost:9450 to finish setup.");
} else {
  const resolvedUrl = directUrl ?? (site && org ? await resolveBridgeUrl(site, org) : undefined);
  if (!resolvedUrl) {
    throw new Error("Unable to determine bridge URL");
  }
  currentConfig = currentConfig ?? {
    site: site ?? "",
    org: org ?? "",
    key,
    url: resolvedUrl,
    propresenterHost,
    propresenterPort: Number.isFinite(propresenterPort) && propresenterPort > 0 ? propresenterPort : undefined,
    propresenterApiPort: Number.isFinite(propresenterApiPort) && propresenterApiPort > 0 ? propresenterApiPort : undefined,
    propresenterPassword,
  };
  console.log(`
  ┌─────────────────────────────────┐
  │   ${`ShowPilot Bridge v${BRIDGE_VERSION}`.padEnd(30)}│
  │   Local Device Proxy Agent      │
  └─────────────────────────────────┘
  `);
  await startBridge(currentConfig);
}

process.on("SIGINT", () => {
  console.log("\n[bridge] Shutting down...");
  if (parentMonitor) clearInterval(parentMonitor);
  bridge?.stop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  if (parentMonitor) clearInterval(parentMonitor);
  bridge?.stop();
  process.exit(0);
});
