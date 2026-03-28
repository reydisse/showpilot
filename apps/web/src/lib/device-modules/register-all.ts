/**
 * Register all device modules with the global registry.
 * Import this file once at app startup to make all modules available.
 */
import { moduleRegistry } from "./registry";

// Browser-direct modules
import { obsModuleDefinition } from "./obs/obs-module";
import { vmixModuleDefinition } from "./vmix/vmix-module";

// Bridge-required modules
import { oscMixerDefinition } from "./osc-mixer/osc-mixer-module";
import { atemModuleDefinition } from "./atem/atem-module";
import { dmxSacnDefinition, dmxArtnetDefinition } from "./dmx/dmx-module";

moduleRegistry.register(obsModuleDefinition);
moduleRegistry.register(vmixModuleDefinition);
moduleRegistry.register(oscMixerDefinition);
moduleRegistry.register(atemModuleDefinition);
moduleRegistry.register(dmxSacnDefinition);
moduleRegistry.register(dmxArtnetDefinition);
