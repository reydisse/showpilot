/**
 * Tech manager dashboard derivation.
 *
 * Same contract as the PM's: a plain snapshot in, a rendered model out,
 * no Prisma types, no ambient clock, every rule unit-testable.
 *
 * The difference is what the page is *for*. The PM dashboard answers "is
 * this service ready and will it run to time". The TM's answers "is the
 * signal path intact, and if not, what do I touch first" — so faults are
 * not a status chip here, they are the work. Everything else on the page
 * exists to tell the tech whether a fault is coming.
 *
 * The governing rule carries over unchanged: a widget earns its place
 * only if a tech would act on it in the next ten minutes. Counts of
 * healthy things are not output. A feature the org has never configured
 * is not a deficit and must never be scored as one — that mistake made
 * the first PM dashboard permanently red.
 */

import { DEPARTMENT_LABELS, DEPARTMENT_ORDER, normalizeCategory } from "@/lib/departments";
import type { DepartmentKey } from "@/lib/departments";
import type { Health, Severity } from "@/lib/pm-dashboard-derive";
import type { ServicePhase } from "@/lib/service-phase";

const MINUTE_MS = 60_000;

/** A claimed fault nobody has acknowledged this long is effectively unowned. */
export const STALE_ACK_MS = 10 * MINUTE_MS;

// ─── Snapshot ────────────────────────────────────────────────

export interface TmIncident {
  id: string;
  category: string;
  severity: string;
  description: string;
  reportedBy: string;
  serviceDate: string;
  /** Epoch ms. */
  reportedAt: number;
  status: string;
  assignedTo: string | null;
  assignedName: string;
  /** Epoch ms, or null when claimed but never acknowledged. */
  acknowledgedAt: number | null;
}

export interface TmEquipment {
  id: string;
  name: string;
  category: string;
  status: string;
  /** Epoch ms of the next service due date, when set. */
  nextServiceMs: number | null;
}

export interface TmStreamDestination {
  id: string;
  name: string;
  platform: string;
  enabled: boolean;
  /** Whether Cloudflare Stream Connect has an output for it. */
  connected: boolean;
}

export interface TmLiveInput {
  id: string;
  name: string;
  status: string;
}

export interface TmDevice {
  id: string;
  name: string;
  kind: string;
  /** Epoch ms of the last heartbeat, null if never seen. */
  lastSeenMs: number | null;
  configured: boolean;
}

export interface TmChecklistItem {
  id: string;
  label: string;
  category: string;
  checked: boolean;
}

/** Who is on duty this week. Read-only here — the PM sets it. */
export interface TmDutyOfficer {
  key: "pm" | "tm";
  label: string;
  name: string | null;
}

export interface TmSnapshot {
  serviceDate: string;
  now: number;
  phase: ServicePhase;
  /** The signed-in tech, so the queue can say which faults are theirs. */
  viewerId: string;
  incidents: TmIncident[];
  equipment: TmEquipment[];
  checklist: TmChecklistItem[];
  streamDestinations: TmStreamDestination[];
  liveInputs: TmLiveInput[];
  devices: TmDevice[];
  /**
   * False when the org has never configured streaming at all. Distinct
   * from "configured and broken", which is a fault; this is silence.
   */
  streamingConfigured: boolean;
  duty: TmDutyOfficer[];
  /** How many pre-service checks the org has defined at all. */
  checklistTemplateCount: number;
  /** Items in the running order for this service. */
  rundownItemCount: number;
  /**
   * Whether this org has ever put anyone on the weekly rota. False means
   * they do not work that way, and an empty duty slot is not a gap to
   * nag them about — the same rule that keeps unconfigured integrations
   * off the page.
   */
  rosterInUse: boolean;
}

// ─── Output ──────────────────────────────────────────────────

export type FaultOwnership = "mine" | "unassigned" | "someone-else";

