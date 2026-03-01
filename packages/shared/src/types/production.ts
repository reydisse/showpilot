export type ChecklistCategory =
  | "audio"
  | "video"
  | "stream"
  | "lighting"
  | "general";

export interface ChecklistTemplate {
  id: string;
  label: string;
  category: ChecklistCategory;
  sortOrder: number;
  createdAt: string;
}

export interface ChecklistEntry {
  id: string;
  templateId: string;
  serviceDate: string;
  checked: boolean;
  checkedBy: string | null;
  checkedAt: string | null;
}

export interface CueSheet {
  id: string;
  cueNumber: number;
  rundownItem: string;
  cameraAssignments: string;
  notes: string;
  serviceDate: string;
  createdAt: string;
  updatedAt: string;
}

export type IncidentCategory =
  | "audio"
  | "video"
  | "stream"
  | "lighting"
  | "other";
export type IncidentSeverity = "low" | "medium" | "high";

export interface Incident {
  id: string;
  category: IncidentCategory;
  severity: IncidentSeverity;
  description: string;
  reportedBy: string;
  serviceDate: string;
  timestamp: string;
}

export type MicType =
  | "wireless-handheld"
  | "wireless-lav"
  | "wired"
  | "headset"
  | "di-box"
  | "other";
export type MicGroup = "vocals" | "band" | "playback" | "sfx" | "other";

export interface MicAssignment {
  id: string;
  channel: number;
  label: string;
  micType: MicType;
  micModel: string;
  notes: string;
  gainDb: number | null;
  phantom: boolean;
  muted: boolean;
  group: MicGroup;
  mixerConsole: string;
  mixerChannel: number | null;
  mixerChannelType: string;
  serviceDate: string;
  createdAt: string;
  updatedAt: string;
}

export type EquipmentStatus =
  | "operational"
  | "needs-repair"
  | "out-of-service"
  | "in-repair";
export type EquipmentCategory =
  | "audio"
  | "video"
  | "lighting"
  | "streaming"
  | "comms"
  | "other";

export interface Equipment {
  id: string;
  name: string;
  category: EquipmentCategory;
  status: EquipmentStatus;
  location: string;
  serialNumber: string;
  notes: string;
  lastServiced: string | null;
  nextService: string | null;
  createdAt: string;
  updatedAt: string;
}
