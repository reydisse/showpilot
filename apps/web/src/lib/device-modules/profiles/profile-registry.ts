import type { ModuleDefinition } from "../types";
import type { ProtocolDriverFactory } from "../protocols/protocol-driver";
import type { DeviceProfile } from "./types";
import { ProfileDrivenModule } from "./profile-driven-module";
import type { ModuleRegistry } from "../registry";

// ─── Protocol Driver Registry ─────────────────────────────

const protocolDrivers = new Map<string, ProtocolDriverFactory>();

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

  return {
    adapterType: `profile:${profile.id}`,
    displayName: `${profile.manufacturer} ${profile.model}`,
    category: profile.category,
    transport: tempDriver.transport,
    connectivity: tempDriver.connectivity,
    configFields,
    icon: profile.icon,
    description: profile.description,
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
