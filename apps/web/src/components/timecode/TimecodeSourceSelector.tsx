import { useState, useEffect } from "react";
import { Play, Square, Radio, Usb, AlertTriangle } from "lucide-react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { sameTimecodeFormat, timecodeFormatLabel } from "@/lib/timecode";
import { findMidiInput, observeMidiInputs } from "@/lib/timecode-sources/midi-inputs";
import type { TimecodeFormat, FrameRate, DropFrameMode, TimecodeState } from "@/types/timecode";

interface TimecodeSourceSelectorProps {
  isMaster: boolean;
  connected: boolean;
  pending: "starting" | "stopping" | null;
  running: boolean;
  totalFrames?: number;
  signal?: TimecodeState["signal"];
  source?: TimecodeState["source"];
  format: TimecodeFormat;
  incomingFormat?: TimecodeState["incomingFormat"];
  mtcSupported: boolean;
  onStartFreerun: (offsetMs?: number) => void;
  onStopGenerator: () => void;
  onStartMtc: (inputId: string) => Promise<void>;
  onSetFormat: (format: TimecodeFormat, expectedFormat: TimecodeFormat, expectedIncomingFormatId?: string) => void;
}

export function TimecodeSourceSelector({
  isMaster,
  connected,
  pending,
  running,
  totalFrames = 0,
  signal,
  source,
  format,
  incomingFormat,
  mtcSupported,
  onStartFreerun,
  onStopGenerator,
  onStartMtc,
  onSetFormat,
}: TimecodeSourceSelectorProps) {
  const [reformat, setReformat] = useState<{ from: TimecodeFormat; to: TimecodeFormat; incomingId?: string } | null>(null);
  const reviewChanged = reformat && (!sameTimecodeFormat(reformat.from, format) || reformat.incomingId !== incomingFormat?.id);
  const [midiInputs, setMidiInputs] = useState<MIDIInput[]>([]);
  const [selectedMidi, setSelectedMidi] = useState<MIDIInput | null>(null);
  const availableMidi = selectedMidi ? findMidiInput(midiInputs, selectedMidi) : null;
  const [scanAttempt, setScanAttempt] = useState(0);
  const [loadingMidi, setLoadingMidi] = useState(false);
  const [midiError, setMidiError] = useState<string | null>(null);

  useEffect(() => {
    if (!mtcSupported) return;
    let disposed = false;
    let release: (() => void) | undefined;
    setLoadingMidi(true);
    setMidiError(null);
    navigator.requestMIDIAccess().then(access => {
      if (!disposed) release = observeMidiInputs(access, setMidiInputs);
    }).catch((cause: unknown) => {
      if (!disposed) {
        setMidiInputs([]);
        setMidiError(cause instanceof Error ? cause.message : "MIDI access was denied");
      }
    }).finally(() => { if (!disposed) setLoadingMidi(false); });
    return () => { disposed = true; release?.(); };
  }, [mtcSupported, scanAttempt]);

  return (
    <fieldset disabled={!connected || pending !== null} className="min-w-0 rounded-xl border border-board-border bg-board-card p-4 space-y-4 disabled:opacity-60">
      <h3 className="text-xs font-medium text-board-muted uppercase tracking-wider">
        Timecode Source
      </h3>
      {source === "mtc" && <MtcFrameAge lastFeedAt={signal?.lastFeedAt ?? null} />}
      {(signal?.status === "timecode-stalled" || signal?.status === "timecode-lost") && (
        <p role="alert" className="flex items-center gap-2 text-sm text-amber-400">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {source === "mtc" ? "MTC signal lost" : "Timecode signal lost"}. Clock held; automation paused.
        </p>
      )}

      {incomingFormat && <div className="space-y-2 rounded-lg border border-amber-500/40 p-3">
        <p role="alert" className="text-sm text-amber-200">Input reports {timecodeFormatLabel(incomingFormat.format)} for five consecutive readings. Clock held; confirm the timeline format before continuing.</p>
        <button type="button" className="min-h-11 rounded-lg border border-amber-500/40 px-3 text-sm text-amber-200"
          onClick={() => setReformat({ from: format, to: incomingFormat.format, incomingId: incomingFormat.id })}>Reformat timeline to {timecodeFormatLabel(incomingFormat.format)}</button>
      </div>}
      {signal?.status === "format-mismatch" && !incomingFormat && <p role="status" className="text-sm text-amber-200">Clock held while the input format stabilizes.</p>}
      {/* Frame rate selector */}
      <div className="flex items-center gap-2">
        <label htmlFor="timecode-frame-rate" className="text-xs text-board-muted w-20">Frame Rate</label>
        <select
          id="timecode-frame-rate"
          disabled={running || Boolean(incomingFormat)}
          value={`${format.frameRate}-${format.dropFrame}`}
          onChange={(e) => {
            const [fr, df] = e.target.value.split("-");
            setReformat({ from: format, to: { frameRate: parseFloat(fr) as FrameRate, dropFrame: df as DropFrameMode } });
          }}
          className="rounded-lg border border-board-border bg-board-bg px-3 py-1.5 text-sm text-board-text"
        >
          <option value="24-ndf">24 fps NDF</option>
          <option value="25-ndf">25 fps NDF</option>
          <option value="29.97-df">29.97 fps DF</option>
          <option value="29.97-ndf">29.97 fps NDF</option>
          <option value="30-ndf">30 fps NDF</option>
        </select>
      </div>

      {running && <p className="text-xs text-board-muted">Stop the clock before reformatting the timeline.</p>}
      <ConfirmDialog open={reformat !== null} onOpenChange={open => { if (!open) setReformat(null); }}
        title="Reformat timeline?" confirmLabel="Reformat timeline" variant="warning"
        description={reviewChanged ? "The input or timeline format changed. Close this dialog and review the latest format."
          : `Change ${reformat ? timecodeFormatLabel(reformat.from) : ""} to ${reformat ? timecodeFormatLabel(reformat.to) : ""}? Cue timecodes stay unchanged and fired cues stay fired. The held clock frame adjusts if needed. Automation remains disabled until you enable it.`}
        confirmDisabled={!connected || running || pending !== null || Boolean(reviewChanged)}
        onConfirm={() => { if (reformat && !running && connected && !reviewChanged) onSetFormat(reformat.to, reformat.from, reformat.incomingId); }} />
      {/* Source controls */}
      <div className="flex flex-col gap-2">
        {/* Internal freerun */}
        {!isMaster ? (
          <button
            onClick={() => onStartFreerun()}
            className="flex items-center gap-2 rounded-lg bg-fire-500/10 border border-fire-500/20 px-4 py-2.5 text-sm font-medium text-fire-500 hover:bg-fire-500/20 transition-colors"
          >
            <Play className="w-4 h-4" />
            {pending === "starting" ? "Starting…" : pending === "stopping" ? "Stopping…" : totalFrames > 0 ? "Resume Internal Generator" : "Start Internal Generator"}
          </button>
        ) : (
          <button
            onClick={onStopGenerator}
            className="flex items-center gap-2 rounded-lg bg-red-500/10 border border-red-500/20 px-4 py-2.5 text-sm font-medium text-red-400 hover:bg-red-500/20 transition-colors"
          >
            <Square className="w-4 h-4" />
            {pending === "stopping" ? "Stopping…" : "Stop Generator"}
          </button>
        )}

        {/* MTC source */}
        {mtcSupported ? (
          <div className="rounded-lg border border-board-border bg-board-bg p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-board-muted flex items-center gap-1.5">
                <Usb className="w-3 h-3" />
                MIDI Timecode (MTC)
              </span>
              <button
                onClick={() => setScanAttempt(attempt => attempt + 1)}
                disabled={loadingMidi}
                className="min-h-11 px-2 text-xs text-fire-500 hover:underline disabled:opacity-50"
              >
                {loadingMidi ? "Scanning..." : "Refresh"}
              </button>
            </div>
            {midiInputs.length > 0 || selectedMidi ? (
              <div className="flex items-center gap-2">
                <select
                  aria-label="MIDI timecode input"
                  value={availableMidi?.id ?? selectedMidi?.id ?? ""}
                  onChange={(e) => setSelectedMidi(midiInputs.find(input => input.id === e.target.value) ?? null)}
                  className="min-w-0 min-h-11 flex-1 rounded-lg border border-board-border bg-board-card px-2 py-1.5 text-xs text-board-text"
                >
                  <option value="">Select MIDI input...</option>
                  {selectedMidi && !availableMidi && <option value={selectedMidi.id}>{selectedMidi.name || selectedMidi.id} (disconnected)</option>}
                  {midiInputs.map((input) => (
                    <option key={input.id} value={input.id}>
                      {input.name || input.id}
                    </option>
                  ))}
                </select>
                <button
                  onClick={async () => {
                    if (!availableMidi) return;
                    setMidiError(null);
                    try {
                      await onStartMtc(availableMidi.id);
                    } catch (cause) {
                      setMidiError(cause instanceof Error ? cause.message : "Could not start this MIDI input");
                    }
                  }}
                  disabled={!availableMidi}
                  className="min-h-11 rounded-lg bg-fire-500/10 border border-fire-500/20 px-3 py-1.5 text-xs font-medium text-fire-500 hover:bg-fire-500/20 disabled:opacity-40 transition-colors"
                >
                  Start MTC
                </button>
              </div>
            ) : (
              <p className="text-xs text-board-muted">
                {loadingMidi ? "Checking MIDI inputs…" : "No MIDI inputs found. Connect a MIDI device; inputs refresh automatically."}
              </p>
            )}
            {midiError && (
              <p role="alert" className="text-xs leading-relaxed text-red-400">
                {midiError.replace(/[.!?]+$/, "")}. Check the browser&apos;s MIDI permission, then click Refresh.
              </p>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-2 rounded-lg border border-yellow-500/20 bg-yellow-500/5 px-3 py-2">
            <AlertTriangle className="w-3.5 h-3.5 text-yellow-500" />
            <span className="text-xs text-board-muted">
              MTC requires Chrome or Edge. Use internal generator on this browser.
            </span>
          </div>
        )}
      </div>

      {isMaster && running && (
        <div className="flex items-center gap-2 text-[10px] text-green-400">
          <Radio className="w-3 h-3 animate-pulse" />
          This client is the timecode master
        </div>
      )}
    </fieldset>
  );
}

function MtcFrameAge({ lastFeedAt }: { lastFeedAt: number | null }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  const seconds = lastFeedAt === null ? null : Math.max(0, Math.floor((now - lastFeedAt) / 1_000));
  return <p className="text-xs text-board-muted">{seconds === null ? "Waiting for an MTC frame" : `Last MTC frame received ${seconds}s ago`}</p>;
}