export interface Fault {
  id: string;
  department: DepartmentKey;
  departmentLabel: string;
  severity: Severity;
  description: string;
  reportedBy: string;
  /** Minutes since it was reported. */
  ageMinutes: number;
  ownership: FaultOwnership;
  assignedName: string;
  acknowledged: boolean;
  /** Claimed but not acknowledged for too long — treat as unowned. */
  stale: boolean;
  /** True when it was logged on an earlier service and never closed. */
  carriedForward: boolean;
}

export interface SignalPath {
  /** Null when the org has never configured streaming. */
  status: Health | null;
  detail: string;
  inputs: { id: string; name: string; ok: boolean; label: string }[];
  destinations: { id: string; name: string; ok: boolean; label: string }[];
}

export interface DepartmentChecks {
  key: DepartmentKey;
  label: string;
  outstanding: number;
  total: number;
  status: Health;
}

/** One thing to fix before the service. Planning and prep only. */
export interface PrepItem {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  actionLabel: string;
  /** Route relative to the org root. */
  actionPath: string;
}

export interface TmDashboardModel {
  phase: ServicePhase;
  faults: Fault[];
  openCount: number;
  mineCount: number;
  unownedCount: number;
  signalPath: SignalPath;
  checks: DepartmentChecks[];
  equipmentFaults: TmEquipment[];
  devices: TmDevice[];
  duty: TmDutyOfficer[];
  prep: PrepItem[];
}

// ─── Faults ──────────────────────────────────────────────────

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

function severityOf(raw: string): Severity {
  if (raw === "high") return "critical";
  if (raw === "medium") return "warning";
  return "info";
}

/**
 * The queue, ordered the way a tech works it.
 *
 * Unowned before owned at the same severity, because an unowned fault is
 * the one that gets dropped — that is the failure mode a tech team
 * actually has, not "this fault is slightly less severe than that one".
 * Within that, oldest first: a problem nobody has touched for twenty
 * minutes outranks one raised thirty seconds ago.
 */
export function deriveFaults(snapshot: TmSnapshot): Fault[] {
  return snapshot.incidents
    .filter((incident) => incident.status !== "resolved")
    .map((incident) => {
      const department = normalizeCategory(incident.category);
      const claimed = Boolean(incident.assignedTo);
      const stale =
        claimed &&
        incident.acknowledgedAt === null &&
        snapshot.now - incident.reportedAt > STALE_ACK_MS;

      return {
        id: incident.id,
        department,
        departmentLabel: DEPARTMENT_LABELS[department],
        severity: severityOf(incident.severity),
        description: incident.description,
        reportedBy: incident.reportedBy,
        ageMinutes: Math.max(0, Math.round((snapshot.now - incident.reportedAt) / MINUTE_MS)),
        ownership: !claimed
          ? ("unassigned" as const)
          : incident.assignedTo === snapshot.viewerId
            ? ("mine" as const)
            : ("someone-else" as const),
        assignedName: incident.assignedName,
        acknowledged: incident.acknowledgedAt !== null,
        stale,
        carriedForward: incident.serviceDate !== snapshot.serviceDate,
      };
    })
    .sort((a, b) => {
      if (a.severity !== b.severity) return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
      const aUnowned = a.ownership === "unassigned" || a.stale;
      const bUnowned = b.ownership === "unassigned" || b.stale;
      if (aUnowned !== bUnowned) return aUnowned ? -1 : 1;
      return b.ageMinutes - a.ageMinutes;
    });
}

// ─── Signal path ─────────────────────────────────────────────

/**
 * Whether the service is reaching the internet.
 *
 * Returns a null status when the org has never configured streaming.
 * That is not a fault and must not be rendered as one — a church that
 * does not stream would otherwise see a permanent red banner about a
 * feature it has deliberately never touched.
 */
