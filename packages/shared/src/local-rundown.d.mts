import type { RundownTimer, RundownTimingItem, RundownTransportCommand, UpdatedRundownItem } from './rundown-transport.mjs';
export interface LocalRundownJournal {
  version:1;
  sessionId:string;
  orgId:string;
  showId:string;
  serviceDate:string;
  baseRevision:number;
  startedAt:number;
  endedAt:number;
  operations:Array<{at:number;command:RundownTransportCommand}>;
}
export declare function parseLocalRundownJournal(value:unknown,now:number):LocalRundownJournal|null;
export declare function reconcileLocalRundown<T extends RundownTimingItem>(
  state:{items:readonly T[];timer:RundownTimer},
  target:{orgId:string;showId:string;serviceDate:string;revision:number},
  journal:LocalRundownJournal,
):{ok:true;state:{items:UpdatedRundownItem<T>[];timer:RundownTimer};sessionId:string}|{ok:false;reason:'wrong-show'|'revision-conflict'|'invalid-command'};
