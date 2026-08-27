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

export interface HomeAssistantEntity {
  entity_id: string;
  state: string;
  attributes?: Record<string, unknown>;
}

type HomeAssistantSettingsInput = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseHomeAssistantEntity(value: unknown): HomeAssistantEntity | null {
  if (!isRecord(value) || typeof value.entity_id !== "string" || typeof value.state !== "string") return null;
  return {
    entity_id: value.entity_id,
    state: value.state,
    attributes: isRecord(value.attributes) ? value.attributes : undefined,
  };
}

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

export function buildHomeAssistantActions(entities: HomeAssistantEntity[]): ModuleAction[] {
  return entities.flatMap(buildEntityActions);
}

function buildEntityActions(entity: HomeAssistantEntity): ModuleAction[] {
  const [domain] = entity.entity_id.split(".");
  const label = toDisplayName(entity);

  switch (domain) {
    case "script":
      return [{
        id: `ha:script:turn_on:${entity.entity_id}`,
        label,
        category: "scripts",
        params: [],
      }];
    case "scene":
      return [{
        id: `ha:scene:turn_on:${entity.entity_id}`,
        label,
        category: "scenes",
        params: [],
      }];
    case "input_button":
      return [{
        id: `ha:input_button:press:${entity.entity_id}`,
        label,
        category: "buttons",
        params: [],
      }];
    case "switch":
    case "light":
      return [
        {
          id: `ha:${domain}:turn_on:${entity.entity_id}`,
          label: `${label} On`,
          category: domain === "switch" ? "switches" : "lights",
          params: [],
        },
        {
          id: `ha:${domain}:turn_off:${entity.entity_id}`,
          label: `${label} Off`,
          category: domain === "switch" ? "switches" : "lights",
          params: [],
        },
        {
          id: `ha:${domain}:toggle:${entity.entity_id}`,
          label: `${label} Toggle`,
          category: domain === "switch" ? "switches" : "lights",
          params: [],
        },
      ];
    default:
      return [];
  }
}

export function parseHomeAssistantEntities(raw: string): HomeAssistantEntity[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((candidate) => {
    const entity = parseHomeAssistantEntity(candidate);
    return entity ? [entity] : [];
  });
}

export function buildHomeAssistantCommand(actionId: string): string {
  const match = actionId.match(/^ha:([^:]+):([^:]+):(.+)$/);
  if (!match) throw new Error("This Home Assistant action is not available.");
  const [, domain, service, entityId] = match;
  if (!SUPPORTED_DOMAINS.has(domain) || !/^[a-z0-9_]+\.[a-z0-9_]+$/.test(entityId)) {
    throw new Error("This Home Assistant entity is not valid.");
  }
  const allowedService = domain === "input_button"
    ? service === "press"
    : domain === "script" || domain === "scene"
      ? service === "turn_on"
      : service === "turn_on" || service === "turn_off" || service === "toggle";
  if (!allowedService) throw new Error("This Home Assistant service is not available.");
  return `POST /api/services/${domain}/${service} ${JSON.stringify({ entity_id: entityId })}`;
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
    this.actions = buildHomeAssistantActions(entities);
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
    if (!this.actions.some((action) => action.id === actionId)) {
      throw new Error("This Home Assistant action is no longer available.");
    }

    const match = actionId.match(/^ha:([^:]+):([^:]+):(.+)$/);
    if (!match) throw new Error("This Home Assistant action is not available.");

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

    return response.flatMap((candidate) => {
      const entity = parseHomeAssistantEntity(candidate);
      if (!entity) return [];
      const [domain] = entity.entity_id.split(".");
      return SUPPORTED_DOMAINS.has(domain) ? [entity] : [];
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

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      const origin = typeof window !== "undefined" ? window.location.origin : "the ShowPilot origin";
      throw new Error(`Home Assistant blocked or could not receive the browser request. Allow ${origin} in Home Assistant cors_allowed_origins, or use a connected bridge.`);
    }

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
  remoteControl: {
    protocol: "http-command",
    target(settings) {
      const baseUrl = typeof settings.baseUrl === "string" ? settings.baseUrl.trim().replace(/\/+$/, "") : "";
      return /^https?:\/\//i.test(baseUrl) ? baseUrl : null;
    },
    connectionSettings(settings) {
      return { authToken: typeof settings.accessToken === "string" ? settings.accessToken : "" };
    },
    actions: () => [],
    feedbacks(settings) {
      return [
        { id: "discovered_entities", label: "Discovered Entities", type: "number", value: 0 },
        { id: "connection_mode", label: "Connection Mode", type: "string", value: settings.connectionMode === "bridge-required" ? "bridge-required" : "browser-direct" },
      ];
    },
    buildCommand: (actionId) => buildHomeAssistantCommand(actionId),
    feedbackQueries: () => [{
      feedbackIds: ["discovered_entities"],
      command: "GET /api/states",
      parse(response) {
        return { discovered_entities: buildHomeAssistantActions(parseHomeAssistantEntities(response)).length };
      },
    }],
  },
  createInstance: (settings: HomeAssistantSettingsInput) =>
    new HomeAssistantModule(parseHomeAssistantSettings(settings)),
};
