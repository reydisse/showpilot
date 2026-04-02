/**
 * ShowPilot Bridge Configuration
 *
 * Loaded from config.json in the gateway directory, or from env vars.
 * The bridge runs on a local machine on the church network and connects
 * outbound to the ShowPilot cloud + local devices (ProPresenter, etc.)
 */

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(__dirname, "../config.json");

export interface DeviceConfig {
  id: string;
  type: "propresenter" | "osc" | "midi";
  name: string;
  enabled: boolean;
  host: string;
  port: number;
  /** PP stage display password */
  password?: string;
  /** PP REST API port (usually 1025) */
  apiPort?: number;
  /** Allow sending cues/commands to this device */
  allowControl?: boolean;
}

export interface BridgeConfig {
  /** ShowPilot cloud URL (e.g., https://app.showpilot.com) */
  cloudUrl: string;
  /** Organization slug or ID */
  orgSlug: string;
  /** API key for authenticating with ShowPilot cloud */
  apiKey: string;
  /** Local HTTP port for the bridge status UI */
  uiPort: number;
  /** Devices configured on the local network */
  devices: DeviceConfig[];
}

const DEFAULT_CONFIG: BridgeConfig = {
  cloudUrl: "",
  orgSlug: "",
  apiKey: "",
  uiPort: 9450,
  devices: [],
};

let _config: BridgeConfig = { ...DEFAULT_CONFIG };

export function loadConfig(): BridgeConfig {
  // Env overrides
  const envCloud = process.env.SP_CLOUD_URL;
  const envOrg = process.env.SP_ORG_SLUG;
  const envKey = process.env.SP_API_KEY;
  const envPort = process.env.SP_UI_PORT;

  if (existsSync(CONFIG_PATH)) {
    try {
      const raw = readFileSync(CONFIG_PATH, "utf-8");
      _config = { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
    } catch (e) {
      console.warn("[Bridge] Failed to parse config.json, using defaults:", e);
      _config = { ...DEFAULT_CONFIG };
    }
  }

  if (envCloud) _config.cloudUrl = envCloud;
  if (envOrg) _config.orgSlug = envOrg;
  if (envKey) _config.apiKey = envKey;
  if (envPort) _config.uiPort = parseInt(envPort, 10);

  return _config;
}

export function getConfig(): BridgeConfig {
  return _config;
}

export function saveConfig(config: BridgeConfig): void {
  _config = config;
  try {
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
  } catch (e) {
    console.error("[Bridge] Failed to save config.json:", e);
  }
}
