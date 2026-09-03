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
import { formatTimeInput, getTodayDateString, serviceTimeToIso } from "./utils";
import { resolveRemoteDeviceControl, type ResolvedRemoteDeviceControl } from "./mobile-device-controls";
import { buildHomeAssistantActions, parseHomeAssistantEntities } from "./device-modules/homeassistant/homeassistant-module";
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
  BridgeRelayStatus,
} from "../durable-objects/BridgeRelay";
import { rundownRelayKey } from "./rundown-relay-key";
import { parseRelayRundownItems, type RelayRundownItem } from "./rundown-relay-payload";
import { fetchOntimeRuntimeState } from "./ontime-runtime";
import { deleteStreamDestinationForOrg, setStreamDestinationEnabledForOrg } from "./stream-destinations";
import { getLiveInputStatusForOrg } from "./stream";
import { objectionableContentReason } from "./user-content-safety";
import { mobileRundownStatus } from "./rundown-status";

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
  RUNDOWN_RELAY?: DurableObjectNamespace;
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
  scheduledStart: string | null;
  expectedEnd: string | null;
  actualStart: string | null;
  actualEnd: string | null;
}

interface MobileScheduleRow extends MobileRundownRow {
  updatedAt: string;
  completedItems: number;
  crewTotal: number;
  crewConfirmed: number;
  crewOpen: number;
  incidentCount: number;
}

interface MobileShowInventoryRow {
  id: string;
  name: string;
  description: string;
  location: string;
  defaultStartTime: string | null;
  rundownJson: string;
  sourceTemplateId: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface MobileSavedRundownSource {
  id: string;
  name: string;
  itemCount: number;
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
  crewMemberId: string | null;
  invitedAt: string | null;
  respondedAt: string | null;
  updatedAt: string;
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
      `SELECT r.id, r.serviceDate, r.name, r.scheduledStartTime, r.location,
              CASE
                WHEN json_extract(timer.value, '$.playback') = 'play' THEN 'running'
                WHEN json_extract(timer.value, '$.playback') = 'pause' THEN 'paused'
                WHEN r.status IN ('running', 'paused') THEN 'stopped'
                ELSE r.status
              END AS status,
              CAST(COUNT(i.id) AS INTEGER) AS itemCount
       FROM rundown r
       LEFT JOIN rundown_item i ON i.showId = r.id AND i.orgId = r.orgId
       LEFT JOIN app_setting timer ON timer.orgId = r.orgId AND timer.key = 'rundown-timer:' || r.id
       LEFT JOIN app_setting active ON active.orgId = r.orgId AND active.key = 'active-show-id'
       WHERE r.orgId = ? AND (
         r.serviceDate >= ? OR r.status IN ('running', 'paused') OR active.value = r.id
         OR json_extract(timer.value, '$.playback') IN ('play', 'pause')
       )
       GROUP BY r.id
       ORDER BY CASE
                  WHEN json_extract(timer.value, '$.playback') IN ('play', 'pause')
                    OR r.status IN ('running', 'paused') OR active.value = r.id THEN 0
                  ELSE 1
                END,
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

interface MobileProPresenterSettings {
  host: string;
  stagePort: number;
  apiPort: number;
  password: string;
  cuesEnabled: boolean;
  stageDisplayEnabled: boolean;
}

async function readMobileProPresenterSettings(
  db: MobileApiDatabase,
  orgId: string,
): Promise<MobileProPresenterSettings> {
  const result = await db.prepare(
    `SELECT key, value FROM app_setting
     WHERE orgId = ? AND key IN (
       'propresenter-host', 'propresenter-port', 'propresenter-api-port',
       'propresenter-password', 'propresenter-send-cues', 'propresenter-stage-display'
     )`,
  ).bind(orgId).all<{ key: string; value: string }>();
  const values = Object.fromEntries((result.results ?? []).map((setting) => [setting.key, setting.value]));
  const port = (value: string | undefined, fallback: number) => {
    const parsed = Number.parseInt(value ?? "", 10);
    return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65_535 ? parsed : fallback;
  };
  return {
    host: values["propresenter-host"]?.trim() ?? "",
    stagePort: port(values["propresenter-port"], 50_001),
    apiPort: port(values["propresenter-api-port"], 1_025),
    password: values["propresenter-password"] ?? "",
    cuesEnabled: values["propresenter-send-cues"] === "true",
    stageDisplayEnabled: values["propresenter-stage-display"] === "true",
  };
}

async function rundown(request: Request, url: URL, showId: string, env: MobileApiEnvironment): Promise<Response> {
  const db = env.DB;
  if (!validId(showId)) return json({ error: "A valid showId is required." }, 400);
  const access = await authorize(request, url, db, ["rundown:view", "rundown:edit", "rundown:control"]);
  if (access instanceof Response) return access;
  const { orgId, identity } = access;
  const show = await db.prepare(
    `SELECT id, serviceDate, name, scheduledStartTime, location, status, updatedAt
     FROM rundown WHERE id = ? AND orgId = ? LIMIT 1`,
  ).bind(showId, orgId).first<Omit<MobileRundownRow, "itemCount"> & { updatedAt: string }>();
  if (!show) return json({ error: "Show not found." }, 404);

  const [itemsResult, showTimerSetting, dateTimerSetting, legacyOwner, timezone, proPresenter, bridge] = await Promise.all([
    db.prepare(
      `SELECT itemId, title, type, duration, notes, assignee, cue, status,
              sortOrder, hardStop, lowerThirdId, scheduledStart, expectedEnd, actualStart, actualEnd
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
    db.prepare("SELECT value FROM app_setting WHERE orgId = ? AND key = 'org-timezone' LIMIT 1")
      .bind(orgId).first<{ value: string }>(),
    readMobileProPresenterSettings(db, orgId),
    mobileBridgeStatus(env, orgId),
  ]);
  const proPresenterTarget = bridge.connectedTargets.find((target) => target.startsWith("propresenter:"));
  return json({
    show,
    timeZone: timezone?.value || "Africa/Accra",
    canEdit: identity.permissions.includes("rundown:edit"),
    canControl: identity.permissions.includes("rundown:control"),
    proPresenter: {
      configured: Boolean(proPresenter.host),
      cuesEnabled: proPresenter.cuesEnabled,
      stageDisplayEnabled: proPresenter.stageDisplayEnabled,
      bridgeOnline: bridge.bridgeOnline,
      connected: Boolean(proPresenterTarget),
    },
    items: (itemsResult.results ?? []).map(serializeMobileRundownItem),
    timer: parseTimer(showTimerSetting?.value ?? (legacyOwner?.id === showId ? dateTimerSetting?.value : null)),
  });
}

async function controlMobileProPresenter(
  request: Request,
  url: URL,
  showId: string,
  env: MobileApiEnvironment,
): Promise<Response> {
  const access = await authorize(request, url, env.DB, ["rundown:control"]);
  if (access instanceof Response) return access;
  const show = await env.DB.prepare("SELECT id FROM rundown WHERE id = ? AND orgId = ? LIMIT 1")
    .bind(showId, access.orgId).first<{ id: string }>();
  if (!show) return json({ error: "Show not found." }, 404);
  const body = await readJson(request);
  const command = body?.command;
  if (command !== "next" && command !== "previous" && command !== "clear") {
    return json({ error: "Choose a valid ProPresenter command." }, 400);
  }
  const settings = await readMobileProPresenterSettings(env.DB, access.orgId);
  if (!settings.host) return json({ error: "Configure ProPresenter in ShowPilot settings first." }, 409);
  if (!settings.cuesEnabled) return json({ error: "Enable ProPresenter cue control in ShowPilot settings first." }, 409);
  const bridge = await mobileBridgeStatus(env, access.orgId);
  if (!bridge.bridgeOnline) return json({ error: "Venue Bridge is offline." }, 503);

  const target = bridge.connectedTargets.find((candidate) => candidate.startsWith("propresenter:"))
    ?? `propresenter:${settings.host}:${settings.stagePort}`;
  if (!bridge.connectedTargets.includes(target)) {
    const connection = await bridgeDispatch(env, access.orgId, {
      type: "connect-device",
      protocol: "propresenter",
      target,
      settings: {
        host: settings.host,
        port: settings.stagePort,
        apiPort: settings.apiPort,
        password: settings.password,
      },
    });
    if (!connection.success) return json(connection, 502);
  }
  const result = await bridgeDispatch(env, access.orgId, {
    type: "command",
    id: `mobile-pp-${crypto.randomUUID()}`,
    protocol: "propresenter",
    target,
    command,
  });
  return json(result, result.success ? 200 : 502);
}

async function updateMobileProPresenterStageDisplay(
  request: Request,
  url: URL,
  showId: string,
  env: MobileApiEnvironment,
): Promise<Response> {
  const access = await authorize(request, url, env.DB, ["rundown:edit", "rundown:control"]);
  if (access instanceof Response) return access;
  const show = await env.DB.prepare("SELECT id FROM rundown WHERE id = ? AND orgId = ? LIMIT 1")
    .bind(showId, access.orgId).first<{ id: string }>();
  if (!show) return json({ error: "Show not found." }, 404);

  const body = await readJson(request);
  if (typeof body?.enabled !== "boolean") {
    return json({ error: "enabled must be true or false." }, 400);
  }

  await env.DB.prepare(
    `INSERT INTO app_setting (id, orgId, key, value, createdAt, updatedAt)
     VALUES (?, ?, 'propresenter-stage-display', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT(orgId, key) DO UPDATE SET value = excluded.value, updatedAt = CURRENT_TIMESTAMP`,
  ).bind(crypto.randomUUID(), access.orgId, body.enabled ? "true" : "false").run();
  return json({ ok: true, enabled: body.enabled });
}

interface MobileRundownTemplate {
  id: string;
  name: string;
  serviceName: string;
  scheduledStartTime: string;
  items: RelayRundownItem[];
  createdAt: string;
  updatedAt: string;
}

function parseMobileRundownTemplate(value: string): MobileRundownTemplate | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) return null;
    const items = parseRelayRundownItems(parsed.items);
    if (
      !validId(parsed.id)
      || typeof parsed.name !== "string" || parsed.name.length > 200
      || typeof parsed.serviceName !== "string" || parsed.serviceName.length > 120
      || typeof parsed.scheduledStartTime !== "string"
      || !/^$|^([01]\d|2[0-3]):[0-5]\d$/.test(parsed.scheduledStartTime)
      || typeof parsed.createdAt !== "string"
      || typeof parsed.updatedAt !== "string"
      || !items
    ) return null;
    return {
      id: parsed.id,
      name: parsed.name,
      serviceName: parsed.serviceName,
      scheduledStartTime: parsed.scheduledStartTime,
      items,
      createdAt: parsed.createdAt,
      updatedAt: parsed.updatedAt,
    };
  } catch {
    return null;
  }
}

async function readMobileRundownTemplates(db: MobileApiDatabase, orgId: string) {
  const result = await db.prepare(
    "SELECT value FROM app_setting WHERE orgId = ? AND key LIKE 'rundown-saved:%'",
  ).bind(orgId).all<{ value: string }>();
  return (result.results ?? [])
    .map((row) => parseMobileRundownTemplate(row.value))
    .filter((template): template is MobileRundownTemplate => template !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function mobileRundownTemplateIndex(templates: MobileRundownTemplate[]) {
  return templates.map((template) => ({
    id: template.id,
    name: template.name,
    itemCount: template.items.length,
    serviceName: template.serviceName,
    scheduledStartTime: template.scheduledStartTime,
    createdAt: template.createdAt,
    updatedAt: template.updatedAt,
  }));
}

async function mobileRundownTemplates(
  request: Request,
  url: URL,
  showId: string,
  db: MobileApiDatabase,
): Promise<Response> {
  const access = await authorize(request, url, db, ["rundown:edit", "rundown:control"]);
  if (access instanceof Response) return access;
  const show = await db.prepare("SELECT id FROM rundown WHERE id = ? AND orgId = ? LIMIT 1")
    .bind(showId, access.orgId).first<{ id: string }>();
  if (!show) return json({ error: "Show not found." }, 404);
  const [templates, previousResult] = await Promise.all([
    readMobileRundownTemplates(db, access.orgId),
    db.prepare(
      `SELECT r.id, r.serviceDate, r.name, r.scheduledStartTime, r.location,
              CAST(COUNT(i.id) AS INTEGER) AS itemCount
         FROM rundown r
         LEFT JOIN rundown_item i ON i.orgId = r.orgId AND i.showId = r.id
        WHERE r.orgId = ? AND r.id <> ?
        GROUP BY r.id
        ORDER BY r.serviceDate DESC, r.scheduledStartTime DESC, r.createdAt DESC
        LIMIT 50`,
    ).bind(access.orgId, showId).all<{
      id: string;
      serviceDate: string;
      name: string;
      scheduledStartTime: string | null;
      location: string;
      itemCount: number;
    }>(),
  ]);
  return json({
    templates: templates.map((template) => ({
      id: template.id,
      name: template.name,
      serviceName: template.serviceName,
      scheduledStartTime: template.scheduledStartTime,
      itemCount: template.items.length,
      createdAt: template.createdAt,
      updatedAt: template.updatedAt,
    })),
    previousShows: previousResult.results ?? [],
  });
}

async function saveMobileRundownTemplate(
  request: Request,
  url: URL,
  showId: string,
  db: MobileApiDatabase,
): Promise<Response> {
  const body = await readJson(request);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const requestId = typeof body?.requestId === "string" ? body.requestId.trim() : "";
  if (!validId(requestId) || requestId.length > 100 || !name || name.length > 200) {
    return json({ error: "A template name and valid requestId are required." }, 400);
  }
  const access = await authorize(request, url, db, ["rundown:edit", "rundown:control"]);
  if (access instanceof Response) return access;
  const show = await db.prepare(
    `SELECT id, serviceDate, name, scheduledStartTime
       FROM rundown WHERE id = ? AND orgId = ? LIMIT 1`,
  ).bind(showId, access.orgId).first<{
    id: string;
    serviceDate: string;
    name: string;
    scheduledStartTime: string | null;
  }>();
  if (!show) return json({ error: "Show not found." }, 404);
  const existing = await db.prepare("SELECT value FROM app_setting WHERE orgId = ? AND key = ? LIMIT 1")
    .bind(access.orgId, `rundown-saved:${requestId}`).first<{ value: string }>();
  if (existing) return json({ ok: true, id: requestId, created: false });

  const [itemsResult, timezone, existingTemplates] = await Promise.all([
    db.prepare(
      `SELECT itemId, title, type, duration, notes, assignee, cue, status,
              sortOrder, hardStop, lowerThirdId, scheduledStart, expectedEnd,
              actualStart, actualEnd
         FROM rundown_item WHERE orgId = ? AND showId = ?
        ORDER BY sortOrder ASC, createdAt ASC`,
    ).bind(access.orgId, showId).all<MobileRundownItemRow>(),
    db.prepare("SELECT value FROM app_setting WHERE orgId = ? AND key = 'org-timezone' LIMIT 1")
      .bind(access.orgId).first<{ value: string }>(),
    readMobileRundownTemplates(db, access.orgId),
  ]);
  const items = parseRelayRundownItems((itemsResult.results ?? []).map((item, index) => ({
    id: item.itemId,
    title: item.title,
    type: item.type,
    duration: item.duration,
    notes: item.notes,
    assignee: item.assignee,
    cue: item.cue,
    status: "upcoming",
    sortOrder: index,
    hardStop: Boolean(item.hardStop),
    lowerThirdId: item.lowerThirdId ?? undefined,
    scheduledStart: item.scheduledStart,
    expectedEnd: item.expectedEnd,
    actualStart: null,
    actualEnd: null,
  })));
  if (!items) return json({ error: "The current rundown cannot be saved as a template." }, 400);

  const now = new Date().toISOString();
  const template: MobileRundownTemplate = {
    id: requestId,
    name,
    serviceName: show.name,
    scheduledStartTime: formatTimeInput(show.scheduledStartTime, timezone?.value || "Africa/Accra"),
    items,
    createdAt: now,
    updatedAt: now,
  };
  const templates = [template, ...existingTemplates.filter((candidate) => candidate.id !== requestId)];
  await db.batch([
    db.prepare(
      `INSERT INTO app_setting (id, orgId, key, value)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(orgId, key) DO UPDATE SET value = excluded.value`,
    ).bind(crypto.randomUUID(), access.orgId, `rundown-saved:${requestId}`, JSON.stringify(template)),
    db.prepare(
      `INSERT INTO app_setting (id, orgId, key, value)
       VALUES (?, ?, 'rundown-saved-index', ?)
       ON CONFLICT(orgId, key) DO UPDATE SET value = excluded.value`,
    ).bind(crypto.randomUUID(), access.orgId, JSON.stringify(mobileRundownTemplateIndex(templates))),
  ]);
  return json({ ok: true, id: requestId, created: true }, 201);
}

async function postMobileRundownRelayCommand(input: {
  env: MobileApiEnvironment;
  orgId: string;
  showId: string;
  serviceDate: string;
  timeZone: string;
  requestId: string;
  expectedRevision: number;
  action: string;
  payload: Record<string, unknown>;
}) {
  if (!input.env.RUNDOWN_RELAY) return null;
  const relayId = input.env.RUNDOWN_RELAY.idFromName(
    rundownRelayKey(
      input.orgId,
      input.serviceDate,
      getTodayDateString(input.timeZone),
      input.showId,
    ),
  );
  const relay = input.env.RUNDOWN_RELAY.get(relayId);
  const relayUrl = new URL("https://rundown.local/command");
  relayUrl.search = new URLSearchParams({
    orgId: input.orgId,
    serviceDate: input.serviceDate,
    showId: input.showId,
    access: "edit",
  }).toString();
  return relay.fetch(new Request(relayUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: input.action,
      id: input.requestId,
      expectedRevision: input.expectedRevision,
      payload: input.payload,
    }),
  }));
}

