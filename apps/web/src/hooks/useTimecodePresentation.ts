import { useLayoutEffect, useState } from "react";
import {
  TimecodePresentationClock,
  type TimecodePresentationSample,
} from "@/lib/timecode-presentation";

/** Confines rendering ticks to the clock, leaving authoritative state untouched. */
export function useTimecodePresentation(
  sample: TimecodePresentationSample | null,
  connected: boolean,
) {
  const [clock] = useState(() => new TimecodePresentationClock());
  const [view, setView] = useState(() => ({
    display: sample?.display ?? "00:00:00:00",
    stale: false,
  }));
  useLayoutEffect(() => {
    clock.observe(sample, connected, performance.now());
    let timer: ReturnType<typeof setInterval> | undefined;
    const tick = () => {
      const now = performance.now();
      const next = clock.read(now);
      setView((previous) =>
        previous.display === next.display && previous.stale === next.stale
          ? previous
          : next,
      );
      if (!clock.needsTick(now) && timer !== undefined) clearInterval(timer);
    };
    tick();
    if (clock.needsTick(performance.now()))
      timer = setInterval(tick, 1000 / 60);
    return () => {
      if (timer !== undefined) clearInterval(timer);
    };
  }, [clock, sample, connected]);
  return view;
}
