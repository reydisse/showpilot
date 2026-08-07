/**
 * Production dashboard derivation.
 *
 * Everything the PM dashboard shows is computed here from a plain
 * snapshot. No Prisma types, no server imports, no ambient clock — so
 * every rule below is unit-testable and the same rules can back a
 * kiosk view or the tech dashboard later.
 *
 * The governing rule: a widget earns its place only if a PM would act
 * on it in the next ten minutes. Counts of healthy things are not
 * output; deficits are.
 */

import { computeCascadedTimes } from "@/lib/rundown-timing";
import { getDepartment, type RoleDepartment } from "@/types";
import type { RundownItem } from "@/types/rundown";
import {
  getPhaseCountdown,
  getServicePhase,
  getServiceTiming,
  type PhaseCountdown,
  type ServicePhase,
  type ServiceTiming,
} from "@/lib/service-phase";

const MINUTE_MS = 60_000;

/** Runtime this far past the service window is worth flagging. */
const RUNTIME_TOLERANCE_MS = 5 * MINUTE_MS;

/** Cascaded arrival later than a hard stop by more than this is a conflict. */
const HARD_STOP_TOLERANCE_MS = MINUTE_MS;

/** How long after call time an empty department becomes an alarm. */
const ARRIVAL_ALARM_MS = 20 * MINUTE_MS;

// ─── Snapshot input ──────────────────────────────────────────

export interface SnapshotChecklistItem {
  id: string;
  label: string;
  category: string;
  checked: boolean;
}

export interface SnapshotIncident {
  id: string;
  category: string;
  severity: string;
  description: string;
  reportedBy: string;
}

export interface SnapshotCue {
  id: string;
  cueNumber: number;
  rundownItem: string;
  cameraAssignments: string;
}

export interface SnapshotEquipment {
  id: string;
  name: string;
  category: string;
  status: string;
  nextService: string | null;
}

export interface SnapshotCrew {
  id: string;
  name: string;
  role: string;
  isOnline: boolean;
  lastCheckIn: string | null;
}

export interface SnapshotStreamDestination {
  id: string;
  name: string;
  platform: string;
  enabled: boolean;
}

export interface SnapshotLiveInput {
  id: string;
  name: string;
  status: string;
}

export interface SnapshotNotification {
  id: string;
  title: string;
  message: string;
  severity: string;
}

export interface SnapshotUpcomingService {
  serviceDate: string;
  scheduledStartTime: string | null;
  itemCount: number;
  missingDuration: number;
  missingOwner: number;
}

export interface PmSnapshot {
  serviceDate: string;
  now: number;
  callLeadMinutes: number;
  serviceWindowMinutes: number;
  rundown: { scheduledStartTime: string | null; status: "stopped" | "live" | "complete" } | null;
  items: RundownItem[];
  checklist: SnapshotChecklistItem[];
  incidents: SnapshotIncident[];
  cues: SnapshotCue[];
  equipment: SnapshotEquipment[];
  crew: SnapshotCrew[];
  streamDestinations: SnapshotStreamDestination[];
  liveInputs: SnapshotLiveInput[];
  notifications: SnapshotNotification[];
  upcoming: SnapshotUpcomingService[];
}

// ─── Output ──────────────────────────────────────────────────

export type Health = "ok" | "warn" | "fail";
export type Severity = "critical" | "warning" | "info";

export interface AttentionItem {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  source: "incident" | "equipment" | "rundown" | "checklist" | "stream" | "cue" | "notification";
  actionLabel: string;
  /** Route relative to the org root, e.g. "rundown". */
  actionPath: string;
}

export interface RundownHealth {
  itemCount: number;
  plannedMs: number;
  windowMs: number;
  /** Planned minus window. Positive means the service overruns. */
  deltaMs: number;
  missingDuration: number;
  missingOwner: number;
  hardStopConflicts: number;
  /** Live only: signed drift against plan. Null before anything starts. */
  driftMs: number | null;
  /** Live only: projected wall-clock end. */
  projectedEndMs: number | null;
}

export interface DepartmentStatus {
  key: DepartmentKey;
  label: string;
  status: Health;
  detail: string;
}

export interface ReadinessFactor {
  id: string;
  label: string;
  detail: string;
  status: Health;
  weight: number;
}

