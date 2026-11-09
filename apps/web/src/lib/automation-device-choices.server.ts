import { z } from "zod";
import type { MobileApiDatabase } from "./mobile-api.server";
import type { AutomationDeviceTarget } from "./automation-catalog";

/** Callers authorize both timecode and device access before reading. */
export async function readAutomationDeviceChoices(db: MobileApiDatabase, orgId: string): Promise<AutomationDeviceTarget[]> {
    const { moduleRegistry } = await import("./device-modules/registry");
    const { maskDeviceSettings } = await import("./device-settings.server");
    const rows = await db.prepare("SELECT id, name, category, adapterType, settings FROM device WHERE orgId=? AND enabled=1 ORDER BY name, id")
      .bind(orgId).all<{ id: string; name: string; category: string; adapterType: string; settings: string }>();
    return (rows.results ?? []).flatMap<import("./automation-catalog").AutomationDeviceTarget>(device => {
      if (device.adapterType === "homeassistant") return [{ id: device.id, label: device.name, category: device.category, actionSource: "homeassistant" }];
      const settings = z.record(z.string(), z.unknown()).parse(JSON.parse(maskDeviceSettings({ ...device, orgId: orgId })));
      const actions = (moduleRegistry.get(device.adapterType)?.remoteControl?.actions(settings) ?? []).map(action => ({
        ...action, params: action.params.map(({ default: value, ...field }) => {
          if (value === undefined) return field;
          if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") throw new Error(`Unsupported default for ${action.label}: ${field.label}`);
          return { ...field, default: value };
        }),
      }));
      return actions.length ? [{ id: device.id, label: device.name, category: device.category, actionSource: "static", actions }] : [];
    });
}
