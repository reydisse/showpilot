import type { BridgeDeviceProtocol, ModuleDefinition } from "../types";
import type { ProtocolDriverFactory } from "../protocols/protocol-driver";
import type { DeviceProfile } from "./types";
import { buildProfileCommand, parseProfileFeedback, ProfileDrivenModule } from "./profile-driven-module";
import type { ModuleRegistry } from "../registry";

// ─── Protocol Driver Registry ─────────────────────────────

const protocolDrivers = new Map<string, ProtocolDriverFactory>();

function remoteProtocol(protocol: string): BridgeDeviceProtocol | null {
  switch (protocol) {
    case "http-command":
    case "pjlink":
    case "tcp-command":
    case "visca-ip":
    case "wol":
      return protocol;
    default:
      return null;
  }
}

function remoteTarget(
  protocol: BridgeDeviceProtocol,
  settings: Record<string, unknown>,
): string | null {
  if (protocol === "wol") {
    const mac = typeof settings.mac === "string" ? settings.mac.trim() : "";
    return mac ? "wol" : null;
  }
  const host = typeof settings.host === "string" ? settings.host.trim() : "";
  if (!host) return null;
  const port = Number(settings.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  if (protocol === "http-command") {
    const basePath = typeof settings.basePath === "string" ? settings.basePath.trim() : "";
    return `http://${host}:${port}${basePath}`.replace(/\/+$/, "");
  }
  return `${host}:${port}`;
}

export function registerProtocol(
  protocolId: string,
  factory: ProtocolDriverFactory
): void {
  protocolDrivers.set(protocolId, factory);
}

export function getProtocol(
  protocolId: string
): ProtocolDriverFactory | undefined {
  return protocolDrivers.get(protocolId);
}

// ─── Profile → ModuleDefinition ───────────────────────────

export function profileToModuleDefinition(
  profile: DeviceProfile
): ModuleDefinition {
  const factory = protocolDrivers.get(profile.protocol);
  if (!factory) {
    throw new Error(
      `Unknown protocol "${profile.protocol}" in profile "${profile.id}"`
    );
  }

  // Get protocol metadata from a temporary instance
  const tempDriver = factory({});

  // Merge protocol base config fields with profile-specific fields
  const configFields = [
    ...tempDriver.baseConfigFields,
    ...(profile.configFields ?? []),
  ];
  const protocol = remoteProtocol(profile.protocol);
  const remoteControl = protocol ? {
    protocol,
    target(settings: Record<string, unknown>) {
      return remoteTarget(protocol, { ...profile.protocolDefaults, ...settings });
    },
    connectionSettings(settings: Record<string, unknown>) {
      const merged = { ...profile.protocolDefaults, ...settings };
      return protocol === "http-command"
        ? { authToken: typeof merged.authToken === "string" ? merged.authToken : "" }
        : merged;
    },
    actions: () => profile.actions,
    feedbacks: () => profile.feedbacks.map((feedback) => ({
      id: feedback.id,
      label: feedback.label,
      type: feedback.type,
      value: feedback.defaultValue,
    })),
    buildCommand: (actionId: string, params: Record<string, unknown>) => buildProfileCommand(profile, actionId, params),
    feedbackQueries: () => profile.feedbacks.flatMap((feedback) => feedback.mapping.pollCommand ? [{
      feedbackIds: [feedback.id],
      command: feedback.mapping.pollCommand,
      parse(response: string) {
        const value = parseProfileFeedback(response, feedback);
        return value === undefined ? {} : { [feedback.id]: value };
      },
    }] : []),
  } satisfies NonNullable<ModuleDefinition["remoteControl"]> : undefined;

  return {
    adapterType: `profile:${profile.id}`,
    displayName: `${profile.manufacturer} ${profile.model}`,
    category: profile.category,
    transport: tempDriver.transport,
    connectivity: tempDriver.connectivity,
    configFields,
    icon: profile.icon,
    description: profile.description,
    remoteControl,
    createInstance(settings: Record<string, unknown>) {
      const mergedSettings = { ...profile.protocolDefaults, ...settings };
      const driver = factory(mergedSettings);
      return new ProfileDrivenModule(profile, driver, mergedSettings);
    },
  };
}

// ─── Bulk Registration ────────────────────────────────────

export function registerProfiles(
  profiles: DeviceProfile[],
  registry: ModuleRegistry
): void {
  for (const profile of profiles) {
    try {
      const definition = profileToModuleDefinition(profile);
      registry.register(definition);
    } catch (err) {
      console.warn(
        `[device-profiles] Failed to register "${profile.id}":`,
        err instanceof Error ? err.message : err
      );
    }
  }
}