export interface Readiness {
  score: number;
  status: Health;
  factors: ReadinessFactor[];
}

export interface ArrivalDepartment {
  key: RoleDepartment;
  label: string;
  present: number;
  total: number;
  alarm: boolean;
}

export interface Arrivals {
  present: number;
  total: number;
  departments: ArrivalDepartment[];
}

export interface DebriefSummary {
  plannedMs: number;
  actualMs: number | null;
  deltaMs: number | null;
  worstOverruns: { id: string; title: string; overrunMs: number }[];
  incidentCount: number;
}

export interface UpcomingService extends SnapshotUpcomingService {
  readiness: number;
  status: Health;
}

export interface PmDashboardModel {
  serviceDate: string;
  phase: ServicePhase;
  timing: ServiceTiming;
  countdown: PhaseCountdown;
  readiness: Readiness;
  rundownHealth: RundownHealth;
  attention: AttentionItem[];
  departments: DepartmentStatus[];
  arrivals: Arrivals;
  cueExceptions: AttentionItem[];
  upcoming: UpcomingService[];
  debrief: DebriefSummary | null;
  hasRundown: boolean;
}

// ─── Departments ─────────────────────────────────────────────

export type DepartmentKey = "audio" | "video" | "lighting" | "stream" | "general";

const DEPARTMENT_LABELS: Record<DepartmentKey, string> = {
  audio: "Audio",
  video: "Video",
  lighting: "Lighting",
  stream: "Stream",
  general: "General",
};

const DEPARTMENT_ORDER: DepartmentKey[] = ["audio", "video", "lighting", "stream", "general"];

/**
 * Checklist, incident and equipment tables each use their own category
 * vocabulary. Fold them into one so a department chip can roll up all
 * three.
 */
export function normalizeCategory(raw: string): DepartmentKey {
  const value = raw.toLowerCase().trim();
  if (value === "audio") return "audio";
  if (value === "video") return "video";
  if (value === "lighting") return "lighting";
  if (value === "stream" || value === "streaming") return "stream";
  return "general";
}

// ─── Rundown health ──────────────────────────────────────────

export function deriveRundownHealth(snapshot: PmSnapshot): RundownHealth {
  const { items, rundown, serviceWindowMinutes, now } = snapshot;

  const plannedMs = items.reduce((sum, item) => sum + Math.max(0, item.duration || 0), 0);
  const windowMs = serviceWindowMinutes * MINUTE_MS;

  const missingDuration = items.filter((item) => !item.duration || item.duration <= 0).length;
  const missingOwner = items.filter((item) => !item.assignee || !item.assignee.trim()).length;

  // Cascading overwrites scheduledStart, so capture the pinned times first.
  const pinned = new Map(items.map((item) => [item.id, item.scheduledStart ?? null]));
  const cascaded = rundown
    ? computeCascadedTimes(items, {
        serviceDate: snapshot.serviceDate,
        scheduledStartTime: rundown.scheduledStartTime,
        status: rundown.status,
      })
    : [];

  let hardStopConflicts = 0;
  for (const item of cascaded) {
    if (!item.hardStop) continue;
    const pinnedStart = pinned.get(item.id);
    if (!pinnedStart || !item.scheduledStart) continue;
    const arrival = new Date(item.scheduledStart).getTime();
    const mustStartBy = new Date(pinnedStart).getTime();
    if (Number.isNaN(arrival) || Number.isNaN(mustStartBy)) continue;
    if (arrival - mustStartBy > HARD_STOP_TOLERANCE_MS) hardStopConflicts += 1;
  }

  // Running drift: how far the items that have actually run diverged
  // from their planned durations. The in-flight item counts too.
  let driftMs: number | null = null;
  const started = items.filter((item) => item.actualStart);
  if (started.length > 0) {
    driftMs = started.reduce((sum, item) => {
      const startMs = new Date(item.actualStart as string).getTime();
      if (Number.isNaN(startMs)) return sum;
      const endMs = item.actualEnd ? new Date(item.actualEnd).getTime() : now;
      if (Number.isNaN(endMs)) return sum;
      return sum + (endMs - startMs - (item.duration || 0));
    }, 0);
  }

  const timing = getServiceTiming({
    scheduledStartTime: rundown?.scheduledStartTime ?? null,
    status: rundown?.status,
    plannedDurationMs: plannedMs,
    callLeadMinutes: snapshot.callLeadMinutes,
    serviceWindowMinutes: snapshot.serviceWindowMinutes,
  });

  const projectedEndMs =
    timing.expectedEndMs !== null && driftMs !== null ? timing.expectedEndMs + driftMs : null;

  return {
    itemCount: items.length,
    plannedMs,
    windowMs,
    deltaMs: plannedMs - windowMs,
    missingDuration,
    missingOwner,
    hardStopConflicts,
    driftMs,
    projectedEndMs,
  };
}

