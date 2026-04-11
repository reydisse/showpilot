import type {
  ModuleDefinition,
  DeviceCategory,
  ConnectivityMode,
} from "./types";

export interface ModuleRegistry {
  register(definition: ModuleDefinition): void;
  get(adapterType: string): ModuleDefinition | undefined;
  getAll(): ModuleDefinition[];
  getByCategory(category: DeviceCategory): ModuleDefinition[];
  getByConnectivity(mode: ConnectivityMode): ModuleDefinition[];
}

export function createModuleRegistry(): ModuleRegistry {
  const modules = new Map<string, ModuleDefinition>();

  return {
    register(definition: ModuleDefinition): void {
      modules.set(definition.adapterType, definition);
    },

    get(adapterType: string): ModuleDefinition | undefined {
      return modules.get(adapterType);
    },

    getAll(): ModuleDefinition[] {
      return [...modules.values()];
    },

    getByCategory(category: DeviceCategory): ModuleDefinition[] {
      return [...modules.values()].filter((d) => d.category === category);
    },

    getByConnectivity(mode: ConnectivityMode): ModuleDefinition[] {
      return [...modules.values()].filter((d) => d.connectivity === mode);
    },
  };
}

/** Global singleton registry */
export const moduleRegistry = createModuleRegistry();
