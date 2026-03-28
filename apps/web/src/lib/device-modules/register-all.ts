/**
 * Register all device modules with the global registry.
 * Import this file once at app startup to make all modules available.
 */
import { moduleRegistry } from "./registry";
import { obsModuleDefinition } from "./obs/obs-module";

moduleRegistry.register(obsModuleDefinition);
