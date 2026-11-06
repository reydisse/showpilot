export interface RundownTimingItem {
  id: string;
  type: string;
  status: 'upcoming' | 'live' | 'complete';
  actualStart?: string | null;
  actualEnd?: string | null;
}
export interface RundownTimer {
  playback: 'stop' | 'play' | 'pause';
  currentItemId: string | null;
  elapsed: number;
  startedAt: number | null;
  pausedAt: number | null;
  mode: 'count-up' | 'count-down' | 'clock';
}
export type RundownTransportCommand =
  | {type:'timer-start';itemId?:string}
  | {type:'timer-goto';itemId:string}
  | {type:'timer-resume'|'timer-pause'|'timer-stop'|'timer-next'|'timer-prev'}
  | {type:'timer-adjust';deltaMs:number}
  | {type:'timer-mode';mode:RundownTimer['mode']};
export declare function parseRundownTransport(action: unknown, payload?: unknown): RundownTransportCommand | null;
export type UpdatedRundownItem<T extends RundownTimingItem> = Omit<T, 'status' | 'actualStart' | 'actualEnd'> & Pick<RundownTimingItem, 'status' | 'actualStart' | 'actualEnd'>;
export declare function applyRundownTransport<T extends RundownTimingItem>(state:{items:readonly T[];timer:RundownTimer}, command:RundownTransportCommand, now:number):{items:UpdatedRundownItem<T>[];timer:RundownTimer}|null;
