import { act, cleanup, render } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { CallerClockBar } from "../caller-clock";
import type { CueRow } from "@/lib/cue-sheet-derive";
const start=Date.UTC(2026,10,6,12);
const rows:CueRow[]=[{itemId:"first",title:"Opening",type:"segment",isSection:false,cue:"",durationMs:60000,scheduledStart:null,expectedEnd:null,status:"live",note:"",assignee:"",notes:{}}];
afterEach(()=>{cleanup();vi.useRealTimers();});
it("uses the reference instant and UTC during server rendering",()=>{
  vi.useFakeTimers();vi.setSystemTime(start+60000);
  const html=renderToString(<CallerClockBar rows={rows} currentItemId={null} timer={null} initialNow={start}/>);
  expect(html).toContain("12:00 PM");expect(html).not.toContain("12:01 PM");
});
it("advances the caller display without rendering the sheet parent and releases its timer",()=>{
  vi.useFakeTimers();vi.setSystemTime(start);
  let renders=0;
  function Sheet(){renders++;return <CallerClockBar rows={rows} currentItemId="first" timer={{playback:"play",elapsed:0,startedAt:start}} initialNow={start}/>;}
  const view=render(<Sheet/>);expect(view.container.textContent).toContain("1:00");
  act(()=>vi.advanceTimersByTime(2000));expect(view.container.textContent).toContain("0:58");expect(renders).toBe(1);
  view.unmount();expect(vi.getTimerCount()).toBe(0);
});

it("uses the same 90-second attention threshold and signed overtime treatment", () => {
  vi.useFakeTimers(); vi.setSystemTime(start);
  const view = render(<CallerClockBar rows={[{ ...rows[0], durationMs: 120_000 }]} currentItemId="first" timer={{ playback: "pause", elapsed: 29_000, startedAt: null }} initialNow={start} />);
  expect(view.container.querySelector("[data-tone=normal]")).toBeTruthy();
  view.rerender(<CallerClockBar rows={[{ ...rows[0], durationMs: 120_000 }]} currentItemId="first" timer={{ playback: "pause", elapsed: 30_000, startedAt: null }} initialNow={start} />);
  expect(view.container.querySelector("[data-tone=attention]")).toBeTruthy();
  view.rerender(<CallerClockBar rows={rows} currentItemId="first" timer={{ playback: "pause", elapsed: 265_000, startedAt: null }} initialNow={start} />);
  expect(view.container.querySelector("[data-tone=over]")).toBeTruthy();
  expect(view.container.textContent).toContain("+3:25");
});
