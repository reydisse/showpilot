import type { NativeTimerState, RundownItem } from "@/types/rundown";

export type RundownDisplayItem = Pick<
  RundownItem,
  "id" | "title" | "type" | "duration" | "status" | "sortOrder" | "hardStop"
>;

export interface RundownDisplaySlide {
  text: string;
  notes: string;
  presentationName: string;
  isScripture: boolean;
  updatedAt: number;
}

export interface RundownDisplayState {
  serviceDate?: string | null;
  showId?: string | null;
  initialized?: boolean;
  revision?: number;
  items: RundownDisplayItem[];
  timer: NativeTimerState;
  ppSlide?: RundownDisplaySlide | null;
  stageMessage?: string;
}

interface DisplaySource {
  items: RundownItem[];
  timer: Omit<NativeTimerState, "serverTime"> & { serverTime?: number };
  serviceDate?: string | null;
  showId?: string | null;
  initialized?: boolean;
  revision?: number;
  ppSlide?: RundownDisplaySlide | null;
  stageMessage?: string;
}

/** The only rundown fields approved for an intentionally public display. */
export function projectRundownDisplayState(source: DisplaySource): RundownDisplayState {
  return {
    ...(source.serviceDate === undefined ? {} : { serviceDate: source.serviceDate }),
    ...(source.showId === undefined ? {} : { showId: source.showId }),
    ...(source.initialized === undefined ? {} : { initialized: source.initialized }),
    ...(source.revision === undefined ? {} : { revision: source.revision }),
    items: source.items.map(({ id, title, type, duration, status, sortOrder, hardStop }) => ({
      id,
      title,
      type,
      duration,
      status,
      sortOrder,
      hardStop,
    })),
    timer: { ...source.timer, serverTime: Date.now() },
    ...(source.ppSlide === undefined ? {} : { ppSlide: source.ppSlide }),
    ...(source.stageMessage === undefined ? {} : { stageMessage: source.stageMessage }),
  };
}
