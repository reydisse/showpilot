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

/** Someone currently checked in. Photos are only loaded for these. */
export interface SnapshotOnFloorMember {
  id: string;
  name: string;
  role: string;
  photoUrl: string;
  lastCheckIn: string | null;
}

/**
 * The org's weekly on-duty roster (roster_assignment, migration 0005),
 * which predates ServiceAssignment and is the authoritative source.
 */
export interface SnapshotRosterDuty {
  weekStart: string;
  pm: { id: string; name: string } | null;
  tm: { id: string; name: string } | null;
}

export interface SnapshotAssignment {
  id: string;
  role: string;
  crewMemberName: string | null;
  status: string;
}

/** An incident still open from a service before this one. */
export interface SnapshotOpenItem {
  id: string;
  serviceDate: string;
  category: string;
  severity: string;
  description: string;
}

export interface SnapshotRecentService {
  serviceDate: string;
  plannedMs: number;
  actualMs: number | null;
  incidentCount: number;
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
  /** False means the org never chose a window — do not judge runtime. */
  serviceWindowConfigured: boolean;
  /** Most recent service before today, for the plan-next state. */
  lastServiceDate: string | null;
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
  assignments: SnapshotAssignment[];
  openItems: SnapshotOpenItem[];
  recent: SnapshotRecentService[];
  onFloor: SnapshotOnFloorMember[];
  /** Checked-in count before the photo query's cap was applied. */
  onFloorTotal: number;
  /**
   * Whether this org has ever assigned anyone to any service. False
   * means scheduling is not part of how they work (or the feature does
   * not exist for them yet) — so it must not be scored.
   */
  schedulingInUse: boolean;
  rosterDuty: SnapshotRosterDuty;
  /** Org members eligible to be named on duty. */
  orgMembers: { id: string; name: string }[];
}

// ─── Output ──────────────────────────────────────────────────

export type Health = "ok" | "warn" | "fail";
export type Severity = "critical" | "warning" | "info";

export interface AttentionItem {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  source:
    | "incident"
    | "equipment"
    | "rundown"
    | "checklist"
    | "stream"
    | "cue"
    | "notification"
    | "crew";
  actionLabel: string;
  /** Route relative to the org root, e.g. "rundown". */
  actionPath: string;
}

