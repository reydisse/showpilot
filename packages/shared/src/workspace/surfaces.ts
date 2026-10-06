import { MODULE_IDS, type ModuleId } from "./types";
export const MODULE_SURFACES: Record<
  ModuleId,
  { web: readonly string[]; mobile: readonly string[] }
> = {
  show: {
    web: ["show"],
    mobile: ["live-show", "show", "shows"],
  },
  rundown: {
    web: ["rundown"],
    mobile: ["rundown"],
  },
  team: {
    web: ["team"],
    mobile: ["team-members", "team-crew", "team"],
  },
  schedule: {
    web: ["schedule"],
    mobile: ["schedule"],
  },
  board: {
    web: ["board", "checkin"],
    mobile: ["show-board", "checkin"],
  },
  chat: {
    web: ["chat"],
    mobile: ["chat"],
  },
  production: {
    web: [
      "production/cue-sheets",
      "production/checklist",
      "production/incidents",
      "production/incidents-history",
      "production/assets",
    ],
    mobile: [
      "cue-sheets",
      "checklist",
      "incidents",
      "incidents-history",
      "asset-inventory",
    ],
  },
  timecode: {
    web: ["timecode"],
    mobile: ["timecode"],
  },
  songs: {
    web: ["songs"],
    mobile: [],
  },
  streaming: {
    web: ["streaming/health", "streaming/platforms"],
    mobile: ["stream", "multi-platform"],
  },
  lower_thirds: {
    web: [
      "streaming/graphics",
      "streaming/lt-preview",
      "streaming/lower-thirds-disabled",
    ],
    mobile: ["lower-thirds"],
  },
  dashboards: {
    web: [
      "dashboard/prod-manager",
      "reports",
      "dashboard/tech-manager",
      "dashboard/audio",
      "dashboard/devices",
    ],
    mobile: [
      "prod-manager",
      "reports",
      "tech-manager",
      "audio",
      "devices",
      "device",
    ],
  },
};
export function moduleForSurface(
  platform: "web" | "mobile",
  path: string,
): ModuleId | null {
  const route = path.replace(/^\//, "").split(/[?#]/)[0];
  if (platform === "web" && route === "streaming/graphics/overlay") return null;
  return (
    MODULE_IDS.find((id) =>
      MODULE_SURFACES[id][platform].some(
        (surface) => route === surface || route.startsWith(`${surface}/`),
      ),
    ) ?? null
  );
}