// ─── Attention queue ─────────────────────────────────────────

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function deriveAttentionQueue(
  snapshot: PmSnapshot,
  health: RundownHealth,
  phase: ServicePhase,
): AttentionItem[] {
  const out: AttentionItem[] = [];
  const { incidents, equipment, checklist, streamDestinations, liveInputs, notifications } =
    snapshot;

  for (const incident of incidents) {
    const severity: Severity =
      incident.severity === "high" ? "critical" : incident.severity === "medium" ? "warning" : "info";
    out.push({
      id: `incident:${incident.id}`,
      severity,
      title: incident.description,
      detail: `Incident · ${incident.category} · reported by ${incident.reportedBy || "unknown"}`,
      source: "incident",
      actionLabel: "Open",
      actionPath: "production/incidents",
    });
  }

  const outOfService = equipment.filter((e) => e.status === "out-of-service");
  if (outOfService.length > 0) {
    out.push({
      id: "equipment:out-of-service",
      severity: "critical",
      title: `${plural(outOfService.length, "item")} out of service`,
      detail: outOfService
        .slice(0, 3)
        .map((e) => e.name)
        .join(", "),
      source: "equipment",
      actionLabel: "Review",
      actionPath: "production/assets",
    });
  }

  const needsRepair = equipment.filter(
    (e) => e.status === "needs-repair" || e.status === "in-repair",
  );
  if (needsRepair.length > 0) {
    out.push({
      id: "equipment:needs-repair",
      severity: "warning",
      title: `${plural(needsRepair.length, "item")} needs repair`,
      detail: needsRepair
        .slice(0, 3)
        .map((e) => e.name)
        .join(", "),
      source: "equipment",
      actionLabel: "Review",
      actionPath: "production/assets",
    });
  }

  const serviceDue = equipment.filter((e) => {
    if (!e.nextService) return false;
    const due = new Date(e.nextService).getTime();
    return !Number.isNaN(due) && due <= snapshot.now;
  });
  if (serviceDue.length > 0) {
    out.push({
      id: "equipment:service-due",
      severity: "info",
      title: `${plural(serviceDue.length, "item")} due for service`,
      detail: serviceDue
        .slice(0, 3)
        .map((e) => e.name)
        .join(", "),
      source: "equipment",
      actionLabel: "Review",
      actionPath: "production/assets",
    });
  }

  if (health.itemCount === 0) {
    out.push({
      id: "rundown:empty",
      severity: "critical",
      title: "No rundown for this service",
      detail: "Nothing to run, time, or cue from",
      source: "rundown",
      actionLabel: "Build",
      actionPath: "rundown",
    });
  } else {
    if (health.missingDuration > 0) {
      out.push({
        id: "rundown:missing-duration",
        severity: "critical",
        title: `${plural(health.missingDuration, "rundown item")} without a duration`,
        detail: "Runtime estimate is unreliable until these are set",
        source: "rundown",
        actionLabel: "Fix",
        actionPath: "rundown",
      });
    }
    if (health.hardStopConflicts > 0) {
      out.push({
        id: "rundown:hard-stop",
        severity: "critical",
        title: `${plural(health.hardStopConflicts, "hard stop")} will be missed`,
        detail: "Cascaded timing arrives after the pinned start",
        source: "rundown",
        actionLabel: "Retime",
        actionPath: "rundown",
      });
    }
    if (health.missingOwner > 0) {
      out.push({
        id: "rundown:missing-owner",
        severity: "warning",
        title: `${plural(health.missingOwner, "rundown item")} without an owner`,
        detail: "Nobody is named to run these",
        source: "rundown",
        actionLabel: "Assign",
        actionPath: "rundown",
      });
    }
    if (health.deltaMs > RUNTIME_TOLERANCE_MS) {
      out.push({
        id: "rundown:overrun",
        severity: "warning",
        title: `Rundown runs ${formatMinutes(health.deltaMs)} over the window`,
        detail: `Planned ${formatMinutes(health.plannedMs)} against a ${formatMinutes(health.windowMs)} service`,
        source: "rundown",
        actionLabel: "Trim",
        actionPath: "rundown",
      });
    }
  }

  // Checklists only matter once the service is close enough to act on.
  if (phase === "prep" || phase === "call" || phase === "live") {
    const unchecked = checklist.filter((c) => !c.checked);
    if (unchecked.length > 0) {
      const byCategory = new Map<DepartmentKey, number>();
      for (const entry of unchecked) {
        const key = normalizeCategory(entry.category);
        byCategory.set(key, (byCategory.get(key) ?? 0) + 1);
      }
      for (const [key, count] of byCategory) {
        out.push({
          id: `checklist:${key}`,
          severity: phase === "call" || phase === "live" ? "critical" : "warning",
          title: `${DEPARTMENT_LABELS[key]} checklist ${checklist.length - unchecked.length} of ${checklist.length} done`,
          detail: `${plural(count, "item")} outstanding`,
          source: "checklist",
          actionLabel: "Open",
          actionPath: "production/checklist",
        });
      }
    }
  }

  if (streamDestinations.length > 0) {
    const enabled = streamDestinations.filter((d) => d.enabled);
    if (enabled.length === 0) {
      out.push({
        id: "stream:none-enabled",
        severity: "warning",
        title: "No stream destination enabled",
        detail: `${plural(streamDestinations.length, "destination")} configured, all off`,
        source: "stream",
        actionLabel: "Enable",
        actionPath: "streaming/platforms",
      });
    } else {
      const disabled = streamDestinations.filter((d) => !d.enabled);
      if (disabled.length > 0) {
        out.push({
          id: "stream:some-disabled",
          severity: "info",
          title: `${plural(disabled.length, "destination")} disabled`,
          detail: disabled.map((d) => d.name).join(", "),
          source: "stream",
          actionLabel: "Review",
          actionPath: "streaming/platforms",
        });
      }
    }
  }

  if ((phase === "call" || phase === "live") && liveInputs.length > 0) {
    const connected = liveInputs.filter(
      (i) => i.status === "connected" || i.status === "streaming",
    );
    if (connected.length === 0) {
      out.push({
        id: "stream:no-signal",
        severity: phase === "live" ? "critical" : "warning",
        title: "No encoder connected",
        detail: `${plural(liveInputs.length, "live input")} idle`,
        source: "stream",
        actionLabel: "Check",
        actionPath: "streaming/health",
      });
    }
  }

  for (const notification of notifications) {
    const severity: Severity =
      notification.severity === "critical"
        ? "critical"
        : notification.severity === "warning"
          ? "warning"
          : "info";
    out.push({
      id: `notification:${notification.id}`,
      severity,
      title: notification.title,
      detail: notification.message,
      source: "notification",
      actionLabel: "Dismiss",
      actionPath: "",
    });
  }

  return out.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

/** Cue problems are their own list — they belong to a different fix session. */
export function deriveCueExceptions(snapshot: PmSnapshot): AttentionItem[] {
  const out: AttentionItem[] = [];
  const titles = new Set(snapshot.items.map((i) => i.title.toLowerCase().trim()));

  const unassigned = snapshot.cues.filter((c) => !c.cameraAssignments.trim());
  if (unassigned.length > 0) {
    out.push({
      id: "cue:no-camera",
      severity: "warning",
      title: `${plural(unassigned.length, "cue")} without a camera assignment`,
      detail: unassigned
        .slice(0, 4)
        .map((c) => `#${c.cueNumber}`)
        .join(", "),
      source: "cue",
      actionLabel: "Assign",
      actionPath: "production/cue-sheets",
    });
  }

  const orphans = snapshot.cues.filter(
    (c) => c.rundownItem.trim() && !titles.has(c.rundownItem.toLowerCase().trim()),
  );
  if (orphans.length > 0) {
    out.push({
      id: "cue:orphaned",
      severity: "info",
      title: `${plural(orphans.length, "cue")} not matched to a rundown item`,
      detail: orphans
        .slice(0, 3)
        .map((c) => c.rundownItem)
        .join(", "),
      source: "cue",
      actionLabel: "Reconcile",
      actionPath: "production/cue-sheets",
    });
  }

  return out;
}

// ─── Departments ─────────────────────────────────────────────

export function deriveDepartments(snapshot: PmSnapshot): DepartmentStatus[] {
  return DEPARTMENT_ORDER.map((key) => {
    const incidents = snapshot.incidents.filter((i) => normalizeCategory(i.category) === key);
    const equipment = snapshot.equipment.filter((e) => normalizeCategory(e.category) === key);
    const unchecked = snapshot.checklist.filter(
      (c) => normalizeCategory(c.category) === key && !c.checked,
    );

    const highIncident = incidents.find((i) => i.severity === "high");
    const dead = equipment.find((e) => e.status === "out-of-service");
    if (highIncident) {
      return { key, label: DEPARTMENT_LABELS[key], status: "fail" as Health, detail: highIncident.description };
    }
    if (dead) {
      return { key, label: DEPARTMENT_LABELS[key], status: "fail" as Health, detail: `${dead.name} out of service` };
    }

    const mediumIncident = incidents.find((i) => i.severity === "medium");
    const repair = equipment.find((e) => e.status === "needs-repair" || e.status === "in-repair");
    if (mediumIncident) {
      return { key, label: DEPARTMENT_LABELS[key], status: "warn" as Health, detail: mediumIncident.description };
    }
    if (repair) {
      return { key, label: DEPARTMENT_LABELS[key], status: "warn" as Health, detail: `${repair.name} needs repair` };
    }
    if (unchecked.length > 0) {
      return {
        key,
        label: DEPARTMENT_LABELS[key],
        status: "warn" as Health,
        detail: `${plural(unchecked.length, "check")} outstanding`,
      };
    }

    return { key, label: DEPARTMENT_LABELS[key], status: "ok" as Health, detail: "Clear" };
  });
}

// ─── Arrivals ────────────────────────────────────────────────

export function deriveArrivals(snapshot: PmSnapshot, timing: ServiceTiming): Arrivals {
  const groups = new Map<RoleDepartment, { present: number; total: number }>();
  for (const member of snapshot.crew) {
    const dept = getDepartment(member.role);
    const current = groups.get(dept) ?? { present: 0, total: 0 };
    current.total += 1;
    if (member.isOnline) current.present += 1;
    groups.set(dept, current);
  }

  const pastCallBy =
    timing.callTimeMs === null ? null : snapshot.now - timing.callTimeMs;
  const alarmActive = pastCallBy !== null && pastCallBy > ARRIVAL_ALARM_MS;

  const departments: ArrivalDepartment[] = [...groups.entries()]
    .map(([key, value]) => ({
      key,
      label: key.charAt(0).toUpperCase() + key.slice(1),
      present: value.present,
      total: value.total,
      alarm: alarmActive && value.present === 0 && value.total > 0,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  return {
    present: snapshot.crew.filter((m) => m.isOnline).length,
    total: snapshot.crew.length,
    departments,
  };
}

// ─── Readiness ───────────────────────────────────────────────

const HEALTH_VALUE: Record<Health, number> = { ok: 1, warn: 0.5, fail: 0 };

export function deriveReadiness(
  snapshot: PmSnapshot,
  health: RundownHealth,
  departments: DepartmentStatus[],
  arrivals: Arrivals,
  phase: ServicePhase,
): Readiness {
  const factors: ReadinessFactor[] = [];

  // Rundown
  if (health.itemCount === 0) {
    factors.push({ id: "rundown", label: "Rundown", detail: "No items", status: "fail", weight: 25 });
  } else if (health.missingDuration > 0 || health.hardStopConflicts > 0) {
    factors.push({
      id: "rundown",
      label: "Rundown",
      detail:
        health.missingDuration > 0
          ? `${plural(health.missingDuration, "item")} without a duration`
          : `${plural(health.hardStopConflicts, "hard stop")} will be missed`,
      status: "fail",
      weight: 25,
    });
  } else if (health.missingOwner > 0 || health.deltaMs > RUNTIME_TOLERANCE_MS) {
    factors.push({
      id: "rundown",
      label: "Rundown",
      detail:
        health.deltaMs > RUNTIME_TOLERANCE_MS
          ? `${formatMinutes(health.deltaMs)} over the window`
          : `${plural(health.missingOwner, "item")} without an owner`,
      status: "warn",
      weight: 25,
    });
  } else {
    factors.push({
      id: "rundown",
      label: "Rundown",
      detail: `${plural(health.itemCount, "item")}, ${formatMinutes(health.plannedMs)}`,
      status: "ok",
      weight: 25,
    });
  }

  // Checklist
  const total = snapshot.checklist.length;
  const done = snapshot.checklist.filter((c) => c.checked).length;
  if (total === 0) {
    factors.push({
      id: "checklist",
      label: "Checklist",
      detail: "No checklist configured",
      status: "warn",
      weight: 20,
    });
  } else {
    const ratio = done / total;
    factors.push({
      id: "checklist",
      label: "Checklist",
      detail: `${done} of ${total} done`,
      status: ratio === 1 ? "ok" : ratio >= 0.5 ? "warn" : "fail",
      weight: 20,
    });
  }

  // Equipment
  const dead = snapshot.equipment.filter((e) => e.status === "out-of-service").length;
  const repair = snapshot.equipment.filter(
    (e) => e.status === "needs-repair" || e.status === "in-repair",
  ).length;
  factors.push({
    id: "equipment",
    label: "Equipment",
    detail: dead > 0 ? `${plural(dead, "item")} out of service` : repair > 0 ? `${plural(repair, "item")} needs repair` : "All operational",
    status: dead > 0 ? "fail" : repair > 0 ? "warn" : "ok",
    weight: 15,
  });

  // Incidents
  const high = snapshot.incidents.filter((i) => i.severity === "high").length;
  const open = snapshot.incidents.length;
  factors.push({
    id: "incidents",
    label: "Incidents",
    detail: high > 0 ? `${plural(high, "high-severity incident")}` : open > 0 ? `${plural(open, "incident")} logged` : "None logged",
    status: high > 0 ? "fail" : open > 0 ? "warn" : "ok",
    weight: 15,
  });

  // Stream
  const enabled = snapshot.streamDestinations.filter((d) => d.enabled).length;
  if (snapshot.streamDestinations.length === 0) {
    factors.push({
      id: "stream",
      label: "Stream",
      detail: "No destinations configured",
      status: "warn",
      weight: 10,
    });
  } else {
    factors.push({
      id: "stream",
      label: "Stream",
      detail: enabled > 0 ? `${plural(enabled, "destination")} enabled` : "All destinations off",
      status: enabled > 0 ? "ok" : "fail",
      weight: 10,
    });
  }

  // Crew — only a readiness signal once people are expected on site.
  if (phase === "call" || phase === "live") {
    const alarmed = arrivals.departments.filter((d) => d.alarm).length;
    factors.push({
      id: "crew",
      label: "Crew",
      detail: `${arrivals.present} of ${arrivals.total} checked in`,
      status: alarmed > 0 ? "fail" : arrivals.present < arrivals.total ? "warn" : "ok",
      weight: 15,
    });
  } else {
    factors.push({
      id: "crew",
      label: "Crew",
      detail: arrivals.total === 0 ? "No crew on the roster" : `${plural(arrivals.total, "member")} on the roster`,
      status: arrivals.total === 0 ? "fail" : "ok",
      weight: 15,
    });
  }

  const totalWeight = factors.reduce((sum, f) => sum + f.weight, 0);
  const earned = factors.reduce((sum, f) => sum + f.weight * HEALTH_VALUE[f.status], 0);
  const score = totalWeight === 0 ? 0 : Math.round((earned / totalWeight) * 100);

  const worst = departments.some((d) => d.status === "fail") || factors.some((f) => f.status === "fail");
  const status: Health = worst ? "fail" : factors.some((f) => f.status === "warn") ? "warn" : "ok";

  return { score, status, factors };
}

// ─── Debrief ─────────────────────────────────────────────────

export function deriveDebrief(snapshot: PmSnapshot, health: RundownHealth): DebriefSummary | null {
  const ran = snapshot.items.filter((i) => i.actualStart && i.actualEnd);
  if (ran.length === 0) return null;

  const starts = ran.map((i) => new Date(i.actualStart as string).getTime()).filter((n) => !Number.isNaN(n));
  const ends = ran.map((i) => new Date(i.actualEnd as string).getTime()).filter((n) => !Number.isNaN(n));
  const actualMs = starts.length && ends.length ? Math.max(...ends) - Math.min(...starts) : null;

  const worstOverruns = ran
    .map((item) => {
      const startMs = new Date(item.actualStart as string).getTime();
      const endMs = new Date(item.actualEnd as string).getTime();
      return {
        id: item.id,
        title: item.title,
        overrunMs: endMs - startMs - (item.duration || 0),
      };
    })
    .filter((entry) => entry.overrunMs > 0)
    .sort((a, b) => b.overrunMs - a.overrunMs)
    .slice(0, 3);

  return {
    plannedMs: health.plannedMs,
    actualMs,
    deltaMs: actualMs === null ? null : actualMs - health.plannedMs,
    worstOverruns,
    incidentCount: snapshot.incidents.length,
  };
}

// ─── Upcoming ────────────────────────────────────────────────

export function deriveUpcoming(snapshot: PmSnapshot): UpcomingService[] {
  return snapshot.upcoming.map((service) => {
    if (service.itemCount === 0) {
      return { ...service, readiness: 0, status: "fail" as Health };
    }
    const complete =
      service.itemCount * 2 - service.missingDuration - service.missingOwner;
    const ratio = Math.max(0, complete) / (service.itemCount * 2);
    const hasStart = service.scheduledStartTime !== null;
    const readiness = Math.round(ratio * (hasStart ? 100 : 70));
    return {
      ...service,
      readiness,
      status: readiness >= 90 ? ("ok" as Health) : readiness >= 50 ? ("warn" as Health) : ("fail" as Health),
    };
  });
}

// ─── Top level ───────────────────────────────────────────────

export function derivePmDashboard(snapshot: PmSnapshot): PmDashboardModel {
  const rundownHealth = deriveRundownHealth(snapshot);

  const phaseInput = {
    scheduledStartTime: snapshot.rundown?.scheduledStartTime ?? null,
    status: snapshot.rundown?.status,
    plannedDurationMs: rundownHealth.plannedMs,
    callLeadMinutes: snapshot.callLeadMinutes,
    serviceWindowMinutes: snapshot.serviceWindowMinutes,
  };

  const phase = getServicePhase(phaseInput, snapshot.now);
  const timing = getServiceTiming(phaseInput);
  const countdown = getPhaseCountdown(phase, timing, snapshot.now);

  const departments = deriveDepartments(snapshot);
  const arrivals = deriveArrivals(snapshot, timing);

  return {
    serviceDate: snapshot.serviceDate,
    phase,
    timing,
    countdown,
    readiness: deriveReadiness(snapshot, rundownHealth, departments, arrivals, phase),
    rundownHealth,
    attention: deriveAttentionQueue(snapshot, rundownHealth, phase),
    departments,
    arrivals,
    cueExceptions: deriveCueExceptions(snapshot),
    upcoming: deriveUpcoming(snapshot),
    debrief: phase === "debrief" ? deriveDebrief(snapshot, rundownHealth) : null,
    hasRundown: snapshot.rundown !== null || snapshot.items.length > 0,
  };
}

// ─── Formatting ──────────────────────────────────────────────

export function formatMinutes(ms: number): string {
  const totalMinutes = Math.round(Math.abs(ms) / MINUTE_MS);
  const sign = ms < 0 ? "-" : "";
  if (totalMinutes < 60) return `${sign}${totalMinutes} min`;
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return m === 0 ? `${sign}${h}h` : `${sign}${h}h ${m}m`;
}

export function formatCountdown(ms: number): string {
  const abs = Math.abs(ms);
  const totalSeconds = Math.floor(abs / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (days > 0) return `${days}d ${pad(hours)}:${pad(minutes)}`;
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}
