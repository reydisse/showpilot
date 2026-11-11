import type { ConnectionStatus } from "@/lib/connection-state";
import { useState } from "react";
import { Pause, Play, Square, TimerReset } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { InternalGeneratorStart } from "./InternalGeneratorStart";
import { TimecodeDisplay } from "./TimecodeDisplay";
import type { TimecodeState } from "@/types/timecode";
import type { TimecodeStartPosition } from "@/lib/timecode-start";

export function TimecodeTransport({ state, connectionStatus, canControl, isMaster, pending, onStart, onStop, onPause }: {
  state: TimecodeState | null;
  connectionStatus: ConnectionStatus;
  canControl: boolean;
  isMaster: boolean;
  pending: "starting" | "stopping" | null;
  onStart: (position?: TimecodeStartPosition) => void;
  onStop: () => void;
  onPause: () => void;
}) {
  const connected = connectionStatus === "connected";
  const [positionOpen, setPositionOpen] = useState(false);
  const enabled = connected && canControl && state !== null && pending === null;
  const paused = state?.signal?.status === "paused";
  const canChoosePosition = enabled && !state?.running && !paused && !state?.incomingFormat && Boolean(state?.showId);
  const buttonClass = "min-h-11 min-w-11 px-3 text-xs";
  return <div aria-label="Timecode transport" className="flex min-w-0 flex-wrap items-center gap-2">
    <TimecodeDisplay state={state} connectionStatus={connectionStatus} showState />
    {isMaster ? <>
      <Button type="button" variant="outline" className={`${buttonClass} text-red-300`} disabled={!enabled} onClick={onStop}>
        <Square />{pending === "stopping" ? "Stopping…" : "Stop Generator"}
      </Button>
      <Button type="button" variant="outline" className={buttonClass} disabled={!enabled} onClick={paused ? () => onStart() : onPause}>
        {paused ? <Play /> : <Pause />}{paused ? "Resume clock" : "Pause clock"}
      </Button>
    </> : <>
      <Button type="button" variant="outline" className={`${buttonClass} text-fire-500`} disabled={!enabled} onClick={() => onStart()}>
        <Play />{pending === "starting" ? "Starting…" : pending === "stopping" ? "Stopping…" : (state?.totalFrames ?? 0) > 0 ? "Resume Internal Generator" : "Start Internal Generator"}
      </Button>
      <Button type="button" variant="outline" className={buttonClass} disabled={!canChoosePosition} aria-label="Choose start position" title="Choose start position" onClick={() => setPositionOpen(true)}><TimerReset /></Button>
    </>}
    {!canControl && connected && <span className="text-xs text-amber-200">Controlled elsewhere</span>}
    <Dialog open={positionOpen} onOpenChange={setPositionOpen}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto border-board-border bg-board-bg text-board-text">
        <DialogTitle>Choose start position</DialogTitle>
        <DialogDescription>Review the held clock position before starting from a different timecode.</DialogDescription>
        {state && <InternalGeneratorStart clock={state} connected={connected && canControl} pending={pending} initialCustom onStart={position => { setPositionOpen(false); onStart(position); }} />}
      </DialogContent>
    </Dialog>
  </div>;
}
