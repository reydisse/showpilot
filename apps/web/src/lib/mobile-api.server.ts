import { getAuth } from "./auth";
import { getCrewScheduleResponseWindow } from "./crew-schedule-response";
import {
  resolveAccessGrantAuthorityForAccess,
  resolveEffectiveAccess,
} from "./effective-access";
import {
  ASSIGNABLE_ROLES,
  hasPermission,
  isAdminTier,
  type Permission,
  type Role,
} from "./permissions";
import { readPhaseSettings } from "./service-phase";
import { getTodayDateString } from "./utils";
import { actionsForMobileAdapter, buildMobileAtemCommand } from "./mobile-device-controls";
import { createServiceForOrg } from "./service-creation.server";
import { PlanLimitError } from "./plan-limits";
import { isValidServiceDate } from "./validation";
import { signToken } from "./kiosk-token";
import {
  createChecklistTemplateId,
  findChecklistTemplateId,
  type ChecklistTemplateWrite,
} from "./checklist-core";
import {
  persistChecklistItem,
  type ChecklistWriteDatabase,
  type ChecklistWriteResult,
} from "./checklist-write.server";
import {
  DEPARTMENT_ORDER,
  normalizeCategory,
  type DepartmentKey,
} from "./departments";
import {
  deriveChecklistSuggestions,
  normalizeChecklistLabel,
  type ChecklistRundownItem,
} from "./smart-checklist-rules";
import { ACCESS_CAPABILITIES, getAccessCapability } from "./access-capabilities";
import {
  getAccessManagementSnapshotForActor,
  grantMemberAccessForActor,
  revokeMemberAccessForActor,
  type AccessGrantDuration,
} from "./access-grants";
import type {
  BridgeDispatchMessage,
  BridgeDispatchResult,
  BridgeRelay,
} from "../durable-objects/BridgeRelay";

export interface MobileApiStatement {
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results?: T[] }>;
  run(): Promise<ChecklistWriteResult>;
}

export interface MobileApiDatabase extends ChecklistWriteDatabase {
  prepare(sql: string): {
    bind(...params: unknown[]): MobileApiStatement;
  };
}

export interface MobileApiEnvironment {
  DB: MobileApiDatabase;
  BRIDGE_RELAY?: DurableObjectNamespace<BridgeRelay>;
  KIOSK_SECRET?: string;
}

interface MobileIdentity {
  userId: string;
  name: string;
  email: string;
  role: Role;
  permissions: Permission[];
  today: string;
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
  assignedTo: string | null;
  acknowledgedAt: string | null;
  assignedAt: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  commentCount: number;
}

interface MobileIncidentResponderRow {
  userId: string;
  role: string;
  name: string;
}

interface MobileIncidentGrantRow {
  userId: string;
  permissions: string;
}

interface MobileIncidentCommentRow {
  id: string;
  incidentId: string;
  userId: string;
  authorName: string;
  body: string;
  parentId: string | null;
  createdAt: string;
}

interface MobileIncidentReactionRow {
  id: string;
  targetId: string;
  userId: string;
  authorName: string;
  emoji: string;
  createdAt: string;
}

interface MobileCheckInMemberRow {
  id: string;
  memberId: string;
  name: string;
  role: string;
  photoUrl: string;
  isOnline: number | boolean;
  lastCheckIn: string | null;
  lastCheckOut: string | null;
}

interface MobileOrganizationMemberRow {
  id: string;
  userId: string;
  organizationId: string;
  role: string;
  createdAt: string;
  userName: string;
  userEmail: string;
  userImage: string | null;
}

interface MobileOrganizationInvitationRow {
  id: string;
  email: string;
  role: string | null;
  status: string;
  expiresAt: string;
  createdAt: string;
}

interface MobileChatMemberRow {
  userId: string;
  role: string;
  name: string;
  image: string | null;
}

const CHAT_PASS_CREATORS = new Set<Role>(["owner", "admin", "td", "pd", "pm", "sm", "tm"]);

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

interface MobileChecklistEntryRow {
  id: string;
  templateId: string;
  checked: number | boolean;
  checkedBy: string | null;
  checkedAt: string | null;
  label: string;
  category: string;
  sortOrder: number;
}

interface MobileChecklistTemplateRow {
  id: string;
  label: string;
}