export function deriveSignalPath(snapshot: TmSnapshot): SignalPath {
  if (!snapshot.streamingConfigured) {
    return { status: null, detail: "", inputs: [], destinations: [] };
  }

  const inputs = snapshot.liveInputs.map((input) => ({
    id: input.id,
    name: input.name,
    ok: input.status === "connected" || input.status === "live",
    label: input.status,
  }));

  const enabled = snapshot.streamDestinations.filter((destination) => destination.enabled);
  const destinations = enabled.map((destination) => ({
    id: destination.id,
    name: destination.name,
    ok: destination.connected,
    label: destination.connected ? destination.platform : "not connected",
  }));

  // Before call time an encoder that is not yet live is normal — someone
  // simply has not switched it on. Only from call onwards is it a fault.
  const judgeInputs = snapshot.phase === "call" || snapshot.phase === "live";
  const deadInputs = judgeInputs ? inputs.filter((input) => !input.ok) : [];
  const deadDestinations = destinations.filter((destination) => !destination.ok);

  let status: Health = "ok";
  let detail = "";
  if (enabled.length === 0) {
    status = "fail";
    detail = `${snapshot.streamDestinations.length} destinations configured, none enabled`;
  } else if (deadDestinations.length > 0) {
    status = "fail";
    detail = `${deadDestinations.map((d) => d.name).join(", ")} not connected`;
  } else if (deadInputs.length > 0) {
    status = "warn";
    detail = `${deadInputs.map((i) => i.name).join(", ")} not live`;
  } else {
    detail = `${enabled.length} destination${enabled.length === 1 ? "" : "s"} live`;
  }

  return { status, detail, inputs, destinations };
}

// ─── Department checks ───────────────────────────────────────

/**
 * Outstanding pre-service checks, per department.
 *
 * Only from call time onwards, for the same reason the PM dashboard
 * waits: days out, an unticked checklist is a to-do list, not a deficit,
 * and turning every department yellow on Tuesday teaches people to
 * ignore the colour.
 *
 * Departments with no checks at all are omitted rather than shown green.
 */
export function deriveChecks(snapshot: TmSnapshot): DepartmentChecks[] {
  if (snapshot.phase !== "call" && snapshot.phase !== "live") return [];

  return DEPARTMENT_ORDER.map((key) => {
    const items = snapshot.checklist.filter((item) => normalizeCategory(item.category) === key);
    const outstanding = items.filter((item) => !item.checked).length;
    return {
      key,
      label: DEPARTMENT_LABELS[key],
      outstanding,
      total: items.length,
      status: (outstanding === 0 ? "ok" : outstanding > 2 ? "fail" : "warn") as Health,
    };
  }).filter((department) => department.total > 0);
}

// ─── Equipment ───────────────────────────────────────────────

/** Only kit that needs a human. Working equipment is not news. */
export function deriveEquipmentFaults(snapshot: TmSnapshot): TmEquipment[] {
  const rank: Record<string, number> = { "out-of-service": 0, "needs-repair": 1, "in-repair": 2 };
  return snapshot.equipment
    .filter((item) => item.status !== "operational")
    .sort((a, b) => (rank[a.status] ?? 3) - (rank[b.status] ?? 3));
}

// ─── Devices ─────────────────────────────────────────────────

/**
 * Configured devices only.
 *
 * A device module that exists in the codebase but has never been set up
 * by this org is not a device that is down — it is a device they do not
 * have. Rendering it would be the integration-transparency rule broken
 * in the most annoying possible way.
 */
export function deriveDevices(snapshot: TmSnapshot): TmDevice[] {
  return snapshot.devices.filter((device) => device.configured);
}

// ─── Before the service ──────────────────────────────────────

/** A fault open longer than this is a repair job, not an incident. */
const STALE_FAULT_DAYS = 7;

/**
 * What a tech team should fix before Sunday.
 *
 * Only in planning and prep: during a service nobody is going to build a
 * checklist, and putting it on screen mid-show is noise at the worst
 * possible moment.
 *
 * Every entry is a real gap read from real data — never a suggestion,
 * never a nudge to configure something the org has chosen not to use.
 * The rule that kept the PM dashboard honest applies here too.
 */
