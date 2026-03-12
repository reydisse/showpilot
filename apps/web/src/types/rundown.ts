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
}

export interface NativeTimerState {
  playback: "stop" | "play" | "pause";
  currentItemId: string | null;
  elapsed: number;
  startedAt: number | null;
  pausedAt: number | null;
  mode: "count-up" | "count-down";
  serverTime: number;
}

export interface RundownState {
  items: RundownItem[];
  timer: NativeTimerState;
}
