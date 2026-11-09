import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { env } from "cloudflare:workers";
import { assertOrgPermission } from "./org-access";
import { idSchema, parseOrThrow } from "./validation";
import { actionsForMobileAdapter } from "./mobile-device-controls";

/** Names and IDs only. Device settings and credentials stay on the server. */
export const getBlackoutTargets = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema }), data))
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "timecode:access");
    await assertOrgPermission(data.orgId, "devices:access");
    const devices = await env.DB.prepare("SELECT id, name, adapterType FROM device WHERE orgId=? AND category='lighting' AND enabled=1 ORDER BY name, id")
      .bind(data.orgId).all<{ id: string; name: string; adapterType: string }>();
    return devices.results.filter(device => actionsForMobileAdapter(device.adapterType).some(action => action.id === "blackout"))
      .map(device => ({ id: device.id, label: device.name }));
  });


export const getAutomationDeviceTargets = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema }), data))
  .handler(async ({ data }): Promise<import("./automation-catalog").AutomationDeviceTarget[]> => {
    await assertOrgPermission(data.orgId, "timecode:access");
    await assertOrgPermission(data.orgId, "devices:access");
    const { readAutomationDeviceChoices } = await import("./automation-device-choices.server");
    return readAutomationDeviceChoices(env.DB, data.orgId);
  });

/** Timeline labels include disabled devices, without their configuration or credentials. */
export const getAutomationDeviceNames = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema }), data))
  .handler(async ({ data }): Promise<import("./automation-catalog").AutomationDeviceName[]> => {
    await assertOrgPermission(data.orgId, "timecode:access");
    await assertOrgPermission(data.orgId, "devices:access");
    const rows = await env.DB.prepare("SELECT id, name, enabled FROM device WHERE orgId=? ORDER BY name, id")
      .bind(data.orgId).all<{ id: string; name: string; enabled: number }>();
    return rows.results.map(device => ({ id: device.id, label: device.name, enabled: device.enabled === 1 }));
  });

/** Discover only the selected, already-connected Home Assistant device. */
export const getAutomationHomeAssistantActions = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema, deviceId: idSchema }), data))
  .handler(async ({ data }): Promise<import("./automation-catalog").AutomationDeviceAction[]> => {
    await assertOrgPermission(data.orgId, "timecode:access");
    const { user } = await assertOrgPermission(data.orgId, "devices:access");
    const device = await env.DB.prepare("SELECT id, adapterType, settings FROM device WHERE orgId=? AND id=? AND enabled=1")
      .bind(data.orgId, data.deviceId).first<{ id: string; adapterType: string; settings: string }>();
    if (!device || device.adapterType !== "homeassistant") throw new Error("Choose an enabled Home Assistant device in this workspace.");
    const { maskDeviceSettings } = await import("./device-settings.server");
    const { resolveRemoteDeviceControl } = await import("./mobile-device-controls");
    const settings = z.record(z.string(), z.unknown()).parse(JSON.parse(maskDeviceSettings({ ...device, orgId: data.orgId })));
    const remote = resolveRemoteDeviceControl(device.adapterType, settings);
    if (!remote) throw new Error("Configure this Home Assistant device's address in Devices before refreshing actions.");
    const { discoverHomeAssistantActions } = await import("./homeassistant-automation.server");
    const actions = await discoverHomeAssistantActions({ relay: env.BRIDGE_RELAY.getByName(data.orgId), target: remote.target,
      actor: { source: "operator", actorUserId: user.id }, assertCanDispatch: () => {} });
    await assertOrgPermission(data.orgId, "timecode:access");
    await assertOrgPermission(data.orgId, "devices:access");
    // Home Assistant actions carry no caller-defined parameters or credentials.
    return actions.map(action => ({ ...action, params: [] }));
  });
