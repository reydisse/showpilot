export interface OntimeEvent {
  id: string;
  type: "event";
  title: string;
  cue: string;
  timeStart: number; // ms from midnight
  timeEnd: number;
  duration: number;
  colour: string;
  note: string;
  skip: boolean;
}

export type Playback = "play" | "pause" | "armed" | "stop" | "roll";

export interface OntimeTimer {
  addedTime: number;
  current: number | null;
  duration: number | null;
  elapsed: number | null;
  playback: Playback;
  startedAt: number | null;
  expectedFinish: number | null;
  finishedAt: number | null;
}

export interface OntimeRuntimeState {
  timer: OntimeTimer;
  eventNow: OntimeEvent | null;
  eventNext: OntimeEvent | null;
  clock: number;
  events: OntimeEvent[];
  connected: boolean;
}
