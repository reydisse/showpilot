import { getAuth } from "./auth";
import { getCrewScheduleResponseWindow } from "./crew-schedule-response";
import { resolveEffectiveAccess } from "./effective-access";
import type { Permission } from "./permissions";
import { readPhaseSettings } from "./service-phase";
import { getTodayDateString } from "./utils";
import { actionsForMobileAdapter, buildMobileAtemCommand } from "./mobile-device-controls";
import { createServiceForOrg } from "./service-creation.server";
import { PlanLimitError } from "./plan-limits";
import { isValidServiceDate } from "./validation";
import type {
  BridgeDispatchMessage,
  BridgeDispatchResult,
  BridgeRelay,
} from "../durable-objects/BridgeRelay";

export interface MobileApiDatabase {
  prepare(sql: string): {
    bind(...params: unknown[]): {
      first<T>(): Promise<T | null>;
      all<T>(): Promise<{ results?: T[] }>;
      run(): Promise<unknown>;
    };
  };
}

export interface MobileApiEnvironment {
  DB: MobileApiDatabase;
  BRIDGE_RELAY?: DurableObjectNamespace<BridgeRelay>;
}

interface MobileIdentity {
  userId: string;
  name: string;
  email: string;
  role: string;
  permissions: Permission[];
}

interface MobileRundownRow {
  id: string;
  serviceDate: string;
  name: string;
  scheduledStartTime: string | null;
  location: string;
  status: string;
  itemCount: number;
}

interface MobileNotificationRow {
  id: string;
  type: string;
  severity: string;
  title: string;
  message: string;
  actionUrl: string;
  source: string;
  createdAt: string;
  readAt: string | null;
}

interface MobileRundownItemRow {
  itemId: string;
  title: string;
  type: string;
  duration: number;
  notes: string;
  assignee: string;
  cue: string;
  status: string;
  sortOrder: number;
  hardStop: number | boolean;
  lowerThirdId: string | null;
  actualStart: string | null;
  actualEnd: string | null;
}

interface MobileScheduleRow extends MobileRundownRow {
  completedItems: number;
  crewTotal: number;
  crewConfirmed: number;
  crewOpen: number;
  incidentCount: number;
}

interface MobileAssignmentRow {
  id: string;
  showId: string | null;
  serviceDate: string;
  role: string;
  department: string;
  status: string;
  callTime: string;
  notes: string;
  responseNote: string;
  crewName: string | null;
  crewEmail: string | null;
  scheduledStartTime: string | null;
  plannedDurationMs: number;
}

interface MobileAssignmentResponseRow {
  id: string;
  showId: string | null;
  crewMemberId: string;
  role: string;
  serviceDate: string;
  status: string;
  crewName: string;
  crewEmail: string;
  scheduledStartTime: string | null;
  plannedDurationMs: number;
}

interface MobileIncidentRow {
  id: string;
  showId: string | null;
  category: string;
  severity: string;
  description: string;
  reportedBy: string;
  serviceDate: string;
  timestamp: string;
  status: string;
  assignedName: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
}

interface MobileDeviceRow {
  id: string;
  name: string;
  category: string;
  adapterType: string;
  enabled: number | boolean;
  updatedAt: string;
}

interface MobileDeviceControlRow extends MobileDeviceRow {
  orgId: string;
  settings: string;
}

interface MobileDeviceListRow extends MobileDeviceRow {
  settings: string;
}

interface MobileTimerState {
  playback: "stop" | "play" | "pause";
  currentItemId: string | null;
  elapsed: number;
  startedAt: number | null;
  pausedAt: number | null;
  mode: "count-down" | "count-up" | "clock";
  serverTime?: number;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store, max-age=0",
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function changedExactlyOneRow(value: unknown): boolean {
  return isRecord(value)
    && value.success === true
    && isRecord(value.meta)
    && value.meta.changes === 1;
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return isRecord(body) ? body : null;
  } catch {
    return null;
  }
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 128;
}

function validDate(value: unknown): value is string {
  return isValidServiceDate(value);
}

