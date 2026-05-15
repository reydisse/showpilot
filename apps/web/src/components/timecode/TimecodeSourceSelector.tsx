import { useState, useEffect } from "react";
import { Play, Square, Radio, Usb, AlertTriangle } from "lucide-react";
import { MtcSource } from "@/lib/timecode-sources/mtc-source";
import type { TimecodeFormat, FrameRate, DropFrameMode } from "@/types/timecode";

interface TimecodeSourceSelectorProps {
  isMaster: boolean;
  running: boolean;
  format: TimecodeFormat;
  mtcSupported: boolean;
  onStartFreerun: (offsetMs?: number) => void;
  onStopGenerator: () => void;
  onStartMtc: (inputId: string) => Promise<void>;
  onSetFormat: (format: TimecodeFormat) => void;
}

export function TimecodeSourceSelector({
  isMaster,
  running,
  format,
  mtcSupported,
  onStartFreerun,
  onStopGenerator,
  onStartMtc,
  onSetFormat,
}: TimecodeSourceSelectorProps) {
  const [midiInputs, setMidiInputs] = useState<MIDIInput[]>([]);
  const [selectedMidi, setSelectedMidi] = useState("");
  const [loadingMidi, setLoadingMidi] = useState(false);

  useEffect(() => {
    if (mtcSupported) {
      MtcSource.getInputs().then(setMidiInputs).catch(() => {});
    }
  }, [mtcSupported]);

  async function refreshMidi() {
    setLoadingMidi(true);
    try {
      const inputs = await MtcSource.getInputs();
      setMidiInputs(inputs);
    } catch {
      // Ignore
    }
    setLoadingMidi(false);
  }

  return (
    <div className="rounded-xl border border-board-border bg-board-card p-4 space-y-4">
      <h3 className="text-xs font-medium text-board-muted uppercase tracking-wider">
        Timecode Source
      </h3>

      {/* Frame rate selector */}
      <div className="flex items-center gap-2">
        <label className="text-xs text-board-muted w-20">Frame Rate</label>
        <select
          value={`${format.frameRate}-${format.dropFrame}`}
          onChange={(e) => {
            const [fr, df] = e.target.value.split("-");
            onSetFormat({
              frameRate: parseFloat(fr) as FrameRate,
              dropFrame: df as DropFrameMode,
            });
          }}
          className="rounded-lg border border-board-border bg-board-bg px-3 py-1.5 text-sm text-board-text"
        >
          <option value="24-ndf">24 fps</option>
          <option value="25-ndf">25 fps</option>
          <option value="29.97-df">29.97 fps DF</option>
          <option value="29.97-ndf">29.97 fps NDF</option>
          <option value="30-ndf">30 fps</option>
        </select>
      </div>

      {/* Source controls */}
      <div className="flex flex-col gap-2">
        {/* Internal freerun */}
        {!running || !isMaster ? (
          <button
            onClick={() => onStartFreerun(0)}
            className="flex items-center gap-2 rounded-lg bg-fire-500/10 border border-fire-500/20 px-4 py-2.5 text-sm font-medium text-fire-500 hover:bg-fire-500/20 transition-colors"
          >
            <Play className="w-4 h-4" />
            Start Internal Generator
          </button>
        ) : (
          <button
            onClick={onStopGenerator}
            className="flex items-center gap-2 rounded-lg bg-red-500/10 border border-red-500/20 px-4 py-2.5 text-sm font-medium text-red-400 hover:bg-red-500/20 transition-colors"
          >
            <Square className="w-4 h-4" />
            Stop Generator
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
                onClick={refreshMidi}
                disabled={loadingMidi}
                className="text-[10px] text-fire-500 hover:underline disabled:opacity-50"
              >
                {loadingMidi ? "Scanning..." : "Refresh"}
              </button>
            </div>
            {midiInputs.length > 0 ? (
              <div className="flex items-center gap-2">
                <select
                  value={selectedMidi}
                  onChange={(e) => setSelectedMidi(e.target.value)}
                  className="flex-1 rounded-lg border border-board-border bg-board-card px-2 py-1.5 text-xs text-board-text"
                >
                  <option value="">Select MIDI input...</option>
                  {midiInputs.map((input) => (
                    <option key={input.id} value={input.id}>
                      {input.name || input.id}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => selectedMidi && onStartMtc(selectedMidi)}
                  disabled={!selectedMidi}
                  className="rounded-lg bg-fire-500/10 border border-fire-500/20 px-3 py-1.5 text-xs font-medium text-fire-500 hover:bg-fire-500/20 disabled:opacity-40 transition-colors"
                >
                  Start MTC
                </button>
              </div>
            ) : (
              <p className="text-[10px] text-board-muted/60">
                No MIDI inputs found. Connect a MIDI device and click Refresh.
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
    </div>
  );
}
