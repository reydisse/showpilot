/**
 * Tech manager derivation rules.
 *
 * The two failure modes this dashboard exists to prevent are a fault
 * nobody has picked up and a fault two people are both working on. Most
 * of what follows pins the first one, because it is the silent one.
 */

import { describe, expect, it } from "vitest";
import {
  STALE_ACK_MS,
  deriveChecks,
  deriveDevices,
  deriveEquipmentFaults,
  deriveFaults,
  deriveSignalPath,
  deriveTmDashboard,
  type TmIncident,
  type TmSnapshot,
} from "@/lib/tm-dashboard-derive";

const MINUTE = 60_000;
const NOW = new Date("2026-08-16T10:00:00.000Z").getTime();
const VIEWER = "user-ama";

function incident(overrides: Partial<TmIncident> & { id: string }): TmIncident {
  return {
    category: "audio",
    severity: "medium",
    description: "Something is wrong",
    reportedBy: "Sam",
    serviceDate: "2026-08-16",
    reportedAt: NOW - 5 * MINUTE,
    status: "open",
    assignedTo: null,
    assignedName: "",
    acknowledgedAt: null,
    ...overrides,
  };
}

function snapshot(overrides: Partial<TmSnapshot> = {}): TmSnapshot {
  return {
    serviceDate: "2026-08-16",
    now: NOW,
    phase: "live",
    viewerId: VIEWER,
    incidents: [],
    equipment: [],
    checklist: [],
    streamDestinations: [],
    liveInputs: [],
    devices: [],
    streamingConfigured: true,
    duty: [],
    ...overrides,
  };
}

describe("deriveFaults", () => {
  it("leaves resolved faults out entirely", () => {
    const faults = deriveFaults(
      snapshot({ incidents: [incident({ id: "i1", status: "resolved" })] }),
    );
    expect(faults).toHaveLength(0);
  });

  it("puts an unowned fault above an owned one of the same severity", () => {
    // The whole point. A fault someone is already on is not the one that
    // needs the tech manager's attention.
    const faults = deriveFaults(
      snapshot({
        incidents: [
          incident({ id: "owned", assignedTo: "user-kojo", assignedName: "Kojo" }),
          incident({ id: "unowned" }),
        ],
      }),
    );
    expect(faults.map((f) => f.id)).toEqual(["unowned", "owned"]);
  });

  it("still ranks severity above ownership", () => {
    // An unowned trivial niggle must not outrank a critical fault that
    // someone happens to have claimed.
    const faults = deriveFaults(
      snapshot({
        incidents: [
          incident({ id: "low", severity: "low" }),
          incident({
            id: "high",
            severity: "high",
            assignedTo: "user-kojo",
            assignedName: "Kojo",
            acknowledgedAt: NOW,
          }),
        ],
      }),
    );
    expect(faults.map((f) => f.id)).toEqual(["high", "low"]);
  });

  it("breaks ties by age, oldest first", () => {
    const faults = deriveFaults(
      snapshot({
        incidents: [
          incident({ id: "recent", reportedAt: NOW - MINUTE }),
          incident({ id: "old", reportedAt: NOW - 30 * MINUTE }),
        ],
      }),
    );
    expect(faults.map((f) => f.id)).toEqual(["old", "recent"]);
  });

  it("marks the viewer's own faults so the queue can say what is theirs", () => {
    const faults = deriveFaults(
      snapshot({
        incidents: [
          incident({ id: "mine", assignedTo: VIEWER, assignedName: "Ama" }),
          incident({ id: "theirs", assignedTo: "user-kojo", assignedName: "Kojo" }),
          incident({ id: "nobody" }),
        ],
      }),
    );
    const byId = new Map(faults.map((f) => [f.id, f.ownership]));
    expect(byId.get("mine")).toBe("mine");
    expect(byId.get("theirs")).toBe("someone-else");
    expect(byId.get("nobody")).toBe("unassigned");
  });

  it("treats a claimed but never-acknowledged fault as unowned once it goes stale", () => {
    // Claiming a fault and actually looking at it are different things.
    // "Assigned eleven minutes ago, never acknowledged" is the state a
    // tech manager has to be able to see.
    const stale = deriveFaults(
      snapshot({
        incidents: [
          incident({
            id: "claimed",
            assignedTo: "user-kojo",
            assignedName: "Kojo",
            reportedAt: NOW - STALE_ACK_MS - MINUTE,
          }),
        ],
      }),
    );
    expect(stale[0].stale).toBe(true);
  });

  it("does not call a fault stale once someone has acknowledged it", () => {
    const faults = deriveFaults(
      snapshot({
        incidents: [
          incident({
            id: "claimed",
            assignedTo: "user-kojo",
            assignedName: "Kojo",
            reportedAt: NOW - STALE_ACK_MS - MINUTE,
            acknowledgedAt: NOW - MINUTE,
          }),
        ],
      }),
    );
    expect(faults[0].stale).toBe(false);
  });

  it("flags a fault carried over from an earlier service", () => {
    const faults = deriveFaults(
      snapshot({ incidents: [incident({ id: "old", serviceDate: "2026-05-19" })] }),
    );
    expect(faults[0].carriedForward).toBe(true);
  });

  it("counts stale claims as unowned in the summary", () => {
    const model = deriveTmDashboard(
      snapshot({
        incidents: [
          incident({ id: "mine", assignedTo: VIEWER, assignedName: "Ama", acknowledgedAt: NOW }),
          incident({
            id: "stale",
            assignedTo: "user-kojo",
            assignedName: "Kojo",
            reportedAt: NOW - STALE_ACK_MS - MINUTE,
          }),
        ],
      }),
    );
    expect(model.openCount).toBe(2);
    expect(model.mineCount).toBe(1);
    expect(model.unownedCount).toBe(1);
  });
});

