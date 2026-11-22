import type React from "react";
import { useEffect, useRef, useState } from "react";
import { Ban, Check, CircleCheck, CircleHelp, Copy, Eye, EyeOff, Loader2, Radio, Unplug } from "lucide-react";

/**
 * Stream — A (Doop canvas aneicgaHqk, "Stream" page): status marks, copy fields and
 * the stream key reveal. Colours come from `.schedule-a`.
 */

export type InputStatus = "streaming" | "connecting" | "idle" | "error" | "unknown" | "disabled";

const STATUS: Record<InputStatus, { label: string; icon: React.ElementType; tone: string; rank: number; detail: string }> = {
  error: { label: "Disconnected", icon: Unplug, tone: "text-[var(--sa-danger)]", rank: 0, detail: "Encoder stopped sending. Check its network, then restart it." },
  unknown: { label: "Check failed", icon: CircleHelp, tone: "text-[var(--sa-warn)]", rank: 1, detail: "Couldn't confirm status. Your encoder may still be sending video." },
  connecting: { label: "Connecting", icon: Loader2, tone: "text-[var(--sa-warn)]", rank: 2, detail: "Encoder found — waiting for video." },
  idle: { label: "Not connected", icon: CircleCheck, tone: "text-[var(--sa-ink-2)]", rank: 3, detail: "No encoder connected yet." },
  disabled: { label: "Disabled", icon: Ban, tone: "text-[var(--sa-ink-3)]", rank: 4, detail: "This input is turned off at the provider." },
  streaming: { label: "LIVE", icon: Radio, tone: "text-[var(--sa-ok)]", rank: 5, detail: "Receiving video." },
};

export function asStatus(value: string | undefined): InputStatus {
  return value && value in STATUS ? (value as InputStatus) : "unknown";
}
export const statusRank = (value: string | undefined) => STATUS[asStatus(value)].rank;
export const statusDetail = (value: string | undefined) => STATUS[asStatus(value)].detail;
export const needsAttention = (value: string | undefined) => ["error", "unknown"].includes(asStatus(value));

/** Icon + word together; colour never carries status alone. */
export function StatusMark({ status, size = "sm" }: { status: string | undefined; size?: "sm" | "md" }) {
  const meta = STATUS[asStatus(status)], Icon = meta.icon;
  const idle = asStatus(status) === "idle";
  return <span className={`inline-flex items-center gap-1.5 whitespace-nowrap font-medium ${size === "md" ? "text-[13px]" : "text-xs"} ${meta.tone}`}>
    {idle ? <span aria-hidden="true" className="h-2 w-2 rounded-full shadow-[inset_0_0_0_1.5px_currentColor]" /> : <Icon aria-hidden="true" className={`h-3.5 w-3.5 shrink-0 ${asStatus(status) === "connecting" ? "animate-spin motion-reduce:animate-none" : ""}`} strokeWidth={1.75} />}
    {meta.label}
  </span>;
}

