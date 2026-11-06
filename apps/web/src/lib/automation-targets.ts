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
    const { moduleRegistry } = await import("./device-modules/registry");
    const { maskDeviceSettings } = await import("./device-settings.server");
    const rows = await env.DB.prepare("SELECT id, name, category, adapterType, settings FROM device WHERE orgId=? AND enabled=1 ORDER BY name, id")
      .bind(data.orgId).all<{ id: string; name: string; category: string; adapterType: string; settings: string }>();
    return rows.results.flatMap(device => {
      const settings = z.record(z.string(), z.unknown()).parse(JSON.parse(maskDeviceSettings({ ...device, orgId: data.orgId })));
      const actions = (moduleRegistry.get(device.adapterType)?.remoteControl?.actions(settings) ?? []).map(action => ({
        ...action, params: action.params.map(({ default: value, ...field }) => {
          if (value === undefined) return field;
          if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") throw new Error(`Unsupported default for ${action.label}: ${field.label}`);
          return { ...field, default: value };
        }),
      }));
      return actions.length ? [{ id: device.id, label: device.name, category: device.category, actions }] : [];
    });
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
