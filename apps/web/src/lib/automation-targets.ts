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