async function loadMobileRundownTemplate(
  request: Request,
  url: URL,
  showId: string,
  templateId: string,
  env: MobileApiEnvironment,
): Promise<Response> {
  const body = await readJson(request);
  const requestId = typeof body?.requestId === "string" ? body.requestId.trim() : "";
  const expectedRevision = body?.expectedRevision;
  if (
    !validId(requestId) || requestId.length > 100
    || typeof expectedRevision !== "number"
    || !Number.isSafeInteger(expectedRevision)
    || expectedRevision < 0
  ) return json({ error: "A valid requestId and live revision are required." }, 400);
  const access = await authorize(request, url, env.DB, ["rundown:edit", "rundown:control"]);
  if (access instanceof Response) return access;
  const show = await env.DB.prepare(
    `SELECT id, serviceDate FROM rundown WHERE id = ? AND orgId = ? LIMIT 1`,
  ).bind(showId, access.orgId).first<{ id: string; serviceDate: string }>();
  if (!show) return json({ error: "Show not found." }, 404);
  const setting = await env.DB.prepare("SELECT value FROM app_setting WHERE orgId = ? AND key = ? LIMIT 1")
    .bind(access.orgId, `rundown-saved:${templateId}`).first<{ value: string }>();
  const template = setting ? parseMobileRundownTemplate(setting.value) : null;
  if (!template || template.id !== templateId) return json({ error: "Template not found." }, 404);
  const timezone = await env.DB.prepare("SELECT value FROM app_setting WHERE orgId = ? AND key = 'org-timezone' LIMIT 1")
    .bind(access.orgId).first<{ value: string }>();
  const freshItems = parseRelayRundownItems(template.items.map((item, index) => ({
    ...item,
    id: `${requestId}-item-${index}`,
    status: "upcoming",
    sortOrder: index,
    actualStart: null,
    actualEnd: null,
  })));
  if (!freshItems) return json({ error: "Template items are invalid." }, 400);
  const relayResponse = await postMobileRundownRelayCommand({
    env,
    orgId: access.orgId,
    serviceDate: show.serviceDate,
    showId: show.id,
    timeZone: timezone?.value || "Africa/Accra",
    requestId,
    expectedRevision,
    action: "seed",
    payload: {
      items: freshItems,
      timer: {
        playback: "stop",
        currentItemId: null,
        elapsed: 0,
        startedAt: null,
        pausedAt: null,
        mode: "count-down",
      },
      force: true,
      serviceName: template.serviceName,
      scheduledStartTime: serviceTimeToIso(
        show.serviceDate,
        template.scheduledStartTime,
        timezone?.value || "Africa/Accra",
      ),
    },
  });
  if (!relayResponse) return json({ error: "Live rundown editing is temporarily unavailable." }, 503);
  const relayBody: unknown = await relayResponse.json();
  if (relayResponse.status === 409) {
    return json({ error: "Another operator changed the rundown first.", conflict: relayBody }, 409);
  }
  if (!relayResponse.ok) return json({ error: "The template was not accepted by live sync." }, 502);
  return json({
    ok: true,
    revision: isRecord(relayBody) && typeof relayBody.revision === "number"
      ? relayBody.revision
      : expectedRevision,
    serviceName: template.serviceName,
    scheduledStartTime: template.scheduledStartTime,
    itemCount: freshItems.length,
  });
}

async function loadMobilePreviousRundown(
  request: Request,
  url: URL,
  showId: string,
  sourceShowId: string,
  env: MobileApiEnvironment,
): Promise<Response> {
  const body = await readJson(request);
  const requestId = typeof body?.requestId === "string" ? body.requestId.trim() : "";
  const expectedRevision = body?.expectedRevision;
  if (
    showId === sourceShowId
    || !validId(requestId) || requestId.length > 100
    || typeof expectedRevision !== "number"
    || !Number.isSafeInteger(expectedRevision)
    || expectedRevision < 0
  ) return json({ error: "Choose a different previous show and current live revision." }, 400);
  const access = await authorize(request, url, env.DB, ["rundown:edit", "rundown:control"]);
  if (access instanceof Response) return access;
  const [target, source, timezone] = await Promise.all([
    env.DB.prepare("SELECT id, serviceDate FROM rundown WHERE id = ? AND orgId = ? LIMIT 1")
      .bind(showId, access.orgId).first<{ id: string; serviceDate: string }>(),
    env.DB.prepare(
      `SELECT id, serviceDate, name, scheduledStartTime, location
         FROM rundown WHERE id = ? AND orgId = ? LIMIT 1`,
    ).bind(sourceShowId, access.orgId).first<{
      id: string;
      serviceDate: string;
      name: string;
      scheduledStartTime: string | null;
      location: string;
    }>(),
    env.DB.prepare("SELECT value FROM app_setting WHERE orgId = ? AND key = 'org-timezone' LIMIT 1")
      .bind(access.orgId).first<{ value: string }>(),
  ]);
  if (!target || !source) return json({ error: "Previous show not found." }, 404);
  const itemsResult = await env.DB.prepare(
    `SELECT itemId, title, type, duration, notes, assignee, cue, status,
            sortOrder, hardStop, lowerThirdId, scheduledStart, expectedEnd,
            actualStart, actualEnd
       FROM rundown_item WHERE orgId = ? AND showId = ?
      ORDER BY sortOrder ASC, createdAt ASC`,
  ).bind(access.orgId, source.id).all<MobileRundownItemRow>();
  const freshItems = parseRelayRundownItems((itemsResult.results ?? []).map((item, index) => ({
    id: `${requestId}-item-${index}`,
    title: item.title,
    type: item.type,
    duration: item.duration,
    notes: item.notes,
    assignee: item.assignee,
    cue: item.cue,
    status: "upcoming",
    sortOrder: index,
    hardStop: Boolean(item.hardStop),
    lowerThirdId: item.lowerThirdId ?? undefined,
    scheduledStart: null,
    expectedEnd: null,
    actualStart: null,
    actualEnd: null,
  })));
  if (!freshItems) return json({ error: "The previous rundown is invalid." }, 400);
  const timeZone = timezone?.value || "Africa/Accra";
  const sourceStartTime = formatTimeInput(source.scheduledStartTime, timeZone);
  const relayResponse = await postMobileRundownRelayCommand({
    env,
    orgId: access.orgId,
    showId: target.id,
    serviceDate: target.serviceDate,
    timeZone,
    requestId,
    expectedRevision,
    action: "seed",
    payload: {
      items: freshItems,
      timer: {
        playback: "stop",
        currentItemId: null,
        elapsed: 0,
        startedAt: null,
        pausedAt: null,
        mode: "count-down",
      },
      force: true,
      serviceName: source.name,
      scheduledStartTime: serviceTimeToIso(target.serviceDate, sourceStartTime, timeZone),
      location: source.location,
    },
  });
  if (!relayResponse) return json({ error: "Live rundown editing is temporarily unavailable." }, 503);
  const relayBody: unknown = await relayResponse.json();
  if (relayResponse.status === 409) {
    return json({ error: "Another operator changed the rundown first.", conflict: relayBody }, 409);
  }
  if (!relayResponse.ok) return json({ error: "The previous rundown was not accepted by live sync." }, 502);
  return json({
    ok: true,
    revision: isRecord(relayBody) && typeof relayBody.revision === "number"
      ? relayBody.revision
      : expectedRevision,
    serviceName: source.name,
    scheduledStartTime: sourceStartTime,
    itemCount: freshItems.length,
  });
}

async function updateMobileRundownMeta(
  request: Request,
  url: URL,
  showId: string,
  env: MobileApiEnvironment,
): Promise<Response> {
  const body = await readJson(request);
  const requestId = typeof body?.requestId === "string" ? body.requestId.trim() : "";
  const expectedRevision = body?.expectedRevision;
  const name = typeof body?.name === "string" ? body.name.trim() : null;
  const location = typeof body?.location === "string" ? body.location.trim() : null;
  const startTime = typeof body?.startTime === "string" ? body.startTime.trim() : null;
  if (
    !validId(requestId) || requestId.length > 100
    || typeof expectedRevision !== "number" || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0
    || name === null || name.length > 120
    || location === null || location.length > 240
    || startTime === null || !/^$|^([01]\d|2[0-3]):[0-5]\d$/.test(startTime)
  ) return json({ error: "Check the show title, start time, and location." }, 400);
  const access = await authorize(request, url, env.DB, ["rundown:edit", "rundown:control"]);
  if (access instanceof Response) return access;
  const show = await env.DB.prepare("SELECT id, serviceDate FROM rundown WHERE id = ? AND orgId = ? LIMIT 1")
    .bind(showId, access.orgId).first<{ id: string; serviceDate: string }>();
  if (!show) return json({ error: "Show not found." }, 404);
  const timezone = await env.DB.prepare("SELECT value FROM app_setting WHERE orgId = ? AND key = 'org-timezone' LIMIT 1")
    .bind(access.orgId).first<{ value: string }>();
  const timeZone = timezone?.value || "Africa/Accra";
  const scheduledStartTime = serviceTimeToIso(show.serviceDate, startTime, timeZone);
  const relayResponse = await postMobileRundownRelayCommand({
    env,
    orgId: access.orgId,
    showId: show.id,
    serviceDate: show.serviceDate,
    timeZone,
    requestId,
    expectedRevision,
    action: "update-meta",
    payload: { serviceName: name, scheduledStartTime, location },
  });
  if (!relayResponse) return json({ error: "Live rundown editing is temporarily unavailable." }, 503);
  const relayBody: unknown = await relayResponse.json();
  if (relayResponse.status === 409) {
    return json({ error: "Another operator changed the show details first.", conflict: relayBody }, 409);
  }
  if (!relayResponse.ok) return json({ error: "The show details were not accepted by live sync." }, 502);
  return json({
    ok: true,
    revision: isRecord(relayBody) && typeof relayBody.revision === "number"
      ? relayBody.revision
      : expectedRevision,
  });
}

async function deleteMobileRundownTemplate(
  request: Request,
  url: URL,
  showId: string,
  templateId: string,
  db: MobileApiDatabase,
): Promise<Response> {
  const access = await authorize(request, url, db, ["rundown:edit", "rundown:control"]);
  if (access instanceof Response) return access;
  const show = await db.prepare("SELECT id FROM rundown WHERE id = ? AND orgId = ? LIMIT 1")
    .bind(showId, access.orgId).first<{ id: string }>();
  if (!show) return json({ error: "Show not found." }, 404);
  const templates = (await readMobileRundownTemplates(db, access.orgId))
    .filter((template) => template.id !== templateId);
  await db.batch([
    db.prepare("DELETE FROM app_setting WHERE orgId = ? AND key = ?")
      .bind(access.orgId, `rundown-saved:${templateId}`),
    db.prepare(
      `INSERT INTO app_setting (id, orgId, key, value)
       VALUES (?, ?, 'rundown-saved-index', ?)
       ON CONFLICT(orgId, key) DO UPDATE SET value = excluded.value`,
    ).bind(crypto.randomUUID(), access.orgId, JSON.stringify(mobileRundownTemplateIndex(templates))),
  ]);
  return json({ ok: true });
}

async function createRundown(request: Request, db: MobileApiDatabase): Promise<Response> {
  const body = await readJson(request);
  if (!body || !validId(body.orgId) || !validDate(body.serviceDate) || (body.requestId !== undefined && !validId(body.requestId))) {
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
  const inventoryId = body.inventoryId === undefined || body.inventoryId === ""
    ? undefined
    : typeof body.inventoryId === "string"
      ? body.inventoryId.trim()
      : null;
  const copyFrom = body.copyFrom === undefined || body.copyFrom === ""
    ? undefined
    : typeof body.copyFrom === "string"
      ? body.copyFrom.trim()
      : null;
  const copyFromShowId = body.copyFromShowId === undefined || body.copyFromShowId === ""
    ? undefined
    : typeof body.copyFromShowId === "string"
      ? body.copyFromShowId.trim()
      : null;
  if (
    name === null
    || name.length > 120
    || location === null
    || location.length > 240
    || startTime === null
    || (startTime !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime))
    || inventoryId === null
    || (inventoryId !== undefined && !validId(inventoryId))
    || copyFrom === null
    || (copyFrom !== undefined && !validDate(copyFrom))
    || copyFromShowId === null
    || (copyFromShowId !== undefined && !validId(copyFromShowId))
    || Boolean(copyFrom) !== Boolean(copyFromShowId)
    || Boolean(inventoryId) && Boolean(copyFrom)
  ) {
    return json({ error: "Check the show details and choose one valid rundown source." }, 400);
  }

  const url = new URL(request.url);
  url.searchParams.set("orgId", body.orgId);
  const access = await authorize(request, url, db, ["schedule:manage"]);
  if (access instanceof Response) return access;

  try {
    const result = await createServiceForOrg({
      orgId: access.orgId,
      requestId: typeof body.requestId === "string" ? body.requestId : undefined,
      serviceDate: body.serviceDate,
      name,
      startTime,
      location,
      ...(inventoryId ? { inventoryId } : {}),
      ...(copyFrom && copyFromShowId ? { copyFrom, copyFromShowId } : {}),
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

function parseStoredRundownItems(value: string | null | undefined): Record<string, unknown>[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    const items = Array.isArray(parsed)
      ? parsed
      : isRecord(parsed) && Array.isArray(parsed.items)
        ? parsed.items
        : [];
    return items.filter(isRecord);
  } catch {
    return [];
  }
}

function parseMobileSavedRundownSources(value: string | null | undefined): MobileSavedRundownSource[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.name !== "string") return [];
      return [{
        id: entry.id,
        name: entry.name,
        itemCount: typeof entry.itemCount === "number" && Number.isFinite(entry.itemCount)
          ? Math.max(0, Math.trunc(entry.itemCount))
          : 0,
      }];
    });
  } catch {
    return [];
  }
}

function isMissingShowInventoryTable(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /show_inventory_item|no such table|does not exist/i.test(message);
}

function summarizeMobileShowInventory(rows: MobileShowInventoryRow[]) {
  return rows.map(({ rundownJson, ...row }) => ({
    ...row,
    itemCount: parseStoredRundownItems(rundownJson).length,
  }));
}

