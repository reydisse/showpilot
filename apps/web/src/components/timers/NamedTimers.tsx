import { useLayoutEffect, useRef, useState } from "react";
import { NamedTimerClock, formatNamedTimerRemaining, namedTimerKey, type NamedTimerSample } from "@/lib/named-timers";

interface Props {
  sample: NamedTimerSample | null;
  connected: boolean;
  mode?: "operator" | "strip" | "single";
  selectedName?: string;
  outputTarget?: { orgSlug: string; showId: string };
}

export function namedTimerDisplayUrl(orgSlug: string, showId: string, name: string): string {
  return `/timer/${encodeURIComponent(orgSlug)}?${new URLSearchParams({ namedTimer: name, showId })}`;
}

export function NamedTimers({ sample, connected, mode = "operator", selectedName, outputTarget }: Props) {
  const clock = useRef(new NamedTimerClock());
  const [timers, setTimers] = useState<ReturnType<NamedTimerClock["values"]>>([]);
  useLayoutEffect(() => {
    clock.current.observe(sample, connected, performance.now());
    const refresh = () => setTimers(clock.current.values(performance.now()));
    refresh();
    if (!connected || !sample?.timers.length) return;
    const interval = setInterval(refresh, 200);
    return () => clearInterval(interval);
  }, [sample, connected]);

  if (mode === "single") {
    const timer = timers.find(candidate => namedTimerKey(candidate.name) === namedTimerKey(selectedName ?? ""));
    return <main className="flex h-full min-h-0 flex-col items-center justify-center gap-4 bg-black p-[5vw] text-center text-white" data-named-timer-output>
      <h1 className="max-w-full break-words text-[clamp(1rem,4vw,4rem)] font-semibold" style={{ overflowWrap: "anywhere" }}>{timer?.name ?? selectedName}</h1>
      <p data-named-timer-remaining className={`font-mono text-[clamp(2rem,18vw,18rem)] leading-none tabular-nums ${timer?.remainingMs === 0 ? "text-amber-400" : ""}`}>{timer ? formatNamedTimerRemaining(timer.remainingMs) : "—:—"}</p>
      <p role="status" className="text-[clamp(.75rem,2vw,2rem)] text-white/70">{!connected ? "Reconnecting · timer unconfirmed" : timer ? timer.remainingMs === 0 ? "Complete" : "Countdown" : "Stopped"}</p>
    </main>;
  }
  if (!timers.length) return null;
  return <section aria-label="Named timers" className={`shrink-0 border border-white/15 bg-black text-white ${mode === "strip" ? "px-3 py-2" : "rounded-xl p-4"}`}>
    {mode === "operator" && <h2 className="mb-2 text-sm font-semibold">Named timers</h2>}
    {!connected && <p role="status" className="mb-2 text-xs text-amber-300">Reconnecting · timers held at last known state</p>}
    <div role="list" className="grid gap-2" style={{ gridTemplateColumns: mode === "strip" ? "repeat(auto-fit, minmax(min(100%, 7rem), 1fr))" : "repeat(auto-fit, minmax(min(100%, 12rem), 1fr))" }}>
      {timers.map(timer => <div key={namedTimerKey(timer.name)} role="listitem" data-named-timer={timer.name} className="min-w-0 rounded-lg border border-white/15 px-3 py-2" style={{ containerType: "inline-size" }}>
        <p className="line-clamp-2 text-xs text-white/75" title={timer.name} style={{ overflowWrap: "anywhere" }}>{timer.name}</p>
        <p data-named-timer-remaining style={mode === "strip" ? { fontSize: "clamp(1rem, 20cqw, 3rem)" } : undefined} className={`font-mono tabular-nums ${mode === "strip" ? "" : "text-3xl"} ${timer.remainingMs === 0 ? "text-amber-400" : ""}`}>{formatNamedTimerRemaining(timer.remainingMs)}</p>
        {timer.remainingMs === 0 && <p className="text-xs text-amber-300">Complete</p>}
        {outputTarget && <a href={namedTimerDisplayUrl(outputTarget.orgSlug, outputTarget.showId, timer.name)} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex min-h-11 items-center rounded-lg px-2 text-xs text-amber-300 underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400" aria-label={`Open ${timer.name} timer display`}>Open timer display</a>}
      </div>)}
    </div>
  </section>;
}
