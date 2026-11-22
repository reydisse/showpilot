import { describe, expect, it } from "vitest";
import type { RundownItem } from "@/types/rundown";
import { projectRundown, runningLabel } from "./rundown-a";

const at = (hhmm: string) => `2026-11-22T${hhmm}:00.000Z`;
const ms = (hhmm: string) => Date.parse(at(hhmm));
const min = 60_000;
const item = (id: string, duration: number, extra: Partial<RundownItem> = {}): RundownItem => ({ id, title: id, type: "segment", duration, notes: "", assignee: "", cue: "", status: "upcoming", sortOrder: 0, hardStop: false, ...extra });

describe("projectRundown", () => {
  const items = [
    item("section", 0, { type: "header", title: "Pre-service" }),
    item("a", 30 * min, { status: "complete", actualStart: at("09:00"), actualEnd: at("09:32") }),
    item("b", 10 * min, { status: "live", actualStart: at("09:32") }),
    item("c", 5 * min),
  ];

  it("plans from the show start and projects later items from where the show really is", () => {
    const result = projectRundown(items, at("09:00"), "b", 4 * min, ms("09:36"));
    expect(result.plan.starts.get("c")).toBe(ms("09:40"));
    expect(result.projected.get("b")).toEqual({ start: ms("09:32"), end: ms("09:42") });
    expect(result.projected.get("c")).toEqual({ start: ms("09:42"), end: ms("09:47") });
    expect(result.behind).toBe(2 * min);
    expect(runningLabel(result.behind!)).toBe("2:00 behind");
  });

  it("grows the live item's end while it runs over", () => {
    const result = projectRundown(items, at("09:00"), "b", 13 * min, ms("09:45"));
    expect(result.projected.get("b")!.end).toBe(ms("09:45"));
    expect(result.behind).toBe(5 * min);
  });

  it("shows only what happened when nothing is running", () => {
    const result = projectRundown(items, at("09:00"), null, 0, ms("10:00"));
    expect(result.projected.has("c")).toBe(false);
    expect(result.behind).toBeNull();
  });

  it("ignores items completed in an earlier run that sit after the live item", () => {
    const stale = [item("x", 10 * min, { status: "live", actualStart: at("09:00") }), item("y", 10 * min, { status: "complete", actualStart: at("07:00"), actualEnd: at("07:10") }), item("z", 10 * min)];
    const result = projectRundown(stale, at("09:00"), "x", 0, ms("09:00"));
    expect(result.projected.get("z")).toEqual({ start: ms("09:10"), end: ms("09:20") });
  });

  it("hides a delta when the show runs on another day than planned", () => {
    const result = projectRundown(items, at("09:00"), "b", 0, Date.parse("2026-11-23T09:32:00.000Z"));
    expect(result.behind).toBeNull();
  });
});