export interface RundownHealth {
  itemCount: number;
  plannedMs: number;
  /** Null when the org has not configured a service length. */
  windowMs: number | null;
  /** Planned minus window, or null when there is no window to judge against. */
  deltaMs: number | null;
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

export interface OnFloorMember {
  id: string;
  name: string;
  role: string;
  photoUrl: string;
  initials: string;
  /** Minutes since check-in. Null when the timestamp is missing. */
  sinceMinutes: number | null;
}

export interface OnFloor {
  members: OnFloorMember[];
  total: number;
  /** People checked in beyond the ones we have avatars for. */
  overflow: number;
}

export type DutyKey = "pm" | "tm";

export interface DutyOfficer {
  key: DutyKey;
  label: string;
  name: string | null;
  /** The role string as the org actually wrote it, e.g. "Tech Director". */
  role: string;
  status: CrewPosition["status"];
  /**
   * Where the name came from. "roster" is the org's weekly rota and wins;
   * "service" is a per-service override set from this dashboard.
   */
  source: "roster" | "service" | null;
  /** User id when it came from the roster — drives the picker's value. */
  userId: string | null;
}

export interface CrewPosition {
  id: string;
  role: string;
  name: string | null;
  status: "confirmed" | "assigned" | "declined" | "open";
}

export interface RosterMember {
  id: string;
  name: string;
  role: string;
}

export interface CrewBoard {
  positions: CrewPosition[];
  total: number;
  confirmed: number;
  unconfirmed: number;
  declined: number;
  open: number;
  /** False when the org has never scheduled anyone for this service. */
  scheduled: boolean;
}

export interface OpenItem extends SnapshotOpenItem {
  /** Whole days between that service and the one on screen. */
  ageDays: number;
}

export interface RecentService extends SnapshotRecentService {
  deltaMs: number | null;
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
  /** True when nothing is scheduled ahead — the dashboard plans instead. */
  planNext: boolean;
  lastServiceDate: string | null;
  crew: CrewBoard;
  duty: DutyOfficer[];
  /** Sunday of the week the on-screen service falls in. */
  dutyWeekStart: string;
  /** Org members eligible to be named on duty. */
  orgMembers: { id: string; name: string }[];
  /** The whole crew roster, for inline assignment controls. */
  roster: RosterMember[];
  schedulingInUse: boolean;
  openItems: OpenItem[];
  recent: RecentService[];
  onFloor: OnFloor;
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
 * Pre-service checks are only meaningful once crew is expected on site.
 * Before that they are a to-do list, not a deficit, and treating them as
 * one turns every department chip yellow a day early.
 */
export function checklistIsDue(phase: ServicePhase): boolean {
  return phase === "call" || phase === "live";
}

/**
 * Checklist, incident and equipment tables each use their own category
 * vocabulary. Fold them into one so a department chip can roll up all
 * three.
 */
export function normalizeCategory(raw: string): DepartmentKey {
  const value = raw.toLowerCase().trim();
  if (value === "audio") return "audio";
  // The onboarding templates seed "visuals" for ProPresenter work, which
  // belongs with video rather than in the general bucket.
  if (value === "video" || value === "visuals") return "video";
  if (value === "lighting") return "lighting";
  if (value === "stream" || value === "streaming") return "stream";
  return "general";
}

/** True only when a real, org-chosen window is being overrun. */
export function overrunsWindow(health: RundownHealth): boolean {
  return health.deltaMs !== null && health.deltaMs > RUNTIME_TOLERANCE_MS;
}

// ─── Rundown health ──────────────────────────────────────────

export function deriveRundownHealth(snapshot: PmSnapshot): RundownHealth {
  const { items, rundown, serviceWindowMinutes, now } = snapshot;

  const plannedMs = items.reduce((sum, item) => sum + Math.max(0, item.duration || 0), 0);
  const windowMs = snapshot.serviceWindowConfigured ? serviceWindowMinutes * MINUTE_MS : null;

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
    deltaMs: windowMs === null ? null : plannedMs - windowMs,
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
  crew: CrewBoard = emptyCrewBoard(),
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

  // An empty rundown during planning is not an incident, it is the normal
  // starting point — the plan-next widget carries that ask, so the queue
  // stays quiet rather than saying the same thing twice on one screen.
  if (health.itemCount === 0) {
    if (phase !== "planning" && phase !== "prep") {
      out.push({
        id: "rundown:empty",
        severity: "critical",
        title: "No rundown for this service",
        detail: "Nothing to run, time, or cue from",
        source: "rundown",
        actionLabel: "Build",
        actionPath: "rundown",
      });
    }
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
    if (health.deltaMs !== null && health.windowMs !== null && health.deltaMs > RUNTIME_TOLERANCE_MS) {
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

  // Pre-service checks are not a problem until crew is on site — flagging
  // an unticked line check the day before is noise, not information. One
  // consolidated row, never one per department; the department strip
  // already carries the per-department breakdown.
  if (checklistIsDue(phase)) {
    const unchecked = checklist.filter((c) => !c.checked);
    if (unchecked.length > 0) {
      const departments = [...new Set(unchecked.map((c) => normalizeCategory(c.category)))]
        .map((key) => DEPARTMENT_LABELS[key].toLowerCase())
        .join(", ");
      out.push({
        id: "checklist:outstanding",
        severity: "critical",
        title: `Checklist ${checklist.length - unchecked.length} of ${checklist.length} done`,
        detail: `${plural(unchecked.length, "item")} outstanding across ${departments}`,
        source: "checklist",
        actionLabel: "Open",
        actionPath: "production/checklist",
      });
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

  // Crew. Open positions escalate as the service approaches: a gap on
  // Tuesday is a task, the same gap at call time is a failure.
  if (crew.scheduled) {
    if (crew.open > 0) {
      out.push({
        id: "crew:open",
        severity: phase === "call" || phase === "live" ? "critical" : "warning",
        title: `${plural(crew.open, "position")} unfilled`,
        detail: crew.positions
          .filter((p) => p.status === "open")
          .slice(0, 4)
          .map((p) => p.role)
          .join(", "),
        source: "crew",
        actionLabel: "Fill",
        actionPath: "team",
      });
    }
    if (crew.declined > 0) {
      out.push({
        id: "crew:declined",
        severity: "critical",
        title: `${plural(crew.declined, "person")} declined`,
        detail: crew.positions
          .filter((p) => p.status === "declined")
          .slice(0, 4)
          .map((p) => `${p.name ?? "Someone"} — ${p.role}`)
          .join(", "),
        source: "crew",
        actionLabel: "Replace",
        actionPath: "team",
      });
    }
    // Unconfirmed only matters once the service is close enough that
    // silence is meaningful.
    if (crew.unconfirmed > 0 && phase !== "planning") {
      out.push({
        id: "crew:unconfirmed",
        severity: phase === "call" || phase === "live" ? "critical" : "warning",
        title: `${plural(crew.unconfirmed, "person")} not confirmed`,
        detail: crew.positions
          .filter((p) => p.status === "assigned")
          .slice(0, 4)
          .map((p) => p.name ?? p.role)
          .join(", "),
        source: "crew",
        actionLabel: "Chase",
        actionPath: "team",
      });
    }
  }

  // Setup nudges. Features the org has never configured are excluded from
  // the readiness score — a church that does not livestream should be able
  // to reach 100%. They surface here instead, at info level, so the
  // capability is still discoverable. Suppressed once crew is on site;
  // nobody configures a checklist thirty minutes before a service.
  if (phase === "planning" || phase === "prep") {
    if (checklist.length === 0) {
      out.push({
        id: "setup:checklist",
        severity: "info",
        title: "No pre-service checklist",
        detail: "Checks the crew ticks off before the service starts",
        source: "checklist",
        actionLabel: "Set up",
        actionPath: "production/checklist",
      });
    }
    if (!crew.scheduled && snapshot.crew.length > 0) {
      out.push({
        id: "setup:crew",
        severity: "info",
        title: "Nobody scheduled for this service",
        detail: `${plural(snapshot.crew.length, "person")} on the roster and no positions assigned yet`,
        source: "crew",
        actionLabel: "Schedule",
        actionPath: "team",
      });
    }
    if (streamDestinations.length === 0) {
      out.push({
        id: "setup:stream",
        severity: "info",
        title: "No stream destination",
        detail: "Add one if this service goes out to YouTube, Facebook or an RTMP endpoint",
        source: "stream",
        actionLabel: "Set up",
        actionPath: "streaming/platforms",
      });
    }
    if (health.itemCount > 0 && health.windowMs === null) {
      out.push({
        id: "setup:service-window",
        severity: "info",
        title: "No service length set",
        detail: `Planned runtime is ${formatMinutes(health.plannedMs)}. Set a target and the dashboard will flag overruns.`,
        source: "rundown",
        actionLabel: "Settings",
        actionPath: "settings",
      });
    }
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

export function deriveDepartments(
  snapshot: PmSnapshot,
  phase: ServicePhase,
): DepartmentStatus[] {
  // Carried-forward incidents count against a department exactly like
  // one logged today. A radio mic that broke in May is still broken.
  const allIncidents = [
    ...snapshot.incidents,
    ...snapshot.openItems.map((o) => ({
      id: o.id,
      category: o.category,
      severity: o.severity,
      description: o.description,
      reportedBy: "",
    })),
  ];

  return DEPARTMENT_ORDER.map((key) => {
    const incidents = allIncidents.filter((i) => normalizeCategory(i.category) === key);
    const equipment = snapshot.equipment.filter((e) => normalizeCategory(e.category) === key);
    const unchecked = checklistIsDue(phase)
      ? snapshot.checklist.filter((c) => normalizeCategory(c.category) === key && !c.checked)
      : [];

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

// ─── Duty officers ───────────────────────────────────────────

/**
 * Every team names these two differently — "Producer", "Service
 * Producer", "Tech Director", "TD". Exact matches first, then phrase
 * containment; short forms are only ever matched exactly so "TD" does
 * not swallow "Stage TD Assistant".
 */
const DUTY_EXACT: Record<string, DutyKey> = {
  pm: "pm",
  producer: "pm",
  "production manager": "pm",
  "service producer": "pm",
  tm: "tm",
  td: "tm",
  "tech manager": "tm",
  "tech director": "tm",
  "technical manager": "tm",
  "technical director": "tm",
};

const DUTY_PHRASES: [string, DutyKey][] = [
  ["production manager", "pm"],
  ["service producer", "pm"],
  ["technical manager", "tm"],
  ["technical director", "tm"],
  ["tech director", "tm"],
  ["tech manager", "tm"],
];

export function dutyKeyFor(role: string): DutyKey | null {
  const value = role.toLowerCase().trim();
  if (value in DUTY_EXACT) return DUTY_EXACT[value];
  for (const [phrase, key] of DUTY_PHRASES) {
    if (value.includes(phrase)) return key;
  }
  return null;
}

const DUTY_LABELS: Record<DutyKey, string> = {
  pm: "Production manager",
  tm: "Technical manager",
};

/** Sunday of the week a date falls in, matching the roster admin's snapSunday. */
export function weekStartFor(serviceDate: string): string {
  const d = new Date(`${serviceDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return serviceDate;
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d.toISOString().slice(0, 10);
}

/**
 * Who is running the service. Always returns both slots, because an
 * unnamed one is the useful information — a Sunday with no technical
 * manager is a problem you want to see, not an absent row.
 *
 * The org's weekly roster wins. It predates this dashboard, it is what
 * the kiosk on-duty board already shows, and two screens disagreeing
 * about who is running the service would be worse than either. A
 * per-service assignment is only consulted when the week is unset.
 */
export function deriveDuty(snapshot: PmSnapshot): DutyOfficer[] {
  return (["pm", "tm"] as DutyKey[]).map((key) => {
    const fromRoster = snapshot.rosterDuty[key];
    if (fromRoster) {
      return {
        key,
        label: DUTY_LABELS[key],
        name: fromRoster.name,
        role: DUTY_LABELS[key],
        // The weekly roster carries no confirmation state; being on the
        // rota is the commitment.
        status: "confirmed" as const,
        source: "roster" as const,
        userId: fromRoster.id,
      };
    }

    const match = snapshot.assignments.find((a) => dutyKeyFor(a.role) === key);
    if (!match || !match.crewMemberName) {
      return {
        key,
        label: DUTY_LABELS[key],
        name: null,
        role: DUTY_LABELS[key],
        status: "open" as const,
        source: null,
        userId: null,
      };
    }
    const status: CrewPosition["status"] =
      match.status === "confirmed"
        ? "confirmed"
        : match.status === "declined"
          ? "declined"
          : "assigned";
    return {
      key,
      label: DUTY_LABELS[key],
      name: match.crewMemberName,
      role: match.role,
      status,
      source: "service" as const,
      userId: null,
    };
  });
}

// ─── Crew board ──────────────────────────────────────────────

const DAY_MS = 24 * 60 * MINUTE_MS;

/**
 * Who is on for this service. An assignment with no crew member is an
 * open position — the thing a PM chases all week — and "assigned but not
 * confirmed" is deliberately distinct from confirmed, because the gap
 * between the two is where Sunday mornings go wrong.
 */
export function deriveCrewBoard(snapshot: PmSnapshot): CrewBoard {
  // Duty officers get their own card; listing them here too would say
  // the same thing twice on one screen.
  const positions: CrewPosition[] = snapshot.assignments
    .filter((a) => dutyKeyFor(a.role) === null)
    .map((a) => {
      let status: CrewPosition["status"];
      if (!a.crewMemberName) status = "open";
      else if (a.status === "confirmed") status = "confirmed";
      else if (a.status === "declined") status = "declined";
      else status = "assigned";
      return { id: a.id, role: a.role, name: a.crewMemberName, status };
    });

  const count = (status: CrewPosition["status"]) =>
    positions.filter((p) => p.status === status).length;

  return {
    positions,
    total: positions.length,
    confirmed: count("confirmed"),
    unconfirmed: count("assigned"),
    declined: count("declined"),
    open: count("open"),
    scheduled: positions.length > 0,
  };
}

// ─── On the floor ────────────────────────────────────────────

/** "JS" from "Jordan Smith", "J" from "Jordan". */
export function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}

/**
 * Who is physically here. Most recent arrival first, so the strip
 * changes at the front as people trickle in and the PM sees movement
 * without reading names.
 */
export function deriveOnFloor(snapshot: PmSnapshot): OnFloor {
  const members: OnFloorMember[] = snapshot.onFloor
    .map((member) => {
      const checkedIn = member.lastCheckIn ? new Date(member.lastCheckIn).getTime() : NaN;
      return {
        id: member.id,
        name: member.name,
        role: member.role,
        photoUrl: member.photoUrl,
        initials: initialsFor(member.name),
        sinceMinutes: Number.isNaN(checkedIn)
          ? null
          : Math.max(0, Math.round((snapshot.now - checkedIn) / MINUTE_MS)),
      };
    })
    .sort((a, b) => (a.sinceMinutes ?? Infinity) - (b.sinceMinutes ?? Infinity));

  return {
    members,
    total: snapshot.onFloorTotal,
    overflow: Math.max(0, snapshot.onFloorTotal - members.length),
  };
}

// ─── Carried-forward items ───────────────────────────────────

/**
 * Incidents still open from earlier services. Nothing else in the
 * product remembers that last Sunday's radio mic was never fixed.
 */
export function deriveOpenItems(snapshot: PmSnapshot): OpenItem[] {
  const today = new Date(`${snapshot.serviceDate}T12:00:00Z`).getTime();
  return snapshot.openItems
    .map((item) => {
      const then = new Date(`${item.serviceDate}T12:00:00Z`).getTime();
      const ageDays =
        Number.isNaN(then) || Number.isNaN(today)
          ? 0
          : Math.max(0, Math.round((today - then) / DAY_MS));
      return { ...item, ageDays };
    })
    .sort((a, b) => {
      const rank = (s: string) => (s === "high" ? 0 : s === "medium" ? 1 : 2);
      return rank(a.severity) - rank(b.severity) || b.ageDays - a.ageDays;
    });
}

// ─── Recent services ─────────────────────────────────────────

export function deriveRecent(snapshot: PmSnapshot): RecentService[] {
  return snapshot.recent.map((service) => ({
    ...service,
    deltaMs: service.actualMs === null ? null : service.actualMs - service.plannedMs,
  }));
}

// ─── Readiness ───────────────────────────────────────────────

const HEALTH_VALUE: Record<Health, number> = { ok: 1, warn: 0.5, fail: 0 };

export function emptyCrewBoard(): CrewBoard {
  return {
    positions: [],
    total: 0,
    confirmed: 0,
    unconfirmed: 0,
    declined: 0,
    open: 0,
    scheduled: false,
  };
}

export function deriveReadiness(
  snapshot: PmSnapshot,
  health: RundownHealth,
  departments: DepartmentStatus[],
  arrivals: Arrivals,
  phase: ServicePhase,
  crew: CrewBoard = emptyCrewBoard(),
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
  } else if (health.missingOwner > 0 || overrunsWindow(health)) {
    factors.push({
      id: "rundown",
      label: "Rundown",
      detail: overrunsWindow(health)
        ? `${formatMinutes(health.deltaMs as number)} over the window`
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

  // Checklist. Outside call and live the completion ratio says nothing
  // about readiness, so the factor is omitted rather than shown green —
  // the remaining weights renormalise on their own. A missing checklist
  // is always worth flagging though.
  const total = snapshot.checklist.length;
  const done = snapshot.checklist.filter((c) => c.checked).length;
  if (total > 0 && checklistIsDue(phase)) {
    const ratio = done / total;
    factors.push({
      id: "checklist",
      label: "Checklist",
      detail: `${done} of ${total} done`,
      status: ratio === 1 ? "ok" : ratio >= 0.5 ? "warn" : "fail",
      weight: 20,
    });
  }

  // Equipment. An org with no inventory is not "unready" — it just does
  // not track gear here.
  const dead = snapshot.equipment.filter((e) => e.status === "out-of-service").length;
  const repair = snapshot.equipment.filter(
    (e) => e.status === "needs-repair" || e.status === "in-repair",
  ).length;
  if (snapshot.equipment.length > 0) factors.push({
    id: "equipment",
    label: "Equipment",
    detail: dead > 0 ? `${plural(dead, "item")} out of service` : repair > 0 ? `${plural(repair, "item")} needs repair` : "All operational",
    status: dead > 0 ? "fail" : repair > 0 ? "warn" : "ok",
    weight: 15,
  });

  // Incidents, including everything still open from earlier services.
  // Scoring only today's would let the card read "None logged" while
  // three unresolved incidents sit on the same screen.
  const todays = snapshot.incidents.length;
  const carried = snapshot.openItems.length;
  const high =
    snapshot.incidents.filter((i) => i.severity === "high").length +
    snapshot.openItems.filter((i) => i.severity === "high").length;
  const totalOpen = todays + carried;
  factors.push({
    id: "incidents",
    label: "Incidents",
    detail:
      high > 0
        ? plural(high, "high-severity incident")
        : totalOpen > 0
          ? `${plural(totalOpen, "open incident")}${carried > 0 && todays === 0 ? " carried over" : ""}`
          : "None open",
    status: high > 0 ? "fail" : totalOpen > 0 ? "warn" : "ok",
    weight: 15,
  });

  // Stream
  // Stream. Never configuring a destination means the org does not
  // livestream; that is a choice, not a deficit. Configuring one and then
  // turning it all off is a deficit.
  const enabled = snapshot.streamDestinations.filter((d) => d.enabled).length;
  if (snapshot.streamDestinations.length > 0) {
    factors.push({
      id: "stream",
      label: "Stream",
      detail: enabled > 0 ? `${plural(enabled, "destination")} enabled` : "All destinations off",
      status: enabled > 0 ? "ok" : "fail",
      weight: 10,
    });
  }

  // Crew. A real schedule is the best signal there is, so prefer it.
  // Falling back to check-ins only matters once people are due on site.
  if (crew.scheduled) {
    const detail =
      crew.open > 0
        ? `${plural(crew.open, "position")} unfilled`
        : crew.declined > 0
          ? `${plural(crew.declined, "decline")} to replace`
          : crew.unconfirmed > 0
            ? `${crew.confirmed} of ${crew.total} confirmed`
            : `${crew.total} confirmed`;
    factors.push({
      id: "crew",
      label: "Crew",
      detail,
      status:
        crew.open > 0 || crew.declined > 0
          ? "fail"
          : crew.unconfirmed > 0
            ? "warn"
            : "ok",
      weight: 15,
    });
  } else if (phase === "call" || phase === "live") {
    const alarmed = arrivals.departments.filter((d) => d.alarm).length;
    factors.push({
      id: "crew",
      label: "Crew",
      detail: `${arrivals.present} of ${arrivals.total} checked in`,
      status: alarmed > 0 ? "fail" : arrivals.present < arrivals.total ? "warn" : "ok",
      weight: 15,
    });
  } else if (arrivals.total === 0) {
    factors.push({
      id: "crew",
      label: "Crew",
      detail: "No crew on the roster",
      status: "fail",
      weight: 15,
    });
  } else if (!snapshot.schedulingInUse) {
    // Nobody has ever been assigned to anything. Scheduling is either
    // not how this org works or not yet available to them; either way,
    // marking them down for it would be scoring a gap they cannot
    // close — the same rule already applied to streaming and
    // checklists. The factor reappears the moment anyone is assigned.
  } else if (phase !== "planning") {
    // A roster is not a rota. Reporting "21 members" as green while the
    // queue says nobody is scheduled had the dashboard contradicting
    // itself on one screen.
    //
    // In planning the factor is omitted rather than scored, exactly as
    // checklists are: weeks out, an unassigned rota is the normal state
    // of the world, not a deficit. The queue still carries an info-level
    // nudge so the gap is visible without dragging the score down.
    factors.push({
      id: "crew",
      label: "Crew",
      detail: "Nobody scheduled yet",
      status: "warn",
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

  const departments = deriveDepartments(snapshot, phase);
  const arrivals = deriveArrivals(snapshot, timing);
  const crew = deriveCrewBoard(snapshot);

  return {
    serviceDate: snapshot.serviceDate,
    phase,
    timing,
    countdown,
    readiness: deriveReadiness(snapshot, rundownHealth, departments, arrivals, phase, crew),
    rundownHealth,
    attention: deriveAttentionQueue(snapshot, rundownHealth, phase, crew),
    departments,
    arrivals,
    cueExceptions: deriveCueExceptions(snapshot),
    upcoming: deriveUpcoming(snapshot),
    debrief: phase === "debrief" ? deriveDebrief(snapshot, rundownHealth) : null,
    hasRundown: snapshot.rundown !== null || snapshot.items.length > 0,
    planNext: rundownHealth.itemCount === 0 && (phase === "planning" || phase === "prep"),
    lastServiceDate: snapshot.lastServiceDate,
    crew,
    duty: deriveDuty(snapshot),
    dutyWeekStart: snapshot.rosterDuty.weekStart,
    orgMembers: snapshot.orgMembers,
    roster: snapshot.crew.map((m) => ({ id: m.id, name: m.name, role: m.role })),
    schedulingInUse: snapshot.schedulingInUse,
    openItems: deriveOpenItems(snapshot),
    recent: deriveRecent(snapshot),
    onFloor: deriveOnFloor(snapshot),
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
