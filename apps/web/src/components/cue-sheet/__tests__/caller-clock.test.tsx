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
  const view=render(<Sheet/>);expect(view.container.textContent).toContain("01:00");
  act(()=>vi.advanceTimersByTime(2000));expect(view.container.textContent).toContain("00:58");expect(renders).toBe(1);
  view.unmount();expect(vi.getTimerCount()).toBe(0);
});