interface MobileChecklistRundownItemRow extends Omit<ChecklistRundownItem, "hardStop"> {
  hardStop: number | boolean;
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

function validAssignableRole(value: unknown): value is (typeof ASSIGNABLE_ROLES)[number] {
  return typeof value === "string" && (ASSIGNABLE_ROLES as readonly string[]).includes(value);
}

const crewPhotoDataUrlPattern = /^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/i;
const maximumCrewPhotoBytes = 1_500_000;

function validCrewPhoto(value: string): boolean {
  if (value === "") return true;
  const match = crewPhotoDataUrlPattern.exec(value);
  if (!match?.[2]) return false;
  const padding = match[2].endsWith("==") ? 2 : match[2].endsWith("=") ? 1 : 0;
  return Math.floor((match[2].length * 3) / 4) - padding <= maximumCrewPhotoBytes;
}

function parseCrewMemberWrite(body: Record<string, unknown> | null) {
  const memberId = typeof body?.memberId === "string" ? body.memberId.trim().toUpperCase() : "";
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const role = typeof body?.role === "string" ? body.role.trim() : "";
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const photoUrl = typeof body?.photoUrl === "string" ? body.photoUrl.trim() : "";
  if (
    memberId.length === 0 || memberId.length > 128
    || name.length === 0 || name.length > 200
    || role.length === 0 || role.length > 100
    || email.length > 254 || (email !== "" && !/^\S+@\S+\.\S+$/.test(email))
    || photoUrl.length > 2_100_000 || !validCrewPhoto(photoUrl)
  ) return null;
  return { memberId, name, role, email, photoUrl };
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
      today: access.today,
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
  const [showsResult, notificationsResult, unreadResult, accessAuthority] = await Promise.all([
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
    resolveAccessGrantAuthorityForAccess(db, identity.userId, orgId, identity, today),
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
    accessAuthority,
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

function validChecklistCategory(value: unknown): value is DepartmentKey {
  return typeof value === "string" && DEPARTMENT_ORDER.some((category) => category === value);
}

async function getChecklistShow(orgId: string, showId: string, db: MobileApiDatabase) {
  return db.prepare(
    `SELECT id, serviceDate, name, scheduledStartTime, location, status
     FROM rundown WHERE id = ? AND orgId = ? LIMIT 1`,
  ).bind(showId, orgId).first<Omit<MobileRundownRow, "itemCount">>();
}

async function buildMobileChecklistDraft(orgId: string, showId: string, db: MobileApiDatabase) {
  const show = await getChecklistShow(orgId, showId, db);
  if (!show) return null;
  const [templatesResult, entriesResult, itemsResult] = await Promise.all([
    db.prepare(
      `SELECT id, label FROM checklist_template
       WHERE orgId = ? ORDER BY sortOrder ASC, createdAt ASC`,
    ).bind(orgId).all<MobileChecklistTemplateRow>(),
    db.prepare(
      `SELECT templateId FROM checklist_entry
       WHERE orgId = ? AND showId = ?`,
    ).bind(orgId, showId).all<{ templateId: string }>(),
    db.prepare(
      `SELECT itemId AS id, title, type, duration, notes, assignee, cue, hardStop
       FROM rundown_item WHERE orgId = ? AND showId = ?
       ORDER BY sortOrder ASC, createdAt ASC`,
    ).bind(orgId, showId).all<MobileChecklistRundownItemRow>(),
  ]);
  const entryTemplateIds = new Set((entriesResult.results ?? []).map((entry) => entry.templateId));
  const templatesByLabel = new Map(
    (templatesResult.results ?? []).map((template) => [normalizeChecklistLabel(template.label), template]),
  );
  const items = (itemsResult.results ?? []).map((item): ChecklistRundownItem => ({
    ...item,
    hardStop: Boolean(item.hardStop),
  }));
  const suggestions = deriveChecklistSuggestions(items).flatMap((suggestion) => {
    const existing = templatesByLabel.get(normalizeChecklistLabel(suggestion.label));
    if (existing && entryTemplateIds.has(existing.id)) return [];
    return [{ ...suggestion, existingTemplateId: existing?.id ?? null }];
  });
  return { show, suggestions };
}

async function checklist(request: Request, url: URL, db: MobileApiDatabase): Promise<Response> {
  const access = await authorize(request, url, db, ["checklist:view", "checklist:access"]);
  if (access instanceof Response) return access;
  const showId = url.searchParams.get("showId");
  if (!validId(showId)) return json({ error: "Choose a valid show." }, 400);
  const show = await getChecklistShow(access.orgId, showId, db);
  if (!show) return json({ error: "Show not found." }, 404);
  const [entriesResult, showsResult] = await Promise.all([
    db.prepare(
      `SELECT e.id, e.templateId, e.checked, e.checkedBy, e.checkedAt,
              t.label, t.category, t.sortOrder
       FROM checklist_entry e
       JOIN checklist_template t ON t.id = e.templateId AND t.orgId = e.orgId
       WHERE e.orgId = ? AND e.showId = ?
       ORDER BY t.sortOrder ASC, t.createdAt ASC, e.id ASC`,
    ).bind(access.orgId, showId).all<MobileChecklistEntryRow>(),
    db.prepare(
      `SELECT id, serviceDate, name, scheduledStartTime, location, status
       FROM rundown
       WHERE orgId = ? AND serviceDate BETWEEN ? AND ?
       ORDER BY serviceDate ASC, scheduledStartTime ASC, createdAt ASC
       LIMIT 250`,
    ).bind(access.orgId, shiftDate(show.serviceDate, -180), shiftDate(show.serviceDate, 365))
      .all<Omit<MobileRundownRow, "itemCount">>(),
  ]);
  return json({
    show,
    shows: showsResult.results ?? [],
    canManage: access.identity.permissions.includes("checklist:access"),
    entries: (entriesResult.results ?? []).map((entry) => ({
      ...entry,
      checked: Boolean(entry.checked),
      category: normalizeCategory(entry.category),
    })),
  });
}

async function addChecklistItemMobile(request: Request, url: URL, db: MobileApiDatabase): Promise<Response> {
  const access = await authorize(request, url, db, ["checklist:access"]);
  if (access instanceof Response) return access;
  const body = await readJson(request);
  const showId = body?.showId;
  const label = typeof body?.label === "string" ? body.label.trim() : "";
  const category = body?.category;
  if (
    !validId(showId)
    || label.length === 0
    || label.length > 200
    || !normalizeChecklistLabel(label)
    || !validChecklistCategory(category)
  ) {
    return json({ error: "Enter a checklist item, department, and valid show." }, 400);
  }
  const [show, templatesResult] = await Promise.all([
    getChecklistShow(access.orgId, showId, db),
    db.prepare(
      `SELECT id, label FROM checklist_template
       WHERE orgId = ? ORDER BY sortOrder ASC, createdAt ASC`,
    ).bind(access.orgId).all<MobileChecklistTemplateRow>(),
  ]);
  if (!show) return json({ error: "Show not found." }, 404);
  const existingTemplateId = findChecklistTemplateId(templatesResult.results ?? [], label);
  const template: ChecklistTemplateWrite = existingTemplateId
    ? { kind: "existing", id: existingTemplateId }
    : {
        kind: "new",
        id: await createChecklistTemplateId(access.orgId, label),
        label,
        category,
      };
  const result = await persistChecklistItem({
    orgId: access.orgId,
    showId,
    serviceDate: show.serviceDate,
    template,
  }, db);
  return json({ ok: true, ...result }, result.added ? 201 : 200);
}

async function toggleChecklistEntryMobile(
  request: Request,
  url: URL,
  entryId: string,
  db: MobileApiDatabase,
): Promise<Response> {
  const access = await authorize(request, url, db, ["checklist:access"]);
  if (access instanceof Response) return access;
  const body = await readJson(request);
  if (!body || typeof body.checked !== "boolean") return json({ error: "Choose a valid checklist state." }, 400);
  const result = await db.prepare(
    `UPDATE checklist_entry
     SET checked = ?, checkedBy = ?, checkedAt = ?
     WHERE id = ? AND orgId = ?`,
  ).bind(
    body.checked ? 1 : 0,
    body.checked ? access.identity.name : null,
    body.checked ? new Date().toISOString() : null,
    entryId,
    access.orgId,
  ).run();
  if (!changedExactlyOneRow(result)) return json({ error: "Checklist item not found." }, 404);
  return json({ ok: true });
}

async function removeChecklistEntryMobile(
  request: Request,
  url: URL,
  entryId: string,
  db: MobileApiDatabase,
): Promise<Response> {
  const access = await authorize(request, url, db, ["checklist:access"]);
  if (access instanceof Response) return access;
  const result = await db.prepare("DELETE FROM checklist_entry WHERE id = ? AND orgId = ?")
    .bind(entryId, access.orgId).run();
  if (!changedExactlyOneRow(result)) return json({ error: "Checklist item not found." }, 404);
  return json({ ok: true });
}

async function updateChecklistCategoryMobile(
  request: Request,
  url: URL,
  templateId: string,
  db: MobileApiDatabase,
): Promise<Response> {
  const access = await authorize(request, url, db, ["checklist:access"]);
  if (access instanceof Response) return access;
  const body = await readJson(request);
  if (!body || !validChecklistCategory(body.category)) return json({ error: "Choose a valid department." }, 400);
  const result = await db.prepare(
    "UPDATE checklist_template SET category = ? WHERE id = ? AND orgId = ?",
  ).bind(body.category, templateId, access.orgId).run();
  if (!changedExactlyOneRow(result)) return json({ error: "Checklist item not found." }, 404);
  return json({ ok: true });
}

async function checklistSuggestions(request: Request, url: URL, db: MobileApiDatabase): Promise<Response> {
  const access = await authorize(request, url, db, ["checklist:access"]);
  if (access instanceof Response) return access;
  const showId = url.searchParams.get("showId");
  if (!validId(showId)) return json({ error: "Choose a valid show." }, 400);
  const draft = await buildMobileChecklistDraft(access.orgId, showId, db);
  if (!draft) return json({ error: "Show not found." }, 404);
  return json({ show: draft.show, suggestions: draft.suggestions });
}

async function applyChecklistSuggestions(request: Request, url: URL, db: MobileApiDatabase): Promise<Response> {
  const access = await authorize(request, url, db, ["checklist:access"]);
  if (access instanceof Response) return access;
  const body = await readJson(request);
  const showId = body?.showId;
  const suggestionIds = body?.suggestionIds;
  if (
    !validId(showId)
    || !Array.isArray(suggestionIds)
    || suggestionIds.length > 30
    || suggestionIds.some((id) => typeof id !== "string" || id.length === 0 || id.length > 100)
  ) {
    return json({ error: "Choose a valid show and up to 30 checklist suggestions." }, 400);
  }
  const draft = await buildMobileChecklistDraft(access.orgId, showId, db);
  if (!draft) return json({ error: "Show not found." }, 404);
  const requested = new Set(suggestionIds);
  const selected = draft.suggestions.filter((suggestion) => requested.has(suggestion.id));
  let added = 0;
  for (const suggestion of selected) {
    const template: ChecklistTemplateWrite = suggestion.existingTemplateId
      ? { kind: "existing", id: suggestion.existingTemplateId }
      : {
          kind: "new",
          id: await createChecklistTemplateId(access.orgId, suggestion.label),
          label: suggestion.label,
          category: suggestion.category,
        };
    const result = await persistChecklistItem({
      orgId: access.orgId,
      showId,
      serviceDate: draft.show.serviceDate,
      template,
    }, db);
    if (result.added) added += 1;
  }
  return json({ ok: true, added });
}

async function schedule(request: Request, url: URL, db: MobileApiDatabase): Promise<Response> {
  const access = await authorize(request, url, db);
  if (access instanceof Response) return access;
  const canViewFull = hasAny(access.identity, ["schedule:view", "schedule:manage"]);
  const requestedDate = url.searchParams.get("date");
  const requestedAssignmentId = url.searchParams.get("assignment");
  if (
    (requestedDate !== null && !validDate(requestedDate))
    || (requestedAssignmentId !== null && !validId(requestedAssignmentId))
  ) {
    return json({ error: "Choose a valid service date and assignment." }, 400);
  }
  const [settingsResult, selectedAssignment] = await Promise.all([
    db.prepare(
      "SELECT key, value FROM app_setting WHERE orgId = ? AND key IN ('org-timezone', 'default-service-window-minutes')",
    ).bind(access.orgId).all<{ key: string; value: string }>(),
    requestedAssignmentId
      ? db.prepare(
        `SELECT a.serviceDate
         FROM service_assignment a
         LEFT JOIN crew_member c ON c.id = a.crewMemberId AND c.orgId = a.orgId
         WHERE a.orgId = ? AND a.id = ? AND (? = 1 OR LOWER(c.email) = ?)
         LIMIT 1`,
      ).bind(
        access.orgId,
        requestedAssignmentId,
        canViewFull ? 1 : 0,
        access.identity.email,
      ).first<{ serviceDate: string }>()
      : Promise.resolve(null),
  ]);
  const settingMap = Object.fromEntries(
    (settingsResult.results ?? []).map((setting) => [setting.key, setting.value]),
  );
  const { serviceWindowMinutes } = readPhaseSettings(settingMap);
  const timeZone = settingMap["org-timezone"] || "Africa/Accra";
  const today = getTodayDateString(timeZone);
  const selectedDate = selectedAssignment?.serviceDate ?? requestedDate;
  const from = selectedDate ?? url.searchParams.get("from") ?? shiftDate(today, -7);
  const to = selectedDate ?? url.searchParams.get("to") ?? shiftDate(today, 45);
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
  const [result, responders] = await Promise.all([
    db.prepare(
      `SELECT id, showId, category, severity, description, reportedBy, serviceDate,
            timestamp, status, assignedTo, assignedName, acknowledgedAt, assignedAt,
            resolvedAt, resolvedBy,
            (SELECT CAST(COUNT(*) AS INTEGER) FROM incident_comment c
             WHERE c.orgId = incident.orgId AND c.incidentId = incident.id) AS commentCount
       FROM incident WHERE orgId = ?
       ORDER BY CASE WHEN status = 'open' THEN 0 ELSE 1 END, timestamp DESC LIMIT 100`,
    ).bind(access.orgId).all<MobileIncidentRow>(),
    resolveMobileIncidentResponders(access.orgId, access.identity.today, db),
  ]);
  const incidentRows = result.results ?? [];
  const discussion = await resolveMobileIncidentDiscussion(
    access.orgId,
    incidentRows.map((incident) => incident.id),
    db,
  );
  return json({
    canReport: hasAny(access.identity, ["incidents:report", "incidents:access"]),
    canManage: access.identity.permissions.includes("incidents:access"),
    canAssignResponders: isAdminTier(access.identity.role),
    discussionEnabled: true,
    historyEnabled: true,
    incidents: incidentRows,
    responders,
    comments: discussion.comments,
    reactions: discussion.reactions,
  });
}

async function resolveMobileIncidentDiscussion(
  orgId: string,
  incidentIds: readonly string[],
  db: MobileApiDatabase,
) {
  if (incidentIds.length === 0) return { comments: [], reactions: [] };
  const chunks: string[][] = [];
  for (let index = 0; index < incidentIds.length; index += 75) {
    chunks.push(incidentIds.slice(index, index + 75));
  }
  const rows = await Promise.all(chunks.map(async (ids) => {
    const placeholders = ids.map(() => "?").join(",");
    return Promise.all([
      db.prepare(
        `SELECT id, incidentId, userId, authorName, body, parentId, createdAt
         FROM incident_comment WHERE orgId = ? AND incidentId IN (${placeholders})`,
      ).bind(orgId, ...ids).all<MobileIncidentCommentRow>(),
      db.prepare(
        `SELECT r.id, r.targetId, r.userId, r.authorName, r.emoji, r.createdAt
         FROM content_reaction r JOIN incident_comment c ON c.id = r.targetId
         WHERE r.orgId = ? AND c.orgId = ? AND r.targetType = 'incident-comment'
           AND c.incidentId IN (${placeholders})`,
      ).bind(orgId, orgId, ...ids).all<MobileIncidentReactionRow>(),
    ]);
  }));
  const comments = rows.flatMap(([commentResult]) => commentResult.results ?? [])
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const reactions = rows.flatMap(([, reactionResult]) => reactionResult.results ?? [])
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  return { comments, reactions };
}

function parseBoundedPositiveInteger(value: string | null, fallback: number, maximum: number): number | null {
  if (value === null || value === "") return fallback;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= maximum ? parsed : null;
}

async function mobileIncidentHistory(request: Request, url: URL, db: MobileApiDatabase): Promise<Response> {
  const access = await authorize(request, url, db, ["incidents:report", "incidents:access"]);
  if (access instanceof Response) return access;
  const status = url.searchParams.get("status") ?? "all";
  const severity = url.searchParams.get("severity") ?? "all";
  const sort = url.searchParams.get("sort") ?? "newest";
  const query = (url.searchParams.get("query") ?? "").trim();
  const category = (url.searchParams.get("category") ?? "").trim();
  const assignee = (url.searchParams.get("assignee") ?? "").trim();
  const from = url.searchParams.get("from") ?? "";
  const to = url.searchParams.get("to") ?? "";
  const page = parseBoundedPositiveInteger(url.searchParams.get("page"), 1, 10_000);
  const pageSize = parseBoundedPositiveInteger(url.searchParams.get("pageSize"), 30, 100);
  if (!new Set(["all", "open", "resolved"]).has(status)
    || !new Set(["all", "low", "medium", "high", "critical"]).has(severity)
    || !new Set(["newest", "oldest", "severity"]).has(sort)
    || query.length > 200 || category.length > 100 || assignee.length > 200
    || (from && !validDate(from)) || (to && !validDate(to)) || (from && to && from > to)
    || page === null || pageSize === null) {
    return json({ error: "Choose valid incident history filters." }, 400);
  }

  const conditions = ["i.orgId = ?"];
  const params: unknown[] = [access.orgId];
  const add = (condition: string, value: unknown) => {
    conditions.push(condition);
    params.push(value);
  };
  if (status !== "all") add("i.status = ?", status);
  if (severity !== "all") add("i.severity = ?", severity);
  if (category) add("lower(trim(i.category)) = ?", category.toLowerCase());
  if (assignee) add("lower(i.assignedName) LIKE ?", `%${assignee.toLowerCase()}%`);
  if (from) add("i.serviceDate >= ?", from);
  if (to) add("i.serviceDate <= ?", to);
  if (query) {
    const needle = `%${query.toLowerCase()}%`;
    conditions.push("(lower(i.description) LIKE ? OR lower(i.reportedBy) LIKE ? OR lower(i.assignedName) LIKE ? OR lower(i.category) LIKE ?)");
    params.push(needle, needle, needle, needle);
  }
  const whereSql = conditions.join(" AND ");
  const orderSql = sort === "oldest"
    ? "i.timestamp ASC"
    : sort === "severity"
      ? "CASE lower(i.severity) WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC, i.timestamp DESC"
      : "i.timestamp DESC";
  const [countRow, incidentResult, categoryResult] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS total FROM incident i WHERE ${whereSql}`)
      .bind(...params).first<{ total: number }>(),
    db.prepare(
      `SELECT id, showId, category, severity, description, reportedBy, serviceDate,
              timestamp, status, assignedTo, assignedName, acknowledgedAt, assignedAt,
              resolvedAt, resolvedBy,
              (SELECT CAST(COUNT(*) AS INTEGER) FROM incident_comment c
               WHERE c.orgId = i.orgId AND c.incidentId = i.id) AS commentCount
       FROM incident i WHERE ${whereSql} ORDER BY ${orderSql} LIMIT ? OFFSET ?`,
    ).bind(...params, pageSize, (page - 1) * pageSize).all<MobileIncidentRow>(),
    db.prepare(
      `SELECT DISTINCT lower(trim(category)) AS category FROM incident
       WHERE orgId = ? AND trim(category) <> '' ORDER BY category ASC`,
    ).bind(access.orgId).all<{ category: string }>(),
  ]);
  return json({
    total: countRow?.total ?? 0,
    page,
    pageSize,
    categories: (categoryResult.results ?? []).map((row) => row.category),
    incidents: incidentResult.results ?? [],
  });
}

function parsePermissionSnapshot(value: string): Permission[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is Permission =>
      typeof item === "string" && item === "incidents:access",
    );
  } catch {
    return [];
  }
}

async function resolveMobileIncidentResponders(orgId: string, today: string, db: MobileApiDatabase) {
  const [membersResult, grantsResult] = await Promise.all([
    db.prepare(
      `SELECT m.userId, m.role, u.name
       FROM member m JOIN user u ON u.id = m.userId
       WHERE m.organizationId = ? ORDER BY u.name ASC, m.userId ASC`,
    ).bind(orgId).all<MobileIncidentResponderRow>(),
    db.prepare(
      `SELECT userId, permissions FROM access_grant
       WHERE orgId = ? AND revokedAt IS NULL AND startsOn <= ?
         AND (expiresOn IS NULL OR expiresOn > ?)`,
    ).bind(orgId, today, today).all<MobileIncidentGrantRow>(),
  ]);
  const grantedUsers = new Set(
    (grantsResult.results ?? [])
      .filter((grant) => parsePermissionSnapshot(grant.permissions).includes("incidents:access"))
      .map((grant) => grant.userId),
  );
  return (membersResult.results ?? [])
    .filter((member) => hasPermission(member.role, "incidents:access") || grantedUsers.has(member.userId))
    .map((member) => ({ userId: member.userId, name: member.name, role: member.role }));
}

type MobileIncidentCommand =
  | { kind: "claim" }
  | { kind: "assign"; targetUserId: string }
  | { kind: "unassign" }
  | { kind: "acknowledge" }
  | { kind: "resolve" };

function parseIncidentCommand(body: Record<string, unknown> | null): MobileIncidentCommand | null {
  if (body?.action === "claim") return { kind: "claim" };
  if (body?.action === "assign" && validId(body.targetUserId)) {
    return { kind: "assign", targetUserId: body.targetUserId };
  }
  if (body?.action === "unassign") return { kind: "unassign" };
  if (body?.action === "acknowledge") return { kind: "acknowledge" };
  if (body?.action === "resolve") return { kind: "resolve" };
  return null;
}

async function notifyMobileIncidentCommand(input: {
  orgId: string;
  actorId: string;
  actorName: string;
  subjectName?: string;
  incidentId: string;
  command: MobileIncidentCommand;
}) {
  let copy: { type: string; title: string; message: string };
  if (input.command.kind === "claim" || input.command.kind === "assign") {
    copy = {
      type: "incident-assigned",
      title: "Operational issue assigned",
      message: `${input.subjectName ?? input.actorName} is now responsible for this issue.`,
    };
  } else if (input.command.kind === "unassign") {
    copy = {
      type: "incident-unassigned",
      title: "Operational issue returned to the queue",
      message: `${input.actorName} returned the issue to the queue.`,
    };
  } else if (input.command.kind === "acknowledge") {
    copy = {
      type: "incident-acknowledged",
      title: "Operational issue acknowledged",
      message: `${input.actorName} acknowledged the assigned issue.`,
    };
  } else {
    copy = {
      type: "incident-resolved",
      title: "Operational issue resolved",
      message: `${input.actorName} marked the issue as resolved.`,
    };
  }
  try {
    const { notifyOperationalEvent } = await import("./operational-notifications.server");
    await notifyOperationalEvent({
      orgId: input.orgId,
      actorId: input.actorId,
      recipientIds: input.command.kind === "assign" ? [input.command.targetUserId] : [],
      includeLeadership: true,
      type: copy.type,
      severity: "warning",
      title: copy.title,
      message: copy.message,
      actionUrl: `production/incidents?incident=${encodeURIComponent(input.incidentId)}`,
      source: input.incidentId,
      pushTag: `fault-${input.incidentId}`,
    });
  } catch {
    // The state transition remains authoritative when notification delivery fails.
  }
}

async function commandIncident(
  request: Request,
  url: URL,
  incidentId: string,
  db: MobileApiDatabase,
): Promise<Response> {
  const access = await authorize(request, url, db, ["incidents:access"]);
  if (access instanceof Response) return access;
  const command = parseIncidentCommand(await readJson(request));
  if (!command) return json({ error: "Choose a valid incident action." }, 400);
  const incident = await db.prepare(
    "SELECT id, status, assignedTo, acknowledgedAt FROM incident WHERE id = ? AND orgId = ? LIMIT 1",
  ).bind(incidentId, access.orgId).first<{
    id: string;
    status: string;
    assignedTo: string | null;
    acknowledgedAt: string | null;
  }>();
  if (!incident) return json({ error: "Incident not found." }, 404);

  if (command.kind === "claim" && incident.status === "resolved") {
    return json({ error: "Resolved incidents cannot be claimed." }, 409);
  }
  if ((command.kind === "assign" || command.kind === "unassign") && incident.status === "resolved") {
    return json({ error: "Resolved incidents cannot be reassigned." }, 409);
  }
  if (command.kind === "acknowledge" && incident.status === "resolved") {
    return json({ error: "Resolved incidents cannot be acknowledged." }, 409);
  }
  if (command.kind === "claim" && incident.assignedTo && incident.assignedTo !== access.identity.userId) {
    return json({ error: "Another operator already owns this incident." }, 409);
  }
  if (command.kind === "acknowledge" && incident.assignedTo !== access.identity.userId) {
    return json({ error: "Only the assigned operator can acknowledge this incident." }, 403);
  }
  if ((command.kind === "assign" || command.kind === "unassign") && !isAdminTier(access.identity.role)) {
    return json({ error: "Only an Owner, Admin, or Director can reassign incidents." }, 403);
  }
  if (command.kind === "assign" && incident.assignedTo === command.targetUserId) return json({ ok: true });
  if (command.kind === "unassign" && incident.assignedTo === null) return json({ ok: true });
  let assignmentTarget: { userId: string; name: string } | null = null;
  if (command.kind === "assign") {
    const responders = await resolveMobileIncidentResponders(access.orgId, access.identity.today, db);
    assignmentTarget = responders.find((responder) => responder.userId === command.targetUserId) ?? null;
    if (!assignmentTarget) return json({ error: "That person cannot manage incidents in this organization." }, 400);
  }
  if (command.kind === "claim" && incident.assignedTo === access.identity.userId) return json({ ok: true });
  if (command.kind === "acknowledge" && incident.acknowledgedAt) return json({ ok: true });
  if (command.kind === "resolve" && incident.status === "resolved") return json({ ok: true });

  const now = new Date().toISOString();
  let result: ChecklistWriteResult;
  if (command.kind === "claim") {
    result = await db.prepare(
        `UPDATE incident SET assignedTo = ?, assignedName = ?, acknowledgedAt = ?, assignedBy = ?, assignedAt = ?
         WHERE id = ? AND orgId = ? AND status <> 'resolved'
           AND (assignedTo IS NULL OR assignedTo = '' OR assignedTo = ?)`,
      ).bind(access.identity.userId, access.identity.name, now, access.identity.userId, now, incidentId, access.orgId, access.identity.userId).run();
  } else if (command.kind === "assign") {
    if (!assignmentTarget) return json({ error: "That person cannot manage incidents in this organization." }, 400);
    result = await db.prepare(
      `UPDATE incident SET assignedTo = ?, assignedName = ?, acknowledgedAt = NULL, assignedBy = ?, assignedAt = ?
       WHERE id = ? AND orgId = ? AND status <> 'resolved'
         AND COALESCE(assignedTo, '') = ?`,
    ).bind(
      assignmentTarget.userId,
      assignmentTarget.name,
      access.identity.userId,
      now,
      incidentId,
      access.orgId,
      incident.assignedTo ?? "",
    ).run();
  } else if (command.kind === "unassign") {
    result = await db.prepare(
      `UPDATE incident SET assignedTo = NULL, assignedName = '', acknowledgedAt = NULL,
               assignedBy = NULL, assignedAt = NULL
       WHERE id = ? AND orgId = ? AND status <> 'resolved'
         AND COALESCE(assignedTo, '') = ?`,
    ).bind(incidentId, access.orgId, incident.assignedTo ?? "").run();
  } else if (command.kind === "acknowledge") {
    result = await db.prepare(
      `UPDATE incident SET acknowledgedAt = ?
       WHERE id = ? AND orgId = ? AND status <> 'resolved'
         AND assignedTo = ? AND acknowledgedAt IS NULL`,
    ).bind(now, incidentId, access.orgId, access.identity.userId).run();
  } else {
    result = await db.prepare(
      `UPDATE incident SET status = 'resolved', resolvedAt = ?, resolvedBy = ?
       WHERE id = ? AND orgId = ? AND status <> 'resolved'`,
    ).bind(now, access.identity.name, incidentId, access.orgId).run();
  }

  if (changedExactlyOneRow(result)) {
    await notifyMobileIncidentCommand({
      orgId: access.orgId,
      actorId: access.identity.userId,
      actorName: access.identity.name,
      subjectName: assignmentTarget?.name,
      incidentId,
      command,
    });
  } else {
    return json({ error: "This incident changed on another device. Refresh and try again." }, 409);
  }
  return json({ ok: true });
}

async function addMobileIncidentComment(
  request: Request,
  url: URL,
  incidentId: string,
  db: MobileApiDatabase,
): Promise<Response> {
  const access = await authorize(request, url, db, ["incidents:report", "incidents:access"]);
  if (access instanceof Response) return access;
  const body = await readJson(request);
  const requestId = validId(body?.requestId) ? body.requestId : null;
  const commentBody = typeof body?.body === "string" ? body.body.trim() : "";
  const parentId = body?.parentId === null || body?.parentId === undefined
    ? null
    : validId(body.parentId) ? body.parentId : undefined;
  if (!requestId || commentBody.length < 1 || commentBody.length > 2_000 || parentId === undefined) {
    return json({ error: "Write a comment of up to 2,000 characters." }, 400);
  }
  const incident = await db.prepare(
    "SELECT id, serviceDate, showId FROM incident WHERE id = ? AND orgId = ? LIMIT 1",
  ).bind(incidentId, access.orgId).first<{ id: string; serviceDate: string; showId: string | null }>();
  if (!incident) return json({ error: "Incident not found." }, 404);

  let parentAuthorId: string | null = null;
  if (parentId) {
    const parent = await db.prepare(
      "SELECT userId FROM incident_comment WHERE id = ? AND incidentId = ? AND orgId = ? LIMIT 1",
    ).bind(parentId, incidentId, access.orgId).first<{ userId: string }>();
    if (!parent) return json({ error: "Reply target not found." }, 400);
    parentAuthorId = parent.userId;
  }

  const comment: MobileIncidentCommentRow = {
    id: requestId,
    incidentId,
    userId: access.identity.userId,
    authorName: access.identity.name,
    body: commentBody,
    parentId,
    createdAt: new Date().toISOString(),
  };
  const result = await db.prepare(
    `INSERT OR IGNORE INTO incident_comment
     (id, orgId, incidentId, userId, authorName, body, parentId, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    comment.id,
    access.orgId,
    comment.incidentId,
    comment.userId,
    comment.authorName,
    comment.body,
    comment.parentId,
    comment.createdAt,
  ).run();
  if (!changedExactlyOneRow(result)) {
    const existing = await db.prepare(
      `SELECT id, incidentId, userId, authorName, body, parentId, createdAt
       FROM incident_comment WHERE id = ? AND orgId = ? AND userId = ? LIMIT 1`,
    ).bind(requestId, access.orgId, access.identity.userId).first<MobileIncidentCommentRow>();
    if (existing
      && existing.incidentId === incidentId
      && existing.body === commentBody
      && existing.parentId === parentId) {
      return json({ comment: existing });
    }
    return json({ error: "That comment request conflicts with an existing update." }, 409);
  }

  try {
    const { notifyOperationalEvent } = await import("./operational-notifications.server");
    await notifyOperationalEvent({
      orgId: access.orgId,
      actorId: access.identity.userId,
      recipientIds: parentAuthorId ? [parentAuthorId] : [],
      includeLeadership: true,
      type: parentId ? "incident-comment-reply" : "incident-comment",
      severity: "warning",
      title: parentId
        ? `${access.identity.name} replied to an issue comment`
        : `${access.identity.name} commented on an issue`,
      message: comment.body.slice(0, 240),
      actionUrl: `production/incidents?date=${encodeURIComponent(incident.serviceDate)}${incident.showId ? `&show=${encodeURIComponent(incident.showId)}` : ""}&incident=${encodeURIComponent(incidentId)}`,
      source: incidentId,
      pushTag: `incident-comment-${incidentId}`,
    });
  } catch {
    // The comment remains authoritative when notification delivery fails.
  }
  return json({ comment });
}

const mobileIncidentReactionEmojis = new Set(["👍", "❤️", "🎉", "👀", "🙏"]);

async function setMobileIncidentReaction(
  request: Request,
  url: URL,
  commentId: string,
  db: MobileApiDatabase,
): Promise<Response> {
  const access = await authorize(request, url, db, ["incidents:report", "incidents:access"]);
  if (access instanceof Response) return access;
  const body = await readJson(request);
  const emoji = typeof body?.emoji === "string" && mobileIncidentReactionEmojis.has(body.emoji)
    ? body.emoji
    : null;
  if (!emoji || typeof body?.active !== "boolean") {
    return json({ error: "Choose a valid reaction state." }, 400);
  }
  const target = await db.prepare(
    `SELECT c.userId, c.incidentId FROM incident_comment c
     JOIN incident i ON i.id = c.incidentId
     WHERE c.id = ? AND c.orgId = ? AND i.orgId = ? LIMIT 1`,
  ).bind(commentId, access.orgId, access.orgId).first<{ userId: string; incidentId: string }>();
  if (!target) return json({ error: "Comment not found." }, 404);

  if (!body.active) {
    await db.prepare(
      `DELETE FROM content_reaction WHERE orgId = ? AND targetType = 'incident-comment'
       AND targetId = ? AND userId = ? AND emoji = ?`,
    ).bind(access.orgId, commentId, access.identity.userId, emoji).run();
    return json({ active: false });
  }

  const reaction: MobileIncidentReactionRow = {
    id: crypto.randomUUID(),
    targetId: commentId,
    userId: access.identity.userId,
    authorName: access.identity.name,
    emoji,
    createdAt: new Date().toISOString(),
  };
  const result = await db.prepare(
    `INSERT OR IGNORE INTO content_reaction
     (id, orgId, targetType, targetId, userId, authorName, emoji, createdAt)
     VALUES (?, ?, 'incident-comment', ?, ?, ?, ?, ?)`,
  ).bind(
    reaction.id,
    access.orgId,
    reaction.targetId,
    reaction.userId,
    reaction.authorName,
    reaction.emoji,
    reaction.createdAt,
  ).run();
  if (changedExactlyOneRow(result) && target.userId !== access.identity.userId) {
    try {
      const { notifyOperationalEvent } = await import("./operational-notifications.server");
      await notifyOperationalEvent({
        orgId: access.orgId,
        actorId: access.identity.userId,
        recipientIds: [target.userId],
        type: "comment-reaction",
        title: `${access.identity.name} reacted ${emoji} to your comment`,
        message: "Open the incident discussion to view the reaction.",
        actionUrl: `production/incidents?incident=${encodeURIComponent(target.incidentId)}`,
        source: commentId,
        pushTag: `comment-reaction-${commentId}`,
      });
    } catch {
      // The reaction remains authoritative when notification delivery fails.
    }
  }
  return json({ active: true, reaction });
}

async function updateMobileIncident(
  request: Request,
  url: URL,
  incidentId: string,
  db: MobileApiDatabase,
): Promise<Response> {
  const access = await authorize(request, url, db, ["incidents:access"]);
  if (access instanceof Response) return access;
  const body = await readJson(request);
  const category = typeof body?.category === "string" ? body.category.trim() : "";
  const severity = typeof body?.severity === "string" ? body.severity.trim() : "";
  const description = typeof body?.description === "string" ? body.description.trim() : "";
  if (!new Set(["audio", "video", "stream", "lighting", "other"]).has(category)
    || !new Set(["low", "medium", "high"]).has(severity)
    || description.length < 2 || description.length > 2_000) {
    return json({ error: "Choose a category, severity, and description." }, 400);
  }
  const result = await db.prepare(
    `UPDATE incident SET category = ?, severity = ?, description = ?
     WHERE id = ? AND orgId = ?`,
  ).bind(category, severity, description, incidentId, access.orgId).run();
  if (!changedExactlyOneRow(result)) return json({ error: "Incident not found." }, 404);
  try {
    const { notifyOperationalEvent } = await import("./operational-notifications.server");
    await notifyOperationalEvent({
      orgId: access.orgId,
      actorId: access.identity.userId,
      includeLeadership: true,
      type: "incident-updated",
      severity: severity === "high" ? "critical" : "warning",
      title: "Operational issue updated",
      message: description.slice(0, 240),
      actionUrl: `production/incidents?incident=${encodeURIComponent(incidentId)}`,
      source: incidentId,
      pushTag: `incident-${incidentId}`,
    });
  } catch {
    // The edit remains authoritative when notification delivery fails.
  }
  return json({ ok: true });
}

async function deleteMobileIncident(
  request: Request,
  url: URL,
  incidentId: string,
  db: MobileApiDatabase,
): Promise<Response> {
  const access = await authorize(request, url, db, ["incidents:access"]);
  if (access instanceof Response) return access;
  const result = await db.prepare("DELETE FROM incident WHERE id = ? AND orgId = ?")
    .bind(incidentId, access.orgId).run();
  return changedExactlyOneRow(result)
    ? json({ ok: true })
    : json({ error: "Incident not found." }, 404);
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

function serializeCheckInMember(member: MobileCheckInMemberRow) {
  return { ...member, isOnline: Boolean(member.isOnline) };
}

async function checkIn(request: Request, url: URL, db: MobileApiDatabase): Promise<Response> {
  const access = await authorize(request, url, db, ["checkin:access"]);
  if (access instanceof Response) return access;
  const result = await db.prepare(
    `SELECT id, memberId, name, role, photoUrl, isOnline, lastCheckIn, lastCheckOut
     FROM crew_member WHERE orgId = ? ORDER BY name ASC, id ASC`,
  ).bind(access.orgId).all<MobileCheckInMemberRow>();
  return json({ members: (result.results ?? []).map(serializeCheckInMember) });
}

async function teamMembers(request: Request, url: URL, db: MobileApiDatabase): Promise<Response> {
  const access = await authorize(request, url, db, ["settings:members"]);
  if (access instanceof Response) return access;
  const [membersResult, invitationsResult] = await Promise.all([
    db.prepare(
      `SELECT m.id, m.userId, m.organizationId, m.role, m.createdAt,
              u.name AS userName, u.email AS userEmail, u.image AS userImage
       FROM member m
       JOIN user u ON u.id = m.userId
       WHERE m.organizationId = ?
       ORDER BY m.createdAt ASC, m.id ASC`,
    ).bind(access.orgId).all<MobileOrganizationMemberRow>(),
    db.prepare(
      `SELECT id, email, role, status, expiresAt, createdAt
       FROM invitation
       WHERE organizationId = ? AND status = 'pending'
       ORDER BY createdAt DESC, id ASC`,
    ).bind(access.orgId).all<MobileOrganizationInvitationRow>(),
  ]);
  return json({
    currentUserId: access.identity.userId,
    assignableRoles: [...ASSIGNABLE_ROLES],
    members: (membersResult.results ?? []).map((member) => ({
      id: member.id,
      userId: member.userId,
      organizationId: member.organizationId,
      role: member.role,
      createdAt: member.createdAt,
      user: {
        id: member.userId,
        name: member.userName,
        email: member.userEmail,
        image: member.userImage,
      },
    })),
    invitations: invitationsResult.results ?? [],
  });
}

function membershipMutationStatus(error: unknown): number {
  if (error instanceof PlanLimitError) return error.status;
  const message = error instanceof Error ? error.message : "";
  const normalized = message.toLowerCase();
  if (normalized.includes("not allowed") || normalized.includes("forbidden") || normalized.includes("unauthorized")) return 403;
  if (normalized.includes("not found")) return 404;
  if (normalized.includes("already") || normalized.includes("only owner") || normalized.includes("without an owner")) return 409;
  return 400;
}

async function inviteTeamMember(request: Request, url: URL, db: MobileApiDatabase): Promise<Response> {
  const access = await authorize(request, url, db, ["settings:members"]);
  if (access instanceof Response) return access;
  const body = await readJson(request);
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 254 || !validAssignableRole(body?.role)) {
    return json({ error: "Enter a valid email address and role." }, 400);
  }
  try {
    const [memberCount, invitationCount] = await Promise.all([
      db.prepare("SELECT CAST(COUNT(*) AS INTEGER) AS count FROM member WHERE organizationId = ?")
        .bind(access.orgId).first<{ count: number }>(),
      db.prepare("SELECT CAST(COUNT(*) AS INTEGER) AS count FROM invitation WHERE organizationId = ? AND status = 'pending'")
        .bind(access.orgId).first<{ count: number }>(),
    ]);
    const { checkPlanLimit } = await import("./plan-limits");
    await checkPlanLimit(access.orgId, "members", (memberCount?.count ?? 0) + (invitationCount?.count ?? 0));
    const invitation = await getAuth().api.createInvitation({
      headers: request.headers,
      body: { email, role: body.role, organizationId: access.orgId },
    });
    return json({ invitation }, 201);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unable to invite this member." }, membershipMutationStatus(error));
  }
}

async function cancelTeamInvitation(
  request: Request,
  url: URL,
  invitationId: string,
  db: MobileApiDatabase,
): Promise<Response> {
  const access = await authorize(request, url, db, ["settings:members"]);
  if (access instanceof Response) return access;
  const invitation = await db.prepare(
    "SELECT id FROM invitation WHERE id = ? AND organizationId = ? AND status = 'pending' LIMIT 1",
  ).bind(invitationId, access.orgId).first<{ id: string }>();
  if (!invitation) return json({ error: "Invitation not found." }, 404);
  try {
    await getAuth().api.cancelInvitation({
      headers: request.headers,
      body: { invitationId: invitation.id },
    });
    return json({ ok: true });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unable to cancel this invitation." }, membershipMutationStatus(error));
  }
}

async function updateTeamMemberRole(
  request: Request,
  url: URL,
  memberId: string,
  db: MobileApiDatabase,
): Promise<Response> {
  const access = await authorize(request, url, db, ["settings:members"]);
  if (access instanceof Response) return access;
  const body = await readJson(request);
  if (!validAssignableRole(body?.role)) return json({ error: "Choose a valid member role." }, 400);
  const member = await db.prepare(
    "SELECT id FROM member WHERE id = ? AND organizationId = ? LIMIT 1",
  ).bind(memberId, access.orgId).first<{ id: string }>();
  if (!member) return json({ error: "Member not found." }, 404);
  try {
    const result = await getAuth().api.updateMemberRole({
      headers: request.headers,
      body: { memberId: member.id, role: body.role, organizationId: access.orgId },
    });
    return json({ member: result });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unable to update this member." }, membershipMutationStatus(error));
  }
}

async function removeTeamMember(
  request: Request,
  url: URL,
  memberId: string,
  db: MobileApiDatabase,
): Promise<Response> {
  const access = await authorize(request, url, db, ["settings:members"]);
  if (access instanceof Response) return access;
  const member = await db.prepare(
    "SELECT id FROM member WHERE id = ? AND organizationId = ? LIMIT 1",
  ).bind(memberId, access.orgId).first<{ id: string }>();
  if (!member) return json({ error: "Member not found." }, 404);
  try {
    await getAuth().api.removeMember({
      headers: request.headers,
      body: { memberIdOrEmail: member.id, organizationId: access.orgId },
    });
    return json({ ok: true });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unable to remove this member." }, membershipMutationStatus(error));
  }
}

async function teamCrew(request: Request, url: URL, db: MobileApiDatabase): Promise<Response> {
  const access = await authorize(request, url, db, ["settings:members"]);
  if (access instanceof Response) return access;
  const result = await db.prepare(
    `SELECT id, memberId, name, role, email, photoUrl, isOnline, lastCheckIn, lastCheckOut
     FROM crew_member WHERE orgId = ? ORDER BY name ASC, id ASC`,
  ).bind(access.orgId).all<MobileCheckInMemberRow & { email: string }>();
  return json({ members: (result.results ?? []).map(serializeCheckInMember) });
}

function crewMutationStatus(error: unknown): number {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return message.includes("unique") || message.includes("constraint") ? 409 : 400;
}

async function createTeamCrewMember(request: Request, url: URL, db: MobileApiDatabase): Promise<Response> {
  const access = await authorize(request, url, db, ["settings:members"]);
  if (access instanceof Response) return access;
  const input = parseCrewMemberWrite(await readJson(request));
  if (!input) return json({ error: "Enter a valid member ID, name, role, email, and photo." }, 400);
  const id = crypto.randomUUID();
  try {
    const result = await db.prepare(
      `INSERT INTO crew_member (id, orgId, memberId, name, role, email, photoUrl, isOnline, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP)`,
    ).bind(id, access.orgId, input.memberId, input.name, input.role, input.email, input.photoUrl).run();
    if (!changedExactlyOneRow(result)) return json({ error: "Crew member was not created." }, 409);
    return json({ ok: true, id }, 201);
  } catch (error) {
    return json({ error: crewMutationStatus(error) === 409 ? "That member ID is already in use." : "Unable to create this crew member." }, crewMutationStatus(error));
  }
}

async function updateTeamCrewMember(
  request: Request,
  url: URL,
  memberId: string,
  db: MobileApiDatabase,
): Promise<Response> {
  const access = await authorize(request, url, db, ["settings:members"]);
  if (access instanceof Response) return access;
  const input = parseCrewMemberWrite(await readJson(request));
  if (!input) return json({ error: "Enter a valid member ID, name, role, email, and photo." }, 400);
  try {
    const result = await db.prepare(
      `UPDATE crew_member
       SET memberId = ?, name = ?, role = ?, email = ?, photoUrl = ?
       WHERE id = ? AND orgId = ?`,
    ).bind(input.memberId, input.name, input.role, input.email, input.photoUrl, memberId, access.orgId).run();
    if (!changedExactlyOneRow(result)) return json({ error: "Crew member not found." }, 404);
    return json({ ok: true });
  } catch (error) {
    return json({ error: crewMutationStatus(error) === 409 ? "That member ID is already in use." : "Unable to update this crew member." }, crewMutationStatus(error));
  }
}

async function removeTeamCrewMember(
  request: Request,
  url: URL,
  memberId: string,
  db: MobileApiDatabase,
): Promise<Response> {
  const access = await authorize(request, url, db, ["settings:members"]);
  if (access instanceof Response) return access;
  const result = await db.prepare("DELETE FROM crew_member WHERE id = ? AND orgId = ?")
    .bind(memberId, access.orgId).run();
  return changedExactlyOneRow(result)
    ? json({ ok: true })
    : json({ error: "Crew member not found." }, 404);
}

async function setCheckInStatus(
  request: Request,
  url: URL,
  memberId: string,
  db: MobileApiDatabase,
): Promise<Response> {
  const access = await authorize(request, url, db, ["checkin:access"]);
  if (access instanceof Response) return access;
  const body = await readJson(request);
  if (!body || typeof body.checkedIn !== "boolean") {
    return json({ error: "Choose whether this crew member is checked in." }, 400);
  }
  const checkedIn = body.checkedIn;
  const update = await db.prepare(
    `UPDATE crew_member
     SET isOnline = ?,
         lastCheckIn = CASE WHEN ? = 1 AND isOnline = 0 THEN CURRENT_TIMESTAMP ELSE lastCheckIn END,
         lastCheckOut = CASE WHEN ? = 0 AND isOnline = 1 THEN CURRENT_TIMESTAMP ELSE lastCheckOut END
     WHERE id = ? AND orgId = ?`,
  ).bind(checkedIn ? 1 : 0, checkedIn ? 1 : 0, checkedIn ? 1 : 0, memberId, access.orgId).run();
  if (!changedExactlyOneRow(update)) return json({ error: "Crew member not found." }, 404);
  const member = await db.prepare(
    `SELECT id, memberId, name, role, photoUrl, isOnline, lastCheckIn, lastCheckOut
     FROM crew_member WHERE id = ? AND orgId = ? LIMIT 1`,
  ).bind(memberId, access.orgId).first<MobileCheckInMemberRow>();
  return member
    ? json({ member: serializeCheckInMember(member) })
    : json({ error: "Crew member not found." }, 404);
}

async function teamAccess(request: Request, url: URL, db: MobileApiDatabase): Promise<Response> {
  const access = await authorize(request, url, db);
  if (access instanceof Response) return access;
  const snapshot = await getAccessManagementSnapshotForActor({
    orgId: access.orgId,
    actorUserId: access.identity.userId,
    database: db,
  });
  return json({
    ...snapshot,
    capabilities: ACCESS_CAPABILITIES.map(({ id, label, description }) => ({ id, label, description })),
  });
}

function accessMutationStatus(error: unknown): number {
  const message = error instanceof Error ? error.message : "";
  if (message.startsWith("Only an Owner") || message.startsWith("The on-duty TM")) return 403;
  if (message.includes("already has")) return 409;
  if (message.includes("not a member") || message.includes("no longer active")) return 404;
  return 400;
}

async function grantTeamAccess(request: Request, url: URL, db: MobileApiDatabase): Promise<Response> {
  const access = await authorize(request, url, db);
  if (access instanceof Response) return access;
  const body = await readJson(request);
  const capability = typeof body?.capability === "string"
    ? getAccessCapability(body.capability)
    : null;
  const duration: AccessGrantDuration | null = body?.duration === "this-week" || body?.duration === "until-revoked"
    ? body.duration
    : null;
  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
  if (!body || !validId(body.userId) || !capability || !duration || reason.length > 240) {
    return json({ error: "Choose a member, capability, and valid duration." }, 400);
  }
  try {
    const grant = await grantMemberAccessForActor({
      orgId: access.orgId,
      actor: { userId: access.identity.userId, name: access.identity.name },
      userId: body.userId,
      capability: capability.id,
      duration,
      reason,
      database: db,
    });
    return json({ ok: true, grantId: grant.id }, 201);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unable to grant access." }, accessMutationStatus(error));
  }
}

async function revokeTeamAccess(
  request: Request,
  url: URL,
  grantId: string,
  db: MobileApiDatabase,
): Promise<Response> {
  const access = await authorize(request, url, db);
  if (access instanceof Response) return access;
  try {
    await revokeMemberAccessForActor({
      orgId: access.orgId,
      actor: { userId: access.identity.userId, name: access.identity.name },
      grantId,
      database: db,
    });
    return json({ ok: true });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unable to revoke access." }, accessMutationStatus(error));
  }
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

function canonicalDirectMessageParticipants(roomId: string): [string, string] | null {
  const parts = roomId.split(":");
  return parts.length === 3 && parts[0] === "dm" && Boolean(parts[1]) && parts[1] < parts[2]
    ? [parts[1], parts[2]]
    : null;
}

async function chatMembers(request: Request, url: URL, db: MobileApiDatabase): Promise<Response> {
  const access = await authorize(request, url, db, ["chat:access"]);
  if (access instanceof Response) return access;
  const result = await db.prepare(
    `SELECT m.userId, m.role, u.name, u.image
     FROM member m
     JOIN user u ON u.id = m.userId
     WHERE m.organizationId = ?
     ORDER BY u.name COLLATE NOCASE ASC, m.createdAt ASC`,
  ).bind(access.orgId).all<MobileChatMemberRow>();
  return json({
    currentUserId: access.identity.userId,
    canInvite: CHAT_PASS_CREATORS.has(access.identity.role),
    members: result.results ?? [],
  });
}

async function chatNotificationsEnabled(orgId: string, db: MobileApiDatabase): Promise<boolean> {
  const setting = await db.prepare(
    "SELECT value FROM app_setting WHERE orgId = ? AND key = 'notify-app-chat' LIMIT 1",
  ).bind(orgId).first<{ value: string }>();
  return setting?.value !== "false";
}

async function notifyMobileChatMessage(request: Request, url: URL, db: MobileApiDatabase): Promise<Response> {
  const access = await authorize(request, url, db, ["chat:access"]);
  if (access instanceof Response) return access;
  const body = await readJson(request);
  const roomId = typeof body?.roomId === "string" ? body.roomId.trim() : "";
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  const messageId = validId(body?.messageId) ? body.messageId : null;
  const mentionedUserIds = Array.isArray(body?.mentionedUserIds)
    ? [...new Set(body.mentionedUserIds.filter(validId))]
    : [];
  const directParticipants = canonicalDirectMessageParticipants(roomId);
  if (
    roomId.length === 0 || roomId.length > 220 || text.length > 4_000
    || mentionedUserIds.length > 20
    || (roomId !== "production" && roomId !== "planning" && !directParticipants)
    || (directParticipants && !directParticipants.includes(access.identity.userId))
  ) return json({ error: "Invalid chat notification." }, 400);

  const recipients = new Map<string, "dm" | "mention">();
  if (directParticipants) {
    const recipientId = directParticipants.find((userId) => userId !== access.identity.userId);
    if (recipientId) recipients.set(recipientId, "dm");
  }
  for (const userId of mentionedUserIds) {
    if (userId !== access.identity.userId) recipients.set(userId, "mention");
  }
  if (recipients.size === 0 || !await chatNotificationsEnabled(access.orgId, db)) return json({ notified: 0 });

  const validMembers = await db.prepare(
    `SELECT userId FROM member WHERE organizationId = ? AND userId IN (${[...recipients].map(() => "?").join(",")})`,
  ).bind(access.orgId, ...recipients.keys()).all<{ userId: string }>();
  const memberIds = new Set((validMembers.results ?? []).map((member) => member.userId));
  const cleanText = text.replace(/<@([^|>]+)\|([^>]+)>/g, "@$2").slice(0, 240) || "Shared an attachment";
  const actionUrl = `chat?room=${encodeURIComponent(roomId)}${messageId ? `&message=${encodeURIComponent(messageId)}` : ""}`;
  let notified = 0;
  try {
    const { notifyOperationalEvent } = await import("./operational-notifications.server");
    for (const kind of ["dm", "mention"] as const) {
      const recipientIds = [...recipients]
        .filter(([userId, recipientKind]) => recipientKind === kind && memberIds.has(userId))
        .map(([userId]) => userId);
      if (!recipientIds.length) continue;
      const result = await notifyOperationalEvent({
        orgId: access.orgId,
        actorId: access.identity.userId,
        recipientIds,
        type: kind === "dm" ? "chat-direct-message" : "chat-mention",
        title: kind === "dm" ? `New message from ${access.identity.name}` : `${access.identity.name} mentioned you`,
        message: cleanText,
        actionUrl,
        source: messageId ?? `chat:${roomId}`,
        pushTag: kind === "dm" ? `chat-dm-${roomId}` : `chat-mention-${roomId}`,
        ...(messageId ? { dedupeKey: `chat-message:${messageId}:${kind}` } : {}),
      });
      notified += result.notified;
    }
  } catch {
    // The durable chat message remains authoritative when notification delivery fails.
  }
  return json({ notified });
}

async function notifyMobileChatReaction(request: Request, url: URL, db: MobileApiDatabase): Promise<Response> {
  const access = await authorize(request, url, db, ["chat:access"]);
  if (access instanceof Response) return access;
  const body = await readJson(request);
  const roomId = typeof body?.roomId === "string" ? body.roomId.trim() : "";
  const directParticipants = canonicalDirectMessageParticipants(roomId);
  if (
    !validId(body?.messageId) || !validId(body?.targetUserId)
    || !new Set(["👍", "❤️", "🎉", "👀", "🙏"]).has(body?.emoji as string)
    || roomId.length === 0 || roomId.length > 220
    || (roomId !== "production" && roomId !== "planning" && !directParticipants)
    || (directParticipants && !directParticipants.includes(access.identity.userId))
  ) return json({ error: "Invalid chat reaction notification." }, 400);
  if (body.targetUserId === access.identity.userId || !await chatNotificationsEnabled(access.orgId, db)) {
    return json({ notified: 0 });
  }
  const target = await db.prepare(
    "SELECT userId FROM member WHERE organizationId = ? AND userId = ? LIMIT 1",
  ).bind(access.orgId, body.targetUserId).first<{ userId: string }>();
  if (!target) return json({ notified: 0 });
  let notified = 0;
  try {
    const { notifyOperationalEvent } = await import("./operational-notifications.server");
    const result = await notifyOperationalEvent({
      orgId: access.orgId,
      actorId: access.identity.userId,
      recipientIds: [target.userId],
      type: "chat-reaction",
      title: `${access.identity.name} reacted ${String(body.emoji)} to your message`,
      message: "Open the conversation to view the reaction.",
      actionUrl: `chat?room=${encodeURIComponent(roomId)}&message=${encodeURIComponent(body.messageId)}`,
      source: body.messageId,
      pushTag: `chat-reaction-${body.messageId}`,
    });
    notified = result.notified;
  } catch {
    // The durable chat reaction remains authoritative when notification delivery fails.
  }
  return json({ notified });
}

async function createMobileCrewChatPass(
  request: Request,
  url: URL,
  env: MobileApiEnvironment,
): Promise<Response> {
  const access = await authorize(request, url, env.DB, ["chat:access"]);
  if (access instanceof Response) return access;
  if (!CHAT_PASS_CREATORS.has(access.identity.role)) return json({ error: "Only production leaders can invite guest crew." }, 403);
  if (!env.KIOSK_SECRET) return json({ error: "Guest chat invitations are not configured." }, 503);
  const body = await readJson(request);
  const hours = typeof body?.hours === "number" && Number.isInteger(body.hours) ? body.hours : 0;
  if (hours < 1 || hours > 24) return json({ error: "Choose an expiry between 1 and 24 hours." }, 400);
  const organization = await env.DB.prepare("SELECT slug FROM organization WHERE id = ? LIMIT 1")
    .bind(access.orgId).first<{ slug: string }>();
  if (!organization) return json({ error: "Organization not found." }, 404);
  const now = Math.floor(Date.now() / 1_000);
  const expiresAt = (now + hours * 3_600) * 1_000;
  const token = `chat_${await signToken({
    scope: "crew-chat",
    orgId: access.orgId,
    orgSlug: organization.slug,
    exp: expiresAt / 1_000,
    iat: now,
  }, env.KIOSK_SECRET)}`;
  return json({
    token,
    expiresAt,
    joinUrl: `${url.origin}/join/chat/${encodeURIComponent(token)}`,
  });
}

async function createMobilePlanningChatPass(
  request: Request,
  url: URL,
  env: MobileApiEnvironment,
): Promise<Response> {
  const access = await authorize(request, url, env.DB, ["chat:access"]);
  if (access instanceof Response) return access;
  if (!CHAT_PASS_CREATORS.has(access.identity.role)) return json({ error: "Only production leaders can share the Planning Room." }, 403);
  if (!env.KIOSK_SECRET) return json({ error: "Planning Room invitations are not configured." }, 503);
  const body = await readJson(request);
  const hours = typeof body?.hours === "number" && Number.isInteger(body.hours) ? body.hours : 0;
  const requestedUserIds = Array.isArray(body?.targetUserIds) ? [...new Set(body.targetUserIds.filter(validId))] : [];
  if (hours < 1 || hours > 24 || requestedUserIds.length < 1 || requestedUserIds.length > 50) {
    return json({ error: "Choose members and an expiry between 1 and 24 hours." }, 400);
  }
  const [organization, targetResult] = await Promise.all([
    env.DB.prepare("SELECT slug FROM organization WHERE id = ? LIMIT 1")
      .bind(access.orgId).first<{ slug: string }>(),
    env.DB.prepare(
      `SELECT userId FROM member WHERE organizationId = ? AND userId IN (${requestedUserIds.map(() => "?").join(",")})`,
    ).bind(access.orgId, ...requestedUserIds).all<{ userId: string }>(),
  ]);
  if (!organization) return json({ error: "Organization not found." }, 404);
  const targetUserIds = [...new Set((targetResult.results ?? []).map((target) => target.userId))];
  if (targetUserIds.length !== requestedUserIds.length) return json({ error: "Every selected person must be an organization member." }, 400);
  const now = Math.floor(Date.now() / 1_000);
  const expiresAt = (now + hours * 3_600) * 1_000;
  const token = `planning_chat_${await signToken({
    scope: "planning-chat",
    roomId: "planning",
    orgId: access.orgId,
    orgSlug: organization.slug,
    targetUserIds,
    exp: expiresAt / 1_000,
    iat: now,
  }, env.KIOSK_SECRET)}`;
  try {
    const { notifyOperationalEvent } = await import("./operational-notifications.server");
    await notifyOperationalEvent({
      orgId: access.orgId,
      actorId: access.identity.userId,
      recipientIds: targetUserIds,
      type: "chat-planning-invite",
      title: `${access.identity.name} shared the Planning Room with you`,
      message: "Open the invite to join the targeted Planning Room conversation.",
      actionUrl: "chat?room=planning",
      source: `planning-chat:${crypto.randomUUID()}`,
      pushTag: `planning-chat-invite-${access.orgId}`,
    });
  } catch {
    // The signed pass remains usable when notification delivery fails.
  }
  return json({
    token,
    expiresAt,
    targetCount: targetUserIds.length,
    joinUrl: `${url.origin}/join/chat/planning/${encodeURIComponent(token)}`,
  });
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
  if (url.pathname === "/api/mobile/v1/incidents/history" && request.method === "GET") return mobileIncidentHistory(request, url, env.DB);
  if (url.pathname === "/api/mobile/v1/incidents" && request.method === "GET") return incidents(request, url, env.DB);
  if (url.pathname === "/api/mobile/v1/incidents" && request.method === "POST") return createIncident(request, url, env.DB);
  if (url.pathname === "/api/mobile/v1/chat/members" && request.method === "GET") return chatMembers(request, url, env.DB);
  if (url.pathname === "/api/mobile/v1/chat/notify" && request.method === "POST") return notifyMobileChatMessage(request, url, env.DB);
  if (url.pathname === "/api/mobile/v1/chat/reaction-notify" && request.method === "POST") return notifyMobileChatReaction(request, url, env.DB);
  if (url.pathname === "/api/mobile/v1/chat/passes/crew" && request.method === "POST") return createMobileCrewChatPass(request, url, env);
  if (url.pathname === "/api/mobile/v1/chat/passes/planning" && request.method === "POST") return createMobilePlanningChatPass(request, url, env);
  if (url.pathname === "/api/mobile/v1/checkin" && request.method === "GET") return checkIn(request, url, env.DB);
  if (url.pathname === "/api/mobile/v1/team/members" && request.method === "GET") return teamMembers(request, url, env.DB);
  if (url.pathname === "/api/mobile/v1/team/invitations" && request.method === "POST") return inviteTeamMember(request, url, env.DB);
  if (url.pathname === "/api/mobile/v1/team/crew" && request.method === "GET") return teamCrew(request, url, env.DB);
  if (url.pathname === "/api/mobile/v1/team/crew" && request.method === "POST") return createTeamCrewMember(request, url, env.DB);
  if (url.pathname === "/api/mobile/v1/team/access" && request.method === "GET") return teamAccess(request, url, env.DB);
  if (url.pathname === "/api/mobile/v1/team/access/grants" && request.method === "POST") return grantTeamAccess(request, url, env.DB);
  if (url.pathname === "/api/mobile/v1/devices" && request.method === "GET") return devices(request, url, env.DB);
  if (url.pathname === "/api/mobile/v1/checklist" && request.method === "GET") return checklist(request, url, env.DB);
  if (url.pathname === "/api/mobile/v1/checklist/items" && request.method === "POST") return addChecklistItemMobile(request, url, env.DB);
  if (url.pathname === "/api/mobile/v1/checklist/suggestions" && request.method === "GET") return checklistSuggestions(request, url, env.DB);
  if (url.pathname === "/api/mobile/v1/checklist/suggestions/apply" && request.method === "POST") return applyChecklistSuggestions(request, url, env.DB);
  if (url.pathname === "/api/mobile/v1/notifications/read" && request.method === "POST") return notificationRead(request, env.DB);
  if (url.pathname === "/api/mobile/v1/push-token" && request.method === "POST") return pushToken(request, env.DB);
  const checkInMemberMatch = url.pathname.match(/^\/api\/mobile\/v1\/checkin\/members\/([^/]+)\/status$/);
  if (checkInMemberMatch && request.method === "POST") {
    const memberId = decodePathId(checkInMemberMatch[1]);
    return memberId
      ? setCheckInStatus(request, url, memberId, env.DB)
      : json({ error: "Not found." }, 404);
  }
  const incidentMatch = url.pathname.match(/^\/api\/mobile\/v1\/incidents\/([^/]+)\/(command|update|remove)$/);
  if (incidentMatch && request.method === "POST") {
    const incidentId = decodeURIComponent(incidentMatch[1] ?? "");
    if (!validId(incidentId)) return json({ error: "A valid incident id is required." }, 400);
    if (incidentMatch[2] === "command") return commandIncident(request, url, incidentId, env.DB);
    if (incidentMatch[2] === "update") return updateMobileIncident(request, url, incidentId, env.DB);
    return deleteMobileIncident(request, url, incidentId, env.DB);
  }
  const incidentCommentMatch = url.pathname.match(/^\/api\/mobile\/v1\/incidents\/([^/]+)\/comments$/);
  if (incidentCommentMatch && request.method === "POST") {
    const incidentId = decodePathId(incidentCommentMatch[1]);
    return incidentId
      ? addMobileIncidentComment(request, url, incidentId, env.DB)
      : json({ error: "Not found." }, 404);
  }
  const incidentReactionMatch = url.pathname.match(/^\/api\/mobile\/v1\/incident-comments\/([^/]+)\/reaction$/);
  if (incidentReactionMatch && request.method === "POST") {
    const commentId = decodePathId(incidentReactionMatch[1]);
    return commentId
      ? setMobileIncidentReaction(request, url, commentId, env.DB)
      : json({ error: "Not found." }, 404);
  }
  const teamGrantMatch = url.pathname.match(/^\/api\/mobile\/v1\/team\/access\/grants\/([^/]+)\/revoke$/);
  if (teamGrantMatch && request.method === "POST") {
    const grantId = decodePathId(teamGrantMatch[1]);
    return grantId
      ? revokeTeamAccess(request, url, grantId, env.DB)
      : json({ error: "Not found." }, 404);
  }
  const teamInvitationMatch = url.pathname.match(/^\/api\/mobile\/v1\/team\/invitations\/([^/]+)\/cancel$/);
  if (teamInvitationMatch && request.method === "POST") {
    const invitationId = decodeURIComponent(teamInvitationMatch[1] ?? "");
    if (!validId(invitationId)) return json({ error: "A valid invitationId is required." }, 400);
    return cancelTeamInvitation(request, url, invitationId, env.DB);
  }
  const teamMemberMatch = url.pathname.match(/^\/api\/mobile\/v1\/team\/members\/([^/]+)\/(role|remove)$/);
  if (teamMemberMatch && request.method === "POST") {
    const memberId = decodeURIComponent(teamMemberMatch[1] ?? "");
    if (!validId(memberId)) return json({ error: "A valid memberId is required." }, 400);
    return teamMemberMatch[2] === "role"
      ? updateTeamMemberRole(request, url, memberId, env.DB)
      : removeTeamMember(request, url, memberId, env.DB);
  }
  const teamCrewMatch = url.pathname.match(/^\/api\/mobile\/v1\/team\/crew\/([^/]+)\/(update|remove)$/);
  if (teamCrewMatch && request.method === "POST") {
    const memberId = decodeURIComponent(teamCrewMatch[1] ?? "");
    if (!validId(memberId)) return json({ error: "A valid crew member id is required." }, 400);
    return teamCrewMatch[2] === "update"
      ? updateTeamCrewMember(request, url, memberId, env.DB)
      : removeTeamCrewMember(request, url, memberId, env.DB);
  }
  const checklistEntryMatch = url.pathname.match(/^\/api\/mobile\/v1\/checklist\/entries\/([^/]+)\/(toggle|remove)$/);
  if (checklistEntryMatch && request.method === "POST") {
    const entryId = decodePathId(checklistEntryMatch[1]);
    if (!entryId) return json({ error: "Not found." }, 404);
    return checklistEntryMatch[2] === "toggle"
      ? toggleChecklistEntryMobile(request, url, entryId, env.DB)
      : removeChecklistEntryMobile(request, url, entryId, env.DB);
  }
  const checklistTemplateMatch = url.pathname.match(/^\/api\/mobile\/v1\/checklist\/templates\/([^/]+)\/category$/);
  if (checklistTemplateMatch && request.method === "POST") {
    const templateId = decodePathId(checklistTemplateMatch[1]);
    return templateId
      ? updateChecklistCategoryMobile(request, url, templateId, env.DB)
      : json({ error: "Not found." }, 404);
  }
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
