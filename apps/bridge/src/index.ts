#!/usr/bin/env node

import { spawn } from "child_process";
import { createInterface } from "readline";
import { Bridge } from "./bridge.js";
import { startParentProcessMonitor } from "./parent-process.js";
import { loadConfigFile, resolveBridgeUrl, startSetupServer, type BridgeConfig } from "./setup-server.js";
import { BRIDGE_VERSION } from "./version.js";

const args = process.argv.slice(2);

function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

const desktopMode = args.includes("--desktop");
// The native desktop app passes configuration through the supervised process
// environment. Never let a stale standalone config file in the working
// directory override those values.
const config = desktopMode ? null : loadConfigFile();
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

let bridge: Bridge | null = null;
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

function startBridge(nextConfig: BridgeConfig) {
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
  bridge.start();
}

function startDesktopControlInput(): void {
  if (!desktopMode) return;
  const lines = createInterface({ input: process.stdin, terminal: false });
  lines.on("line", (line) => {
    try {
      const value: unknown = JSON.parse(line);
      if (
        typeof value !== "object" || value === null
        || !("type" in value) || value.type !== "timecode-feed"
        || !("timecode" in value) || typeof value.timecode !== "object" || value.timecode === null
        || !("format" in value) || typeof value.format !== "object" || value.format === null
        || !("totalFrames" in value) || typeof value.totalFrames !== "number"
      ) return;
      const timecode = value.timecode as Record<string, unknown>;
      const format = value.format as Record<string, unknown>;
      if (
        typeof timecode.hours !== "number"
        || typeof timecode.minutes !== "number"
        || typeof timecode.seconds !== "number"
        || typeof timecode.frames !== "number"
        || ![24, 25, 29.97, 30].includes(format.frameRate as number)
        || (format.dropFrame !== "df" && format.dropFrame !== "ndf")
      ) return;
      bridge?.feedTimecode({
        timecode: {
          hours: timecode.hours,
          minutes: timecode.minutes,
          seconds: timecode.seconds,
          frames: timecode.frames,
        },
        format: {
          frameRate: format.frameRate as 24 | 25 | 29.97 | 30,
          dropFrame: format.dropFrame,
        },
        totalFrames: value.totalFrames,
      });
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
    startBridge(nextConfig);
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
  startBridge(currentConfig);
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