export function relativeAge(at: number | null, now: number) {
  if (at === null) return "Not checked yet";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return `Checked ${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  return `Checked ${minutes} min ago`;
}

/** Ticks once a second for "Checked Ns ago"; only this hook re-renders on the clock. */
export function useSecondTick() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(id); }, []);
  return now;
}

export const fieldBox = "flex min-h-10 min-w-0 items-center gap-1 rounded-lg border border-[var(--sa-border-strong)] bg-board-bg pl-3 pr-1 max-lg:min-h-11";
const fieldButton = "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-[13px] text-[var(--sa-ink-2)] hover:bg-[var(--sa-surface-2)] hover:text-board-text disabled:opacity-40 max-lg:h-11 max-lg:min-w-11 max-lg:justify-center";

function useCopy(value: string) {
  const [state, setState] = useState<"idle" | "copying" | "copied" | "failed">("idle");
  const generation = useRef(0);
  useEffect(() => { setState("idle"); return () => { generation.current++; }; }, [value]);
  useEffect(() => {
    if (state !== "copied") return;
    const id = window.setTimeout(() => setState("idle"), 2000);
    return () => window.clearTimeout(id);
  }, [state]);
  const copy = async () => {
    const current = ++generation.current; setState("copying");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([navigator.clipboard.writeText(value), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Copy timed out")), 5_000); })]);
      if (generation.current === current) setState("copied");
    } catch { if (generation.current === current) setState("failed"); }
    finally { clearTimeout(timer); }
  };
  return { state, copy };
}

/** A read-only value with Copy. Copy confirms for 2s; failure says so and offers Retry. */
export function CopyField({ label, value, id, hideLabel = false }: { label: string; value: string; id: string; hideLabel?: boolean }) {
  const { state, copy } = useCopy(value);
  return <div className="flex min-w-0 flex-col gap-1.5">
    <span id={`${id}-label`} className={hideLabel ? "sr-only" : "text-[13px] font-medium text-board-text"}>{label}</span>
    <div className={fieldBox}>
      <code aria-labelledby={`${id}-label`} className="min-w-0 flex-1 select-all truncate font-mono text-[13px] text-board-text">{value}</code>
      <button type="button" disabled={state === "copying"} onClick={() => void copy()} aria-label={`${state === "failed" ? "Retry copying" : "Copy"} ${label}`} className={fieldButton}>
        {state === "copied" ? <><Check aria-hidden="true" className="h-3.5 w-3.5 text-[var(--sa-ok)]" /><span className="text-[var(--sa-ok)] max-lg:sr-only">Copied</span></> : <><Copy aria-hidden="true" className="h-3.5 w-3.5" /><span className="max-lg:sr-only">Copy</span></>}
      </button>
    </div>
    {state === "failed" && <p role="alert" className="text-xs text-[var(--sa-warn)]">Could not copy {label}. Retry copying or select the value manually.</p>}
    {state === "copied" && <p role="status" className="sr-only">{label} copied.</p>}
  </div>;
}

/**
 * The stream key stays masked. Revealing asks first and hides again after 30s;
 * Copy never needs a reveal.
 */
export function SecretField({ label, value, id, hideLabel = false }: { label: string; value: string; id: string; hideLabel?: boolean }) {
  const { state, copy } = useCopy(value);
  const [asking, setAsking] = useState(false);
  const [hideAt, setHideAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (hideAt === null) return;
    const id = window.setInterval(() => { const at = Date.now(); setNow(at); if (at >= hideAt) setHideAt(null); }, 500);
    return () => window.clearInterval(id);
  }, [hideAt]);
  useEffect(() => { setHideAt(null); setAsking(false); }, [value]);
  const revealed = hideAt !== null;
  return <div className="relative flex min-w-0 flex-col gap-1.5">
    <span id={`${id}-label`} className={hideLabel ? "sr-only" : "text-[13px] font-medium text-board-text"}>{label}</span>
    <div className={`${fieldBox} ${revealed ? "border-[var(--sa-warn)]/50" : ""}`}>
      <code aria-labelledby={`${id}-label`} className={`min-w-0 flex-1 truncate font-mono text-[13px] ${revealed ? "select-all text-board-text" : "tracking-[0.2em] text-[var(--sa-ink-2)]"}`}>{revealed ? value : "•".repeat(32)}</code>
      {revealed ? <span className="shrink-0 font-mono text-xs text-[var(--sa-warn)] max-sm:hidden">Hides in {Math.max(0, Math.ceil((hideAt - now) / 1000))}s</span> : null}
      <button type="button" onClick={() => revealed ? setHideAt(null) : setAsking(true)} aria-label={`${revealed ? "Hide" : "Reveal"} ${label}`} aria-expanded={asking} className={fieldButton}>
        {revealed ? <EyeOff aria-hidden="true" className="h-3.5 w-3.5" /> : <Eye aria-hidden="true" className="h-3.5 w-3.5" />}
      </button>
      <button type="button" disabled={state === "copying"} onClick={() => void copy()} aria-label={`${state === "failed" ? "Retry copying" : "Copy"} ${label}`} className={fieldButton}>
        {state === "copied" ? <><Check aria-hidden="true" className="h-3.5 w-3.5 text-[var(--sa-ok)]" /><span className="text-[var(--sa-ok)] max-lg:sr-only">Copied</span></> : <><Copy aria-hidden="true" className="h-3.5 w-3.5" /><span className="max-lg:sr-only">Copy</span></>}
      </button>
    </div>
    {asking ? <div role="dialog" aria-label={`Show the ${label.toLowerCase()}?`} className="absolute right-0 top-full z-20 mt-2 w-[min(320px,100%)] rounded-xl border border-[var(--sa-border-strong)] bg-[var(--sa-surface)] p-4 shadow-[0_16px_40px_rgba(0,0,0,0.5)]"
      onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); setAsking(false); } }}>
      <p className="text-[13px] font-semibold text-board-text">Show the {label.toLowerCase()}?</p>
      <p className="mt-1.5 text-[13px] leading-[1.5] text-[var(--sa-ink-2)]">Anyone who can see your screen could use it to stream to this input. It hides again after 30 seconds.</p>
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" autoFocus onClick={() => setAsking(false)} className="inline-flex h-8 items-center rounded-lg border border-[var(--sa-border-strong)] px-3 text-[13px] font-medium text-board-text hover:bg-[var(--sa-surface-2)] max-lg:h-11">Cancel</button>
        <button type="button" onClick={() => { setAsking(false); setNow(Date.now()); setHideAt(Date.now() + 30_000); }} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[var(--sa-border-strong)] bg-[var(--sa-surface-2)] px-3 text-[13px] font-medium text-board-text hover:bg-[var(--sa-surface-3)] max-lg:h-11"><Eye aria-hidden="true" className="h-3.5 w-3.5" />Show key</button>
      </div>
    </div> : null}
    {state === "failed" && <p role="alert" className="text-xs text-[var(--sa-warn)]">Could not copy {label}. Retry copying or select the value manually.</p>}
    {state === "copied" && <p role="status" className="sr-only">{label} copied.</p>}
  </div>;
}
