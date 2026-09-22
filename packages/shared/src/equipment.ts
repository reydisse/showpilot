export const EQUIPMENT_CATEGORIES = [
  "audio",
  "video",
  "lighting",
  "streaming",
  "network",
  "power",
  "cables",
  "comms",
  "other",
] as const;

export type EquipmentCategory = (typeof EQUIPMENT_CATEGORIES)[number];

export const EQUIPMENT_STATUSES = [
  "operational",
  "maintenance",
  "needs-repair",
  "in-repair",
  "broken",
  "out-of-service",
  "retired",
] as const;

export type EquipmentStatus = (typeof EQUIPMENT_STATUSES)[number];

export const EQUIPMENT_CATEGORY_LABELS: Record<EquipmentCategory, string> = {
  audio: "Audio",
  video: "Video",
  lighting: "Lighting",
  streaming: "Streaming",
  network: "Network",
  power: "Power",
  cables: "Cables",
  comms: "Comms",
  other: "Other",
};

export const EQUIPMENT_STATUS_LABELS: Record<EquipmentStatus, string> = {
  operational: "Operational",
  maintenance: "Maintenance",
  "needs-repair": "Needs repair",
  "in-repair": "In repair",
  broken: "Broken",
  "out-of-service": "Out of service",
  retired: "Retired",
};

export function isEquipmentCategory(value: string): value is EquipmentCategory {
  return (EQUIPMENT_CATEGORIES as readonly string[]).includes(value);
}

export function isEquipmentStatus(value: string): value is EquipmentStatus {
  return (EQUIPMENT_STATUSES as readonly string[]).includes(value);
}

export function equipmentCategoryLabel(value: string): string {
  return isEquipmentCategory(value)
    ? EQUIPMENT_CATEGORY_LABELS[value]
    : `Unknown (${value})`;
}

export function equipmentStatusLabel(value: string): string {
  return isEquipmentStatus(value)
    ? EQUIPMENT_STATUS_LABELS[value]
    : `Unknown (${value})`;
}