describe("deriveSignalPath", () => {
  it("says nothing at all when the org has never configured streaming", () => {
    // A church that does not stream must not see a permanent red banner
    // about a feature it has deliberately never touched.
    const path = deriveSignalPath(snapshot({ streamingConfigured: false }));
    expect(path.status).toBeNull();
    expect(path.destinations).toHaveLength(0);
  });

  it("fails when destinations exist but none are enabled", () => {
    const path = deriveSignalPath(
      snapshot({
        streamDestinations: [
          { id: "d1", name: "YouTube", platform: "youtube", enabled: false, connected: false },
        ],
      }),
    );
    expect(path.status).toBe("fail");
    expect(path.detail).toContain("none enabled");
  });

  it("fails when an enabled destination is not connected", () => {
    const path = deriveSignalPath(
      snapshot({
        streamDestinations: [
          { id: "d1", name: "YouTube", platform: "youtube", enabled: true, connected: false },
        ],
      }),
    );
    expect(path.status).toBe("fail");
    expect(path.detail).toContain("YouTube");
  });

  it("ignores an idle encoder before call time", () => {
    // Nobody has switched it on yet, which during planning is simply
    // Tuesday, not a fault.
    const path = deriveSignalPath(
      snapshot({
        phase: "planning",
        liveInputs: [{ id: "l1", name: "Booth", status: "idle" }],
        streamDestinations: [
          { id: "d1", name: "YouTube", platform: "youtube", enabled: true, connected: true },
        ],
      }),
    );
    expect(path.status).toBe("ok");
  });

  it("warns about an idle encoder once the crew is on site", () => {
    const path = deriveSignalPath(
      snapshot({
        phase: "call",
        liveInputs: [{ id: "l1", name: "Booth", status: "idle" }],
        streamDestinations: [
          { id: "d1", name: "YouTube", platform: "youtube", enabled: true, connected: true },
        ],
      }),
    );
    expect(path.status).toBe("warn");
    expect(path.detail).toContain("Booth");
  });
});

describe("deriveChecks", () => {
  const checklist = [
    { id: "c1", label: "Line check", category: "audio", checked: false },
    { id: "c2", label: "Gain structure", category: "audio", checked: false },
    { id: "c3", label: "Cameras", category: "video", checked: true },
  ];

  it("stays quiet until the crew is due on site", () => {
    for (const phase of ["planning", "prep"] as const) {
      expect(deriveChecks(snapshot({ phase, checklist }))).toHaveLength(0);
    }
  });

  it("reports outstanding checks per department from call time", () => {
    const checks = deriveChecks(snapshot({ phase: "call", checklist }));
    const audio = checks.find((check) => check.key === "audio");
    expect(audio?.outstanding).toBe(2);
    expect(checks.find((check) => check.key === "video")?.status).toBe("ok");
  });

  it("omits departments with no checks rather than showing them green", () => {
    const checks = deriveChecks(snapshot({ phase: "call", checklist }));
    expect(checks.some((check) => check.key === "lighting")).toBe(false);
  });
});

describe("deriveEquipmentFaults", () => {
  it("reports only kit that needs a human, worst first", () => {
    const faults = deriveEquipmentFaults(
      snapshot({
        equipment: [
          { id: "e1", name: "X32", category: "audio", status: "needs-repair", nextServiceMs: null },
          { id: "e2", name: "ATEM", category: "video", status: "operational", nextServiceMs: null },
          { id: "e3", name: "Cam 2", category: "video", status: "out-of-service", nextServiceMs: null },
        ],
      }),
    );
    expect(faults.map((f) => f.name)).toEqual(["Cam 2", "X32"]);
  });
});

describe("deriveDevices", () => {
  it("hides device modules the org has never set up", () => {
    // A module that ships in the codebase but was never configured is
    // not a device that is down — it is a device they do not own.
    const devices = deriveDevices(
      snapshot({
        devices: [
          { id: "d1", name: "ATEM", kind: "atem", lastSeenMs: NOW, configured: true },
          { id: "d2", name: "vMix", kind: "vmix", lastSeenMs: null, configured: false },
        ],
      }),
    );
    expect(devices.map((device) => device.name)).toEqual(["ATEM"]);
  });
});

describe("fault age", () => {
  // The queue deliberately carries old faults forward, so a very large
  // age is the normal case rather than an edge one. Probed against the
  // real database, a May fault read "8515m".
  it("keeps ageMinutes as raw minutes for the view to format", () => {
    const faults = deriveFaults(
      snapshot({ incidents: [incident({ id: "old", reportedAt: NOW - 141 * 60 * MINUTE })] }),
    );
    expect(faults[0].ageMinutes).toBe(141 * 60);
  });
});
