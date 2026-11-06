import { useEffect, useRef, useState } from "react";
import { Radio } from "lucide-react";
import {
  getBridgeConfig, getLtcStatus, getMtcStatus, listAudioInputs, listMidiInputs,
  LTC_RATES, startLtcInput, startMtcInput, stopLtcInput, stopMtcInput,
  type AudioInputInfo, type LtcInputConfig, type LtcStatus, type MidiInputInfo, type MtcStatus,
} from "./desktop";

const emptyLtc: LtcStatus = {
  selected: null, connected: false, locked: false, timecode: null,
  lastFrameAgeMs: null, level: 0, sampleRate: null, error: null,
};
const emptyInput: LtcInputConfig = { deviceId: "", deviceName: "", channel: 1, rate: "30-ndf" };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function TimecodeInputs({ bridgeRunning }: { bridgeRunning: boolean }) {
  const [midiInputs, setMidiInputs] = useState<MidiInputInfo[]>([]);
  const [audioInputs, setAudioInputs] = useState<AudioInputInfo[]>([]);
  const [midiInput, setMidiInput] = useState("");
  const [audioInput, setAudioInput] = useState<LtcInputConfig>(emptyInput);
  const [mtc, setMtc] = useState<MtcStatus>({ connected: false, inputName: null, timecode: null });
  const [ltc, setLtc] = useState(emptyLtc);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [refreshError, setRefreshError] = useState("");
  const epoch = useRef(0);
  const active = useRef(true);
  const edited = useRef(false);
  const inFlight = useRef(false);
  const refreshing = useRef<Promise<void> | null>(null);

  async function refresh() {
    while (refreshing.current) await refreshing.current;
    if (!active.current) return;
    let finished: () => void = () => {};
    refreshing.current = new Promise(resolve => { finished = resolve; });
    const version = epoch.current;
    try {
      const results = await Promise.allSettled([
        getMtcStatus(), getLtcStatus(), listMidiInputs(), listAudioInputs(),
      ]);
      if (version !== epoch.current) return;
      const [midi, audio, midiPorts, audioPorts] = results;
      if (midi.status === "fulfilled") setMtc(midi.value);
      else setMtc(current => ({ ...current, connected: false }));
      if (audio.status === "fulfilled") setLtc(audio.value);
      else setLtc(current => ({ ...current, connected: false, locked: false, level: 0 }));
      if (midiPorts.status === "fulfilled") setMidiInputs(midiPorts.value);
      if (audioPorts.status === "fulfilled") setAudioInputs(audioPorts.value);
      const errors = results.flatMap(result => result.status === "rejected" ? [message(result.reason)] : []);
      setRefreshError(errors.length ? `Cannot refresh timecode inputs: ${errors.join("; ")}` : "");
    } catch (reason) {
      if (version === epoch.current) {
        setRefreshError(`Cannot refresh timecode inputs: ${message(reason)}`);
        setMtc(current => ({ ...current, connected: false }));
        setLtc(current => ({ ...current, connected: false, locked: false, level: 0 }));
      }
    } finally { refreshing.current = null; finished(); }
  }

  useEffect(() => {
    active.current = true;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const version = epoch.current;
    void getBridgeConfig().then(saved => {
      if (disposed || edited.current || version !== epoch.current || !saved) return;
      setMidiInput(saved.midiInputName ?? "");
      setAudioInput(saved.ltcInput ?? emptyInput);
    }).catch(reason => { if (!disposed) setError(message(reason)); });
    async function poll() {
      await refresh();
      if (!disposed) timer = setTimeout(() => void poll(), 2000);
    }
    void poll();
    return () => { disposed = true; active.current = false; epoch.current++; clearTimeout(timer); };
  }, []);

  async function run(label: string, operation?: () => Promise<unknown>) {
    if (inFlight.current) return;
    inFlight.current = true;
    const version = ++epoch.current;
    setPending(label); setError("");
    try {
      await operation?.();
      if (version === epoch.current) await refresh();
    } catch (reason) {
      if (version === epoch.current) setError(message(reason));
    } finally {
      inFlight.current = false;
      if (version === epoch.current) setPending(null);
    }
  }

  const audioDevice = audioInputs.find(input => input.id === audioInput.deviceId);
  const validChannel = Number.isInteger(audioInput.channel) && audioInput.channel >= 1
    && audioInput.channel <= (audioDevice?.channels ?? 32);
  const busy = pending !== null;
  const ltcLabel = !ltc.selected ? "LTC stopped" : !ltc.connected ? "Audio input unavailable"
    : ltc.locked ? "LTC locked" : "Waiting for LTC";

  return <section className="card timecode-inputs" aria-labelledby="timecode-input-heading">
    <div className="card-title"><Radio /><div><h1 id="timecode-input-heading">Timecode input</h1>
      <p>Choose MIDI timecode or an audio channel carrying LTC. One input feeds the clock at a time.</p>
    </div></div>
    {!bridgeRunning && <p className="input-hint">Start the Bridge before connecting a timecode input.</p>}

    <fieldset disabled={busy}>
      <legend>MIDI timecode (MTC)</legend>
      <label>MIDI input<select value={midiInput} onChange={event => { edited.current = true; setMidiInput(event.target.value); }}>
        <option value="">Choose a MIDI input</option>
        {midiInput && !midiInputs.some(input => input.id === midiInput) && <option value={midiInput}>{midiInput} · unavailable</option>}
        {midiInputs.map(input => <option key={input.id} value={input.id}>{input.name}</option>)}
      </select></label>
      <div className="mtc-row"><div><strong>{mtc.connected ? "MTC connected" : mtc.inputName ? "Waiting for MIDI input" : "MTC stopped"}</strong><small>{mtc.timecode ?? "—"}</small></div>
        <div className="mtc-actions">
          <button className="primary" type="button" disabled={!midiInput || !bridgeRunning}
            onClick={() => void run("Connecting MTC…", () => startMtcInput(midiInput))}>{ltc.selected ? "Switch to MTC" : "Connect MTC"}</button>
          {mtc.inputName && <button className="secondary" type="button" onClick={() => void run("Stopping MTC…", stopMtcInput)}>Stop MTC</button>}
        </div>
      </div>
      <p className="input-hint">MTC carries position. MIDI Clock alone does not carry a timecode label.</p>
    </fieldset>

    <fieldset disabled={busy}>
      <legend>Audio timecode (LTC)</legend>
      <label>Audio input<select value={audioInput.deviceId} onChange={event => {
        edited.current = true;
        const selected = audioInputs.find(input => input.id === event.target.value);
        setAudioInput(current => ({ ...current, deviceId: selected?.id ?? "", deviceName: selected?.name ?? "", channel: 1 }));
      }}>
        <option value="">Choose an audio input</option>
        {audioInput.deviceId && !audioDevice && <option value={audioInput.deviceId}>{audioInput.deviceName} · unavailable</option>}
        {audioInputs.map(input => <option key={input.id} value={input.id}>{input.name}</option>)}
      </select></label>
      <div className="two-fields">
        <label>Audio channel<input type="number" min={1} max={audioDevice?.channels ?? 32} step={1} value={Number.isFinite(audioInput.channel) ? audioInput.channel : ""}
          onChange={event => { edited.current = true; setAudioInput(current => ({ ...current, channel: event.target.valueAsNumber })); }} /></label>
        <label>LTC frame rate<select value={audioInput.rate} onChange={event => {
          edited.current = true;
          const rate = LTC_RATES.find(rate => rate.value === event.target.value);
          if (rate) setAudioInput(current => ({ ...current, rate: rate.value }));
        }}>{LTC_RATES.map(rate => <option key={rate.value} value={rate.value}>{rate.label}</option>)}</select></label>
      </div>
      <p className="input-hint">Match the source frame rate exactly. Allow microphone access when prompted. Audio stays on this computer.</p>
      <div className="ltc-signal" aria-label="LTC signal">
        <strong role="status">{ltcLabel}</strong>
        <output aria-label="Decoded LTC">{ltc.timecode ?? "—"}</output>
        <label>Input level<meter min={0} max={1} value={ltc.level} aria-label="LTC input level" /></label>
        <small>{ltc.lastFrameAgeMs === null ? "No valid frame received" : `Last valid frame ${(ltc.lastFrameAgeMs / 1000).toFixed(1)}s ago`}
          {ltc.sampleRate ? ` · ${ltc.sampleRate / 1000} kHz` : ""}</small>
      </div>
      {ltc.error && <p className="error" role="alert">{ltc.error}</p>}
      <div className="mtc-actions">
        <button className="primary" type="button" disabled={!audioDevice || !validChannel || !bridgeRunning}
          onClick={() => void run("Connecting LTC…", () => startLtcInput(audioInput))}>{mtc.inputName ? "Switch to LTC" : "Connect LTC"}</button>
        {ltc.selected && <button className="secondary" type="button" onClick={() => void run("Stopping LTC…", stopLtcInput)}>Stop LTC</button>}
      </div>
    </fieldset>
    <button className="secondary input-rescan" type="button" disabled={busy} onClick={() => void run("Refreshing inputs…")}>Rescan inputs</button>
    {pending && <p role="status" className="input-hint">{pending}</p>}
    {error && <p className="error" role="alert">{error}</p>}
    {refreshError && <p className="error" role="alert">{refreshError}</p>}
  </section>;
}
