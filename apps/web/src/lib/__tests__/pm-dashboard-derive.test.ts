import { describe, expect, it } from "vitest";
import {
  deriveArrivals,
  deriveAttentionQueue,
  deriveCrewBoard,
  deriveCueExceptions,
  deriveDuty,
  dutyKeyFor,
  deriveDepartments,
  deriveOnFloor,
  deriveOpenItems,
  deriveRecent,
  deriveReadiness,
  deriveRundownHealth,
  deriveUpcoming,
  derivePmDashboard,
  formatMinutes,
  initialsFor,
  normalizeCategory,
  type PmSnapshot,
} from "@/lib/pm-dashboard-derive";
import { getServiceTiming } from "@/lib/service-phase";
import type { RundownItem } from "@/types/rundown";

const MINUTE = 60_000;
const START = new Date("2026-08-09T10:00:00.000Z").getTime();

function item(overrides: Partial<RundownItem> = {}): RundownItem {
  return {
    id: overrides.id ?? "item-1",
    title: "Welcome",
    type: "segment",
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

function snapshot(overrides: Partial<PmSnapshot> = {}): PmSnapshot {
  return {
    serviceDate: "2026-08-09",
    now: START - 3 * 60 * MINUTE,
    callLeadMinutes: 90,
    serviceWindowMinutes: 70,
    serviceWindowConfigured: true,
    lastServiceDate: null,
    rundown: { scheduledStartTime: new Date(START).toISOString(), status: "stopped" },
    items: [item({ id: "a" }), item({ id: "b", duration: 60 * MINUTE, title: "Message" })],
    checklist: [],
    incidents: [],
    cues: [],
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
    ...overrides,
  };
}

describe("deriveRundownHealth", () => {
  it("computes planned runtime against the window", () => {
    const health = deriveRundownHealth(snapshot());
    expect(health.plannedMs).toBe(70 * MINUTE);
    expect(health.windowMs).toBe(70 * MINUTE);
    expect(health.deltaMs).toBe(0);
  });

  it("flags an overrunning rundown", () => {
    const health = deriveRundownHealth(
      snapshot({ items: [item({ id: "a", duration: 90 * MINUTE })] }),
    );
    expect(health.deltaMs).toBe(20 * MINUTE);
  });

  it("counts items missing a duration or an owner", () => {
    const health = deriveRundownHealth(
      snapshot({
        items: [item({ id: "a", duration: 0 }), item({ id: "b", assignee: "  " })],
      }),
    );
    expect(health.missingDuration).toBe(1);
    expect(health.missingOwner).toBe(1);
  });

  it("detects a hard stop the cascade cannot make", () => {
    // 'a' runs 60 min from 10:00, so 'b' arrives 11:00 — but 'b' is
    // pinned to start at 10:30 and marked hard stop.
    const health = deriveRundownHealth(
      snapshot({
        items: [
          item({ id: "a", duration: 60 * MINUTE }),
          item({
            id: "b",
            hardStop: true,
            scheduledStart: new Date(START + 30 * MINUTE).toISOString(),
          }),
        ],
      }),
    );
    expect(health.hardStopConflicts).toBe(1);
  });

  it("does not flag a hard stop the cascade arrives in time for", () => {
    const health = deriveRundownHealth(
      snapshot({
        items: [
          item({ id: "a", duration: 10 * MINUTE }),
          item({
            id: "b",
            hardStop: true,
            scheduledStart: new Date(START + 30 * MINUTE).toISOString(),
          }),
        ],
      }),
    );
    expect(health.hardStopConflicts).toBe(0);
  });

  it("reports no drift before anything has run", () => {
    expect(deriveRundownHealth(snapshot()).driftMs).toBeNull();
  });

  it("accumulates drift across items that have run", () => {
    const health = deriveRundownHealth(
      snapshot({
        now: START + 30 * MINUTE,
        items: [
          item({
            id: "a",
            duration: 10 * MINUTE,
            actualStart: new Date(START).toISOString(),
            actualEnd: new Date(START + 15 * MINUTE).toISOString(),
          }),
        ],
      }),
    );
    expect(health.driftMs).toBe(5 * MINUTE);
  });
});

describe("deriveAttentionQueue", () => {
  it("sorts critical before warning before info", () => {
    const snap = snapshot({
      incidents: [
        { id: "i1", category: "audio", severity: "low", description: "Hum", reportedBy: "Sam" },
        { id: "i2", category: "video", severity: "high", description: "Cam 2 dead", reportedBy: "Ada" },
      ],
    });
    const queue = deriveAttentionQueue(snap, deriveRundownHealth(snap), "prep");
    expect(queue[0].severity).toBe("critical");
    expect(queue[queue.length - 1].severity).toBe("info");
  });

  it("treats a missing duration as critical, not cosmetic", () => {
    const snap = snapshot({ items: [item({ id: "a", duration: 0 })] });
    const queue = deriveAttentionQueue(snap, deriveRundownHealth(snap), "prep");
    const entry = queue.find((q) => q.id === "rundown:missing-duration");
    expect(entry?.severity).toBe("critical");
  });

  it("raises checklists only once crew is on site", () => {
    const snap = snapshot({
      checklist: [{ id: "c1", label: "Line check", category: "audio", checked: false }],
    });
    for (const quiet of ["planning", "prep"] as const) {
      expect(
        deriveAttentionQueue(snap, deriveRundownHealth(snap), quiet).some(
          (q) => q.source === "checklist",
        ),
      ).toBe(false);
    }
    const call = deriveAttentionQueue(snap, deriveRundownHealth(snap), "call");
    expect(call.find((q) => q.id === "checklist:outstanding")?.severity).toBe("critical");
  });

  it("consolidates outstanding checks into one row, not one per department", () => {
    const snap = snapshot({
      checklist: [
        { id: "c1", label: "Line check", category: "audio", checked: false },
        { id: "c2", label: "Cameras", category: "video", checked: false },
        { id: "c3", label: "Slides", category: "visuals", checked: false },
        { id: "c4", label: "Comms", category: "comms", checked: true },
      ],
    });
    const rows = deriveAttentionQueue(snap, deriveRundownHealth(snap), "call").filter(
      (q) => q.source === "checklist",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Checklist 1 of 4 done");
    // 'visuals' folds into video, so two departments, not three.
    expect(rows[0].detail).toBe("3 items outstanding across audio, video");
  });

  it("flags an empty rundown once the service is imminent", () => {
    const snap = snapshot({ items: [] });
    const queue = deriveAttentionQueue(snap, deriveRundownHealth(snap), "call");
    expect(queue[0].id).toBe("rundown:empty");
  });

  it("leaves the empty-rundown ask to the plan-next widget while planning", () => {
    const snap = snapshot({ items: [] });
    for (const phase of ["planning", "prep"] as const) {
      const queue = deriveAttentionQueue(snap, deriveRundownHealth(snap), phase);
      expect(queue.some((q) => q.id === "rundown:empty")).toBe(false);
    }
  });

  it("only complains about encoders once crew is on site", () => {
    const snap = snapshot({ liveInputs: [{ id: "l1", name: "Booth", status: "idle" }] });
    const planning = deriveAttentionQueue(snap, deriveRundownHealth(snap), "planning");
    const call = deriveAttentionQueue(snap, deriveRundownHealth(snap), "call");
    expect(planning.some((q) => q.id === "stream:no-signal")).toBe(false);
    expect(call.some((q) => q.id === "stream:no-signal")).toBe(true);
  });
});

describe("deriveCueExceptions", () => {
  it("reports cues with no camera and cues with no matching item", () => {
    const exceptions = deriveCueExceptions(
      snapshot({
        cues: [
          { id: "c1", cueNumber: 1, rundownItem: "Welcome", cameraAssignments: "" },
          { id: "c2", cueNumber: 2, rundownItem: "Baptism", cameraAssignments: "Cam 1" },
        ],
      }),
    );
    expect(exceptions.map((e) => e.id)).toEqual(["cue:no-camera", "cue:orphaned"]);
  });
});

describe("deriveDepartments", () => {
  it("folds stream and streaming into one department", () => {
    expect(normalizeCategory("streaming")).toBe("stream");
    expect(normalizeCategory("stream")).toBe("stream");
    expect(normalizeCategory("comms")).toBe("general");
  });

  it("fails a department with a high-severity incident", () => {
    const departments = deriveDepartments(
      snapshot({
        incidents: [
          { id: "i1", category: "audio", severity: "high", description: "FOH down", reportedBy: "Sam" },
        ],
      }),
      "call",
    );
    expect(departments.find((d) => d.key === "audio")?.status).toBe("fail");
    expect(departments.find((d) => d.key === "video")?.status).toBe("ok");
  });
});

describe("deriveArrivals", () => {
  it("does not raise a no-show alarm before call time", () => {
    const snap = snapshot({
      crew: [{ id: "m1", name: "Sam", role: "Audio Engineer", isOnline: false, lastCheckIn: null }],
    });
    const arrivals = deriveArrivals(snap, getServiceTiming({ scheduledStartTime: new Date(START).toISOString() }));
    expect(arrivals.departments.every((d) => !d.alarm)).toBe(true);
  });

  it("raises a no-show alarm well past call time", () => {
    const snap = snapshot({
      now: START - 30 * MINUTE,
      crew: [{ id: "m1", name: "Sam", role: "Audio Engineer", isOnline: false, lastCheckIn: null }],
    });
    const arrivals = deriveArrivals(snap, getServiceTiming({ scheduledStartTime: new Date(START).toISOString() }));
    expect(arrivals.departments.some((d) => d.alarm)).toBe(true);
  });
});

describe("deriveReadiness", () => {
  it("scores a clean service highly", () => {
    const snap = snapshot({
      checklist: [{ id: "c1", label: "Line check", category: "audio", checked: true }],
      equipment: [{ id: "e1", name: "X32", category: "audio", status: "operational", nextService: null }],
      streamDestinations: [{ id: "s1", name: "YouTube", platform: "youtube", enabled: true }],
      crew: [{ id: "m1", name: "Sam", role: "Audio Engineer", isOnline: true, lastCheckIn: null }],
      assignments: [{ id: "a1", role: "Audio", crewMemberName: "Sam", status: "confirmed" }],
    });
    const health = deriveRundownHealth(snap);
    const readiness = deriveReadiness(
      snap,
      health,
      deriveDepartments(snap, "prep"),
      deriveArrivals(snap, getServiceTiming({})),
      "prep",
      deriveCrewBoard(snap),
    );
    expect(readiness.score).toBe(100);
    expect(readiness.status).toBe("ok");
  });

  it("drops the score and fails when the rundown has no durations", () => {
    const snap = snapshot({ items: [item({ id: "a", duration: 0 })] });
    const health = deriveRundownHealth(snap);
    const readiness = deriveReadiness(
      snap,
      health,
      deriveDepartments(snap, "call"),
      deriveArrivals(snap, getServiceTiming({})),
      "prep",
    );
    expect(readiness.status).toBe("fail");
    expect(readiness.score).toBeLessThan(100);
    expect(readiness.factors.find((f) => f.id === "rundown")?.status).toBe("fail");
  });

  it("omits crew while planning and judges it once the service is near", () => {
    const snap = snapshot({
      crew: [{ id: "m1", name: "Sam", role: "Audio Engineer", isOnline: false, lastCheckIn: null }],
    });
    const health = deriveRundownHealth(snap);
    const timing = getServiceTiming({ scheduledStartTime: new Date(START).toISOString() });
    const at = (phase: "planning" | "prep" | "call") =>
      deriveReadiness(snap, health, deriveDepartments(snap, phase), deriveArrivals(snap, timing), phase);
    // Weeks out an unassigned rota is normal, so it is not scored.
    expect(at("planning").factors.some((f) => f.id === "crew")).toBe(false);
    expect(at("prep").factors.find((f) => f.id === "crew")?.detail).toBe("Nobody scheduled yet");
    expect(at("call").factors.find((f) => f.id === "crew")?.status).toBe("warn");
  });
});

describe("deriveUpcoming", () => {
  it("scores an empty service as zero", () => {
    const upcoming = deriveUpcoming(
      snapshot({
        upcoming: [
          { serviceDate: "2026-08-16", scheduledStartTime: null, itemCount: 0, missingDuration: 0, missingOwner: 0 },
        ],
      }),
    );
    expect(upcoming[0].readiness).toBe(0);
    expect(upcoming[0].status).toBe("fail");
  });

  it("caps a service with no start time below complete", () => {
    const upcoming = deriveUpcoming(
      snapshot({
        upcoming: [
          { serviceDate: "2026-08-16", scheduledStartTime: null, itemCount: 4, missingDuration: 0, missingOwner: 0 },
        ],
      }),
    );
    expect(upcoming[0].readiness).toBe(70);
  });
});

describe("derivePmDashboard", () => {
  it("produces a debrief only after the service has run", () => {
    const before = derivePmDashboard(snapshot());
    expect(before.phase).toBe("prep");
    expect(before.debrief).toBeNull();

    const after = derivePmDashboard(
      snapshot({
        now: START + 80 * MINUTE,
        items: [
          item({
            id: "a",
            duration: 10 * MINUTE,
            actualStart: new Date(START).toISOString(),
            actualEnd: new Date(START + 14 * MINUTE).toISOString(),
          }),
        ],
      }),
    );
    expect(after.phase).toBe("debrief");
    expect(after.debrief?.worstOverruns[0].overrunMs).toBe(4 * MINUTE);
  });
});

describe("formatMinutes", () => {
  it("renders minutes and hours", () => {
    expect(formatMinutes(9 * MINUTE)).toBe("9 min");
    expect(formatMinutes(90 * MINUTE)).toBe("1h 30m");
    expect(formatMinutes(120 * MINUTE)).toBe("2h");
  });
});

describe("service window is only judged when the org configured one", () => {
  it("reports no delta and no overrun row when unset", () => {
    const snap = snapshot({
      serviceWindowConfigured: false,
      items: [item({ id: "a", duration: 120 * MINUTE })],
    });
    const health = deriveRundownHealth(snap);
    expect(health.windowMs).toBeNull();
    expect(health.deltaMs).toBeNull();
    expect(health.plannedMs).toBe(120 * MINUTE);

    const queue = deriveAttentionQueue(snap, health, "prep");
    expect(queue.some((q) => q.id === "rundown:overrun")).toBe(false);
    // ...and prompts for the missing setting instead of inventing a verdict.
    expect(queue.some((q) => q.id === "setup:service-window")).toBe(true);
  });

  it("judges runtime once a window exists", () => {
    const snap = snapshot({
      serviceWindowConfigured: true,
      serviceWindowMinutes: 90,
      items: [item({ id: "a", duration: 120 * MINUTE })],
    });
    const health = deriveRundownHealth(snap);
    expect(health.deltaMs).toBe(30 * MINUTE);
    expect(deriveAttentionQueue(snap, health, "prep").some((q) => q.id === "rundown:overrun")).toBe(
      true,
    );
  });
});

describe("readiness excludes features the org never configured", () => {
  function score(overrides: Partial<PmSnapshot>) {
    const snap = snapshot(overrides);
    const health = deriveRundownHealth(snap);
    return deriveReadiness(
      snap,
      health,
      deriveDepartments(snap, "prep"),
      deriveArrivals(snap, getServiceTiming({})),
      "prep",
      deriveCrewBoard(snap),
    );
  }

  it("can reach 100 for an org that does not stream and tracks no gear", () => {
    const readiness = score({
      crew: [{ id: "m1", name: "Sam", role: "Audio Engineer", isOnline: false, lastCheckIn: null }],
      assignments: [{ id: "a1", role: "Audio", crewMemberName: "Sam", status: "confirmed" }],
    });
    expect(readiness.factors.map((f) => f.id)).not.toContain("stream");
    expect(readiness.factors.map((f) => f.id)).not.toContain("equipment");
    expect(readiness.score).toBe(100);
  });

  it("still fails an org that configured a destination and turned it off", () => {
    const readiness = score({
      crew: [{ id: "m1", name: "Sam", role: "Audio Engineer", isOnline: false, lastCheckIn: null }],
      assignments: [{ id: "a1", role: "Audio", crewMemberName: "Sam", status: "confirmed" }],
      streamDestinations: [{ id: "s1", name: "YouTube", platform: "youtube", enabled: false }],
    });
    expect(readiness.factors.find((f) => f.id === "stream")?.status).toBe("fail");
    expect(readiness.score).toBeLessThan(100);
  });

  it("surfaces unconfigured features as info nudges rather than deductions", () => {
    const snap = snapshot({});
    const queue = deriveAttentionQueue(snap, deriveRundownHealth(snap), "prep");
    const nudges = queue.filter((q) => q.id.startsWith("setup:"));
    expect(nudges.map((n) => n.id).sort()).toEqual([
      "setup:checklist",
      "setup:stream",
    ]);
    expect(nudges.every((n) => n.severity === "info")).toBe(true);
  });

  it("suppresses setup nudges once crew is on site", () => {
    const snap = snapshot({});
    for (const phase of ["call", "live"] as const) {
      const queue = deriveAttentionQueue(snap, deriveRundownHealth(snap), phase);
      expect(queue.some((q) => q.id.startsWith("setup:"))).toBe(false);
    }
  });
});

describe("plan-next state", () => {
  it("is set when the resolved service has no rundown", () => {
    const model = derivePmDashboard(
      snapshot({ items: [], rundown: null, lastServiceDate: "2026-05-19" }),
    );
    expect(model.phase).toBe("planning");
    expect(model.planNext).toBe(true);
    expect(model.lastServiceDate).toBe("2026-05-19");
  });

  it("is not set once a rundown exists", () => {
    expect(derivePmDashboard(snapshot()).planNext).toBe(false);
  });
});

describe("crew board", () => {
  const roster = [
    { id: "a1", role: "Camera 1", crewMemberName: "Sam", status: "confirmed" },
    { id: "a2", role: "Camera 2", crewMemberName: "Ada", status: "assigned" },
    { id: "a3", role: "Audio", crewMemberName: null, status: "assigned" },
    { id: "a4", role: "Lighting", crewMemberName: "Rey", status: "declined" },
  ];

  it("treats an assignment with nobody on it as an open position", () => {
    const crew = deriveCrewBoard(snapshot({ assignments: roster }));
    expect(crew.open).toBe(1);
    expect(crew.confirmed).toBe(1);
    expect(crew.unconfirmed).toBe(1);
    expect(crew.declined).toBe(1);
    expect(crew.scheduled).toBe(true);
  });

  it("is unscheduled, not empty, when nothing has been assigned", () => {
    expect(deriveCrewBoard(snapshot()).scheduled).toBe(false);
  });

  it("escalates open positions as the service approaches", () => {
    const snap = snapshot({ assignments: roster });
    const crew = deriveCrewBoard(snap);
    const health = deriveRundownHealth(snap);
    expect(
      deriveAttentionQueue(snap, health, "prep", crew).find((q) => q.id === "crew:open")?.severity,
    ).toBe("warning");
    expect(
      deriveAttentionQueue(snap, health, "call", crew).find((q) => q.id === "crew:open")?.severity,
    ).toBe("critical");
  });

  it("stays quiet about unconfirmed crew during planning", () => {
    const snap = snapshot({ assignments: roster });
    const crew = deriveCrewBoard(snap);
    const health = deriveRundownHealth(snap);
    expect(
      deriveAttentionQueue(snap, health, "planning", crew).some((q) => q.id === "crew:unconfirmed"),
    ).toBe(false);
    expect(
      deriveAttentionQueue(snap, health, "prep", crew).some((q) => q.id === "crew:unconfirmed"),
    ).toBe(true);
  });

  it("prefers the schedule over check-ins for the readiness factor", () => {
    const snap = snapshot({ assignments: roster });
    const crew = deriveCrewBoard(snap);
    const readiness = deriveReadiness(
      snap,
      deriveRundownHealth(snap),
      deriveDepartments(snap, "prep"),
      deriveArrivals(snap, getServiceTiming({})),
      "prep",
      crew,
    );
    const factor = readiness.factors.find((f) => f.id === "crew");
    expect(factor?.status).toBe("fail");
    expect(factor?.detail).toBe("1 position unfilled");
  });
});

describe("carried-forward open items", () => {
  it("ages each item against the service on screen and ranks by severity", () => {
    const items = deriveOpenItems(
      snapshot({
        serviceDate: "2026-08-09",
        openItems: [
          { id: "o1", serviceDate: "2026-08-02", category: "audio", severity: "low", description: "Hum on 3" },
          { id: "o2", serviceDate: "2026-07-26", category: "video", severity: "high", description: "Cam 2 dead" },
        ],
      }),
    );
    expect(items.map((i) => i.id)).toEqual(["o2", "o1"]);
    expect(items[0].ageDays).toBe(14);
    expect(items[1].ageDays).toBe(7);
  });
});

describe("recent services", () => {
  it("reports delta only where a service was actually timed", () => {
    const recent = deriveRecent(
      snapshot({
        recent: [
          { serviceDate: "2026-08-02", plannedMs: 60 * MINUTE, actualMs: 68 * MINUTE, incidentCount: 1 },
          { serviceDate: "2026-07-26", plannedMs: 60 * MINUTE, actualMs: null, incidentCount: 0 },
        ],
      }),
    );
    expect(recent[0].deltaMs).toBe(8 * MINUTE);
    expect(recent[1].deltaMs).toBeNull();
  });
});

describe("the dashboard must not contradict itself", () => {
  const carried = [
    { id: "o1", serviceDate: "2026-05-19", category: "audio", severity: "high", description: "Radio mic 4" },
    { id: "o2", serviceDate: "2026-05-12", category: "lighting", severity: "low", description: "Wash flickers" },
  ];

  it("counts carried-forward incidents in the readiness factor", () => {
    const snap = snapshot({ incidents: [], openItems: carried });
    const readiness = deriveReadiness(
      snap,
      deriveRundownHealth(snap),
      deriveDepartments(snap, "prep"),
      deriveArrivals(snap, getServiceTiming({})),
      "prep",
    );
    const factor = readiness.factors.find((f) => f.id === "incidents");
    // Would previously have read "None logged" while two sat on screen.
    expect(factor?.status).toBe("fail");
    expect(factor?.detail).toBe("1 high-severity incident");
  });

  it("counts carried-forward incidents against their department", () => {
    const departments = deriveDepartments(snapshot({ openItems: carried }), "prep");
    expect(departments.find((d) => d.key === "audio")?.status).toBe("fail");
    expect(departments.find((d) => d.key === "lighting")?.status).toBe("ok");
  });

  it("does not call crew ok merely because a roster exists", () => {
    const snap = snapshot({
      crew: [{ id: "m1", name: "Sam", role: "Audio Engineer", isOnline: false, lastCheckIn: null }],
      assignments: [],
    });
    const readiness = deriveReadiness(
      snap,
      deriveRundownHealth(snap),
      deriveDepartments(snap, "prep"),
      deriveArrivals(snap, getServiceTiming({})),
      "prep",
    );
    const factor = readiness.factors.find((f) => f.id === "crew");
    expect(factor?.status).toBe("warn");
    expect(factor?.detail).toBe("Nobody scheduled yet");
  });

  it("reports no open incidents only when there really are none", () => {
    const snap = snapshot();
    const readiness = deriveReadiness(
      snap,
      deriveRundownHealth(snap),
      deriveDepartments(snap, "prep"),
      deriveArrivals(snap, getServiceTiming({})),
      "prep",
    );
    expect(readiness.factors.find((f) => f.id === "incidents")?.detail).toBe("None open");
  });
});

describe("on the floor", () => {
  it("builds initials from one or two names", () => {
    expect(initialsFor("Jordan Smith")).toBe("JS");
    expect(initialsFor("Jordan")).toBe("J");
    expect(initialsFor("  ada  b  lovelace ")).toBe("AL");
    expect(initialsFor("")).toBe("?");
  });

  it("puts the most recent arrival first", () => {
    const floor = deriveOnFloor(
      snapshot({
        now: START,
        onFloorTotal: 2,
        onFloor: [
          { id: "1", name: "Early Bird", role: "Audio", photoUrl: "", lastCheckIn: new Date(START - 60 * MINUTE).toISOString() },
          { id: "2", name: "Just Arrived", role: "Camera", photoUrl: "", lastCheckIn: new Date(START - 2 * MINUTE).toISOString() },
        ],
      }),
    );
    expect(floor.members.map((m) => m.name)).toEqual(["Just Arrived", "Early Bird"]);
    expect(floor.members[0].sinceMinutes).toBe(2);
    expect(floor.overflow).toBe(0);
  });

  it("reports the overflow when more are in than we fetched photos for", () => {
    const floor = deriveOnFloor(
      snapshot({
        onFloorTotal: 25,
        onFloor: [{ id: "1", name: "Sam", role: "Audio", photoUrl: "", lastCheckIn: null }],
      }),
    );
    expect(floor.total).toBe(25);
    expect(floor.overflow).toBe(24);
  });
});

describe("duty officers", () => {
  it("recognises the names teams actually use", () => {
    expect(dutyKeyFor("Production Manager")).toBe("pm");
    expect(dutyKeyFor("producer")).toBe("pm");
    expect(dutyKeyFor("Tech Director")).toBe("tm");
    expect(dutyKeyFor("TD")).toBe("tm");
    expect(dutyKeyFor("Camera 2")).toBeNull();
  });

  it("matches short forms exactly so they do not swallow other roles", () => {
    expect(dutyKeyFor("TM")).toBe("tm");
    // 'TD' inside a longer role must not claim the technical manager slot.
    expect(dutyKeyFor("Stage TD Assistant")).toBeNull();
  });

  it("always returns both slots, naming the gap when one is unfilled", () => {
    const duty = deriveDuty(
      snapshot({
        assignments: [
          { id: "a1", role: "Producer", crewMemberName: "Rey", status: "confirmed" },
          { id: "a2", role: "Camera 1", crewMemberName: "Sam", status: "assigned" },
        ],
      }),
    );
    expect(duty.map((d) => d.key)).toEqual(["pm", "tm"]);
    expect(duty[0]).toMatchObject({ name: "Rey", status: "confirmed", role: "Producer" });
    expect(duty[1]).toMatchObject({ name: null, status: "open" });
  });

  it("keeps duty roles out of the crew board so nobody is listed twice", () => {
    const snap = snapshot({
      assignments: [
        { id: "a1", role: "Production Manager", crewMemberName: "Rey", status: "confirmed" },
        { id: "a2", role: "Camera 1", crewMemberName: "Sam", status: "assigned" },
      ],
    });
    expect(deriveCrewBoard(snap).positions.map((p) => p.role)).toEqual(["Camera 1"]);
    expect(deriveDuty(snap)[0].name).toBe("Rey");
  });
});