async function loadMobileShowInventory(db: MobileApiDatabase, orgId: string) {
  const templateIndex = await db.prepare(
    "SELECT value FROM app_setting WHERE orgId = ? AND key = 'rundown-saved-index' LIMIT 1",
  ).bind(orgId).first<{ value: string }>();
  try {
    const result = await db.prepare(
      `SELECT id, name, description, location, defaultStartTime, rundownJson,
              sourceTemplateId, archivedAt, createdAt, updatedAt
       FROM show_inventory_item WHERE orgId = ?
       ORDER BY name ASC, createdAt DESC`,
    ).bind(orgId).all<MobileShowInventoryRow>();
    const items = summarizeMobileShowInventory(result.results ?? []);
    return {
      inventory: items.filter((item) => !item.archivedAt),
      archivedInventory: items.filter((item) => Boolean(item.archivedAt)),
      savedTemplates: parseMobileSavedRundownSources(templateIndex?.value),
    };
  } catch (error) {
    if (!isMissingShowInventoryTable(error)) throw error;
    return {
      inventory: [],
      archivedInventory: [],
      savedTemplates: parseMobileSavedRundownSources(templateIndex?.value),
    };
  }
}

function parseMobileInventoryWrite(body: Record<string, unknown> | null) {
  const requestId = typeof body?.requestId === "string" ? body.requestId.trim() : "";
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const description = typeof body?.description === "string" ? body.description.trim() : "";
  const location = typeof body?.location === "string" ? body.location.trim() : "";
  const defaultStartTime = typeof body?.defaultStartTime === "string" ? body.defaultStartTime.trim() : "";
  const sourceTemplateId = body?.sourceTemplateId === undefined || body.sourceTemplateId === null || body.sourceTemplateId === ""
    ? null
    : typeof body.sourceTemplateId === "string"
      ? body.sourceTemplateId.trim()
      : undefined;
  if (
    !validId(requestId)
    || name.length < 1
    || name.length > 120
    || description.length > 500
    || location.length > 240
    || (defaultStartTime !== "" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(defaultStartTime))
    || sourceTemplateId === undefined
    || (sourceTemplateId !== null && !validId(sourceTemplateId))
  ) return null;
  return { requestId, name, description, location, defaultStartTime, sourceTemplateId };
}

async function createMobileShowInventory(request: Request, url: URL, db: MobileApiDatabase): Promise<Response> {
  const access = await authorize(request, url, db, ["schedule:manage"]);
  if (access instanceof Response) return access;
  const input = parseMobileInventoryWrite(await readJson(request));
  if (!input) return json({ error: "Check the reusable show details." }, 400);
  const existing = await db.prepare(
    `SELECT id, name, description, location, defaultStartTime, sourceTemplateId
     FROM show_inventory_item WHERE id = ? LIMIT 1`,
  ).bind(input.requestId).first<Pick<MobileShowInventoryRow, "id" | "name" | "description" | "location" | "defaultStartTime" | "sourceTemplateId">>();
  if (existing) {
    const sameRequest = existing.name === input.name
      && existing.description === input.description
      && existing.location === input.location
      && existing.defaultStartTime === (input.defaultStartTime || null)
      && existing.sourceTemplateId === input.sourceTemplateId;
    const owned = await db.prepare(
      "SELECT id FROM show_inventory_item WHERE id = ? AND orgId = ? LIMIT 1",
    ).bind(input.requestId, access.orgId).first<{ id: string }>();
    return owned && sameRequest
      ? json({ ok: true, id: existing.id, created: false })
      : json({ error: "That inventory request was already used. Refresh and try again." }, 409);
  }
  let rundownJson = "[]";
  if (input.sourceTemplateId) {
    const template = await db.prepare(
      "SELECT value FROM app_setting WHERE orgId = ? AND key = ? LIMIT 1",
    ).bind(access.orgId, `rundown-saved:${input.sourceTemplateId}`).first<{ value: string }>();
    if (!template) return json({ error: "Saved rundown template not found." }, 404);
    rundownJson = JSON.stringify(parseStoredRundownItems(template.value).map((item, index) => ({
      ...item,
      id: `${input.requestId}-item-${index}`,
      status: "upcoming",
      scheduledStart: null,
      expectedEnd: null,
      actualStart: null,
      actualEnd: null,
    })));
  }
  try {
    await db.prepare(
      `INSERT INTO show_inventory_item
        (id, orgId, name, description, location, defaultStartTime, rundownJson,
         sourceTemplateId, archivedAt, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    ).bind(
      input.requestId,
      access.orgId,
      input.name,
      input.description,
      input.location,
      input.defaultStartTime || null,
      rundownJson,
      input.sourceTemplateId,
    ).run();
  } catch (error) {
    if (isMissingShowInventoryTable(error)) {
      return json({ error: "Show inventory is not available until its database migration is applied." }, 503);
    }
    throw error;
  }
  return json({ ok: true, id: input.requestId, created: true }, 201);
}

async function setMobileShowInventoryArchived(
  request: Request,
  url: URL,
  inventoryId: string,
  archived: boolean,
  db: MobileApiDatabase,
): Promise<Response> {
  const access = await authorize(request, url, db, ["schedule:manage"]);
  if (access instanceof Response) return access;
  const body = await readJson(request);
  const expectedUpdatedAt = typeof body?.expectedUpdatedAt === "string" ? body.expectedUpdatedAt : "";
  if (!expectedUpdatedAt || expectedUpdatedAt.length > 64) {
    return json({ error: "Refresh the inventory and try again." }, 400);
  }
  const result = await db.prepare(
    `UPDATE show_inventory_item
     SET archivedAt = ${archived ? "CURRENT_TIMESTAMP" : "NULL"}, updatedAt = CURRENT_TIMESTAMP
     WHERE id = ? AND orgId = ? AND updatedAt = ? AND archivedAt IS ${archived ? "NULL" : "NOT NULL"}`,
  ).bind(inventoryId, access.orgId, expectedUpdatedAt).run();
  return changedExactlyOneRow(result)
    ? json({ ok: true })
    : json({ error: "This inventory item changed on another device. Refresh and try again." }, 409);
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
      "SELECT key, value FROM app_setting WHERE orgId = ? AND key IN ('org-timezone', 'default-service-window-minutes', 'schedule-provider', 'schedule-provider-url', 'schedule-provider-label', 'terminology-profile')",
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

  const [servicesResult, assignmentsResult, crewResult, inventoryData] = await Promise.all([
    db.prepare(
      `SELECT r.id, r.serviceDate, r.name, r.scheduledStartTime, r.location, r.status, r.updatedAt,
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
              a.callTime, a.notes, a.responseNote, a.crewMemberId, a.invitedAt,
              a.respondedAt, a.updatedAt, c.name AS crewName, c.email AS crewEmail,
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
    canViewFull
      ? db.prepare(
        `SELECT id, name, role, email FROM crew_member
         WHERE orgId = ? ORDER BY name ASC, createdAt ASC`,
      ).bind(access.orgId).all<{ id: string; name: string; role: string; email: string }>()
      : Promise.resolve({ results: [] as { id: string; name: string; role: string; email: string }[] }),
    canViewFull
      ? loadMobileShowInventory(db, access.orgId)
      : Promise.resolve({ inventory: [], archivedInventory: [], savedTemplates: [] }),
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
    crew: crewResult.results ?? [],
    provider: {
      type: ["native", "planning-center", "faithteams", "other"].includes(settingMap["schedule-provider"])
        ? settingMap["schedule-provider"]
        : "native",
      url: settingMap["schedule-provider-url"] ?? "",
      label: settingMap["schedule-provider-label"] ?? "",
    },
    terminologyProfile: settingMap["terminology-profile"] || "general",
    ...inventoryData,
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

interface MobileScheduleShowWriteRow {
  id: string;
  serviceDate: string;
  status: string;
  updatedAt: string;
}

interface MobileScheduleAssignmentWriteRow {
  id: string;
  orgId: string;
  showId: string | null;
  serviceDate: string;
  crewMemberId: string | null;
  role: string;
  department: string;
  status: string;
  callTime: string;
  notes: string;
  responseNote: string;
  invitedAt: string | null;
  respondedAt: string | null;
  updatedAt: string;
}

interface MobileScheduleAssignmentWrite {
  requestId: string;
  showId: string;
  role: string;
  department: string;
  crewMemberId: string | null;
  callTime: string;
  notes: string;
  expectedUpdatedAt: string | null;
}

function parseMobileScheduleAssignmentWrite(body: Record<string, unknown> | null): MobileScheduleAssignmentWrite | null {
  const requestId = typeof body?.requestId === "string" ? body.requestId.trim() : "";
  const showId = typeof body?.showId === "string" ? body.showId.trim() : "";
  const role = typeof body?.role === "string" ? body.role.trim() : "";
  const department = typeof body?.department === "string" ? body.department.trim() : "";
  const crewMemberId = body?.crewMemberId === null || body?.crewMemberId === ""
    ? null
    : typeof body?.crewMemberId === "string" ? body.crewMemberId.trim() : undefined;
  const callTime = typeof body?.callTime === "string" ? body.callTime.trim() : "";
  const notes = typeof body?.notes === "string" ? body.notes.trim() : "";
  const expectedUpdatedAt = body?.expectedUpdatedAt === null || body?.expectedUpdatedAt === undefined
    ? null
    : typeof body.expectedUpdatedAt === "string" ? body.expectedUpdatedAt : undefined;
  if (
    !validId(requestId) || !validId(showId)
    || role.length < 1 || role.length > 120
    || department.length < 1 || department.length > 80
    || crewMemberId === undefined || (crewMemberId !== null && !validId(crewMemberId))
    || (callTime !== "" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(callTime))
    || notes.length > 500
    || expectedUpdatedAt === undefined || (expectedUpdatedAt !== null && (expectedUpdatedAt.length < 1 || expectedUpdatedAt.length > 64))
  ) return null;
  return { requestId, showId, role, department, crewMemberId, callTime, notes, expectedUpdatedAt };
}

async function getMobileScheduleShow(db: MobileApiDatabase, orgId: string, showId: string) {
  return db.prepare(
    "SELECT id, serviceDate, status, updatedAt FROM rundown WHERE id = ? AND orgId = ? LIMIT 1",
  ).bind(showId, orgId).first<MobileScheduleShowWriteRow>();
}

async function validateMobileScheduleCrew(db: MobileApiDatabase, orgId: string, crewMemberId: string | null) {
  if (!crewMemberId) return { ok: true as const, crew: null };
  const crew = await db.prepare(
    "SELECT id, name, email FROM crew_member WHERE id = ? AND orgId = ? LIMIT 1",
  ).bind(crewMemberId, orgId).first<{ id: string; name: string; email: string }>();
  if (!crew) return { ok: false as const, error: "Crew member not found." };
  if (!crew.email.trim()) return { ok: false as const, error: `Add an email address to ${crew.name} before assigning them.` };
  return { ok: true as const, crew };
}

async function clearMobileAssignmentInvitation(orgId: string, assignmentId: string) {
  try {
    const { clearAssignmentInvitation } = await import("./assignment-notifications.server");
    await clearAssignmentInvitation(orgId, assignmentId);
  } catch (error) {
    console.error("[Mobile schedule] Failed to clear stale assignment invitation", error);
  }
}

async function deliverMobileAssignmentInvitation(input: {
  request: Request;
  db: MobileApiDatabase;
  orgId: string;
  assignmentId: string;
  showId: string;
  serviceDate: string;
  role: string;
  crewMemberId: string;
  reminder?: boolean;
}) {
  try {
    const { sendCrewScheduleInvite } = await import("./crew-schedule");
    const delivery = await sendCrewScheduleInvite({
      orgId: input.orgId,
      assignmentId: input.assignmentId,
      crewMemberId: input.crewMemberId,
      serviceDate: input.serviceDate,
      role: input.role,
      origin: new URL(input.request.url).origin,
      reminder: input.reminder,
    });
    if (delivery.delivered) {
      await input.db.prepare(
        "UPDATE service_assignment SET invitedAt = CURRENT_TIMESTAMP, updatedAt = CURRENT_TIMESTAMP WHERE id = ? AND orgId = ? AND showId = ?",
      ).bind(input.assignmentId, input.orgId, input.showId).run();
    }
    return delivery;
  } catch (error) {
    console.error("[Mobile schedule] Assignment delivery failed", error);
    return { delivered: false, reason: "delivery-failed" as const };
  }
}

async function createMobileScheduleAssignment(request: Request, url: URL, db: MobileApiDatabase): Promise<Response> {
  const access = await authorize(request, url, db, ["schedule:manage"]);
  if (access instanceof Response) return access;
  const parsed = parseMobileScheduleAssignmentWrite(await readJson(request));
  if (!parsed || parsed.expectedUpdatedAt !== null) return json({ error: "Check the assignment details and try again." }, 400);
  const [show, crew, existing] = await Promise.all([
    getMobileScheduleShow(db, access.orgId, parsed.showId),
    validateMobileScheduleCrew(db, access.orgId, parsed.crewMemberId),
    db.prepare(
      `SELECT id, orgId, showId, serviceDate, crewMemberId, role, department, status,
              callTime, notes, responseNote, invitedAt, respondedAt, updatedAt
       FROM service_assignment WHERE id = ? LIMIT 1`,
    ).bind(parsed.requestId).first<MobileScheduleAssignmentWriteRow>(),
  ]);
  if (!show) return json({ error: "Show not found." }, 404);
  if (!crew.ok) return json({ error: crew.error }, 400);
  if (existing) {
    const sameRequest = existing.orgId === access.orgId
      && existing.showId === show.id
      && existing.role === parsed.role
      && existing.department === parsed.department
      && existing.crewMemberId === parsed.crewMemberId
      && existing.callTime === parsed.callTime
      && existing.notes === parsed.notes;
    return sameRequest
      ? json({ ok: true, id: existing.id, created: false, delivered: Boolean(existing.invitedAt) })
      : json({ error: "That assignment request was already used. Refresh and try again." }, 409);
  }
  await db.prepare(
    `INSERT INTO service_assignment
      (id, orgId, showId, serviceDate, crewMemberId, role, department, status, callTime, notes, responseNote, invitedAt, respondedAt, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'assigned', ?, ?, '', NULL, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  ).bind(
    parsed.requestId,
    access.orgId,
    show.id,
    show.serviceDate,
    parsed.crewMemberId,
    parsed.role,
    parsed.department,
    parsed.callTime,
    parsed.notes,
  ).run();
  const delivery = parsed.crewMemberId
    ? await deliverMobileAssignmentInvitation({
      request, db, orgId: access.orgId, assignmentId: parsed.requestId, showId: show.id,
      serviceDate: show.serviceDate, role: parsed.role, crewMemberId: parsed.crewMemberId,
    })
    : { delivered: false, reason: null };
  return json({ ok: true, id: parsed.requestId, created: true, delivered: delivery.delivered }, 201);
}

async function copyMobileScheduleTeam(request: Request, url: URL, showId: string, db: MobileApiDatabase): Promise<Response> {
  const access = await authorize(request, url, db, ["schedule:manage"]);
  if (access instanceof Response) return access;
  const body = await readJson(request);
  const requestId = typeof body?.requestId === "string" ? body.requestId.trim() : "";
  const sourceShowId = typeof body?.sourceShowId === "string" ? body.sourceShowId.trim() : "";
  if (!validId(requestId) || requestId.length > 96 || !validId(sourceShowId) || sourceShowId === showId) {
    return json({ error: "Choose a valid previous show to copy." }, 400);
  }
  const [target, source, sourceResult, targetResult] = await Promise.all([
    getMobileScheduleShow(db, access.orgId, showId),
    getMobileScheduleShow(db, access.orgId, sourceShowId),
    db.prepare(
      `SELECT id, crewMemberId, role, department, callTime
       FROM service_assignment WHERE orgId = ? AND showId = ?
       ORDER BY department ASC, role ASC, createdAt ASC, id ASC`,
    ).bind(access.orgId, sourceShowId).all<Pick<MobileScheduleAssignmentWriteRow, "id" | "crewMemberId" | "role" | "department" | "callTime">>(),
    db.prepare(
      `SELECT id, crewMemberId, role, department, callTime, invitedAt
       FROM service_assignment WHERE orgId = ? AND showId = ?
       ORDER BY id ASC`,
    ).bind(access.orgId, showId).all<Pick<MobileScheduleAssignmentWriteRow, "id" | "crewMemberId" | "role" | "department" | "callTime" | "invitedAt">>(),
  ]);
  if (!target || !source) return json({ error: "Show not found." }, 404);
  if (target.status === "running" || target.status === "paused") {
    return json({ error: "A live show team cannot be replaced." }, 409);
  }
  if (source.serviceDate > target.serviceDate) {
    return json({ error: "Choose a show that occurs before this one." }, 400);
  }
  const sourceRows = sourceResult.results ?? [];
  if (sourceRows.length === 0) return json({ error: "That show has no team to copy." }, 409);
  const expectedIds = sourceRows.map((_, index) => `${requestId}-${index}`);
  const targetRows = targetResult.results ?? [];
  const targetById = new Map(targetRows.map((row) => [row.id, row]));
  const isRetry = targetRows.length === expectedIds.length
    && expectedIds.every((id) => targetById.has(id));
  if (targetRows.length > 0 && !isRetry) {
    return json({ error: "This show already has positions. Remove them before copying another team." }, 409);
  }
  if (!isRetry) {
    await db.batch(sourceRows.map((row, index) => db.prepare(
      `INSERT INTO service_assignment
        (id, orgId, showId, serviceDate, crewMemberId, role, department, status,
         callTime, notes, responseNote, invitedAt, respondedAt, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'assigned', ?, '', '', NULL, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    ).bind(
      expectedIds[index],
      access.orgId,
      target.id,
      target.serviceDate,
      row.crewMemberId,
      row.role,
      row.department,
      row.callTime,
    )));
  }
  const assignedRows = sourceRows.filter((row) => Boolean(row.crewMemberId));
  const alreadyDelivered = isRetry
    ? expectedIds.filter((id) => Boolean(targetById.get(id)?.invitedAt)).length
    : 0;
  const deliverable = sourceRows.flatMap((row, index) => {
    const id = expectedIds[index];
    if (!row.crewMemberId || (isRetry && targetById.get(id)?.invitedAt)) return [];
    return [{ ...row, id, crewMemberId: row.crewMemberId }];
  });
  const deliveries = await Promise.all(deliverable.map((assignment) => deliverMobileAssignmentInvitation({
    request,
    db,
    orgId: access.orgId,
    assignmentId: assignment.id,
    showId: target.id,
    serviceDate: target.serviceDate,
    role: assignment.role,
    crewMemberId: assignment.crewMemberId,
  })));
  return json({
    ok: true,
    copied: sourceRows.length,
    created: !isRetry,
    delivered: alreadyDelivered + deliveries.filter((delivery) => delivery.delivered).length,
    total: assignedRows.length,
  }, isRetry ? 200 : 201);
}

async function updateMobileScheduleAssignment(
  request: Request,
  url: URL,
  assignmentId: string,
  db: MobileApiDatabase,
): Promise<Response> {
  const access = await authorize(request, url, db, ["schedule:manage"]);
  if (access instanceof Response) return access;
  const parsed = parseMobileScheduleAssignmentWrite(await readJson(request));
  if (!parsed || parsed.expectedUpdatedAt === null) return json({ error: "Refresh the schedule and check the assignment details." }, 400);
  const [existing, show, crew] = await Promise.all([
    db.prepare(
      `SELECT id, orgId, showId, serviceDate, crewMemberId, role, department, status,
              callTime, notes, responseNote, invitedAt, respondedAt, updatedAt
       FROM service_assignment WHERE id = ? AND orgId = ? LIMIT 1`,
    ).bind(assignmentId, access.orgId).first<MobileScheduleAssignmentWriteRow>(),
    getMobileScheduleShow(db, access.orgId, parsed.showId),
    validateMobileScheduleCrew(db, access.orgId, parsed.crewMemberId),
  ]);
  if (!existing || !show || existing.showId !== show.id) return json({ error: "Assignment not found." }, 404);
  if (!crew.ok) return json({ error: crew.error }, 400);
  if (existing.updatedAt !== parsed.expectedUpdatedAt) {
    return json({ error: "This assignment changed on another device. Refresh and try again." }, 409);
  }
  const personChanged = existing.crewMemberId !== parsed.crewMemberId;
  if (personChanged && existing.status === "declined") {
    const replacement = await createMobileScheduleAssignment(
      new Request(request.url, { method: "POST", headers: request.headers, body: JSON.stringify({ ...parsed, expectedUpdatedAt: null }) }),
      url,
      db,
    );
    return replacement;
  }
  const result = await db.prepare(
    `UPDATE service_assignment
     SET role = ?, department = ?, crewMemberId = ?, callTime = ?, notes = ?,
         status = CASE WHEN ? = 1 THEN 'assigned' ELSE status END,
         responseNote = CASE WHEN ? = 1 THEN '' ELSE responseNote END,
         respondedAt = CASE WHEN ? = 1 THEN NULL ELSE respondedAt END,
         invitedAt = CASE WHEN ? = 1 THEN NULL ELSE invitedAt END,
         updatedAt = CURRENT_TIMESTAMP
     WHERE id = ? AND orgId = ? AND showId = ? AND updatedAt = ?`,
  ).bind(
    parsed.role, parsed.department, parsed.crewMemberId, parsed.callTime, parsed.notes,
    personChanged ? 1 : 0, personChanged ? 1 : 0, personChanged ? 1 : 0, personChanged ? 1 : 0,
    assignmentId, access.orgId, show.id, parsed.expectedUpdatedAt,
  ).run();
  if (!changedExactlyOneRow(result)) return json({ error: "This assignment changed on another device. Refresh and try again." }, 409);
  if (personChanged) await clearMobileAssignmentInvitation(access.orgId, assignmentId);
  const delivery = personChanged && parsed.crewMemberId
    ? await deliverMobileAssignmentInvitation({
      request, db, orgId: access.orgId, assignmentId, showId: show.id,
      serviceDate: show.serviceDate, role: parsed.role, crewMemberId: parsed.crewMemberId,
    })
    : { delivered: false, reason: null };
  return json({ ok: true, id: assignmentId, created: false, delivered: delivery.delivered });
}

async function deleteMobileScheduleAssignment(
  request: Request,
  url: URL,
  assignmentId: string,
  db: MobileApiDatabase,
): Promise<Response> {
  const access = await authorize(request, url, db, ["schedule:manage"]);
  if (access instanceof Response) return access;
  const result = await db.batch([
    db.prepare("DELETE FROM notification WHERE orgId = ? AND source = ?").bind(access.orgId, assignmentId),
    db.prepare("DELETE FROM service_assignment WHERE orgId = ? AND id = ?").bind(access.orgId, assignmentId),
  ]);
  return changedExactlyOneRow(result[1]) ? json({ ok: true }) : json({ error: "Assignment not found." }, 404);
}

async function remindMobileScheduleAssignments(
  request: Request,
  url: URL,
  input: { assignmentId?: string; showId?: string },
  db: MobileApiDatabase,
): Promise<Response> {
  const access = await authorize(request, url, db, ["schedule:manage"]);
  if (access instanceof Response) return access;
  const rows = input.assignmentId
    ? await db.prepare(
      `SELECT id, showId, serviceDate, crewMemberId, role FROM service_assignment
       WHERE id = ? AND orgId = ? AND status = 'assigned' AND crewMemberId IS NOT NULL`,
    ).bind(input.assignmentId, access.orgId).all<{ id: string; showId: string; serviceDate: string; crewMemberId: string; role: string }>()
    : await db.prepare(
      `SELECT id, showId, serviceDate, crewMemberId, role FROM service_assignment
       WHERE showId = ? AND orgId = ? AND status = 'assigned' AND crewMemberId IS NOT NULL`,
    ).bind(input.showId, access.orgId).all<{ id: string; showId: string; serviceDate: string; crewMemberId: string; role: string }>();
  const assignments = rows.results ?? [];
  if (input.assignmentId && assignments.length === 0) return json({ error: "Only pending assignments can be reminded." }, 404);
  const deliveries = await Promise.all(assignments.map((assignment) => deliverMobileAssignmentInvitation({
    request,
    db,
    orgId: access.orgId,
    assignmentId: assignment.id,
    showId: assignment.showId,
    serviceDate: assignment.serviceDate,
    role: assignment.role,
    crewMemberId: assignment.crewMemberId,
    reminder: true,
  })));
  const available = deliveries.filter((delivery) => delivery.reason !== "assignment-expired");
  return json({ ok: true, delivered: available.filter((delivery) => delivery.delivered).length, total: available.length });
}

async function updateMobileScheduleService(
  request: Request,
  url: URL,
  showId: string,
  db: MobileApiDatabase,
): Promise<Response> {
  const access = await authorize(request, url, db, ["schedule:manage"]);
  if (access instanceof Response) return access;
  const body = await readJson(request);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const startTime = typeof body?.startTime === "string" ? body.startTime.trim() : "";
  const location = typeof body?.location === "string" ? body.location.trim() : "";
  const expectedUpdatedAt = typeof body?.expectedUpdatedAt === "string" ? body.expectedUpdatedAt : "";
  if (name.length > 120 || location.length > 240 || (startTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime)) || !expectedUpdatedAt || expectedUpdatedAt.length > 64) {
    return json({ error: "Check the service title, start time, and location." }, 400);
  }
  const [show, timezone] = await Promise.all([
    getMobileScheduleShow(db, access.orgId, showId),
    db.prepare("SELECT value FROM app_setting WHERE orgId = ? AND key = 'org-timezone' LIMIT 1")
      .bind(access.orgId).first<{ value: string }>(),
  ]);
  if (!show) return json({ error: "Show not found." }, 404);
  if (show.updatedAt !== expectedUpdatedAt) return json({ error: "This show changed on another device. Refresh and try again." }, 409);
  const scheduledStartTime = serviceTimeToIso(show.serviceDate, startTime, timezone?.value) || null;
  const result = await db.prepare(
    `UPDATE rundown SET name = ?, scheduledStartTime = ?, location = ?, updatedAt = CURRENT_TIMESTAMP
     WHERE id = ? AND orgId = ? AND updatedAt = ?`,
  ).bind(name, scheduledStartTime, location, showId, access.orgId, expectedUpdatedAt).run();
  return changedExactlyOneRow(result)
    ? json({ ok: true })
    : json({ error: "This show changed on another device. Refresh and try again." }, 409);
}

