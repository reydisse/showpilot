import { describe, it, expect, beforeEach } from "vitest";
import {
  createModuleRegistry,
  type ModuleRegistry,
} from "../registry";
import type { ModuleDefinition, DeviceModule } from "../types";

function makeDummyDefinition(adapterType: string): ModuleDefinition {
  return {
    adapterType,
    displayName: `Test ${adapterType}`,
    category: "mixer",
    transport: "websocket",
    connectivity: "browser-direct",
    configFields: [{ key: "host", label: "Host" }],
    icon: "Monitor",
    description: `Test module for ${adapterType}`,
    createInstance: () => ({} as DeviceModule),
  };
}

describe("ModuleRegistry", () => {
  let registry: ModuleRegistry;

  beforeEach(() => {
    registry = createModuleRegistry();
  });

  it("starts empty", () => {
    expect(registry.getAll()).toEqual([]);
  });

  it("registers and retrieves a module definition", () => {
    const def = makeDummyDefinition("obs");
    registry.register(def);

    expect(registry.get("obs")).toBe(def);
  });

  it("returns undefined for unknown adapter type", () => {
    expect(registry.get("nonexistent")).toBeUndefined();
  });

  it("returns all registered modules", () => {
    registry.register(makeDummyDefinition("obs"));
    registry.register(makeDummyDefinition("vmix"));
    registry.register(makeDummyDefinition("atem"));

    const all = registry.getAll();
    expect(all).toHaveLength(3);
    expect(all.map((d) => d.adapterType)).toEqual(["obs", "vmix", "atem"]);
  });

  it("filters modules by category", () => {
    const obs = makeDummyDefinition("obs");
    obs.category = "streaming";
    const x32 = makeDummyDefinition("osc-mixer");
    x32.category = "mixer";

    registry.register(obs);
    registry.register(x32);

    expect(registry.getByCategory("mixer")).toHaveLength(1);
    expect(registry.getByCategory("mixer")[0].adapterType).toBe("osc-mixer");
    expect(registry.getByCategory("streaming")).toHaveLength(1);
  });

  it("filters modules by connectivity mode", () => {
    const obs = makeDummyDefinition("obs");
    obs.connectivity = "browser-direct";
    const x32 = makeDummyDefinition("osc-mixer");
    x32.connectivity = "bridge-required";

    registry.register(obs);
    registry.register(x32);

    expect(registry.getByConnectivity("browser-direct")).toHaveLength(1);
    expect(registry.getByConnectivity("bridge-required")).toHaveLength(1);
  });

  it("overwrites existing module with same adapter type", () => {
    registry.register(makeDummyDefinition("obs"));
    const updated = makeDummyDefinition("obs");
    updated.displayName = "OBS Updated";
    registry.register(updated);

    expect(registry.getAll()).toHaveLength(1);
    expect(registry.get("obs")?.displayName).toBe("OBS Updated");
  });
});
