import { act, cleanup, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RundownClockCard, RundownOffset, RundownProgress } from "./RundownClock";
import type { NativeTimerState } from "@/types/rundown";
const start = Date.UTC(2026,10,6,12);
const timer: NativeTimerState = {playback:"play",currentItemId:"first",elapsed:0,startedAt:start,pausedAt:null,mode:"count-down",serverTime:start};
const item = {id:"first",title:"First",duration:125000,assignee:"Speaker"};
const props = {timer,initialNow:start,overtimeBehavior:"flash",currentItem:item,nextItem:{title:"Second",duration:300000}};
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(start); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
const tick = (ms:number) => act(() => { vi.advanceTimersByTime(ms); });
const clock = (container:HTMLElement) => container.querySelector('[data-rundown-clock]')?.textContent;
it("updates the clock, offset and progress without rendering their parent or static rows", () => {
  let parents=0, rows=0;
  function Row() { rows++; return <p>Unchanged rundown row</p>; }
  function Page() { parents++; return <><Row/><RundownClockCard {...props}/><RundownOffset timer={timer} duration={item.duration} initialNow={start}/><RundownProgress timer={timer} duration={item.duration} initialNow={start} overtimeBehavior="flash" id="rundown-item-progress"/></>; }
  const view=render(<Page/>);
  expect(clock(view.container)).toBe("2:05");
  tick(6000);
  expect(clock(view.container)).toBe("1:59");
  expect(view.container.querySelector('.rundown-row-offset')?.textContent?.trim()).toBe("-1m59s");
  for(const id of ["rundown-progress-fill","rundown-item-progress"]) {
    const bar=view.container.querySelector<HTMLElement>(`#${id}`);
    expect(bar?.dataset.tone).toBe("warning");
    expect(parseFloat(bar?.style.width ?? "0")).toBeGreaterThan(4);
  }
  expect({parents,rows}).toEqual({parents:1,rows:1});
  view.unmount(); expect(vi.getTimerCount()).toBe(0);
});
it("changes warning/overtime colors at the time boundary and holds when paused", () => {
  const view=render(<RundownClockCard {...props} currentItem={{...item,duration:1000}}/>);
  tick(2000);
  expect(clock(view.container)).toBe("-0:01"); expect(screen.getByText("Overtime")).toBeTruthy();
  expect(view.container.querySelector<HTMLElement>('#rundown-progress-fill')?.dataset.tone).toBe("overtime");
  view.rerender(<RundownClockCard {...props} currentItem={{...item,duration:1000}} timer={{...timer,playback:"pause",elapsed:2000,startedAt:null}}/>);
  tick(3000); expect(clock(view.container)).toBe("-0:01");
  expect(vi.getTimerCount()).toBe(0);
});
it("honors stop-at-zero, count-up, clock mode and no selected item", () => {
  const view=render(<RundownClockCard {...props} currentItem={{...item,duration:1000}} overtimeBehavior="stop"/>);
  tick(2000); expect(clock(view.container)).toBe("00:00"); expect(screen.queryByText("Overtime")).toBeNull();
  view.rerender(<RundownClockCard {...props} timer={{...timer,mode:"count-up"}}/>);
  expect(clock(view.container)).toBe("0:02");
  view.rerender(<RundownClockCard {...props} timer={{...timer,mode:"clock",playback:"pause"}}/>);
  tick(1000); expect(clock(view.container)).toBe(new Date(start+3000).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit",second:"2-digit"}));
  view.rerender(<RundownClockCard {...props} currentItem={undefined}/>);
  expect(clock(view.container)).toBe("--:--");
});
it("resets progress on item change, clamps extra time and responds to paused adjustments", () => {
  const paused={...timer,playback:"pause" as const,elapsed:50000,startedAt:null};
  const view=render(<RundownProgress timer={paused} duration={100000} initialNow={start} overtimeBehavior="flash" id="bar"/>);
  tick(400); const bar=view.container.querySelector<HTMLElement>('#bar'); expect(bar?.style.width).toBe("50%");
  view.rerender(<RundownProgress timer={{...paused,currentItemId:"second",elapsed:20000}} duration={100000} initialNow={start} overtimeBehavior="flash" id="bar"/>);
  expect(bar?.style.width).toBe("0%"); tick(400); expect(bar?.style.width).toBe("20%");
  view.rerender(<RundownProgress timer={{...paused,currentItemId:"second",elapsed:-10000}} duration={100000} initialNow={start} overtimeBehavior="flash" id="bar"/>);
  expect(bar?.style.width).toBe("0%"); expect(vi.getTimerCount()).toBe(0);
});
it("server-rendered clock text uses the supplied reference instant", () => {
  vi.setSystemTime(start+3600000);
  const html=renderToString(<RundownClockCard {...props} timer={{...timer,mode:"clock"}}/>);
  expect(html).toContain(new Date(start).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit",second:"2-digit"}));
});
