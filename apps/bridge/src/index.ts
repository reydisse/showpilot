#!/usr/bin/env node

import { spawn } from "child_process";
import { Bridge } from "./bridge.js";
import { loadConfigFile, resolveBridgeUrl, startSetupServer, type BridgeConfig } from "./setup-server.js";

const args = process.argv.slice(2);

function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

const config = loadConfigFile();
const site = getArg("site") ?? process.env.SHOWPILOT_SITE_URL ?? config?.site;
const org = getArg("org") ?? process.env.SHOWPILOT_ORG ?? config?.org;
const key = getArg("key") ?? process.env.SHOWPILOT_BRIDGE_KEY ?? config?.key;
const noOpen = args.includes("--no-open");

let bridge: Bridge | null = null;
let currentConfig: BridgeConfig | null = config ?? null;

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

function startBridge(nextConfig: BridgeConfig) {
  bridge?.stop();
  bridge = new Bridge({
    url: nextConfig.url ?? "",
    key: nextConfig.key,
    reconnect: true,
  });
  bridge.start();
}

startSetupServer(9450, () => ({
  config: currentConfig,
  bridgeRunning: Boolean(bridge),
  bridgeStatus: bridge ? "running" : "waiting",
}), async (nextConfig) => {
  nextConfig.url = nextConfig.url ?? await resolveBridgeUrl(nextConfig.site, nextConfig.org);
  currentConfig = nextConfig;
  startBridge(nextConfig);
});

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
  currentConfig = currentConfig ?? { site: site ?? "", org: org ?? "", key, url: resolvedUrl };
  console.log(`
  ┌─────────────────────────────────┐
  │   ShowPilot Bridge v0.1.0       │
  │   Local Device Proxy Agent      │
  └─────────────────────────────────┘
  `);
  startBridge({ site: site ?? "", org: org ?? "", key, url: resolvedUrl });
}

process.on("SIGINT", () => {
  console.log("\n[bridge] Shutting down...");
  bridge?.stop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  bridge?.stop();
  process.exit(0);
});
