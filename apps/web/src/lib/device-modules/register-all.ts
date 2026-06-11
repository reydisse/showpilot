/**
 * Register all device modules with the global registry.
 * Import this file once at app startup.
 */
import { moduleRegistry } from "./registry";

// ── Hand-coded modules (complex bidirectional protocols) ──
import { obsModuleDefinition } from "./obs/obs-module";
import { vmixModuleDefinition } from "./vmix/vmix-module";
import { oscMixerDefinition } from "./osc-mixer/osc-mixer-module";
import { atemModuleDefinition } from "./atem/atem-module";
import { dmxSacnDefinition, dmxArtnetDefinition } from "./dmx/dmx-module";
import { homeAssistantModuleDefinition } from "./homeassistant/homeassistant-module";

moduleRegistry.register(obsModuleDefinition);
moduleRegistry.register(vmixModuleDefinition);
moduleRegistry.register(oscMixerDefinition);
moduleRegistry.register(atemModuleDefinition);
moduleRegistry.register(dmxSacnDefinition);
moduleRegistry.register(dmxArtnetDefinition);
moduleRegistry.register(homeAssistantModuleDefinition);

// ── Protocol drivers ──────────────────────────────────────
import "./protocols/register-protocols";

// ── JSON device profiles ──────────────────────────────────
import { registerProfiles } from "./profiles/profile-registry";

// Import profiles as JSON modules
import epsonProfile from "./device-profiles/projectors/epson-eb-l1755u.json";
import panasonicProfile from "./device-profiles/projectors/panasonic-pt-rz690.json";
import ptzOpticsProfile from "./device-profiles/cameras/ptzoptics-move-4k.json";
import extronProfile from "./device-profiles/switchers/extron-dxp-crosspoint.json";
import samsungProfile from "./device-profiles/displays/samsung-smart-signage.json";

import type { DeviceProfile } from "./profiles/types";

registerProfiles(
  [
    epsonProfile,
    panasonicProfile,
    ptzOpticsProfile,
    extronProfile,
    samsungProfile,
  ] as DeviceProfile[],
  moduleRegistry
);
