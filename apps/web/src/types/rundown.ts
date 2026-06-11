export type ItemType = "segment" | "song" | "prayer" | "announcement" | "offering" | "custom";
export type ItemStatus = "upcoming" | "live" | "complete";

export interface RundownItem {
  id: string;
  title: string;
  type: ItemType;
  duration: number; // ms
  notes: string;
  assignee: string;
  cue: string;
  status: ItemStatus;
  sortOrder: number;
  hardStop: boolean;
  lowerThirdId?: string;
  scheduledStart?: string | null; // ISO timestamp
  expectedEnd?: string | null;    // ISO timestamp
  actualStart?: string | null;    // ISO timestamp
  actualEnd?: string | null;      // ISO timestamp
}

export interface RundownMeta {
  serviceDate: string;
  scheduledStartTime?: string | null; // ISO timestamp
  status: "stopped" | "live" | "complete";
}

export interface NativeTimerState {
  playback: "stop" | "play" | "pause";
  currentItemId: string | null;
  elapsed: number;
  startedAt: number | null;
  pausedAt: number | null;
  mode: "count-up" | "count-down" | "clock";
  serverTime: number;
}

export interface RundownState {
  items: RundownItem[];
  timer: NativeTimerState;
  meta?: RundownMeta;
}
