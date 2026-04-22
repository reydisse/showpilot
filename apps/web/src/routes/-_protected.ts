import { withPermission } from "@/middleware/withPermission";

// Representative examples showing the Workers RBAC middleware applied to
// different production areas. This file is intentionally prefixed with "-"
// so TanStack Router ignores it during route generation.

export const protectedShowView = withPermission("show:view", async () => {
  return Response.json({ ok: true, route: "show:view" });
});

export const protectedRundownEdit = withPermission("rundown:edit", async () => {
  return Response.json({ ok: true, route: "rundown:edit" });
});

export const protectedIncidentCreate = withPermission(
  ["incidents:report", "incidents:access"],
  async () => {
    return Response.json({ ok: true, route: "POST /incidents" });
  },
);

export const protectedDevices = withPermission("devices:access", async () => {
  return Response.json({ ok: true, route: "devices:access" });
});

export const protectedDangerZone = withPermission("settings:danger_zone", async () => {
  return Response.json({ ok: true, route: "settings:danger_zone" });
});