async function deleteMobileScheduleService(
  request: Request,
  url: URL,
  showId: string,
  db: MobileApiDatabase,
): Promise<Response> {
  const access = await authorize(request, url, db, ["schedule:manage"]);
  if (access instanceof Response) return access;
  try {
    const { deleteServiceForOrg } = await import("./service-deletion.server");
    return json(await deleteServiceForOrg({ orgId: access.orgId, showId }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to remove show.";
    return json({ error: message }, message === "Show not found" ? 404 : 409);
  }
}

async function saveMobileScheduleProvider(request: Request, url: URL, db: MobileApiDatabase): Promise<Response> {
  const access = await authorize(request, url, db, ["schedule:manage"]);
  if (access instanceof Response) return access;
  const body = await readJson(request);
  const provider = typeof body?.provider === "string" ? body.provider : "";
  const workspaceUrl = typeof body?.url === "string" ? body.url.trim() : "";
  const label = typeof body?.label === "string" ? body.label.trim() : "";
  const terminologyProfile = typeof body?.terminologyProfile === "string" ? body.terminologyProfile : "";
  if (!["native", "planning-center", "faithteams", "other"].includes(provider)
    || label.length > 80 || !["general", "church"].includes(terminologyProfile)) {
    return json({ error: "Check the scheduling source and organization language." }, 400);
  }
  if (provider !== "native" && !workspaceUrl) return json({ error: "A scheduling workspace URL is required." }, 400);
  if (workspaceUrl) {
    try {
      if (new URL(workspaceUrl).protocol !== "https:") throw new Error();
    } catch {
      return json({ error: "Scheduling links must use HTTPS." }, 400);
    }
  }
  const values = [
    ["schedule-provider", provider],
    ["schedule-provider-url", workspaceUrl],
    ["schedule-provider-label", label],
    ["terminology-profile", terminologyProfile],
  ];
  await db.batch(values.map(([key, value]) => db.prepare(
    `INSERT INTO app_setting (id, orgId, key, value, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT(orgId, key) DO UPDATE SET value = excluded.value, updatedAt = CURRENT_TIMESTAMP`,
  ).bind(crypto.randomUUID(), access.orgId, key, value)));
  return json({ ok: true });
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
      `SELECT userId, permissions FROM member_permission_grant
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
  const contentError = objectionableContentReason(commentBody);
  if (contentError) return json({ error: contentError }, 400);
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

const isMobileIncidentReactionEmoji = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 32 && /\p{Extended_Pictographic}/u.test(value);

async function setMobileIncidentReaction(
  request: Request,
  url: URL,
  commentId: string,
  db: MobileApiDatabase,
): Promise<Response> {
  const access = await authorize(request, url, db, ["incidents:report", "incidents:access"]);
  if (access instanceof Response) return access;
  const body = await readJson(request);
  if (!body || !isMobileIncidentReactionEmoji(body.emoji) || typeof body.active !== "boolean") {
    return json({ error: "Choose a valid reaction state." }, 400);
  }
  const { active, emoji } = body;
  const target = await db.prepare(
    `SELECT c.userId, c.incidentId FROM incident_comment c
     JOIN incident i ON i.id = c.incidentId
     WHERE c.id = ? AND c.orgId = ? AND i.orgId = ? LIMIT 1`,
  ).bind(commentId, access.orgId, access.orgId).first<{ userId: string; incidentId: string }>();
  if (!target) return json({ error: "Comment not found." }, 404);

  if (!active) {
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

function serializeMobileRundownItem(item: MobileRundownItemRow) {
  return {
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
    scheduledStart: item.scheduledStart,
    expectedEnd: item.expectedEnd,
    actualStart: item.actualStart,
    actualEnd: item.actualEnd,
  };
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

async function showBoard(request: Request, url: URL, db: MobileApiDatabase): Promise<Response> {
  const access = await authorize(request, url, db, ["showboard:view"]);
  if (access instanceof Response) return access;
  const [result, clockFormat, timeZone] = await Promise.all([
    db.prepare(
      `SELECT id, memberId, name, role, photoUrl, isOnline, lastCheckIn, lastCheckOut
       FROM crew_member WHERE orgId = ?
       ORDER BY isOnline DESC, name ASC, id ASC`,
    ).bind(access.orgId).all<MobileCheckInMemberRow>(),
    db.prepare("SELECT value FROM app_setting WHERE orgId = ? AND key = 'clock-format' LIMIT 1")
      .bind(access.orgId).first<{ value: string }>(),
    db.prepare("SELECT value FROM app_setting WHERE orgId = ? AND key = 'org-timezone' LIMIT 1")
      .bind(access.orgId).first<{ value: string }>(),
  ]);
  return json({
    clockFormat: clockFormat?.value === "24hr" ? "24hr" : "12hr",
    timeZone: timeZone?.value || "Africa/Accra",
    members: (result.results ?? []).map(serializeCheckInMember),
  });
}

async function showWorkspace(request: Request, url: URL, db: MobileApiDatabase): Promise<Response> {
  const access = await authorize(request, url, db, ["show:view"]);
  if (access instanceof Response) return access;
  const { orgId, identity } = access;
  const [settingsResult, crewResult] = await Promise.all([
    db.prepare(
      `SELECT key, value FROM app_setting
       WHERE orgId = ? AND key IN (
         'org-timezone', 'clock-format', 'rundown-adapter', 'ontime-url', 'active-show-id'
       )`,
    ).bind(orgId).all<{ key: string; value: string }>(),
    db.prepare(
      `SELECT id, memberId, name, role, photoUrl, isOnline, lastCheckIn, lastCheckOut
       FROM crew_member WHERE orgId = ?
       ORDER BY isOnline DESC, name ASC, id ASC`,
    ).bind(orgId).all<MobileCheckInMemberRow>(),
  ]);
  const settings = Object.fromEntries((settingsResult.results ?? []).map((setting) => [setting.key, setting.value]));
  const timeZone = settings["org-timezone"] || "Africa/Accra";
  const today = getTodayDateString(timeZone);
  const configuredAdapter = new Set(["native", "ontime", "propresenter", "planning-center"])
    .has(settings["rundown-adapter"])
    ? settings["rundown-adapter"]
    : "native";
  const common = {
    clockFormat: settings["clock-format"] === "24hr" ? "24hr" : "12hr",
    timeZone,
    configuredAdapter,
    chatAvailable: identity.permissions.includes("chat:access"),
    showBoardAvailable: identity.permissions.includes("showboard:view"),
    canOpenRundown: hasAny(identity, ["rundown:view", "rundown:edit", "rundown:control"]),
    crew: (crewResult.results ?? []).map(serializeCheckInMember),
  };

  const ontimeUrl = settings["ontime-url"]?.trim();
  if (configuredAdapter === "ontime" && ontimeUrl) {
    const ontime = await fetchOntimeRuntimeState(ontimeUrl);
    if (ontime.connected) {
      return json({
        ...common,
        adapterStatus: "ready",
        runtime: { kind: "ontime", ...ontime },
      });
    }
  }

  const activeShowId = settings["active-show-id"] ?? "";
  const show = await db.prepare(
    `SELECT id, serviceDate, name, scheduledStartTime, location, status, updatedAt
     FROM rundown
     WHERE orgId = ? AND (id = ? OR status IN ('running', 'paused') OR serviceDate >= ?)
     ORDER BY CASE
       WHEN id = ? THEN 0
       WHEN status IN ('running', 'paused') THEN 1
       ELSE 2
     END, serviceDate ASC, scheduledStartTime ASC, createdAt ASC
     LIMIT 1`,
  ).bind(orgId, activeShowId, today, activeShowId).first<Omit<MobileRundownRow, "itemCount"> & { updatedAt: string }>();

  if (!show) {
    return json({
      ...common,
      adapterStatus: configuredAdapter === "ontime" ? "fallback" : "ready",
      runtime: { kind: "native", show: null, items: [], timer: parseTimer(null) },
    });
  }

  const [itemsResult, showTimerSetting, dateTimerSetting, legacyOwner] = await Promise.all([
    db.prepare(
      `SELECT itemId, title, type, duration, notes, assignee, cue, status,
              sortOrder, hardStop, lowerThirdId, scheduledStart, expectedEnd, actualStart, actualEnd
       FROM rundown_item WHERE orgId = ? AND showId = ?
       ORDER BY sortOrder ASC, createdAt ASC`,
    ).bind(orgId, show.id).all<MobileRundownItemRow>(),
    db.prepare("SELECT value FROM app_setting WHERE orgId = ? AND key = ? LIMIT 1")
      .bind(orgId, `rundown-timer:${show.id}`).first<{ value: string }>(),
    db.prepare("SELECT value FROM app_setting WHERE orgId = ? AND key = ? LIMIT 1")
      .bind(orgId, `rundown-timer:${show.serviceDate}`).first<{ value: string }>(),
    db.prepare(
      `SELECT id FROM rundown WHERE orgId = ? AND serviceDate = ?
       ORDER BY scheduledStartTime ASC, createdAt ASC LIMIT 1`,
    ).bind(orgId, show.serviceDate).first<{ id: string }>(),
  ]);
  const timer = parseTimer(showTimerSetting?.value ?? (legacyOwner?.id === show.id ? dateTimerSetting?.value : null));
  return json({
    ...common,
    adapterStatus: configuredAdapter === "ontime" ? "fallback" : "ready",
    runtime: {
      kind: "native",
      show: { ...show, status: mobileRundownStatus(timer.playback, show.status) },
      items: (itemsResult.results ?? []).map(serializeMobileRundownItem),
      timer,
    },
  });
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

async function mobileBridgeStatus(env: MobileApiEnvironment, orgId: string): Promise<BridgeRelayStatus> {
  const fallback: BridgeRelayStatus = { bridgeOnline: false, clientCount: 0, connectedTargets: [] };
  if (!env.BRIDGE_RELAY) return fallback;
  try {
    const id = env.BRIDGE_RELAY.idFromName(orgId);
    return await env.BRIDGE_RELAY.get(id).getBridgeStatus();
  } catch {
    return fallback;
  }
}

interface MobileDeviceAdapterField {
  key: string;
  label: string;
  placeholder: string;
  type: "text" | "number" | "password" | "select";
  required: boolean;
  options: { value: string; label: string }[];
}

interface MobileDeviceAdapter {
  adapterType: string;
  displayName: string;
  category: string;
  connectivity: "browser-direct" | "bridge-required";
  description: string;
  fields: MobileDeviceAdapterField[];
}

async function mobileDeviceAdapters(): Promise<MobileDeviceAdapter[]> {
  await import("./device-modules/register-all");
  const { moduleRegistry } = await import("./device-modules/registry");
  return moduleRegistry.getAll().map((definition) => ({
    adapterType: definition.adapterType,
    displayName: definition.displayName,
    category: definition.category,
    connectivity: definition.connectivity,
    description: definition.description,
    fields: definition.configFields.map((field) => ({
      key: field.key,
      label: field.label,
      placeholder: field.placeholder ?? "",
      type: field.type ?? "text",
      required: field.required === true,
      options: field.options ?? [],
    })),
  })).sort((left, right) => left.displayName.localeCompare(right.displayName));
}

function serializeMobileDeviceConfiguration(
  adapter: MobileDeviceAdapter | undefined,
  settings: Record<string, unknown> | null,
) {
  return (adapter?.fields ?? []).map((field) => {
    const raw = settings?.[field.key];
    return {
      ...field,
      value: field.type === "password" || raw === null || raw === undefined ? "" : String(raw),
      secretConfigured: field.type === "password" && typeof raw === "string" && raw.length > 0,
    };
  });
}

async function devices(request: Request, url: URL, env: MobileApiEnvironment): Promise<Response> {
  const access = await authorize(request, url, env.DB, ["devices:access"]);
  if (access instanceof Response) return access;
  const [result, bridge, adapters] = await Promise.all([env.DB.prepare(
    `SELECT id, name, category, adapterType, enabled, updatedAt, settings
     FROM device WHERE orgId = ? ORDER BY enabled DESC, name ASC`,
  ).bind(access.orgId).all<MobileDeviceListRow>(), mobileBridgeStatus(env, access.orgId), mobileDeviceAdapters()]);
  const connectedTargets = new Set(bridge.connectedTargets);
  const adaptersByType = new Map(adapters.map((adapter) => [adapter.adapterType, adapter]));
  return json({
    bridge: {
      online: bridge.bridgeOnline,
      clientCount: bridge.clientCount,
      version: bridge.version ?? null,
      deviceCount: bridge.devices ?? connectedTargets.size,
      uptime: bridge.uptime ?? null,
    },
    adapters,
    devices: (result.results ?? []).map((device) => {
      const settings = parsedSettings(device.settings);
      const adapter = adaptersByType.get(device.adapterType);
      const remote = settings ? resolveRemoteDeviceControl(device.adapterType, settings) : null;
      const target = remote?.target ?? null;
      return {
        id: device.id,
        name: device.name,
        category: device.category,
        adapterType: device.adapterType,
        enabled: Boolean(device.enabled),
        connected: Boolean(device.enabled && target && connectedTargets.has(target)),
        updatedAt: device.updatedAt,
        configuration: serializeMobileDeviceConfiguration(adapter, settings),
        controls: remote?.actions ?? [],
        feedbackCount: remote?.feedbacks.length ?? 0,
      };
    }),
  });
}

async function parseMobileDeviceWrite(
  body: Record<string, unknown> | null,
  existing: MobileDeviceControlRow | null,
) {
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const adapterType = typeof body?.adapterType === "string" ? body.adapterType.trim() : "";
  const enabled = typeof body?.enabled === "boolean" ? body.enabled : true;
  const suppliedSettings = isRecord(body?.settings) ? body.settings : {};
  if (!name || name.length > 200 || !adapterType) return { error: "Enter a device name and adapter." } as const;
  const adapter = (await mobileDeviceAdapters()).find((candidate) => candidate.adapterType === adapterType);
  if (!adapter) return { error: "Choose a supported device adapter." } as const;
  const existingSettings = existing?.adapterType === adapterType ? parsedSettings(existing.settings) : null;
  const settings: Record<string, string | number> = {};
  for (const field of adapter.fields) {
    const raw = suppliedSettings[field.key];
    if (field.type === "password" && (raw === undefined || raw === "") && typeof existingSettings?.[field.key] === "string") {
      settings[field.key] = existingSettings[field.key] as string;
      continue;
    }
    if (field.type === "number") {
      if (raw === undefined || raw === "") {
        if (field.required) return { error: `${field.label} is required.` } as const;
        continue;
      }
      const value = Number(raw);
      if (!Number.isFinite(value) || (field.key.toLowerCase().includes("port") && (!Number.isInteger(value) || value < 1 || value > 65_535))) {
        return { error: `${field.label} is not valid.` } as const;
      }
      settings[field.key] = value;
      continue;
    }
    const value = typeof raw === "string" ? raw.trim() : "";
    if (field.required && !value) return { error: `${field.label} is required.` } as const;
    if (value.length > 4_096) return { error: `${field.label} is too long.` } as const;
    if (field.type === "select" && value && !field.options.some((option) => option.value === value)) {
      return { error: `${field.label} is not valid.` } as const;
    }
    if (value) settings[field.key] = value;
  }
  const serializedSettings = JSON.stringify(settings);
  if (serializedSettings.length > 20_000) return { error: "Device settings are too large." } as const;
  return { value: { name, adapterType, category: adapter.category, enabled, settings: serializedSettings } } as const;
}

async function createMobileDevice(request: Request, url: URL, env: MobileApiEnvironment): Promise<Response> {
  const access = await authorize(request, url, env.DB, ["devices:access"]);
  if (access instanceof Response) return access;
  const parsed = await parseMobileDeviceWrite(await readJson(request), null);
  if ("error" in parsed) return json({ error: parsed.error }, 400);
  const count = await env.DB.prepare("SELECT CAST(COUNT(*) AS INTEGER) AS count FROM device WHERE orgId = ?")
    .bind(access.orgId).first<{ count: number }>();
  try {
    const { checkPlanLimit } = await import("./plan-limits");
    await checkPlanLimit(access.orgId, "devices", count?.count ?? 0);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Device limit reached." }, error instanceof PlanLimitError ? error.status : 400);
  }
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO device (id, orgId, name, category, adapterType, settings, enabled, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  ).bind(id, access.orgId, parsed.value.name, parsed.value.category, parsed.value.adapterType, parsed.value.settings, parsed.value.enabled).run();
  return json({ ok: true, id }, 201);
}

async function updateMobileDevice(
  request: Request,
  url: URL,
  deviceId: string,
  env: MobileApiEnvironment,
): Promise<Response> {
  const access = await authorize(request, url, env.DB, ["devices:access"]);
  if (access instanceof Response) return access;
  const existing = await env.DB.prepare(
    `SELECT id, orgId, name, category, adapterType, settings, enabled, updatedAt
     FROM device WHERE id = ? AND orgId = ? LIMIT 1`,
  ).bind(deviceId, access.orgId).first<MobileDeviceControlRow>();
  if (!existing) return json({ error: "Device not found." }, 404);
  const parsed = await parseMobileDeviceWrite(await readJson(request), existing);
  if ("error" in parsed) return json({ error: parsed.error }, 400);
  const result = await env.DB.prepare(
    `UPDATE device SET name = ?, category = ?, adapterType = ?, settings = ?, enabled = ?, updatedAt = CURRENT_TIMESTAMP
     WHERE id = ? AND orgId = ?`,
  ).bind(parsed.value.name, parsed.value.category, parsed.value.adapterType, parsed.value.settings, parsed.value.enabled, deviceId, access.orgId).run();
  return changedExactlyOneRow(result) ? json({ ok: true }) : json({ error: "Device changed elsewhere. Refresh and try again." }, 409);
}

async function deleteMobileDevice(
  request: Request,
  url: URL,
  deviceId: string,
  env: MobileApiEnvironment,
): Promise<Response> {
  const access = await authorize(request, url, env.DB, ["devices:access"]);
  if (access instanceof Response) return access;
  const result = await env.DB.prepare("DELETE FROM device WHERE id = ? AND orgId = ?")
    .bind(deviceId, access.orgId).run();
  return changedExactlyOneRow(result) ? json({ ok: true }) : json({ error: "Device not found." }, 404);
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

function liveFeedbackValue(value: unknown): string | number | boolean | null {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? value
    : null;
}

async function refreshRemoteDeviceControl(
  env: MobileApiEnvironment,
  orgId: string,
  adapterType: string,
  settings: Record<string, unknown>,
  remote: ResolvedRemoteDeviceControl,
  bridge: BridgeRelayStatus,
) {
  const values: Record<string, unknown> = {};
  let updatedAt: number | null = null;
  let actions = remote.actions;
  const event = bridge.deviceEvents?.[remote.target];
  if (event && remote.definition.parseEvent) {
    Object.assign(values, remote.definition.parseEvent(event.eventName, event.data, settings));
    updatedAt = event.receivedAt;
  }
  if (!bridge.connectedTargets.includes(remote.target)) return { values, actions, updatedAt };

  const queries = remote.definition.feedbackQueries?.(settings) ?? [];
  const results = await Promise.all(queries.map(async (query) => {
    const result = await bridgeDispatch(env, orgId, {
      type: "command",
      id: `mobile-feedback-${crypto.randomUUID()}`,
      protocol: remote.definition.protocol,
      target: remote.target,
      command: query.command,
    });
    return { query, result };
  }));
  for (const { query, result } of results) {
    if (!result.success || typeof result.response !== "string") continue;
    Object.assign(values, query.parse(result.response));
    updatedAt = Date.now();
    if (adapterType === "homeassistant" && query.command === "GET /api/states") {
      actions = buildHomeAssistantActions(parseHomeAssistantEntities(result.response));
    }
  }
  return { values, actions, updatedAt };
}

async function deviceControlState(
  request: Request,
  url: URL,
  deviceId: string,
  env: MobileApiEnvironment,
): Promise<Response> {
  if (!validId(deviceId)) return json({ error: "A valid deviceId is required." }, 400);
  const access = await authorize(request, url, env.DB, ["devices:access"]);
  if (access instanceof Response) return access;
  const device = await env.DB.prepare(
    `SELECT id, orgId, name, category, adapterType, settings, enabled, updatedAt
     FROM device WHERE id = ? AND orgId = ? LIMIT 1`,
  ).bind(deviceId, access.orgId).first<MobileDeviceControlRow>();
  if (!device || !device.enabled) return json({ error: "Device not found or disabled." }, 404);
  const settings = parsedSettings(device.settings);
  const remote = settings ? resolveRemoteDeviceControl(device.adapterType, settings) : null;
  if (!settings || !remote) return json({ error: "This device is missing a valid remote-control configuration." }, 409);
  const bridge = await mobileBridgeStatus(env, access.orgId);
  const connected = bridge.bridgeOnline && bridge.connectedTargets.includes(remote.target);
  const refreshed = await refreshRemoteDeviceControl(env, access.orgId, device.adapterType, settings, remote, bridge);
  return json({
    connected,
    bridgeOnline: bridge.bridgeOnline,
    controls: refreshed.actions,
    feedbacks: remote.feedbacks.map((feedback) => ({
      id: feedback.id,
      label: feedback.label,
      type: feedback.type,
      value: liveFeedbackValue(refreshed.values[feedback.id]),
      available: feedback.id in refreshed.values,
    })),
    refreshedAt: refreshed.updatedAt,
  });
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
  const settings = parsedSettings(device.settings);
  const remote = settings ? resolveRemoteDeviceControl(device.adapterType, settings) : null;
  if (!settings || !remote) return json({ error: "This device is missing a valid remote-control configuration." }, 409);
  if (operation === "connect") {
    const result = await bridgeDispatch(env, access.orgId, {
      type: "connect-device",
      protocol: remote.definition.protocol,
      target: remote.target,
      settings: remote.connectionSettings,
    });
    return json(result, result.success ? 200 : 502);
  }
  if (operation === "disconnect") {
    const result = await bridgeDispatch(env, access.orgId, { type: "disconnect-device", target: remote.target });
    return json(result, result.success ? 200 : 502);
  }

  const actionId = typeof body.actionId === "string" ? body.actionId : "";
  const params = isRecord(body.params) ? body.params : {};
  const bridge = await mobileBridgeStatus(env, access.orgId);
  if (!bridge.bridgeOnline || !bridge.connectedTargets.includes(remote.target)) {
    return json({ error: "Connect this device through the venue Bridge before sending commands." }, 409);
  }
  if (device.adapterType === "homeassistant") {
    const discovery = await bridgeDispatch(env, access.orgId, {
      type: "command",
      id: `mobile-discovery-${crypto.randomUUID()}`,
      protocol: remote.definition.protocol,
      target: remote.target,
      command: "GET /api/states",
    });
    const allowed = discovery.success && typeof discovery.response === "string"
      ? buildHomeAssistantActions(parseHomeAssistantEntities(discovery.response))
      : [];
    if (!allowed.some((action) => action.id === actionId)) return json({ error: "This Home Assistant action is no longer available." }, 409);
  }
  let command: string;
  try {
    command = remote.definition.buildCommand(actionId, params, settings);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Invalid device action." }, 400);
  }
  const result = await bridgeDispatch(env, access.orgId, {
    type: "command",
    id: `mobile-${crypto.randomUUID()}`,
    protocol: remote.definition.protocol,
    target: remote.target,
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

const cueColumnColors = new Set(["slate", "amber", "green", "blue", "purple", "pink", "cyan", "red"]);
const equipmentStatuses = new Set(["operational", "maintenance", "broken", "retired", "needs-repair", "out-of-service", "in-repair"]);
const equipmentCategories = new Set(["audio", "video", "lighting", "streaming", "network", "power", "cables", "comms", "other"]);
const micTypes = new Set(["wireless-handheld", "wireless-lav", "wired", "headset", "di-box", "other"]);
const micGroups = new Set(["vocals", "band", "playback", "sfx", "other"]);

function boundedText(value: unknown, maximum: number, required = false): string | null {
  if (typeof value !== "string") return required ? null : "";
  const text = value.trim();
  if ((required && text.length === 0) || text.length > maximum) return null;
  return text;
}

async function resolveMobileShow(
  db: MobileApiDatabase,
  orgId: string,
  today: string,
  requestedShowId?: unknown,
): Promise<{ id: string; serviceDate: string; name: string; status: string } | null> {
  if (requestedShowId !== undefined && !validId(requestedShowId)) return null;
  if (typeof requestedShowId === "string") {
    return db.prepare(
      "SELECT id, serviceDate, name, status FROM rundown WHERE id = ? AND orgId = ? LIMIT 1",
    ).bind(requestedShowId, orgId).first();
  }
  return db.prepare(
    `SELECT id, serviceDate, name, status FROM rundown WHERE orgId = ?
     ORDER BY CASE WHEN serviceDate >= ? THEN 0 ELSE 1 END,
       CASE WHEN serviceDate >= ? THEN serviceDate END ASC, serviceDate DESC,
       scheduledStartTime ASC, createdAt ASC LIMIT 1`,
  ).bind(orgId, today, today).first();
}

async function mobileCueSheet(request: Request, url: URL, db: MobileApiDatabase): Promise<Response> {
  const access = await authorize(request, url, db, ["cuesheet:view", "cuesheet:edit", "cuesheet:add_notes"]);
  if (access instanceof Response) return access;
  const show = await resolveMobileShow(db, access.orgId, access.identity.today, url.searchParams.get("showId") ?? undefined);
  if (!show) {
    const shows = await db.prepare(
      "SELECT id, serviceDate, name, scheduledStartTime FROM rundown WHERE orgId = ? ORDER BY serviceDate DESC, scheduledStartTime DESC",
    ).bind(access.orgId).all<Record<string, unknown>>();
    return json({
      show: null,
      shows: shows.results ?? [],
      canEdit: hasAny(access.identity, ["cuesheet:edit"]),
      canAddNotes: hasAny(access.identity, ["cuesheet:edit", "cuesheet:add_notes"]),
      columns: [],
      rows: [],
    });
  }
  const [columnsResult, itemResult, noteResult, showsResult] = await Promise.all([
    db.prepare(
      "SELECT id, label, color, sortOrder, width FROM cue_column WHERE orgId = ? ORDER BY sortOrder, createdAt",
    ).bind(access.orgId).all<{ id: string; label: string; color: string; sortOrder: number; width: number }>(),
    db.prepare(
      `SELECT itemId AS id, title, type, duration, assignee, cue, status, sortOrder
       FROM rundown_item WHERE orgId = ? AND showId = ? ORDER BY sortOrder, createdAt`,
    ).bind(access.orgId, show.id).all<Record<string, unknown>>(),
    db.prepare(
      "SELECT itemId, columnId, text, updatedAt, updatedBy FROM cue_note WHERE orgId = ? AND showId = ?",
    ).bind(access.orgId, show.id).all<Record<string, unknown>>(),
    db.prepare(
      "SELECT id, serviceDate, name, scheduledStartTime FROM rundown WHERE orgId = ? ORDER BY serviceDate DESC, scheduledStartTime DESC",
    ).bind(access.orgId).all<Record<string, unknown>>(),
  ]);
  const notes = new Map((noteResult.results ?? []).map((note) => [`${note.itemId}:${note.columnId}`, note]));
  const columns = columnsResult.results ?? [];
  return json({
    show,
    shows: showsResult.results ?? [],
    canEdit: hasAny(access.identity, ["cuesheet:edit"]),
    canAddNotes: hasAny(access.identity, ["cuesheet:edit", "cuesheet:add_notes"]),
    columns,
    rows: (itemResult.results ?? []).map((item) => ({
      ...item,
      notes: columns.map((column) => notes.get(`${item.id}:${column.id}`) ?? {
        itemId: item.id,
        columnId: column.id,
        text: "",
        updatedAt: null,
        updatedBy: "",
      }),
    })),
  });
}

async function writeMobileCueSheet(request: Request, url: URL, db: MobileApiDatabase): Promise<Response> {
  const body = await readJson(request);
  const action = body?.action;
  const permissions: Permission[] = action === "upsert-note"
    ? ["cuesheet:edit", "cuesheet:add_notes"]
    : ["cuesheet:edit"];
  const access = await authorize(request, url, db, permissions);
  if (access instanceof Response) return access;
  if (action === "upsert-note") {
    if (!validId(body?.showId) || !validId(body?.itemId) || !validId(body?.columnId)) return json({ error: "Valid cue targets are required." }, 400);
    const text = boundedText(body?.text, 2_000);
    if (text === null) return json({ error: "Cue notes may contain at most 2,000 characters." }, 400);
    const targets = await db.prepare(
      `SELECT 1 AS valid FROM rundown_item i JOIN cue_column c ON c.id = ? AND c.orgId = i.orgId
       WHERE i.orgId = ? AND i.showId = ? AND i.itemId = ? LIMIT 1`,
    ).bind(body.columnId, access.orgId, body.showId, body.itemId).first<{ valid: number }>();
    if (!targets) return json({ error: "Cue row or column not found." }, 404);
    await db.prepare(
      `INSERT INTO cue_note (id, orgId, showId, serviceDate, itemId, columnId, text, updatedAt, updatedBy)
       SELECT ?, ?, id, serviceDate, ?, ?, ?, CURRENT_TIMESTAMP, ? FROM rundown WHERE id = ? AND orgId = ?
       ON CONFLICT(orgId, showId, itemId, columnId) DO UPDATE SET
         text = excluded.text, updatedAt = CURRENT_TIMESTAMP, updatedBy = excluded.updatedBy`,
    ).bind(crypto.randomUUID(), access.orgId, body.itemId, body.columnId, text, access.identity.name, body.showId, access.orgId).run();
    return json({ ok: true });
  }
  if (action === "add-column") {
    const label = boundedText(body?.label, 80, true);
    const color = typeof body?.color === "string" && cueColumnColors.has(body.color) ? body.color : "slate";
    if (!label) return json({ error: "A column label is required." }, 400);
    const next = await db.prepare("SELECT COALESCE(MAX(sortOrder), -1) + 1 AS value FROM cue_column WHERE orgId = ?")
      .bind(access.orgId).first<{ value: number }>();
    const id = crypto.randomUUID();
    await db.prepare(
      "INSERT INTO cue_column (id, orgId, label, color, sortOrder, width, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, 160, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
    ).bind(id, access.orgId, label, color, next?.value ?? 0).run();
    return json({ ok: true, id });
  }
  if (action === "update-column" || action === "move-column") {
    if (!validId(body?.columnId)) return json({ error: "A valid column is required." }, 400);
    const current = await db.prepare("SELECT label, color, sortOrder FROM cue_column WHERE id = ? AND orgId = ?")
      .bind(body.columnId, access.orgId).first<{ label: string; color: string; sortOrder: number }>();
    if (!current) return json({ error: "Cue column not found." }, 404);
    const label = body.label === undefined ? current.label : boundedText(body.label, 80, true);
    const color = body.color === undefined ? current.color : typeof body.color === "string" && cueColumnColors.has(body.color) ? body.color : null;
    const sortOrder = action === "move-column" && typeof body.sortOrder === "number" && Number.isInteger(body.sortOrder)
      ? Math.max(0, Math.min(100, body.sortOrder))
      : current.sortOrder;
    if (!label || !color) return json({ error: "Column values are invalid." }, 400);
    if (action === "move-column" && sortOrder !== current.sortOrder) {
      await db.prepare(
        "UPDATE cue_column SET sortOrder = ?, updatedAt = CURRENT_TIMESTAMP WHERE orgId = ? AND sortOrder = ? AND id <> ?",
      ).bind(current.sortOrder, access.orgId, sortOrder, body.columnId).run();
    }
    await db.prepare("UPDATE cue_column SET label = ?, color = ?, sortOrder = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ? AND orgId = ?")
      .bind(label, color, sortOrder, body.columnId, access.orgId).run();
    return json({ ok: true });
  }
  if (action === "remove-column" && validId(body?.columnId)) {
    await db.prepare("DELETE FROM cue_column WHERE id = ? AND orgId = ?").bind(body.columnId, access.orgId).run();
    return json({ ok: true });
  }
  return json({ error: "Unsupported cue-sheet action." }, 400);
}

async function mobileAssets(request: Request, url: URL, db: MobileApiDatabase): Promise<Response> {
  const access = await authorize(request, url, db, ["assets:view", "assets:manage"]);
  if (access instanceof Response) return access;
  const result = await db.prepare(
    `SELECT id, name, category, status, location, serialNumber, notes, lastServiced, nextService, updatedAt
     FROM equipment WHERE orgId = ? ORDER BY category, name, createdAt`,
  ).bind(access.orgId).all<Record<string, unknown>>();
  return json({ canManage: hasAny(access.identity, ["assets:manage"]), assets: result.results ?? [] });
}

function parseAssetWrite(body: Record<string, unknown> | null) {
  const name = boundedText(body?.name, 200, true);
  const category = typeof body?.category === "string" ? body.category.toLowerCase() : "";
  const status = typeof body?.status === "string" ? body.status.toLowerCase() : "";
  const location = boundedText(body?.location, 240);
  const serialNumber = boundedText(body?.serialNumber, 240);
  const notes = boundedText(body?.notes, 2_000);
  if (!name || !equipmentCategories.has(category) || !equipmentStatuses.has(status) || location === null || serialNumber === null || notes === null) return null;
  return { name, category, status, location, serialNumber, notes };
}

async function writeMobileAsset(request: Request, url: URL, db: MobileApiDatabase, assetId?: string): Promise<Response> {
  const access = await authorize(request, url, db, ["assets:manage"]);
  if (access instanceof Response) return access;
  const body = await readJson(request);
  if (body?.action === "remove" && assetId) {
    const result = await db.prepare("DELETE FROM equipment WHERE id = ? AND orgId = ?").bind(assetId, access.orgId).run();
    return changedExactlyOneRow(result) ? json({ ok: true }) : json({ error: "Asset not found." }, 404);
  }
  const write = parseAssetWrite(body);
  if (!write) return json({ error: "Asset details are invalid." }, 400);
  if (assetId) {
    const result = await db.prepare(
      `UPDATE equipment SET name = ?, category = ?, status = ?, location = ?, serialNumber = ?, notes = ?, updatedAt = CURRENT_TIMESTAMP
       WHERE id = ? AND orgId = ?`,
    ).bind(write.name, write.category, write.status, write.location, write.serialNumber, write.notes, assetId, access.orgId).run();
    return changedExactlyOneRow(result) ? json({ ok: true }) : json({ error: "Asset not found." }, 404);
  }
  const id = crypto.randomUUID();
  await db.prepare(
    `INSERT INTO equipment (id, orgId, name, category, status, location, serialNumber, notes, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  ).bind(id, access.orgId, write.name, write.category, write.status, write.location, write.serialNumber, write.notes).run();
  return json({ ok: true, id });
}

async function mobileStreaming(request: Request, url: URL, db: MobileApiDatabase): Promise<Response> {
  const access = await authorize(request, url, db, ["stream_health:view", "stream_health:manage", "streaming_suite:access"]);
  if (access instanceof Response) return access;
  const [inputs, destinations] = await Promise.all([
    db.prepare("SELECT id, name, status, rtmpUrl, srtUrl, createdAt FROM live_input WHERE orgId = ? ORDER BY createdAt")
      .bind(access.orgId).all<Record<string, unknown>>(),
    db.prepare(
      `SELECT id, name, platform, rtmpUrl, enabled, cfOutputId, liveInputId, createdAt,
        CASE WHEN streamKey = '' THEN 0 ELSE 1 END AS hasStreamKey
       FROM stream_destination WHERE orgId = ? ORDER BY createdAt`,
    ).bind(access.orgId).all<Record<string, unknown>>(),
  ]);
  const inputRows = inputs.results ?? [];
  const liveStatuses = await Promise.all(inputRows.map((row) => getLiveInputStatusForOrg(access.orgId, String(row.id))));
  return json({
    canManage: hasAny(access.identity, ["stream_health:manage"]),
    inputs: inputRows.map((row, index) => ({
      ...row,
      ...(liveStatuses[index] ?? {}),
    })),
    destinations: (destinations.results ?? []).map((row) => ({
      ...row,
      enabled: Boolean(row.enabled),
      connected: typeof row.cfOutputId === "string" && row.cfOutputId.length > 0,
      hasStreamKey: Boolean(row.hasStreamKey),
    })),
  });
}

async function writeMobileDestination(request: Request, url: URL, db: MobileApiDatabase, destinationId?: string): Promise<Response> {
  const access = await authorize(request, url, db, ["stream_health:manage"]);
  if (access instanceof Response) return access;
  const body = await readJson(request);
  if (body?.action === "remove" && destinationId) {
    try {
      await deleteStreamDestinationForOrg(access.orgId, destinationId);
      return json({ ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Destination removal failed.";
      return json({ error: message }, /not found/i.test(message) ? 404 : 502);
    }
  }
  if (body?.action === "toggle" && destinationId && typeof body.enabled === "boolean") {
    try {
      await setStreamDestinationEnabledForOrg(access.orgId, destinationId, body.enabled);
      return json({ ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Destination toggle failed.";
      return json({ error: message }, /not found/i.test(message) ? 404 : 502);
    }
  }
  const name = boundedText(body?.name, 200, true);
  const platform = boundedText(body?.platform, 50, true)?.toLowerCase() ?? null;
  const rtmpUrl = boundedText(body?.rtmpUrl, 500);
  const streamKey = body?.streamKey === undefined ? undefined : boundedText(body.streamKey, 500);
  if (!name || !platform || rtmpUrl === null || streamKey === null || !/^rtmps?:\/\//i.test(rtmpUrl)) {
    return json({ error: "A name, platform, and valid RTMP URL are required." }, 400);
  }
  if (destinationId) {
    const current = await db.prepare("SELECT rtmpUrl, streamKey, cfOutputId FROM stream_destination WHERE id = ? AND orgId = ?")
      .bind(destinationId, access.orgId).first<{ rtmpUrl: string; streamKey: string; cfOutputId: string }>();
    if (!current) return json({ error: "Destination not found." }, 404);
    const changesCredentials = rtmpUrl !== current.rtmpUrl || Boolean(streamKey);
    if (current.cfOutputId && changesCredentials) {
      return json({ error: "Disable this destination before changing its RTMP credentials." }, 409);
    }
    await db.prepare(
      "UPDATE stream_destination SET name = ?, platform = ?, rtmpUrl = ?, streamKey = ? WHERE id = ? AND orgId = ?",
    ).bind(name, platform, rtmpUrl, streamKey === undefined || streamKey === "" ? current.streamKey : streamKey, destinationId, access.orgId).run();
    return json({ ok: true });
  }
  if (!streamKey) return json({ error: "A stream key is required for a new destination." }, 400);
  const id = crypto.randomUUID();
  await db.prepare(
    `INSERT INTO stream_destination (id, orgId, name, platform, rtmpUrl, streamKey, enabled, cfOutputId, liveInputId, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, 0, '', '', CURRENT_TIMESTAMP)`,
  ).bind(id, access.orgId, name, platform, rtmpUrl, streamKey).run();
  return json({ ok: true, id });
}

function parseActiveGraphicIds(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter(validId) : [];
  } catch {
    return [];
  }
}

async function mobileGraphics(request: Request, url: URL, db: MobileApiDatabase): Promise<Response> {
  const access = await authorize(request, url, db, ["lowerthird:view", "lowerthird:trigger", "lowerthird:configure"]);
  if (access instanceof Response) return access;
  const [org, templates, active] = await Promise.all([
    db.prepare("SELECT cloud_enabled AS cloudEnabled FROM organization WHERE id = ?").bind(access.orgId).first<{ cloudEnabled: number | boolean }>(),
    db.prepare("SELECT id, name, title, subtitle, style, createdAt, updatedAt FROM graphic_template WHERE orgId = ? ORDER BY createdAt")
      .bind(access.orgId).all<Record<string, unknown>>(),
    db.prepare("SELECT value FROM app_setting WHERE orgId = ? AND key = 'active-graphics'")
      .bind(access.orgId).first<{ value: string }>(),
  ]);
  return json({
    cloudEnabled: Boolean(org?.cloudEnabled),
    canConfigure: hasAny(access.identity, ["lowerthird:configure"]),
    canTrigger: hasAny(access.identity, ["lowerthird:trigger"]),
    activeIds: parseActiveGraphicIds(active?.value),
    templates: templates.results ?? [],
  });
}

async function writeMobileGraphic(request: Request, url: URL, db: MobileApiDatabase, graphicId?: string): Promise<Response> {
  const body = await readJson(request);
  const triggerAction = body?.action === "toggle" || body?.action === "clear";
  const access = await authorize(request, url, db, [triggerAction ? "lowerthird:trigger" : "lowerthird:configure"]);
  if (access instanceof Response) return access;
  const org = await db.prepare("SELECT cloud_enabled AS enabled FROM organization WHERE id = ?")
    .bind(access.orgId).first<{ enabled: number | boolean }>();
  if (!org?.enabled) return json({ error: "Cloud graphics are not enabled for this organization." }, 403);
  if (body?.action === "clear") {
    await db.prepare("DELETE FROM app_setting WHERE orgId = ? AND key IN ('active-graphics', 'active-graphic')").bind(access.orgId).run();
    return json({ ok: true, activeIds: [] });
  }
  if (body?.action === "toggle" && graphicId) {
    const owns = await db.prepare("SELECT id FROM graphic_template WHERE id = ? AND orgId = ?").bind(graphicId, access.orgId).first<{ id: string }>();
    if (!owns) return json({ error: "Graphic not found." }, 404);
    const stored = await db.prepare("SELECT value FROM app_setting WHERE orgId = ? AND key = 'active-graphics'").bind(access.orgId).first<{ value: string }>();
    const current = parseActiveGraphicIds(stored?.value);
    const next = current.includes(graphicId) ? current.filter((id) => id !== graphicId) : [...current, graphicId];
    await db.prepare(
      `INSERT INTO app_setting (id, orgId, key, value) VALUES (?, ?, 'active-graphics', ?)
       ON CONFLICT(orgId, key) DO UPDATE SET value = excluded.value`,
    ).bind(crypto.randomUUID(), access.orgId, JSON.stringify(next)).run();
    return json({ ok: true, activeIds: next });
  }
  if (body?.action === "remove" && graphicId) {
    await db.prepare("DELETE FROM graphic_template WHERE id = ? AND orgId = ?").bind(graphicId, access.orgId).run();
    return json({ ok: true });
  }
  const name = boundedText(body?.name, 200, true);
  const title = boundedText(body?.title, 500, true);
  const subtitle = boundedText(body?.subtitle, 500);
  if (!name || !title || subtitle === null) return json({ error: "Graphic details are invalid." }, 400);
  if (graphicId) {
    const result = await db.prepare(
      "UPDATE graphic_template SET name = ?, title = ?, subtitle = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ? AND orgId = ?",
    ).bind(name, title, subtitle, graphicId, access.orgId).run();
    return changedExactlyOneRow(result) ? json({ ok: true }) : json({ error: "Graphic not found." }, 404);
  }
  const id = crypto.randomUUID();
  await db.prepare(
    "INSERT INTO graphic_template (id, orgId, name, title, subtitle, style, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
  ).bind(id, access.orgId, name, title, subtitle).run();
  return json({ ok: true, id });
}

async function mobileDashboard(request: Request, url: URL, db: MobileApiDatabase, kind: "pm" | "tm"): Promise<Response> {
  const permission: Permission = kind === "pm" ? "dashboard:pm" : "dashboard:tm";
  const access = await authorize(request, url, db, [permission]);
  if (access instanceof Response) return access;
  const show = await resolveMobileShow(db, access.orgId, access.identity.today, url.searchParams.get("showId") ?? undefined);
  const showId = show?.id ?? "";
  const [items, assignments, checklist, incidents, equipment, inputs, destinations, devices] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'complete' THEN 1 ELSE 0 END) AS complete, SUM(CASE WHEN duration <= 0 THEN 1 ELSE 0 END) AS missingDuration, SUM(CASE WHEN TRIM(assignee) = '' THEN 1 ELSE 0 END) AS missingOwner FROM rundown_item WHERE orgId = ? AND showId = ?").bind(access.orgId, showId).first<Record<string, number | null>>(),
    db.prepare("SELECT status, COUNT(*) AS count FROM service_assignment WHERE orgId = ? AND showId = ? GROUP BY status").bind(access.orgId, showId).all<Record<string, unknown>>(),
    db.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN checked = 1 THEN 1 ELSE 0 END) AS complete FROM checklist_entry WHERE orgId = ? AND showId = ?").bind(access.orgId, showId).first<Record<string, number | null>>(),
    db.prepare("SELECT id, category, severity, description, status, assignedName, timestamp FROM incident WHERE orgId = ? AND status <> 'resolved' ORDER BY timestamp DESC LIMIT 12").bind(access.orgId).all<Record<string, unknown>>(),
    db.prepare("SELECT id, name, category, status, nextService FROM equipment WHERE orgId = ? ORDER BY CASE status WHEN 'operational' THEN 1 ELSE 0 END, name LIMIT 30").bind(access.orgId).all<Record<string, unknown>>(),
    db.prepare("SELECT id, name, status FROM live_input WHERE orgId = ? ORDER BY createdAt").bind(access.orgId).all<Record<string, unknown>>(),
    db.prepare("SELECT id, name, platform, enabled, cfOutputId FROM stream_destination WHERE orgId = ? ORDER BY createdAt").bind(access.orgId).all<Record<string, unknown>>(),
    db.prepare("SELECT id, name, category, adapterType, enabled FROM device WHERE orgId = ? ORDER BY name").bind(access.orgId).all<Record<string, unknown>>(),
  ]);
  return json({
    kind,
    show,
    items: { total: items?.total ?? 0, complete: items?.complete ?? 0, missingDuration: items?.missingDuration ?? 0, missingOwner: items?.missingOwner ?? 0 },
    assignments: assignments.results ?? [],
    checklist: { total: checklist?.total ?? 0, complete: checklist?.complete ?? 0 },
    incidents: incidents.results ?? [],
    equipment: equipment.results ?? [],
    inputs: inputs.results ?? [],
    destinations: (destinations.results ?? []).map((row) => ({ ...row, enabled: Boolean(row.enabled), connected: Boolean(row.cfOutputId) })),
    devices: (devices.results ?? []).map((row) => ({ ...row, enabled: Boolean(row.enabled) })),
  });
}

async function mobileReports(request: Request, url: URL, db: MobileApiDatabase): Promise<Response> {
  const access = await authorize(request, url, db, ["schedule:view"]);
  if (access instanceof Response) return access;
  const result = await db.prepare(
    `SELECT r.id, r.serviceDate, r.name, r.location, r.status, r.scheduledStartTime,
      COUNT(DISTINCT i.id) AS itemCount,
      COUNT(DISTINCT CASE WHEN i.status = 'complete' THEN i.id END) AS completedItems,
      COUNT(DISTINCT f.id) AS incidentCount,
      COUNT(DISTINCT a.id) AS assignmentCount,
      COUNT(DISTINCT CASE WHEN a.status = 'confirmed' THEN a.id END) AS confirmedAssignments,
      COUNT(DISTINCT c.id) AS checklistCount,
      COUNT(DISTINCT CASE WHEN c.checked = 1 THEN c.id END) AS completedChecks
     FROM rundown r
     LEFT JOIN rundown_item i ON i.orgId = r.orgId AND i.showId = r.id
     LEFT JOIN incident f ON f.orgId = r.orgId AND f.showId = r.id
     LEFT JOIN service_assignment a ON a.orgId = r.orgId AND a.showId = r.id
     LEFT JOIN checklist_entry c ON c.orgId = r.orgId AND c.showId = r.id
     WHERE r.orgId = ? GROUP BY r.id ORDER BY r.serviceDate DESC, r.scheduledStartTime DESC LIMIT 100`,
  ).bind(access.orgId).all<Record<string, unknown>>();
  return json({ organization: access.orgId, generatedAt: new Date().toISOString(), reports: result.results ?? [] });
}

async function mobileAudio(request: Request, url: URL, db: MobileApiDatabase): Promise<Response> {
  const access = await authorize(request, url, db, ["dashboard:tm"]);
  if (access instanceof Response) return access;
  const show = await resolveMobileShow(db, access.orgId, access.identity.today, url.searchParams.get("showId") ?? undefined);
  const [assignments, mixers, shows] = await Promise.all([
    db.prepare(
      `SELECT id, showId, channel, label, micType, micModel, notes, gainDb, phantom, muted, "group",
        mixerConsole, mixerChannel, mixerChannelType, serviceDate, updatedAt
       FROM mic_assignment WHERE orgId = ? AND showId = ? ORDER BY channel, createdAt`,
    ).bind(access.orgId, show?.id ?? "").all<Record<string, unknown>>(),
    db.prepare("SELECT id, name, adapterType FROM device WHERE orgId = ? AND category = 'mixer' AND enabled = 1 ORDER BY name")
      .bind(access.orgId).all<Record<string, unknown>>(),
    db.prepare("SELECT id, serviceDate, name, scheduledStartTime FROM rundown WHERE orgId = ? ORDER BY serviceDate DESC, scheduledStartTime DESC")
      .bind(access.orgId).all<Record<string, unknown>>(),
  ]);
  return json({
    show,
    shows: shows.results ?? [],
    mixers: mixers.results ?? [],
    assignments: (assignments.results ?? []).map((row) => ({ ...row, phantom: Boolean(row.phantom), muted: Boolean(row.muted) })),
  });
}

async function writeMobileAudio(request: Request, url: URL, db: MobileApiDatabase, assignmentId?: string): Promise<Response> {
  const access = await authorize(request, url, db, ["dashboard:tm"]);
  if (access instanceof Response) return access;
  const body = await readJson(request);
  if (body?.action === "remove" && assignmentId) {
    const result = await db.prepare("DELETE FROM mic_assignment WHERE id = ? AND orgId = ?").bind(assignmentId, access.orgId).run();
    return changedExactlyOneRow(result) ? json({ ok: true }) : json({ error: "Audio assignment not found." }, 404);
  }
  if (!validId(body?.showId) || typeof body?.channel !== "number" || !Number.isInteger(body.channel) || body.channel < 1 || body.channel > 512) {
    return json({ error: "A show and channel from 1 to 512 are required." }, 400);
  }
  const label = boundedText(body.label, 200, true);
  const micType = typeof body.micType === "string" && micTypes.has(body.micType) ? body.micType : null;
  const group = typeof body.group === "string" && micGroups.has(body.group) ? body.group : null;
  const micModel = boundedText(body.micModel, 200);
  const notes = boundedText(body.notes, 2_000);
  const mixerConsole = boundedText(body.mixerConsole, 200);
  if (!label || !micType || !group || micModel === null || notes === null || mixerConsole === null) return json({ error: "Audio assignment details are invalid." }, 400);
  const gainDb = body.gainDb === null || body.gainDb === undefined
    ? null
    : typeof body.gainDb === "number" && Number.isFinite(body.gainDb) && body.gainDb >= -200 && body.gainDb <= 200
      ? body.gainDb
      : undefined;
  const mixerChannel = body.mixerChannel === null || body.mixerChannel === undefined
    ? null
    : typeof body.mixerChannel === "number" && Number.isInteger(body.mixerChannel) && body.mixerChannel >= 0 && body.mixerChannel <= 10_000
      ? body.mixerChannel
      : undefined;
  const mixerChannelType = boundedText(body.mixerChannelType, 80);
  if (gainDb === undefined || mixerChannel === undefined || mixerChannelType === null) {
    return json({ error: "Audio gain and mixer channel details are invalid." }, 400);
  }
  const show = await db.prepare("SELECT id, serviceDate FROM rundown WHERE id = ? AND orgId = ?")
    .bind(body.showId, access.orgId).first<{ id: string; serviceDate: string }>();
  if (!show) return json({ error: "Show not found." }, 404);
  const values = [body.channel, label, micType, micModel, notes, gainDb, body.phantom === true, body.muted === true, group, mixerConsole, mixerChannel, mixerChannelType] as const;
  if (assignmentId) {
    const result = await db.prepare(
      `UPDATE mic_assignment SET showId = ?, serviceDate = ?, channel = ?, label = ?, micType = ?, micModel = ?, notes = ?, gainDb = ?, phantom = ?, muted = ?, "group" = ?, mixerConsole = ?, mixerChannel = ?, mixerChannelType = ?, updatedAt = CURRENT_TIMESTAMP
       WHERE id = ? AND orgId = ?`,
    ).bind(show.id, show.serviceDate, ...values, assignmentId, access.orgId).run();
    return changedExactlyOneRow(result) ? json({ ok: true }) : json({ error: "Audio assignment not found." }, 404);
  }
  const id = crypto.randomUUID();
  await db.prepare(
    `INSERT INTO mic_assignment (id, orgId, showId, channel, label, micType, micModel, notes, gainDb, phantom, muted, "group", mixerConsole, mixerChannel, mixerChannelType, serviceDate, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  ).bind(id, access.orgId, show.id, ...values, show.serviceDate).run();
  return json({ ok: true, id });
}

const reportReasons = new Set(["harassment", "hate", "sexual", "violence", "spam", "other"]);

async function mobileContentSafety(request: Request, url: URL, db: MobileApiDatabase): Promise<Response> {
  const access = await authorize(request, url, db);
  if (access instanceof Response) return access;
  const rows = await db.prepare(
    "SELECT blockedUserId FROM content_block WHERE orgId = ? AND blockerUserId = ? ORDER BY createdAt ASC",
  ).bind(access.orgId, access.identity.userId).all<{ blockedUserId: string }>();
  return json({ blockedUserIds: (rows.results ?? []).map((row) => row.blockedUserId) });
}

async function reportMobileContent(request: Request, url: URL, db: MobileApiDatabase): Promise<Response> {
  const access = await authorize(request, url, db);
  if (access instanceof Response) return access;
  const body = await readJson(request);
  const targetType = body?.targetType === "chat-message" || body?.targetType === "incident-comment" ? body.targetType : null;
  const reason = typeof body?.reason === "string" && reportReasons.has(body.reason) ? body.reason : null;
  const details = boundedText(body?.details, 1_000);
  const targetAuthorId = validId(body?.targetAuthorId) ? body.targetAuthorId : null;
  if (!targetType || !validId(body?.targetId) || !reason || details === null) {
    return json({ error: "Choose a reason for this report." }, 400);
  }
  const reportId = crypto.randomUUID();
  await db.prepare(
    `INSERT INTO content_report (id, orgId, reporterUserId, targetType, targetId, targetAuthorId, reason, details, status, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', CURRENT_TIMESTAMP)`,
  ).bind(reportId, access.orgId, access.identity.userId, targetType, body.targetId, targetAuthorId, reason, details).run();

  const reviewers = await db.prepare(
    "SELECT userId FROM member WHERE organizationId = ? AND role IN ('owner', 'admin', 'td', 'cd', 'pd')",
  ).bind(access.orgId).all<{ userId: string }>();
  for (const reviewer of reviewers.results ?? []) {
    if (reviewer.userId === access.identity.userId) continue;
    await db.prepare(
      `INSERT INTO notification (id, orgId, userId, type, severity, title, message, target, source, actionUrl, createdAt, dismissed)
       VALUES (?, ?, ?, 'content-report', 'warning', 'Content report needs review', ?, 'personal', ?, 'team', CURRENT_TIMESTAMP, 0)`,
    ).bind(crypto.randomUUID(), access.orgId, reviewer.userId, `${access.identity.name} reported ${targetType.replace("-", " ")} for ${reason}.`, reportId).run();
  }
  return json({ ok: true, reportId }, 201);
}

async function blockMobileUser(request: Request, url: URL, db: MobileApiDatabase): Promise<Response> {
  const access = await authorize(request, url, db);
  if (access instanceof Response) return access;
  const body = await readJson(request);
  if (!validId(body?.blockedUserId) || body.blockedUserId === access.identity.userId) {
    return json({ error: "Choose another organization member to block." }, 400);
  }
  const member = await db.prepare(
    "SELECT userId FROM member WHERE organizationId = ? AND userId = ? LIMIT 1",
  ).bind(access.orgId, body.blockedUserId).first<{ userId: string }>();
  if (!member) return json({ error: "That person is not in this organization." }, 404);
  await db.prepare(
    `INSERT OR IGNORE INTO content_block (id, orgId, blockerUserId, blockedUserId, createdAt)
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`,
  ).bind(crypto.randomUUID(), access.orgId, access.identity.userId, body.blockedUserId).run();
  return json({ ok: true });
}

export async function handleMobileApi(request: Request, env: MobileApiEnvironment): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/mobile/v1/")) return null;
  if (url.pathname === "/api/mobile/v1/bootstrap" && request.method === "GET") return bootstrap(request, url, env.DB);
  if (url.pathname === "/api/mobile/v1/rundowns" && request.method === "POST") return createRundown(request, env.DB);
  if (url.pathname === "/api/mobile/v1/schedule" && request.method === "GET") return schedule(request, url, env.DB);
  if (url.pathname === "/api/mobile/v1/schedule/respond" && request.method === "POST") return respondToAssignment(request, env.DB);
  if (url.pathname === "/api/mobile/v1/schedule/assignments" && request.method === "POST") return createMobileScheduleAssignment(request, url, env.DB);
  if (url.pathname === "/api/mobile/v1/schedule/inventory" && request.method === "POST") return createMobileShowInventory(request, url, env.DB);
  if (url.pathname === "/api/mobile/v1/schedule/provider" && request.method === "POST") return saveMobileScheduleProvider(request, url, env.DB);
  if (url.pathname === "/api/mobile/v1/incidents/history" && request.method === "GET") return mobileIncidentHistory(request, url, env.DB);
  if (url.pathname === "/api/mobile/v1/incidents" && request.method === "GET") return incidents(request, url, env.DB);
  if (url.pathname === "/api/mobile/v1/incidents" && request.method === "POST") return createIncident(request, url, env.DB);
  if (url.pathname === "/api/mobile/v1/chat/members" && request.method === "GET") return chatMembers(request, url, env.DB);
  if (url.pathname === "/api/mobile/v1/chat/notify" && request.method === "POST") return notifyMobileChatMessage(request, url, env.DB);
  if (url.pathname === "/api/mobile/v1/chat/reaction-notify" && request.method === "POST") return notifyMobileChatReaction(request, url, env.DB);
  if (url.pathname === "/api/mobile/v1/content-safety" && request.method === "GET") return mobileContentSafety(request, url, env.DB);
  if (url.pathname === "/api/mobile/v1/content-safety/report" && request.method === "POST") return reportMobileContent(request, url, env.DB);
  if (url.pathname === "/api/mobile/v1/content-safety/block" && request.method === "POST") return blockMobileUser(request, url, env.DB);
  if (url.pathname === "/api/mobile/v1/chat/passes/crew" && request.method === "POST") return createMobileCrewChatPass(request, url, env);
  if (url.pathname === "/api/mobile/v1/chat/passes/planning" && request.method === "POST") return createMobilePlanningChatPass(request, url, env);
  if (url.pathname === "/api/mobile/v1/checkin" && request.method === "GET") return checkIn(request, url, env.DB);
  if (url.pathname === "/api/mobile/v1/show-board" && request.method === "GET") return showBoard(request, url, env.DB);
  if (url.pathname === "/api/mobile/v1/show-workspace" && request.method === "GET") return showWorkspace(request, url, env.DB);
  if (url.pathname === "/api/mobile/v1/team/members" && request.method === "GET") return teamMembers(request, url, env.DB);
  if (url.pathname === "/api/mobile/v1/team/invitations" && request.method === "POST") return inviteTeamMember(request, url, env.DB);
  if (url.pathname === "/api/mobile/v1/team/crew" && request.method === "GET") return teamCrew(request, url, env.DB);
  if (url.pathname === "/api/mobile/v1/team/crew" && request.method === "POST") return createTeamCrewMember(request, url, env.DB);
  if (url.pathname === "/api/mobile/v1/team/access" && request.method === "GET") return teamAccess(request, url, env.DB);
  if (url.pathname === "/api/mobile/v1/team/access/grants" && request.method === "POST") return grantTeamAccess(request, url, env.DB);
  if (url.pathname === "/api/mobile/v1/devices" && request.method === "GET") return devices(request, url, env);
  if (url.pathname === "/api/mobile/v1/devices" && request.method === "POST") return createMobileDevice(request, url, env);
  if (url.pathname === "/api/mobile/v1/checklist" && request.method === "GET") return checklist(request, url, env.DB);
  if (url.pathname === "/api/mobile/v1/checklist/items" && request.method === "POST") return addChecklistItemMobile(request, url, env.DB);
  if (url.pathname === "/api/mobile/v1/checklist/suggestions" && request.method === "GET") return checklistSuggestions(request, url, env.DB);
  if (url.pathname === "/api/mobile/v1/checklist/suggestions/apply" && request.method === "POST") return applyChecklistSuggestions(request, url, env.DB);
  if (url.pathname === "/api/mobile/v1/notifications/read" && request.method === "POST") return notificationRead(request, env.DB);
  if (url.pathname === "/api/mobile/v1/push-token" && request.method === "POST") return pushToken(request, env.DB);
  if (url.pathname === "/api/mobile/v1/cue-sheets") {
    if (request.method === "GET") return mobileCueSheet(request, url, env.DB);
    if (request.method === "POST") return writeMobileCueSheet(request, url, env.DB);
  }
  if (url.pathname === "/api/mobile/v1/assets") {
    if (request.method === "GET") return mobileAssets(request, url, env.DB);
    if (request.method === "POST") return writeMobileAsset(request, url, env.DB);
  }
  if (url.pathname === "/api/mobile/v1/streaming" && request.method === "GET") return mobileStreaming(request, url, env.DB);
  if (url.pathname === "/api/mobile/v1/streaming/destinations" && request.method === "POST") return writeMobileDestination(request, url, env.DB);
  if (url.pathname === "/api/mobile/v1/graphics") {
    if (request.method === "GET") return mobileGraphics(request, url, env.DB);
    if (request.method === "POST") return writeMobileGraphic(request, url, env.DB);
  }
  if (url.pathname === "/api/mobile/v1/reports" && request.method === "GET") return mobileReports(request, url, env.DB);
  if (url.pathname === "/api/mobile/v1/audio") {
    if (request.method === "GET") return mobileAudio(request, url, env.DB);
    if (request.method === "POST") return writeMobileAudio(request, url, env.DB);
  }
  const mobileDashboardMatch = url.pathname.match(/^\/api\/mobile\/v1\/dashboards\/(pm|tm)$/);
  if (mobileDashboardMatch && request.method === "GET") return mobileDashboard(request, url, env.DB, mobileDashboardMatch[1] as "pm" | "tm");
  const mobileAssetMatch = url.pathname.match(/^\/api\/mobile\/v1\/assets\/([^/]+)$/);
  if (mobileAssetMatch && request.method === "POST") {
    const assetId = decodePathId(mobileAssetMatch[1]);
    return assetId ? writeMobileAsset(request, url, env.DB, assetId) : json({ error: "Asset not found." }, 404);
  }
  const mobileDestinationMatch = url.pathname.match(/^\/api\/mobile\/v1\/streaming\/destinations\/([^/]+)$/);
  if (mobileDestinationMatch && request.method === "POST") {
    const destinationId = decodePathId(mobileDestinationMatch[1]);
    return destinationId ? writeMobileDestination(request, url, env.DB, destinationId) : json({ error: "Destination not found." }, 404);
  }
  const mobileGraphicMatch = url.pathname.match(/^\/api\/mobile\/v1\/graphics\/([^/]+)$/);
  if (mobileGraphicMatch && request.method === "POST") {
    const graphicId = decodePathId(mobileGraphicMatch[1]);
    return graphicId ? writeMobileGraphic(request, url, env.DB, graphicId) : json({ error: "Graphic not found." }, 404);
  }
  const mobileAudioMatch = url.pathname.match(/^\/api\/mobile\/v1\/audio\/([^/]+)$/);
  if (mobileAudioMatch && request.method === "POST") {
    const assignmentId = decodePathId(mobileAudioMatch[1]);
    return assignmentId ? writeMobileAudio(request, url, env.DB, assignmentId) : json({ error: "Audio assignment not found." }, 404);
  }
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
  if (deviceControlMatch && (request.method === "GET" || request.method === "POST")) {
    const deviceId = decodePathId(deviceControlMatch[1]);
    if (!deviceId) return json({ error: "Not found." }, 404);
    return request.method === "GET"
      ? deviceControlState(request, url, deviceId, env)
      : controlDevice(request, url, deviceId, env);
  }
  const deviceWriteMatch = url.pathname.match(/^\/api\/mobile\/v1\/devices\/([^/]+)(?:\/(remove))?$/);
  if (deviceWriteMatch && request.method === "POST") {
    const deviceId = decodePathId(deviceWriteMatch[1]);
    if (!deviceId) return json({ error: "Not found." }, 404);
    return deviceWriteMatch[2] === "remove"
      ? deleteMobileDevice(request, url, deviceId, env)
      : updateMobileDevice(request, url, deviceId, env);
  }
  const scheduleAssignmentMatch = url.pathname.match(/^\/api\/mobile\/v1\/schedule\/assignments\/([^/]+)(?:\/(remove|remind))?$/);
  if (scheduleAssignmentMatch && request.method === "POST") {
    const assignmentId = decodePathId(scheduleAssignmentMatch[1]);
    if (!assignmentId) return json({ error: "Not found." }, 404);
    if (scheduleAssignmentMatch[2] === "remove") return deleteMobileScheduleAssignment(request, url, assignmentId, env.DB);
    if (scheduleAssignmentMatch[2] === "remind") return remindMobileScheduleAssignments(request, url, { assignmentId }, env.DB);
    return updateMobileScheduleAssignment(request, url, assignmentId, env.DB);
  }
  const scheduleInventoryMatch = url.pathname.match(/^\/api\/mobile\/v1\/schedule\/inventory\/([^/]+)\/(archive|restore)$/);
  if (scheduleInventoryMatch && request.method === "POST") {
    const inventoryId = decodePathId(scheduleInventoryMatch[1]);
    if (!inventoryId) return json({ error: "Inventory item not found." }, 404);
    return setMobileShowInventoryArchived(request, url, inventoryId, scheduleInventoryMatch[2] === "archive", env.DB);
  }
  const scheduleServiceMatch = url.pathname.match(/^\/api\/mobile\/v1\/schedule\/services\/([^/]+)(?:\/(remove|remind|copy-team))?$/);
  if (scheduleServiceMatch && request.method === "POST") {
    const showId = decodePathId(scheduleServiceMatch[1]);
    if (!showId) return json({ error: "Not found." }, 404);
    if (scheduleServiceMatch[2] === "remove") return deleteMobileScheduleService(request, url, showId, env.DB);
    if (scheduleServiceMatch[2] === "remind") return remindMobileScheduleAssignments(request, url, { showId }, env.DB);
    if (scheduleServiceMatch[2] === "copy-team") return copyMobileScheduleTeam(request, url, showId, env.DB);
    return updateMobileScheduleService(request, url, showId, env.DB);
  }
  const rundownTemplateActionMatch = url.pathname.match(
    /^\/api\/mobile\/v1\/rundowns\/([^/]+)\/templates\/([^/]+)\/(load|remove)$/,
  );
  if (rundownTemplateActionMatch && request.method === "POST") {
    const showId = decodePathId(rundownTemplateActionMatch[1]);
    const templateId = decodePathId(rundownTemplateActionMatch[2]);
    if (!showId || !templateId) return json({ error: "Not found." }, 404);
    return rundownTemplateActionMatch[3] === "load"
      ? loadMobileRundownTemplate(request, url, showId, templateId, env)
      : deleteMobileRundownTemplate(request, url, showId, templateId, env.DB);
  }
  const rundownPreviousMatch = url.pathname.match(
    /^\/api\/mobile\/v1\/rundowns\/([^/]+)\/previous\/([^/]+)\/load$/,
  );
  if (rundownPreviousMatch && request.method === "POST") {
    const showId = decodePathId(rundownPreviousMatch[1]);
    const sourceShowId = decodePathId(rundownPreviousMatch[2]);
    return showId && sourceShowId
      ? loadMobilePreviousRundown(request, url, showId, sourceShowId, env)
      : json({ error: "Not found." }, 404);
  }
  const rundownTemplatesMatch = url.pathname.match(/^\/api\/mobile\/v1\/rundowns\/([^/]+)\/templates$/);
  if (rundownTemplatesMatch) {
    const showId = decodePathId(rundownTemplatesMatch[1]);
    if (!showId) return json({ error: "Not found." }, 404);
    if (request.method === "GET") return mobileRundownTemplates(request, url, showId, env.DB);
    if (request.method === "POST") return saveMobileRundownTemplate(request, url, showId, env.DB);
  }
  const rundownMetaMatch = url.pathname.match(/^\/api\/mobile\/v1\/rundowns\/([^/]+)\/meta$/);
  if (rundownMetaMatch && request.method === "POST") {
    const showId = decodePathId(rundownMetaMatch[1]);
    return showId
      ? updateMobileRundownMeta(request, url, showId, env)
      : json({ error: "Not found." }, 404);
  }
  const rundownProPresenterMatch = url.pathname.match(/^\/api\/mobile\/v1\/rundowns\/([^/]+)\/propresenter$/);
  if (rundownProPresenterMatch && request.method === "POST") {
    const showId = decodePathId(rundownProPresenterMatch[1]);
    return showId
      ? controlMobileProPresenter(request, url, showId, env)
      : json({ error: "Not found." }, 404);
  }
  const rundownProPresenterStageDisplayMatch = url.pathname.match(
    /^\/api\/mobile\/v1\/rundowns\/([^/]+)\/propresenter\/stage-display$/,
  );
  if (rundownProPresenterStageDisplayMatch && request.method === "POST") {
    const showId = decodePathId(rundownProPresenterStageDisplayMatch[1]);
    return showId
      ? updateMobileProPresenterStageDisplay(request, url, showId, env)
      : json({ error: "Not found." }, 404);
  }
  const rundownMatch = url.pathname.match(/^\/api\/mobile\/v1\/rundowns\/([^/]+)$/);
  if (rundownMatch && request.method === "GET") {
    const showId = decodePathId(rundownMatch[1]);
    return showId ? rundown(request, url, showId, env) : json({ error: "Not found." }, 404);
  }
  return json({ error: "Not found." }, 404);
}
