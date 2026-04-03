/**
 * ShowPilot Bridge
 *
 * Runs on a local computer on the church/venue network.
 * Connects outbound to the ShowPilot cloud and bridges
 * local production hardware (ProPresenter, etc.) to the
 * cloud-based rundown and timer system.
 *
 * Usage:
 *   npx tsx src/index.ts          # dev mode
 *   node dist/index.js            # production
 *
 * Configure via config.json or environment variables:
 *   SP_CLOUD_URL=https://your-app.pages.dev
 *   SP_ORG_SLUG=your-org
 *   SP_API_KEY=sk-...
 *   SP_UI_PORT=9450
 */

import { loadConfig, getConfig, saveConfig, type DeviceConfig } from "./config.js";
import { CloudLink, type RundownState, type CloudLinkStatus } from "./cloud-link.js";
import { ProPresenterDevice, type PPSlideData, type PPStatus } from "./devices/propresenter.js";
import { startUIServer } from "./ui-server.js";

// ─── State ──────────────────────────────────────────────────

interface DeviceInstance {
  config: DeviceConfig;
  driver: ProPresenterDevice;
  status: PPStatus;
  currentSlide: PPSlideData | null;
}

const devices = new Map<string, DeviceInstance>();
let cloudLink: CloudLink | null = null;
let cloudStatus: CloudLinkStatus = "disconnected";
let lastRundownState: RundownState | null = null;
const startTime = Date.now();

// ─── Cloud Link ─────────────────────────────────────────────

function connectCloud(): void {
  const config = getConfig();

  if (!config.cloudUrl || !config.orgSlug) {
    console.log("[Bridge] Cloud URL or org slug not configured — skipping cloud connection");
    console.log(`[Bridge] Configure at http://localhost:${config.uiPort}`);
    return;
  }

  if (cloudLink) {
    cloudLink.disconnect();
  }

  cloudLink = new CloudLink(config, {
    onState: (state) => {
      lastRundownState = state;
      handleCloudState(state);
    },
    onStatusChange: (status) => {
      cloudStatus = status;
      console.log(`[Bridge] Cloud: ${status}`);
    },
  });

  cloudLink.connect();
}

/**
 * Handle rundown state changes from the cloud.
 * This is where we bridge cloud → local devices.
 */
function handleCloudState(state: RundownState): void {
  const currentItem = state.items.find((i) => i.id === state.timer.currentItemId);

  // Log significant state changes
  if (state.timer.playback === "play" && currentItem) {
    console.log(`[Bridge] Now playing: "${currentItem.title}" (${Math.round(currentItem.duration / 1000)}s)`);
  } else if (state.timer.playback === "stop") {
    console.log("[Bridge] Timer stopped");
  }

  // Future: send cues to ProPresenter when items advance
  // For now, PP → Cloud is the primary direction (slide relay)
}

// ─── Device Management ──────────────────────────────────────

function connectDevice(config: DeviceConfig): void {
  if (!config.enabled) return;
  if (devices.has(config.id)) return;

  if (config.type === "propresenter") {
    const instance: DeviceInstance = {
      config,
      driver: null as unknown as ProPresenterDevice,
      status: "disconnected",
      currentSlide: null,
    };

    const driver = new ProPresenterDevice(config, {
      onSlideChange: (slide) => {
        instance.currentSlide = slide;
        console.log(`[Bridge] PP slide: "${slide?.text?.slice(0, 60) || "(cleared)"}"`);
        // Relay slide data to cloud for kiosk display
        if (cloudLink && cloudLink.getStatus() === "connected") {
          cloudLink.sendCommand("pp-slide", {
            slide: slide ? {
              text: slide.text,
              notes: slide.notes || "",
              presentationName: slide.presentationName || "",
              isScripture: slide.isScripture || false,
            } : null,
          });
        }
      },
      onStatusChange: (status) => {
        instance.status = status;
        console.log(`[Bridge] PP "${config.name}": ${status}`);
      },
    });

    instance.driver = driver;
    devices.set(config.id, instance);
    driver.connect();
  }
}

function disconnectDevice(id: string): void {
  const instance = devices.get(id);
  if (instance) {
    instance.driver.disconnect();
    devices.delete(id);
  }
}

function addDevice(device: DeviceConfig): void {
  const config = getConfig();
  config.devices.push(device);
  saveConfig(config);
  connectDevice(device);
}

function removeDevice(id: string): void {
  disconnectDevice(id);
  const config = getConfig();
  config.devices = config.devices.filter((d) => d.id !== id);
  saveConfig(config);
}

function toggleDevice(id: string, enabled: boolean): void {
  const config = getConfig();
  const device = config.devices.find((d) => d.id === id);
  if (!device) return;

  device.enabled = enabled;
  saveConfig(config);

  if (enabled) {
    connectDevice(device);
  } else {
    disconnectDevice(id);
  }
}

function reconnect(): void {
  // Disconnect all, reload config, reconnect
  for (const [id] of devices) {
    disconnectDevice(id);
  }
  const config = loadConfig();
  connectCloud();
  for (const device of config.devices) {
    connectDevice(device);
  }
}

// ─── Boot ───────────────────────────────────────────────────

function main(): void {
  console.log("");
  console.log("  ╔══════════════════════════════╗");
  console.log("  ║     ShowPilot Bridge v0.1     ║");
  console.log("  ╚══════════════════════════════╝");
  console.log("");

  const config = loadConfig();
  console.log(`[Bridge] Org: ${config.orgSlug || "(not configured)"}`);
  console.log(`[Bridge] Cloud: ${config.cloudUrl || "(not configured)"}`);
  console.log(`[Bridge] Devices: ${config.devices.length}`);
  console.log("");

  // Start status UI
  startUIServer(config.uiPort, {
    getStatus: () => ({
      cloud: cloudStatus,
      orgSlug: config.orgSlug,
      devices: Array.from(devices.values()).map((d) => ({
        id: d.config.id,
        name: d.config.name,
        type: d.config.type,
        enabled: d.config.enabled,
        status: d.status,
        currentSlide: d.currentSlide?.text?.slice(0, 80) || null,
      })),
      uptime: Date.now() - startTime,
    }),
    addDevice,
    removeDevice,
    toggleDevice,
    reconnect,
  });

  // Connect to cloud
  connectCloud();

  // Connect configured devices
  for (const device of config.devices) {
    connectDevice(device);
  }
}

main();