function shiftDate(date: string, days: number): string {
  const parsed = new Date(`${date}T12:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

async function resolveOrgId(value: string, db: MobileApiDatabase): Promise<string> {
  const byId = await db.prepare("SELECT id FROM organization WHERE id = ?").bind(value).first<{ id: string }>();
  if (byId) return byId.id;
  const bySlug = await db.prepare("SELECT id FROM organization WHERE slug = ?").bind(value).first<{ id: string }>();
  return bySlug?.id ?? value;
}

async function getIdentity(request: Request, orgId: string, db: MobileApiDatabase): Promise<MobileIdentity | null> {
  try {
    const session = await getAuth().api.getSession({ headers: request.headers });
    if (!session) return null;
    const access = await resolveEffectiveAccess(db, session.user.id, orgId);
    if (!access) return null;
    return {
      userId: session.user.id,
      name: session.user.name,
      email: session.user.email.toLowerCase(),
      role: access.role,
      permissions: access.permissions,
    };
  } catch {
    return null;
  }
}

function hasAny(identity: MobileIdentity, permissions: Permission[]): boolean {
  return permissions.some((permission) => identity.permissions.includes(permission));
}

async function authorize(
  request: Request,
  url: URL,
  db: MobileApiDatabase,
  permissions?: Permission[],
): Promise<{ orgId: string; identity: MobileIdentity } | Response> {
  const suppliedOrgId = url.searchParams.get("orgId")?.trim();
  if (!validId(suppliedOrgId)) return json({ error: "A valid orgId is required." }, 400);
  const orgId = await resolveOrgId(suppliedOrgId, db);
  const identity = await getIdentity(request, orgId, db);
  if (!identity) return json({ error: "Unauthorized" }, 401);
  if (permissions?.length && !hasAny(identity, permissions)) {
    return json({ error: "Forbidden" }, 403);
  }
  return { orgId, identity };
}

function parseTimer(value: string | null | undefined): MobileTimerState {
  const fallback = (): MobileTimerState => ({
    playback: "stop",
    currentItemId: null,
    elapsed: 0,
    startedAt: null,
    pausedAt: null,
    mode: "count-down",
  });
  if (!value) return fallback();
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) return fallback();
    const playback = parsed.playback === "play" || parsed.playback === "pause"
      ? parsed.playback
      : "stop";
    const mode = parsed.mode === "count-up" || parsed.mode === "clock"
      ? parsed.mode
      : "count-down";
    return {
      playback,
      currentItemId: typeof parsed.currentItemId === "string" ? parsed.currentItemId : null,
      elapsed: typeof parsed.elapsed === "number" && Number.isFinite(parsed.elapsed) ? parsed.elapsed : 0,
      startedAt: typeof parsed.startedAt === "number" && Number.isFinite(parsed.startedAt) ? parsed.startedAt : null,
      pausedAt: typeof parsed.pausedAt === "number" && Number.isFinite(parsed.pausedAt) ? parsed.pausedAt : null,
      mode,
      ...(typeof parsed.serverTime === "number" && Number.isFinite(parsed.serverTime)
        ? { serverTime: parsed.serverTime }
        : {}),
    };
  } catch {
    return fallback();
  }
}

async function bootstrap(request: Request, url: URL, db: MobileApiDatabase): Promise<Response> {
  const access = await authorize(request, url, db);
  if (access instanceof Response) return access;
  const { orgId, identity } = access;
  const organization = await db
    .prepare("SELECT id, name, slug FROM organization WHERE id = ? LIMIT 1")
    .bind(orgId)
    .first<{ id: string; name: string; slug: string }>();
  if (!organization) return json({ error: "Organization not found." }, 404);

  const timezone = await db.prepare("SELECT value FROM app_setting WHERE orgId = ? AND key = 'org-timezone' LIMIT 1")
    .bind(orgId).first<{ value: string }>();
  const today = getTodayDateString(timezone?.value || "Africa/Accra");
  const [showsResult, notificationsResult, unreadResult] = await Promise.all([
    db.prepare(
      `SELECT r.id, r.serviceDate, r.name, r.scheduledStartTime, r.location, r.status,
              CAST(COUNT(i.id) AS INTEGER) AS itemCount
       FROM rundown r
       LEFT JOIN rundown_item i ON i.showId = r.id AND i.orgId = r.orgId
       WHERE r.orgId = ? AND (r.serviceDate >= ? OR r.status IN ('running', 'paused'))
       GROUP BY r.id
       ORDER BY CASE WHEN r.status IN ('running', 'paused') THEN 0 ELSE 1 END,
                r.serviceDate ASC, r.scheduledStartTime ASC
       LIMIT 30`,
    ).bind(orgId, today).all<MobileRundownRow>(),
    db.prepare(
      `SELECT id, type, severity, title, message, actionUrl, source, createdAt, readAt
       FROM notification
       WHERE orgId = ? AND userId = ? AND dismissed = 0
       ORDER BY createdAt DESC
       LIMIT 50`,
    ).bind(orgId, identity.userId).all<MobileNotificationRow>(),
    db.prepare(
      `SELECT CAST(COUNT(*) AS INTEGER) AS count
       FROM notification
       WHERE orgId = ? AND userId = ? AND dismissed = 0 AND readAt IS NULL`,
    ).bind(orgId, identity.userId).first<{ count: number }>(),
  ]);
  const notifications = notificationsResult.results ?? [];
  return json({
    organization,
    timeZone: timezone?.value || "Africa/Accra",
    identity: {
      userId: identity.userId,
      name: identity.name,
      role: identity.role,
      permissions: identity.permissions,
    },
    shows: showsResult.results ?? [],
    notifications,
    unreadNotifications: unreadResult?.count ?? 0,
  });
}

async function rundown(request: Request, url: URL, showId: string, db: MobileApiDatabase): Promise<Response> {
  if (!validId(showId)) return json({ error: "A valid showId is required." }, 400);
  const access = await authorize(request, url, db, ["rundown:view", "rundown:control"]);
  if (access instanceof Response) return access;
  const { orgId, identity } = access;
  const show = await db.prepare(
    `SELECT id, serviceDate, name, scheduledStartTime, location, status
     FROM rundown WHERE id = ? AND orgId = ? LIMIT 1`,
  ).bind(showId, orgId).first<Omit<MobileRundownRow, "itemCount">>();
  if (!show) return json({ error: "Show not found." }, 404);

  const [itemsResult, showTimerSetting, dateTimerSetting, legacyOwner] = await Promise.all([
    db.prepare(
      `SELECT itemId, title, type, duration, notes, assignee, cue, status,
              sortOrder, hardStop, lowerThirdId, actualStart, actualEnd
       FROM rundown_item WHERE orgId = ? AND showId = ?
       ORDER BY sortOrder ASC, createdAt ASC`,
    ).bind(orgId, showId).all<MobileRundownItemRow>(),
    db.prepare("SELECT value FROM app_setting WHERE orgId = ? AND key = ? LIMIT 1")
      .bind(orgId, `rundown-timer:${showId}`).first<{ value: string }>(),
    db.prepare("SELECT value FROM app_setting WHERE orgId = ? AND key = ? LIMIT 1")
      .bind(orgId, `rundown-timer:${show.serviceDate}`).first<{ value: string }>(),
    db.prepare(
      `SELECT id FROM rundown WHERE orgId = ? AND serviceDate = ?
       ORDER BY scheduledStartTime ASC, createdAt ASC LIMIT 1`,
    ).bind(orgId, show.serviceDate).first<{ id: string }>(),
  ]);
  return json({
    show,
    canControl: identity.permissions.includes("rundown:control"),
    items: (itemsResult.results ?? []).map((item) => ({
      id: item.itemId,
      title: item.title,
      type: item.type,
      duration: item.duration,
      notes: item.notes,
      assignee: item.assignee,
      cue: item.cue,
      status: item.status,
      sortOrder: item.sortOrder,
      hardStop: Boolean(item.hardStop),
      lowerThirdId: item.lowerThirdId ?? undefined,
      actualStart: item.actualStart,
      actualEnd: item.actualEnd,
    })),
    timer: parseTimer(showTimerSetting?.value ?? (legacyOwner?.id === showId ? dateTimerSetting?.value : null)),
  });
}

async function createRundown(request: Request, db: MobileApiDatabase): Promise<Response> {
  const body = await readJson(request);
  if (!body || !validId(body.orgId) || !validDate(body.serviceDate)) {
    return json({ error: "Choose a valid workspace and service date." }, 400);
  }

  const name = body.name === undefined
    ? ""
    : typeof body.name === "string"
      ? body.name.trim()
      : null;
  const location = body.location === undefined
    ? ""
    : typeof body.location === "string"
      ? body.location.trim()
      : null;
  const startTime = body.startTime === undefined || body.startTime === ""
    ? undefined
    : typeof body.startTime === "string"
      ? body.startTime.trim()
      : null;
  if (
    name === null
    || name.length > 120
    || location === null
    || location.length > 240
    || startTime === null
    || (startTime !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime))
  ) {
    return json({ error: "Check the service title, start time, and location." }, 400);
  }

  const url = new URL(request.url);
  url.searchParams.set("orgId", body.orgId);
  const access = await authorize(request, url, db, ["schedule:manage"]);
  if (access instanceof Response) return access;

  try {
    const result = await createServiceForOrg({
      orgId: access.orgId,
      serviceDate: body.serviceDate,
      name,
      startTime,
      location,
    });
    return json(result, 201);
  } catch (error) {
    if (error instanceof PlanLimitError) return json({ error: error.message }, error.status);
    throw error;
  }
}

async function schedule(request: Request, url: URL, db: MobileApiDatabase): Promise<Response> {
  const access = await authorize(request, url, db);
  if (access instanceof Response) return access;
  const canViewFull = hasAny(access.identity, ["schedule:view", "schedule:manage"]);
  const settingsResult = await db.prepare(
    "SELECT key, value FROM app_setting WHERE orgId = ? AND key IN ('org-timezone', 'default-service-window-minutes')",
  ).bind(access.orgId).all<{ key: string; value: string }>();
  const settingMap = Object.fromEntries(
    (settingsResult.results ?? []).map((setting) => [setting.key, setting.value]),
  );
  const { serviceWindowMinutes } = readPhaseSettings(settingMap);
  const timeZone = settingMap["org-timezone"] || "Africa/Accra";
  const today = getTodayDateString(timeZone);
  const from = url.searchParams.get("from") || shiftDate(today, -7);
  const to = url.searchParams.get("to") || shiftDate(today, 45);
  if (!validDate(from) || !validDate(to) || from > to) return json({ error: "A valid date range is required." }, 400);

  const [servicesResult, assignmentsResult] = await Promise.all([
    db.prepare(
      `SELECT r.id, r.serviceDate, r.name, r.scheduledStartTime, r.location, r.status,
              CAST(COUNT(DISTINCT i.id) AS INTEGER) AS itemCount,
              CAST(COUNT(DISTINCT CASE WHEN i.status = 'complete' THEN i.id END) AS INTEGER) AS completedItems,
              CAST(COUNT(DISTINCT a.id) AS INTEGER) AS crewTotal,
              CAST(COUNT(DISTINCT CASE WHEN a.status = 'confirmed' THEN a.id END) AS INTEGER) AS crewConfirmed,
              CAST(COUNT(DISTINCT CASE WHEN a.crewMemberId IS NULL THEN a.id END) AS INTEGER) AS crewOpen,
              CAST(COUNT(DISTINCT x.id) AS INTEGER) AS incidentCount
       FROM rundown r
       LEFT JOIN rundown_item i ON i.orgId = r.orgId AND i.showId = r.id
       LEFT JOIN service_assignment a ON a.orgId = r.orgId AND a.showId = r.id
       LEFT JOIN incident x ON x.orgId = r.orgId AND x.showId = r.id
       WHERE r.orgId = ? AND r.serviceDate BETWEEN ? AND ?
         AND (? = 1 OR EXISTS (
           SELECT 1 FROM service_assignment own_assignment
           JOIN crew_member own_crew ON own_crew.id = own_assignment.crewMemberId AND own_crew.orgId = own_assignment.orgId
           WHERE own_assignment.orgId = r.orgId AND own_assignment.showId = r.id AND LOWER(own_crew.email) = ?
         ))
       GROUP BY r.id
       ORDER BY r.serviceDate ASC, r.scheduledStartTime ASC, r.createdAt ASC`,
    ).bind(access.orgId, from, to, canViewFull ? 1 : 0, access.identity.email).all<MobileScheduleRow>(),
    db.prepare(
      `SELECT a.id, a.showId, a.serviceDate, a.role, a.department, a.status,
              a.callTime, a.notes, a.responseNote, c.name AS crewName, c.email AS crewEmail,
              r.scheduledStartTime,
              COALESCE((
                SELECT SUM(ri.duration) FROM rundown_item ri
                WHERE ri.orgId = a.orgId AND ri.showId = a.showId
              ), 0) AS plannedDurationMs
       FROM service_assignment a
       LEFT JOIN crew_member c ON c.id = a.crewMemberId AND c.orgId = a.orgId
       LEFT JOIN rundown r ON r.id = a.showId AND r.orgId = a.orgId
       WHERE a.orgId = ? AND a.serviceDate BETWEEN ? AND ?
         AND (? = 1 OR LOWER(c.email) = ?)
       ORDER BY a.serviceDate ASC, a.department ASC, a.role ASC`,
    ).bind(access.orgId, from, to, canViewFull ? 1 : 0, access.identity.email).all<MobileAssignmentRow>(),
  ]);
  const assignments = assignmentsResult.results ?? [];
  const nowMs = Date.now();
  const services = (servicesResult.results ?? []).map((service) => {
    if (canViewFull) return service;
    const ownAssignments = assignments.filter((assignment) => assignment.showId === service.id);
    return {
      ...service,
      crewTotal: ownAssignments.length,
      crewConfirmed: ownAssignments.filter((assignment) => assignment.status === "confirmed").length,
      crewOpen: 0,
      incidentCount: 0,
    };
  });
  return json({
    from,
    to,
    timeZone,
    canViewFull,
    canManage: access.identity.permissions.includes("schedule:manage"),
    services,
    assignments: assignments.map((assignment) => {
      const responseWindow = getCrewScheduleResponseWindow(
        {
          serviceDate: assignment.serviceDate,
          scheduledStartTime: assignment.scheduledStartTime,
          plannedDurationMs: assignment.showId ? assignment.plannedDurationMs : undefined,
          serviceWindowMinutes,
          timeZone,
        },
        nowMs,
      );
      const isOwner = assignment.crewEmail?.toLowerCase() === access.identity.email;
      return {
        ...assignment,
        responseWindow,
        canRespond: isOwner && assignment.status === "assigned" && responseWindow.status === "open",
      };
    }),
  });
}

async function respondToAssignment(request: Request, db: MobileApiDatabase): Promise<Response> {
  const body = await readJson(request);
  if (!body || !validId(body.orgId) || !validId(body.assignmentId)) {
    return json({ error: "orgId and assignmentId are required." }, 400);
  }
  const response = body.response;
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if ((response !== "confirmed" && response !== "declined") || reason.length > 500) {
    return json({ error: "Choose a valid response and keep the note under 500 characters." }, 400);
  }
  const url = new URL(request.url);
  url.searchParams.set("orgId", body.orgId);
  const access = await authorize(request, url, db);
  if (access instanceof Response) return access;
  const [assignment, settingsResult] = await Promise.all([
    db.prepare(
      `SELECT a.id, a.showId, a.crewMemberId, a.role, a.serviceDate, a.status,
              c.name AS crewName, c.email AS crewEmail, r.scheduledStartTime,
              COALESCE((
                SELECT SUM(ri.duration) FROM rundown_item ri
                WHERE ri.orgId = a.orgId AND ri.showId = a.showId
              ), 0) AS plannedDurationMs
       FROM service_assignment a
       JOIN crew_member c ON c.id = a.crewMemberId AND c.orgId = a.orgId
       LEFT JOIN rundown r ON r.id = a.showId AND r.orgId = a.orgId
       WHERE a.id = ? AND a.orgId = ? LIMIT 1`,
    ).bind(body.assignmentId, access.orgId).first<MobileAssignmentResponseRow>(),
    db.prepare(
      "SELECT key, value FROM app_setting WHERE orgId = ? AND key IN ('org-timezone', 'default-service-window-minutes')",
    ).bind(access.orgId).all<{ key: string; value: string }>(),
  ]);
  if (!assignment || assignment.crewEmail.toLowerCase() !== access.identity.email) {
    return json({ error: "Assignment not found." }, 404);
  }
  const settingMap = Object.fromEntries(
    (settingsResult.results ?? []).map((setting) => [setting.key, setting.value]),
  );
  const { serviceWindowMinutes } = readPhaseSettings(settingMap);
  const responseWindow = getCrewScheduleResponseWindow(
    {
      serviceDate: assignment.serviceDate,
      scheduledStartTime: assignment.scheduledStartTime,
      plannedDurationMs: assignment.showId ? assignment.plannedDurationMs : undefined,
      serviceWindowMinutes,
      timeZone: settingMap["org-timezone"],
    },
    Date.now(),
  );
  if (assignment.status !== "assigned") {
    return json({ error: "A response has already been recorded for this assignment." }, 409);
  }
  if (responseWindow.status === "closed") {
    return json({ error: "This assignment is closed because the service has ended." }, 409);
  }
  const update = await db.prepare(
    `UPDATE service_assignment
     SET status = ?, responseNote = ?, respondedAt = CURRENT_TIMESTAMP, updatedAt = CURRENT_TIMESTAMP
     WHERE id = ? AND orgId = ? AND crewMemberId = ? AND status = 'assigned'`,
  ).bind(response, reason, assignment.id, access.orgId, assignment.crewMemberId).run();
  if (!changedExactlyOneRow(update)) {
    return json({ error: "A response has already been recorded for this assignment." }, 409);
  }

  const { notifyOperationalEvent } = await import("./operational-notifications.server");
  const responseLabel = response === "confirmed" ? "accepted" : "declined";
  await notifyOperationalEvent({
    orgId: access.orgId,
    includeLeadership: true,
    type: `assignment-${response}`,
    severity: response === "declined" ? "warning" : "info",
    title: `${assignment.crewName || access.identity.name} ${responseLabel} an assignment`,
    message: `${assignment.role} · ${assignment.serviceDate}${reason ? ` · ${reason}` : ""}`,
    actionUrl: `schedule?date=${encodeURIComponent(assignment.serviceDate)}&assignment=${encodeURIComponent(assignment.id)}`,
    source: assignment.id,
    pushTag: `assignment-response-${assignment.id}`,
  });
  return json({ ok: true });
}

async function incidents(request: Request, url: URL, db: MobileApiDatabase): Promise<Response> {
  const access = await authorize(request, url, db, ["incidents:report", "incidents:access"]);
  if (access instanceof Response) return access;
  const result = await db.prepare(
    `SELECT id, showId, category, severity, description, reportedBy, serviceDate,
            timestamp, status, assignedName, acknowledgedAt, resolvedAt
     FROM incident WHERE orgId = ?
     ORDER BY CASE WHEN status = 'open' THEN 0 ELSE 1 END, timestamp DESC LIMIT 100`,
  ).bind(access.orgId).all<MobileIncidentRow>();
  return json({
    canReport: hasAny(access.identity, ["incidents:report", "incidents:access"]),
    canManage: access.identity.permissions.includes("incidents:access"),
    incidents: result.results ?? [],
  });
}

async function createIncident(request: Request, url: URL, db: MobileApiDatabase): Promise<Response> {
  const access = await authorize(request, url, db, ["incidents:report", "incidents:access"]);
  if (access instanceof Response) return access;
  const body = await readJson(request);
  if (!body) return json({ error: "Invalid JSON body." }, 400);
  const category = typeof body.category === "string" ? body.category.trim() : "";
  const severity = typeof body.severity === "string" ? body.severity.trim() : "";
  const description = typeof body.description === "string" ? body.description.trim() : "";
  const serviceDate = body.serviceDate;
  const showId = body.showId === null || body.showId === "" ? null : body.showId;
  if (!new Set(["audio", "video", "stream", "lighting", "other"]).has(category)
    || !new Set(["low", "medium", "high"]).has(severity)
    || description.length < 2 || description.length > 2_000 || !validDate(serviceDate)
    || (showId !== null && !validId(showId))) {
    return json({ error: "Choose a category, severity, service date, and description." }, 400);
  }
  if (showId) {
    const show = await db.prepare("SELECT id FROM rundown WHERE id = ? AND orgId = ? LIMIT 1")
      .bind(showId, access.orgId).first<{ id: string }>();
    if (!show) return json({ error: "Show not found." }, 404);
  }
  const id = crypto.randomUUID();
  await db.prepare(
    `INSERT INTO incident (id, orgId, showId, category, severity, description, reportedBy, serviceDate, timestamp, status, assignedName)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, 'open', '')`,
  ).bind(id, access.orgId, showId, category, severity, description, access.identity.name, serviceDate).run();
  return json({ ok: true, id }, 201);
}

async function devices(request: Request, url: URL, db: MobileApiDatabase): Promise<Response> {
  const access = await authorize(request, url, db, ["devices:access"]);
  if (access instanceof Response) return access;
  const result = await db.prepare(
    `SELECT id, name, category, adapterType, enabled, updatedAt, settings
     FROM device WHERE orgId = ? ORDER BY enabled DESC, name ASC`,
  ).bind(access.orgId).all<MobileDeviceListRow>();
  return json({
    devices: (result.results ?? []).map((device) => {
      const settings = parsedSettings(device.settings);
      const consoleType = String(settings?.consoleName || "x32").toLowerCase() === "wing" ? "wing" : "x32";
      return {
        id: device.id,
        name: device.name,
        category: device.category,
        adapterType: device.adapterType,
        enabled: Boolean(device.enabled),
        updatedAt: device.updatedAt,
        controls: actionsForMobileAdapter(device.adapterType, consoleType),
      };
    }),
  });
}

function parsedSettings(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function bridgeDispatch(
  env: MobileApiEnvironment,
  orgId: string,
  message: BridgeDispatchMessage,
): Promise<BridgeDispatchResult> {
  if (!env.BRIDGE_RELAY) return { success: false, error: "Venue Bridge is unavailable" };
  const id = env.BRIDGE_RELAY.idFromName(orgId);
  const stub = env.BRIDGE_RELAY.get(id);
  try {
    return await stub.dispatchBridgeMessage(message);
  } catch {
    return { success: false, error: "Venue Bridge is unavailable" };
  }
}

async function controlDevice(
  request: Request,
  url: URL,
  deviceId: string,
  env: MobileApiEnvironment,
): Promise<Response> {
  if (!validId(deviceId)) return json({ error: "A valid deviceId is required." }, 400);
  const access = await authorize(request, url, env.DB, ["devices:access"]);
  if (access instanceof Response) return access;
  const body = await readJson(request);
  if (!body) return json({ error: "Invalid JSON body." }, 400);
  const operation = body.operation;
  if (operation !== "connect" && operation !== "disconnect" && operation !== "action") {
    return json({ error: "Choose a valid device operation." }, 400);
  }
  const device = await env.DB.prepare(
    `SELECT id, orgId, name, category, adapterType, settings, enabled, updatedAt
     FROM device WHERE id = ? AND orgId = ? LIMIT 1`,
  ).bind(deviceId, access.orgId).first<MobileDeviceControlRow>();
  if (!device || !device.enabled) return json({ error: "Device not found or disabled." }, 404);
  if (device.adapterType !== "atem" && device.adapterType !== "osc-mixer") {
    return json({ error: "This device adapter does not yet expose safe mobile controls." }, 409);
  }
  const settings = parsedSettings(device.settings);
  if (!settings) return json({ error: "The device settings are not configured correctly." }, 409);
  const host = typeof settings.host === "string" ? settings.host.trim() : "";
  const consoleType = String(settings.consoleName || "x32").toLowerCase() === "wing" ? "wing" : "x32";
  const defaultPort = device.adapterType === "atem" ? 9910 : consoleType === "wing" ? 2223 : 10023;
  const port = Number(settings?.port || defaultPort);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65_535) {
    return json({ error: "The device host or port is not configured correctly." }, 409);
  }
  const protocol = device.adapterType === "atem" ? "atem" : "osc";
  const target = `${host}:${port}`;
  if (operation === "connect") {
    const result = await bridgeDispatch(env, access.orgId, { type: "connect-device", protocol, target, settings });
    return json(result, result.success ? 200 : 502);
  }
  if (operation === "disconnect") {
    const result = await bridgeDispatch(env, access.orgId, { type: "disconnect-device", target });
    return json(result, result.success ? 200 : 502);
  }

  const actionId = typeof body.actionId === "string" ? body.actionId : "";
  const params = isRecord(body.params) ? body.params : {};
  let command: string;
  try {
    if (device.adapterType === "atem") command = buildMobileAtemCommand(actionId, params);
    else {
      const { buildMixerOscCommand } = await import("./device-modules/osc-mixer/osc-mixer-module");
      command = buildMixerOscCommand(consoleType, actionId, params);
    }
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Invalid device action." }, 400);
  }
  const result = await bridgeDispatch(env, access.orgId, {
    type: "command",
    id: `mobile-${crypto.randomUUID()}`,
    protocol,
    target,
    command,
  });
  return json(result, result.success ? 200 : 502);
}

async function notificationRead(request: Request, db: MobileApiDatabase): Promise<Response> {
  const body = await readJson(request);
  const markAll = body?.all === true;
  if (!body || !validId(body.orgId) || (!markAll && !validId(body.notificationId))) {
    return json({ error: "orgId and either notificationId or all are required." }, 400);
  }
  const url = new URL(request.url);
  url.searchParams.set("orgId", body.orgId);
  const access = await authorize(request, url, db);
  if (access instanceof Response) return access;
  if (markAll) {
    await db.prepare(
      `UPDATE notification SET readAt = COALESCE(readAt, CURRENT_TIMESTAMP)
       WHERE orgId = ? AND userId = ? AND dismissed = 0`,
    ).bind(access.orgId, access.identity.userId).run();
  } else {
    await db.prepare(
      `UPDATE notification SET readAt = COALESCE(readAt, CURRENT_TIMESTAMP)
       WHERE id = ? AND orgId = ? AND userId = ?`,
    ).bind(body.notificationId, access.orgId, access.identity.userId).run();
  }
  return json({ ok: true });
}

async function pushToken(request: Request, db: MobileApiDatabase): Promise<Response> {
  const body = await readJson(request);
  const validToken = typeof body?.token === "string" && /^Expo(?:nent)?PushToken\[[^\]]{8,200}\]$/.test(body.token);
  const validPlatform = body?.platform === "ios" || body?.platform === "android";
  if (!body || !validId(body.orgId) || !validToken || !validPlatform) {
    return json({ error: "A valid orgId, Expo push token, and platform are required." }, 400);
  }
  const url = new URL(request.url);
  url.searchParams.set("orgId", body.orgId);
  const access = await authorize(request, url, db);
  if (access instanceof Response) return access;
  if (body.enabled === false) {
    // Signing out is device-wide. Remove this user's token from every
    // organization so a previous workspace cannot keep notifying the device.
    await db.prepare("DELETE FROM push_subscription WHERE endpoint = ? AND userId = ?")
      .bind(body.token, access.identity.userId).run();
    return json({ ok: true });
  }
  await db.prepare(
    `INSERT INTO push_subscription (id, orgId, userId, endpoint, p256dh, auth, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, 'expo', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT(endpoint, orgId) DO UPDATE SET userId = excluded.userId,
       p256dh = 'expo', auth = excluded.auth, updatedAt = CURRENT_TIMESTAMP`,
  ).bind(crypto.randomUUID(), access.orgId, access.identity.userId, body.token, body.platform).run();
  return json({ ok: true });
}

function decodePathId(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    if (!validId(decoded) || /[\\/?#\u0000-\u001F\u007F]/.test(decoded)) return null;
    return decoded;
  } catch {
    return null;
  }
}

export async function handleMobileApi(request: Request, env: MobileApiEnvironment): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/mobile/v1/")) return null;
  if (url.pathname === "/api/mobile/v1/bootstrap" && request.method === "GET") return bootstrap(request, url, env.DB);
  if (url.pathname === "/api/mobile/v1/rundowns" && request.method === "POST") return createRundown(request, env.DB);
  if (url.pathname === "/api/mobile/v1/schedule" && request.method === "GET") return schedule(request, url, env.DB);
  if (url.pathname === "/api/mobile/v1/schedule/respond" && request.method === "POST") return respondToAssignment(request, env.DB);
  if (url.pathname === "/api/mobile/v1/incidents" && request.method === "GET") return incidents(request, url, env.DB);
  if (url.pathname === "/api/mobile/v1/incidents" && request.method === "POST") return createIncident(request, url, env.DB);
  if (url.pathname === "/api/mobile/v1/devices" && request.method === "GET") return devices(request, url, env.DB);
  if (url.pathname === "/api/mobile/v1/notifications/read" && request.method === "POST") return notificationRead(request, env.DB);
  if (url.pathname === "/api/mobile/v1/push-token" && request.method === "POST") return pushToken(request, env.DB);
  const deviceControlMatch = url.pathname.match(/^\/api\/mobile\/v1\/devices\/([^/]+)\/control$/);
  if (deviceControlMatch && request.method === "POST") {
    const deviceId = decodePathId(deviceControlMatch[1]);
    return deviceId ? controlDevice(request, url, deviceId, env) : json({ error: "Not found." }, 404);
  }
  const rundownMatch = url.pathname.match(/^\/api\/mobile\/v1\/rundowns\/([^/]+)$/);
  if (rundownMatch && request.method === "GET") {
    const showId = decodePathId(rundownMatch[1]);
    return showId ? rundown(request, url, showId, env.DB) : json({ error: "Not found." }, 404);
  }
  return json({ error: "Not found." }, 404);
}