export function derivePrep(snapshot: TmSnapshot): PrepItem[] {
  if (snapshot.phase !== "planning" && snapshot.phase !== "prep") return [];

  const out: PrepItem[] = [];

  if (snapshot.rundownItemCount === 0) {
    out.push({
      id: "prep:no-rundown",
      severity: "critical",
      title: "No running order for this service",
      detail: "Nothing to check against, and no cue sheet until it exists",
      actionLabel: "Build it",
      actionPath: "rundown",
    });
  }

  // A team with no checks at all walks into the service with nothing to
  // verify. Distinct from having checks but not having started them.
  if (snapshot.checklistTemplateCount === 0) {
    out.push({
      id: "prep:no-checklist",
      severity: "critical",
      title: "No pre-service checks exist",
      detail: "Nothing will be verified before the service starts",
      actionLabel: "Add checks",
      actionPath: "production/checklist",
    });
  } else if (snapshot.checklist.length === 0) {
    out.push({
      id: "prep:checklist-not-started",
      severity: "warning",
      title: "Checks not started for this service",
      detail: `${snapshot.checklistTemplateCount} checks defined, none carried onto this date`,
      actionLabel: "Open",
      actionPath: "production/checklist",
    });
  }

  // An unstaffed technical slot is a week problem, and the week is when
  // it can be solved. Only for orgs that use the rota at all.
  if (snapshot.rosterInUse) {
    const unstaffed = snapshot.duty.filter((officer) => !officer.name);
    if (unstaffed.length > 0) {
      out.push({
        id: "prep:duty-unstaffed",
        severity: "warning",
        title: `No ${unstaffed.map((officer) => officer.label.toLowerCase()).join(" or ")} on duty`,
        detail: "Nobody is named for this service on the weekly rota",
        actionLabel: "Set the rota",
        actionPath: "dashboard/prod-manager",
      });
    }
  }

  const dead = snapshot.equipment.filter((item) => item.status === "out-of-service");
  if (dead.length > 0) {
    out.push({
      id: "prep:equipment-dead",
      severity: "critical",
      title: `${dead.length === 1 ? "1 item" : `${dead.length} items`} out of service`,
      detail: dead.map((item) => item.name).join(", "),
      actionLabel: "Repair queue",
      actionPath: "dashboard/tech-manager",
    });
  }

  // Faults that have survived a week are repair work, not live incidents,
  // and the week is when they can actually be fixed.
  const staleMs = STALE_FAULT_DAYS * 24 * 60 * MINUTE_MS;
  const lingering = snapshot.incidents.filter(
    (incident) => incident.status !== "resolved" && snapshot.now - incident.reportedAt > staleMs,
  );
  if (lingering.length > 0) {
    const oldest = lingering.reduce((a, b) => (a.reportedAt < b.reportedAt ? a : b));
    const days = Math.round((snapshot.now - oldest.reportedAt) / (24 * 60 * MINUTE_MS));
    out.push({
      id: "prep:lingering-faults",
      severity: "warning",
      title: `${lingering.length === 1 ? "1 fault" : `${lingering.length} faults`} open more than a week`,
      detail: `Oldest is ${days} days old — fix before the service, not during it`,
      actionLabel: "Review",
      actionPath: "production/incidents",
    });
  }

  return out.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

// ─── Model ───────────────────────────────────────────────────

export function deriveTmDashboard(snapshot: TmSnapshot): TmDashboardModel {
  const faults = deriveFaults(snapshot);
  return {
    phase: snapshot.phase,
    faults,
    openCount: faults.length,
    mineCount: faults.filter((fault) => fault.ownership === "mine").length,
    unownedCount: faults.filter((fault) => fault.ownership === "unassigned" || fault.stale).length,
    signalPath: deriveSignalPath(snapshot),
    checks: deriveChecks(snapshot),
    equipmentFaults: deriveEquipmentFaults(snapshot),
    devices: deriveDevices(snapshot),
    duty: snapshot.duty,
    prep: derivePrep(snapshot),
  };
}
