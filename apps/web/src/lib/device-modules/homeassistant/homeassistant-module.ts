import { BaseDeviceModule } from "../base-module";
import { getSharedBridgeProxy } from "../bridge-proxy";
import type { ModuleAction, ModuleFeedback, ModuleDefinition } from "../types";

type ConnectionMode = "browser-direct" | "bridge-required";

interface HomeAssistantSettings {
  orgId?: string;
  baseUrl: string;
  accessToken: string;
  connectionMode?: ConnectionMode;
}

interface HomeAssistantEntity {
  entity_id: string;
  state: string;
  attributes?: Record<string, unknown>;
}

type HomeAssistantSettingsInput = Record<string, unknown>;

function parseHomeAssistantSettings(settings: HomeAssistantSettingsInput): HomeAssistantSettings {
  const baseUrl =
    typeof settings.baseUrl === "string" ? settings.baseUrl.trim() : "";
  const accessToken =
    typeof settings.accessToken === "string" ? settings.accessToken.trim() : "";
  const connectionMode = settings.connectionMode === "bridge-required" ? "bridge-required" : "browser-direct";
  const orgId =
    typeof settings.orgId === "string" && settings.orgId.trim().length > 0
      ? settings.orgId
      : undefined;

  return {
    orgId,
    baseUrl,
    accessToken,
    connectionMode,
  };
}

const SUPPORTED_DOMAINS = new Set(["script", "scene", "switch", "light", "input_button"]);

function toDisplayName(entity: HomeAssistantEntity) {
  const friendlyName = entity.attributes?.friendly_name;
  if (typeof friendlyName === "string" && friendlyName.trim()) {
    return friendlyName.trim();
  }
  return entity.entity_id;
}

function buildEntityActions(entity: HomeAssistantEntity): ModuleAction[] {
  const [domain] = entity.entity_id.split(".");
  const label = toDisplayName(entity);

  switch (domain) {
    case "script":
      return [{
        id: `ha:script.turn_on:${entity.entity_id}`,
        label,
        category: "scripts",
        params: [],
      }];
    case "scene":
      return [{
        id: `ha:scene.turn_on:${entity.entity_id}`,
        label,
        category: "scenes",
        params: [],
      }];
    case "input_button":
      return [{
        id: `ha:input_button.press:${entity.entity_id}`,
        label,
        category: "buttons",
        params: [],
      }];
    case "switch":
    case "light":
      return [
        {
          id: `ha:${domain}.turn_on:${entity.entity_id}`,
          label: `${label} On`,
          category: domain === "switch" ? "switches" : "lights",
          params: [],
        },
        {
          id: `ha:${domain}.turn_off:${entity.entity_id}`,
          label: `${label} Off`,
          category: domain === "switch" ? "switches" : "lights",
          params: [],
        },
        {
          id: `ha:${domain}.toggle:${entity.entity_id}`,
          label: `${label} Toggle`,
          category: domain === "switch" ? "switches" : "lights",
          params: [],
        },
      ];
    default:
      return [];
  }
}

export class HomeAssistantModule extends BaseDeviceModule {
  private orgId = "";
  private baseUrl: string;
  private accessToken: string;
  private connectionMode: ConnectionMode;
  private actions: ModuleAction[] = [];
  private feedbacks: ModuleFeedback[] = [
    { id: "discovered_entities", label: "Discovered Entities", type: "number", value: 0 },
    { id: "connection_mode", label: "Connection Mode", type: "string", value: "browser-direct" },
  ];

  constructor(settings: HomeAssistantSettings) {
    super();
    this.orgId = settings.orgId || "";
    this.baseUrl = settings.baseUrl.replace(/\/+$/, "");
    this.accessToken = settings.accessToken;
    this.connectionMode = settings.connectionMode === "bridge-required" ? "bridge-required" : "browser-direct";
    this.feedbacks[1].value = this.connectionMode;
  }

  protected async doConnect(): Promise<void> {
    const entities = await this.fetchEntities();
    this.actions = entities.flatMap(buildEntityActions);
    this.feedbacks[0].value = this.actions.length;
    this.emitFeedback("discovered_entities", this.actions.length);
    this.emitFeedback("connection_mode", this.connectionMode);
  }

  protected doDisconnect(): void {}

  getActions(): ModuleAction[] {
    return this.actions;
  }

  async executeAction(actionId: string): Promise<void> {
    if (this.connectionStatus() !== "connected") {
      throw new Error("Not connected");
    }

    const match = actionId.match(/^ha:([^:]+):([^:]+):(.+)$/);
    if (!match) throw new Error(`Unknown action: ${actionId}`);

    const [, domain, service, entityId] = match;
    const path = `/api/services/${domain}/${service}`;
    const body = { entity_id: entityId };

    await this.request("POST", path, body);
  }

  getFeedbacks(): ModuleFeedback[] {
    return this.feedbacks;
  }

  private async fetchEntities(): Promise<HomeAssistantEntity[]> {
    const response = await this.request("GET", "/api/states");
    if (!Array.isArray(response)) {
      throw new Error("Home Assistant returned invalid state list");
    }

    return (response as HomeAssistantEntity[]).filter((entity) => {
      const [domain] = entity.entity_id.split(".");
      return SUPPORTED_DOMAINS.has(domain);
    });
  }

  private async request(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    if (this.connectionMode === "bridge-required") {
      if (!this.orgId) throw new Error("Organization ID required for bridge mode");

      const proxy = getSharedBridgeProxy(this.orgId);
      if (!proxy.isBridgeOnline()) throw new Error("Bridge is offline");

      const target = this.baseUrl;
      proxy.connectDevice("http-command", target, {
        authToken: this.accessToken,
      });

      const command = body ? `${method} ${path} ${JSON.stringify(body)}` : `${method} ${path}`;
      const raw = await proxy.sendCommand("http-command", target, command);
      if (!raw) return null;
      return JSON.parse(raw);
    }

    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    if (!response.ok) {
      throw new Error(`Home Assistant request failed: ${response.status}`);
    }

    return await response.json();
  }
}

export const homeAssistantModuleDefinition: ModuleDefinition = {
  adapterType: "homeassistant",
  displayName: "Home Assistant",
  category: "automation",
  transport: "http",
  connectivity: "browser-direct",
  configFields: [
    {
      key: "connectionMode",
      label: "Connection Mode",
      type: "select",
      options: [
        { value: "browser-direct", label: "Browser Direct" },
        { value: "bridge-required", label: "Bridge Required" },
      ],
      required: true,
    },
    { key: "baseUrl", label: "Base URL", placeholder: "http://homeassistant.local:8123", required: true },
    { key: "accessToken", label: "Long-Lived Access Token", type: "password", required: true },
  ],
  icon: "Home",
  description: "Discover and trigger Home Assistant scripts, scenes, switches, lights, and input buttons.",
  createInstance: (settings: HomeAssistantSettingsInput) =>
    new HomeAssistantModule(parseHomeAssistantSettings(settings)),
};
