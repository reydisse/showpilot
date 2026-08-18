/**
 * Section bands ("Pre-service", "Pre-sermon") are structure, not running
 * order. Everything that walks the item list has to skip them, and the
 * failure mode when it doesn't is loud: a heading goes live, or the
 * dashboard reports every heading as an item missing its duration.
 */

import { describe, expect, it } from "vitest";
import { computeCascadedTimes } from "@/lib/rundown-timing";
import { deriveRundownHealth, type PmSnapshot } from "@/lib/pm-dashboard-derive";
import { isHeaderItem, rundownItemNumbers, type ItemType, type RundownItem } from "@/types/rundown";

const MINUTE = 60_000;
const START = new Date("2026-08-09T10:00:00.000Z").getTime();

function item(overrides: Partial<RundownItem> & { id: string }): RundownItem {
  return {
    title: "Welcome",
    type: "segment" as ItemType,
    duration: 10 * MINUTE,
    notes: "",
    assignee: "Sam",
    cue: "",
    status: "upcoming",
    sortOrder: 0,
    hardStop: false,
    scheduledStart: null,
    expectedEnd: null,
    actualStart: null,
    actualEnd: null,
    ...overrides,
  };
}

function header(id: string, title: string): RundownItem {
  return item({ id, title, type: "header", duration: 0, assignee: "" });
}

function snapshot(items: RundownItem[]): PmSnapshot {
  return {
    serviceDate: "2026-08-09",
    serviceName: "",
    now: START,
    callLeadMinutes: 90,
    serviceWindowMinutes: 70,
    serviceWindowConfigured: true,
    lastServiceDate: null,
    rundown: { scheduledStartTime: new Date(START).toISOString(), status: "stopped" },
    items,
    checklist: [],
    incidents: [],
    equipment: [],
    crew: [],
    streamDestinations: [],
    liveInputs: [],
    notifications: [],
    upcoming: [],
    assignments: [],
    openItems: [],
    recent: [],
    onFloor: [],
    onFloorTotal: 0,
    schedulingInUse: true,
    rosterDuty: { weekStart: "2026-08-09", pm: null, tm: null },
    orgMembers: [],
  };
}

describe("isHeaderItem", () => {
  it("identifies section bands and nothing else", () => {
    expect(isHeaderItem({ type: "header" })).toBe(true);
    for (const type of ["segment", "song", "prayer", "announcement", "offering", "custom"]) {
      expect(isHeaderItem({ type })).toBe(false);
    }
  });
});

describe("rundownItemNumbers", () => {
  it("numbers sections and their playable children hierarchically", () => {
    const numbers = rundownItemNumbers([
      header("h1", "Pre-service"), item({ id: "a" }), item({ id: "b" }),
      header("h2", "Main service"), item({ id: "c" }),
    ]);
    expect([...numbers.values()]).toEqual(["1", "1.1", "1.2", "2", "2.1"]);
  });

  it("keeps flat numbering when a rundown has no sections", () => {
    const numbers = rundownItemNumbers([item({ id: "a" }), item({ id: "b" })]);
    expect([...numbers.values()]).toEqual(["1", "2"]);
  });
});

describe("computeCascadedTimes with sections", () => {
  const meta = {
    serviceDate: "2026-08-09",
    scheduledStartTime: new Date(START).toISOString(),
    status: "stopped" as const,
  };

  it("does not advance the clock across a section band", () => {
    const timed = computeCascadedTimes(
      [header("h1", "Pre-service"), item({ id: "a" }), item({ id: "b" })],
      meta,
    );
    // The heading and the item beneath it start at the same moment.
    expect(timed[0].scheduledStart).toBe(new Date(START).toISOString());
    expect(timed[1].scheduledStart).toBe(new Date(START).toISOString());
    expect(timed[2].scheduledStart).toBe(new Date(START + 10 * MINUTE).toISOString());
  });

  it("ignores a duration a section band should never have had", () => {
    // Defensive: a header that somehow acquired 30 minutes must not push
    // the whole service later.
    const rogue = item({ id: "h1", type: "header", duration: 30 * MINUTE, assignee: "" });
    const timed = computeCascadedTimes([rogue, item({ id: "a" })], meta);
    expect(timed[1].scheduledStart).toBe(new Date(START).toISOString());
  });
});

describe("deriveRundownHealth with sections", () => {
  it("does not count section bands as items missing a duration or owner", () => {
    const health = deriveRundownHealth(
      snapshot([header("h1", "Pre-service"), item({ id: "a" }), header("h2", "Pre-sermon")]),
    );
    expect(health.missingDuration).toBe(0);
    expect(health.missingOwner).toBe(0);
  });

  it("counts only real segments", () => {
    const health = deriveRundownHealth(
      snapshot([header("h1", "Pre-service"), item({ id: "a" }), item({ id: "b" })]),
    );
    expect(health.itemCount).toBe(2);
    expect(health.plannedMs).toBe(20 * MINUTE);
  });

  it("still reports a real segment with no duration", () => {
    const health = deriveRundownHealth(
      snapshot([header("h1", "Pre-service"), item({ id: "a", duration: 0 })]),
    );
    expect(health.missingDuration).toBe(1);
  });
});
