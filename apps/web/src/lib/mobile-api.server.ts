import { proPresenterOutputCommandSchema } from "@showpilot/shared/propresenter-output";
import { readMemberProPresenterOutput, writeProPresenterOutput, ProPresenterOutputAccessError } from "./propresenter-output.server";
import { notifyProPresenterOutput } from "./propresenter-output-notify.server";
import { listTimecodeShows } from "./timecode-shows.server";
import { idSchema } from "./validation";
import { removeSavedRundown } from "./saved-rundown-delete.server";
import { createSavedRundown } from "./saved-rundown-create.server";
import { markDatabaseWrite } from "./request-database.server";
import { notificationPreferenceCommandSchema } from "./notification-preference-contract";
import { readNotificationPreferences, readPreferenceActor, writeNotificationPreference, NotificationPreferenceError } from "./notification-preferences.server";
import { readAccessActor, retryAccessNotice } from "./access-write.server";
import { grantAccessSchema, revokeAccessSchema } from "./access-write-contract";
import { crewActor, writeCrewProfile } from "./crew-roster.server";
import { crewProfileCommandSchema } from "./crew-roster-contract";
import { teamInvitationSchema, retryInvitationDeliverySchema } from "./team-invitation-contract";
import { listTeamInvitations } from "./team-invitation.server";
import { assertTeamCommandSuccess, TeamCommandError } from "./team-command.server";
import { workspaceCommandSchema } from "./workspace/profile-contract";
import { z } from "zod";
import { CREDENTIAL_MASK, isCredentialField } from "./credential-fields";
import { maskDeviceSettings, readDeviceSettingsForUse, writeDeviceSettings } from "./device-settings.server";
import { readProPresenterSettings } from "./propresenter-settings.server";
import { rundownInternalRequest } from "@/lib/rundown-internal-request.server";
import {
  resolveWorkspaceProfile,
  legacyTerminologyProfile,
} from "@showpilot/shared";
import {
  workspaceD1Store,
  readWorkspaceProfile,
  writeWorkspaceProfile,
} from "./workspace/profile.server";
import {
  EQUIPMENT_CATEGORIES,
  EQUIPMENT_STATUSES,
  isEmojiReaction,
} from "@showpilot/shared";
import { getAuth } from "./auth";
import { getCrewScheduleResponseWindow } from "./crew-schedule-response";
import { getAssignmentCallTime } from "./assignment-call-time";
import { assignmentResponseVersion } from "./assignment-response-version";
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
import {
  resolveRemoteDeviceControl,
  type ResolvedRemoteDeviceControl,
} from "./mobile-device-controls";
import {
  buildHomeAssistantActions,
  parseHomeAssistantEntities,
} from "./device-modules/homeassistant/homeassistant-module";
import { createServiceForOrg } from "./service-creation.server";
import { createShowInputSchema, reviewShowCreationSchema } from "./show-creation-contract";
import { PlanLimitError } from "./plan-limits";
import { isValidServiceDate } from "./validation";
import { issueChatPass, CHAT_PASS_CREATORS, ChatPassCreationError, chatPassCreationMessage } from "./chat-pass-issuance.server";
import { chatPassCommandSchema } from "./chat-pass-creation";
import { MOBILE_REPORT_SUMMARY_SQL } from "./mobile-report-summary";
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
  ChecklistRevisionConflictError,
  setChecklistEntryCategory,
  transitionChecklistEntry,
} from "./checklist-toggle.server";
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
import {
  ACCESS_CAPABILITIES,
} from "./access-capabilities";
import {
  getAccessManagementSnapshotForActor,
  grantMemberAccessForActor,
  revokeMemberAccessForActor,
} from "./access-grants";
import type {
  BridgeDispatchMessage,
  BridgeDispatchResult,
  BridgeRelay,
  BridgeRelayStatus,
} from "../durable-objects/BridgeRelay";
import { rundownRelayKey } from "./rundown-relay-key";
import {
  parseRelayRundownItems,
  type RelayRundownItem,
} from "./rundown-relay-payload";
import { fetchOntimeRuntimeState } from "./ontime-runtime";
import {
  deleteStreamDestinationForOrg,
  setStreamDestinationEnabledForOrg,
} from "./stream-destinations";
import { getLiveInputStatusForOrg } from "./stream";
import { saveStreamDestinationForOrg } from "./stream-destination-write.server";
import { objectionableContentReason } from "./user-content-safety";
import { mobileRundownStatus } from "./rundown-status";
import {
  contentLengthExceeds,
  readRequestJsonWithinLimit,
} from "./request-body.server";
import {
  getPresentedRundownPin,
  resolveRundownAccess,
  rundownPermissionError,
  type RundownAccess,
  rundownPinChallenge,
} from "./rundown-pin.server";
import {
  RundownMetadataConflictError,
  updateRundownMetadataThroughRelay,
} from "./rundown-meta-update.server";

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
  CREDENTIAL_ENCRYPTION_KEYS?: string;
  BETTER_AUTH_SECRET?: string;
  DB: MobileApiDatabase;
  BRIDGE_RELAY?: DurableObjectNamespace<BridgeRelay>;
  RUNDOWN_RELAY?: {
    idFromName(name: string): DurableObjectId;
    get(id: DurableObjectId): { fetch(request: Request): Promise<Response> };
    getByName(name: string): { fetch(request: Request): Promise<Response> };
  };
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
  scheduledCallTime: string | null;
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

interface MobileAssignmentRow {
  id: string;
  revision: string | null;
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
  scheduledCallTime: string | null;
  plannedDurationMs: number;
  responseVersion?: string;
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
  managementRevision: number;
  id: string;
  userId: string;
  organizationId: string;
  role: string;
  createdAt: string;
  userName: string;
  userEmail: string;
  userImage: string | null;
}

interface MobileChatMemberRow {
  userId: string;
  role: string;
  name: string;
  image: string | null;
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

interface MobileChecklistEntryRow {
  id: string;
  templateId: string;
  checked: number | boolean;
  checkedBy: string | null;
  checkedAt: string | null;
  label: string;
  category: string;
  sortOrder: number;
  revision: number;
}

interface MobileChecklistTemplateRow {
  id: string;
  label: string;
}

interface MobileChecklistRundownItemRow extends Omit<
  ChecklistRundownItem,
  "hardStop"
> {
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
  return (
    isRecord(value) &&
    value.success === true &&
    isRecord(value.meta) &&
    value.meta.changes === 1
  );
}

async function readJson(
  request: Request,
): Promise<Record<string, unknown> | null> {
  const result = await readRequestJsonWithinLimit(request, 3_250_000);
  return result.ok && isRecord(result.value) ? result.value : null;
}

function validId(value: unknown): value is string {
  return (
    typeof value === "string" && value.trim().length > 0 && value.length <= 128
  );
}

function validDate(value: unknown): value is string {
  return isValidServiceDate(value);
}

function validAssignableRole(
  value: unknown,
): value is (typeof ASSIGNABLE_ROLES)[number] {
  return (
    typeof value === "string" &&
    (ASSIGNABLE_ROLES as readonly string[]).includes(value)
  );
}

const crewPhotoDataUrlPattern =
  /^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/i;
const maximumCrewPhotoBytes = 1_500_000;

function validCrewPhoto(value: string): boolean {
  if (value === "") return true;
  const match = crewPhotoDataUrlPattern.exec(value);
  if (!match?.[2]) return false;
  const padding = match[2].endsWith("==") ? 2 : match[2].endsWith("=") ? 1 : 0;
  return (
    Math.floor((match[2].length * 3) / 4) - padding <= maximumCrewPhotoBytes
  );
}

function parseCrewMemberWrite(body: Record<string, unknown> | null) {
  const memberId =
    typeof body?.memberId === "string"
      ? body.memberId.trim().toUpperCase()
      : "";
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const role = typeof body?.role === "string" ? body.role.trim() : "";
  const email =
    typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const photoUrl =
    typeof body?.photoUrl === "string" ? body.photoUrl.trim() : "";
  if (
    memberId.length === 0 ||
    memberId.length > 128 ||
    name.length === 0 ||
    name.length > 200 ||
    role.length === 0 ||
    role.length > 100 ||
    email.length > 254 ||
    (email !== "" && !/^\S+@\S+\.\S+$/.test(email)) ||
    photoUrl.length > 2_100_000 ||
    !validCrewPhoto(photoUrl)
  )
    return null;
  return { memberId, name, role, email, photoUrl };
}

function shiftDate(date: string, days: number): string {
  const parsed = new Date(`${date}T12:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

async function resolveOrgId(
  value: string,
  db: MobileApiDatabase,
): Promise<string> {
  const byId = await db
    .prepare("SELECT id FROM organization WHERE id = ?")
    .bind(value)
    .first<{ id: string }>();
  if (byId) return byId.id;
  const bySlug = await db
    .prepare("SELECT id FROM organization WHERE slug = ?")
    .bind(value)
    .first<{ id: string }>();
  return bySlug?.id ?? value;
}

async function getIdentity(
  request: Request,
  orgId: string,
  db: MobileApiDatabase,
): Promise<MobileIdentity | null> {
  try {
    const session = await getAuth().api.getSession({
      headers: request.headers,
    });
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
  return permissions.some((permission) =>
    identity.permissions.includes(permission),
  );
}

async function authorize(
  request: Request,
  url: URL,
  db: MobileApiDatabase,
  permissions?: Permission[],
): Promise<{ orgId: string; identity: MobileIdentity; pinAccess: RundownAccess["pin"] } | Response> {
  const suppliedOrgId = url.searchParams.get("orgId")?.trim();
  if (!validId(suppliedOrgId))
    return json({ error: "A valid orgId is required." }, 400);
  const orgId = await resolveOrgId(suppliedOrgId, db);
  const identity = await getIdentity(request, orgId, db);
  if (!identity) return json({ error: "Unauthorized" }, 401);
  const resolved: RundownAccess = permissions?.some((permission) => permission.startsWith("rundown:"))
    ? await resolveRundownAccess(db, orgId, identity, getPresentedRundownPin(request, orgId))
    : { permissions: identity.permissions, pin: "unprotected" };
  if (permissions?.length) {
    const error = rundownPermissionError(resolved, permissions);
    if (error) return error === "pin_required" ? rundownPinChallenge() : json({ error: "Forbidden" }, 403);
  }
  return { orgId, identity: { ...identity, permissions: resolved.permissions }, pinAccess: resolved.pin };
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
    const playback =
      parsed.playback === "play" || parsed.playback === "pause"
        ? parsed.playback
        : "stop";
    const mode =
      parsed.mode === "count-up" || parsed.mode === "clock"
        ? parsed.mode
        : "count-down";
    return {
      playback,
      currentItemId:
        typeof parsed.currentItemId === "string" ? parsed.currentItemId : null,
      elapsed:
        typeof parsed.elapsed === "number" && Number.isFinite(parsed.elapsed)
          ? parsed.elapsed
          : 0,
      startedAt:
        typeof parsed.startedAt === "number" &&
        Number.isFinite(parsed.startedAt)
          ? parsed.startedAt
          : null,
      pausedAt:
        typeof parsed.pausedAt === "number" && Number.isFinite(parsed.pausedAt)
          ? parsed.pausedAt
          : null,
      mode,
      ...(typeof parsed.serverTime === "number" &&
      Number.isFinite(parsed.serverTime)
        ? { serverTime: parsed.serverTime }
        : {}),
    };
  } catch {
    return fallback();
  }
}

async function timecodeChoices(request: Request, url: URL, env: MobileApiEnvironment): Promise<Response> {
  const kind = url.searchParams.get("kind");
  const access = await authorize(request, url, env.DB, ["timecode:access"]);
  if (access instanceof Response) return access;
  const required = kind === "devices" ? "devices:access" : "songs:access";
  if (!access.identity.permissions.includes(required)) return json({ error: "Forbidden" }, 403);
  const orgId = access.orgId;
  if (kind === "devices") {
    const { readAutomationDeviceChoices } = await import("./automation-device-choices.server");
    return json({ devices: await readAutomationDeviceChoices(env.DB, orgId) });
  }
  if (kind === "songs") {
    const rows = await env.DB.prepare("SELECT id, title, ppPresentationUuid FROM song WHERE orgId=? ORDER BY title,id").bind(orgId)
      .all<{ id: string; title: string; ppPresentationUuid: string | null }>();
    return json({ songs: rows.results ?? [] });
  }
  if (kind === "sections") {
    const songId = idSchema.safeParse(url.searchParams.get("songId"));
    if (!songId.success) return json({ error: "Choose a song." }, 400);
    const song = await env.DB.prepare("SELECT id, title, ppPresentationUuid FROM song WHERE orgId=? AND id=?").bind(orgId, songId.data)
      .first<{ id: string; title: string; ppPresentationUuid: string | null }>();
    if (!song) return json({ error: "Song not found in this workspace." }, 404);
    const sections = await env.DB.prepare("SELECT id, label, lyrics, sourceSlideIndex FROM song_section WHERE orgId=? AND songId=? ORDER BY sortOrder,id")
      .bind(orgId, songId.data).all<{ id: string; label: string; lyrics: string; sourceSlideIndex: number | null }>();
    return json({ ...song, sections: sections.results ?? [] });
  }
  return json({ error: "Choose a supported cue catalog." }, 400);
}

async function timecodeShows(request: Request, url: URL, db: MobileApiDatabase): Promise<Response> {
  const access = await authorize(request, url, db, ["timecode:access"]);
  if (access instanceof Response) return access;
  return json({ shows: await listTimecodeShows(db, access.orgId) });
}

async function bootstrap(
  request: Request,
  url: URL,
  db: MobileApiDatabase,
): Promise<Response> {
  const access = await authorize(request, url, db);
  if (access instanceof Response) return access;
  const { orgId, identity } = access;
  const organization = await db
    .prepare("SELECT id, name, slug FROM organization WHERE id = ? LIMIT 1")
    .bind(orgId)
    .first<{ id: string; name: string; slug: string }>();
  if (!organization) return json({ error: "Organization not found." }, 404);

  const timezone = await db
    .prepare(
      "SELECT value FROM app_setting WHERE orgId = ? AND key = 'org-timezone' LIMIT 1",
    )
    .bind(orgId)
    .first<{ value: string }>();
  const today = getTodayDateString(timezone?.value || "Africa/Accra");
  const [showsResult, notificationsResult, unreadResult, accessAuthority] =
    await Promise.all([
      db
        .prepare(
          `SELECT r.id, r.serviceDate, r.name, r.scheduledStartTime, r.scheduledCallTime, r.location,
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
        )
        .bind(orgId, today)
        .all<MobileRundownRow>(),
      db
        .prepare(
          `SELECT id, type, severity, title, message, actionUrl, source, createdAt, readAt
       FROM notification
       WHERE orgId = ? AND userId = ? AND dismissed = 0
       ORDER BY julianday(createdAt) DESC, id DESC
       LIMIT 51`,
        )
        .bind(orgId, identity.userId)
        .all<MobileNotificationRow>(),
      db
        .prepare(
          `SELECT CAST(COUNT(*) AS INTEGER) AS count
       FROM notification
       WHERE orgId = ? AND userId = ? AND dismissed = 0 AND readAt IS NULL`,
        )
        .bind(orgId, identity.userId)
        .first<{ count: number }>(),
      resolveAccessGrantAuthorityForAccess(
        db,
        identity.userId,
        orgId,
        identity,
        today,
      ),
    ]);
  const rawNotifications = notificationsResult.results ?? [];
  const notifications = rawNotifications.slice(0, 50);
  const lastNotification = notifications.at(-1);
  return json({
    workspace: await readWorkspaceProfile(workspaceD1Store(db, orgId)),
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
    notificationNextCursor:
      rawNotifications.length > 50 && lastNotification
        ? { createdAt: lastNotification.createdAt, id: lastNotification.id }
        : null,
    unreadNotifications: unreadResult?.count ?? 0,
    accessAuthority,
  });
}

async function rundown(
  request: Request,
  url: URL,
  showId: string,
  env: MobileApiEnvironment,
): Promise<Response> {
  const db = env.DB;
  if (!validId(showId))
    return json({ error: "A valid showId is required." }, 400);
  const access = await authorize(request, url, db, [
    "rundown:view",
    "rundown:edit",
    "rundown:control",
  ]);
  if (access instanceof Response) return access;
  const { orgId, identity } = access;
  const show = await db
    .prepare(
      `SELECT id, serviceDate, name, scheduledStartTime, scheduledCallTime, location, status, updatedAt
     FROM rundown WHERE id = ? AND orgId = ? LIMIT 1`,
    )
    .bind(showId, orgId)
    .first<Omit<MobileRundownRow, "itemCount"> & { updatedAt: string }>();
  if (!show) return json({ error: "Show not found." }, 404);

  const [
    itemsResult,
    showTimerSetting,
    dateTimerSetting,
    legacyOwner,
    timezone,
    proPresenter,
    bridge,
  ] = await Promise.all([
    db
      .prepare(
        `SELECT itemId, title, type, duration, notes, assignee, cue, status,
              sortOrder, hardStop, lowerThirdId, scheduledStart, expectedEnd, actualStart, actualEnd
       FROM rundown_item WHERE orgId = ? AND showId = ?
       ORDER BY sortOrder ASC, createdAt ASC`,
      )
      .bind(orgId, showId)
      .all<MobileRundownItemRow>(),
    db
      .prepare(
        "SELECT value FROM app_setting WHERE orgId = ? AND key = ? LIMIT 1",
      )
      .bind(orgId, `rundown-timer:${showId}`)
      .first<{ value: string }>(),
    db
      .prepare(
        "SELECT value FROM app_setting WHERE orgId = ? AND key = ? LIMIT 1",
      )
      .bind(orgId, `rundown-timer:${show.serviceDate}`)
      .first<{ value: string }>(),
    db
      .prepare(
        `SELECT id FROM rundown WHERE orgId = ? AND serviceDate = ?
       ORDER BY scheduledStartTime ASC, createdAt ASC LIMIT 1`,
      )
      .bind(orgId, show.serviceDate)
      .first<{ id: string }>(),
    db
      .prepare(
        "SELECT value FROM app_setting WHERE orgId = ? AND key = 'org-timezone' LIMIT 1",
      )
      .bind(orgId)
      .first<{ value: string }>(),
    readProPresenterSettings(db, orgId, env.CREDENTIAL_ENCRYPTION_KEYS),
    mobileBridgeStatus(env, orgId),
  ]);
  const proPresenterTarget = bridge.connectedTargets.find((target) =>
    target.startsWith("propresenter:"),
  );
  return json({
    show,
    timeZone: timezone?.value || "Africa/Accra",
    canCreateShows: identity.permissions.includes("schedule:manage"),
    pinAccess: access.pinAccess,
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
    timer: parseTimer(
      showTimerSetting?.value ??
        (legacyOwner?.id === showId ? dateTimerSetting?.value : null),
    ),
  });
}

async function controlMobileProPresenter(
  request: Request, url: URL, showId: string, env: MobileApiEnvironment,
  mode: "prepare" | "execute" | "check",
): Promise<Response> {
  const access = await authorize(request, url, env.DB, ["rundown:control"]);
  if (access instanceof Response) return access;
  const { proPresenterCommandSchema } = await import("@showpilot/shared/propresenter-command");
  const parsed = proPresenterCommandSchema.safeParse(await readJson(request));
  if (!parsed.success) return json({ error: "Update the app and review the original slide command." }, 400);
  const command = parsed.data;
  if (command.orgId !== access.orgId || command.userId !== access.identity.userId || command.showId !== showId)
    return json({ error: "Your account or show changed. Return to the original slide command." }, 403);
  const session = await getAuth().api.getSession({ headers: request.headers, query: { disableCookieCache: true } });
  if (!session || session.user.id !== command.userId) return json({ error: "Sign in again before controlling slides." }, 401);
  if (!env.BRIDGE_RELAY) return json({ error: "Slide control is unavailable." }, 503);
  try {
    return json(await env.BRIDGE_RELAY.get(env.BRIDGE_RELAY.idFromName(command.orgId)).recoverProPresenterCommand(command, {
      orgId: command.orgId, userId: command.userId, sessionId: session.session.id,
      rundownPin: getPresentedRundownPin(request, command.orgId),
    }, mode));
  } catch {
    return json({ error: "The slide command could not be confirmed. Check your access and the original command status before sending another." }, 503);
  }
}

async function mobileProPresenterOutput(
  request: Request,
  url: URL,
  env: MobileApiEnvironment,
): Promise<Response> {
  // The shared output authority checks live permission and the PIN once, then
  // guards that exact authority in the committing transaction. Hashing the PIN
  // here as well can consume the command's validity window before it is stored.
  const access = await authorize(request, url, env.DB);
  if (access instanceof Response) return access;
  const session = await getAuth().api.getSession({ headers: request.headers, query: { disableCookieCache: true } });
  if (!session || session.user.id !== access.identity.userId) return json({ error: "Sign in again before changing output." }, 401);
  const actor = { orgId: access.orgId, userId: session.user.id, sessionId: session.session.id, rundownPin: getPresentedRundownPin(request, access.orgId) };
  const parsed = request.method === "POST" ? proPresenterOutputCommandSchema.safeParse(await readJson(request)) : null;
  if (parsed && !parsed.success) return json({ error: "Update the app and review the original output change." }, 400);
  if (parsed?.success && (parsed.data.orgId !== actor.orgId || parsed.data.userId !== actor.userId)) return json({ error: "Return to the account and workspace that started this output change." }, 403);
  try {
    if (!parsed?.success) return json(await readMemberProPresenterOutput(env.DB, actor));
    const result = await writeProPresenterOutput(env.DB, parsed.data, actor);
    if (result.outcome === "applied" || result.outcome === "superseded") await notifyProPresenterOutput(env, actor.orgId);
    return json(result);
  } catch (error) {
    if (error instanceof ProPresenterOutputAccessError)
      return error.code === "pin_required" ? rundownPinChallenge() : json({ error: "Forbidden" }, 403);
    return json({ error: "Output state could not be confirmed. Check your access and retry the original request." }, 503);
  }
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

function parseMobileRundownTemplate(
  value: string,
): MobileRundownTemplate | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) return null;
    const items = parseRelayRundownItems(parsed.items);
    if (
      !validId(parsed.id) ||
      typeof parsed.name !== "string" ||
      parsed.name.length > 200 ||
      typeof parsed.serviceName !== "string" ||
      parsed.serviceName.length > 120 ||
      typeof parsed.scheduledStartTime !== "string" ||
      !/^$|^([01]\d|2[0-3]):[0-5]\d$/.test(parsed.scheduledStartTime) ||
      typeof parsed.createdAt !== "string" ||
      typeof parsed.updatedAt !== "string" ||
      !items
    )
      return null;
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

async function readMobileRundownTemplates(
  db: MobileApiDatabase,
  orgId: string,
) {
  const result = await db
    .prepare(
      "SELECT value FROM app_setting WHERE orgId = ? AND key LIKE 'rundown-saved:%'",
    )
    .bind(orgId)
    .all<{ value: string }>();
  return (result.results ?? [])
    .map((row) => parseMobileRundownTemplate(row.value))
    .filter((template): template is MobileRundownTemplate => template !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function mobileRundownTemplates(
  request: Request,
  url: URL,
  showId: string,
  db: MobileApiDatabase,
): Promise<Response> {
  const access = await authorize(request, url, db, ["rundown:edit"]);
  if (access instanceof Response) return access;
  const show = await db
    .prepare("SELECT id FROM rundown WHERE id = ? AND orgId = ? LIMIT 1")
    .bind(showId, access.orgId)
    .first<{ id: string }>();
  if (!show) return json({ error: "Show not found." }, 404);
  const [templates, previousResult] = await Promise.all([
    readMobileRundownTemplates(db, access.orgId),
    db
      .prepare(
        `SELECT r.id, r.serviceDate, r.name, r.scheduledStartTime, r.location,
              CAST(COUNT(i.id) AS INTEGER) AS itemCount
         FROM rundown r
         LEFT JOIN rundown_item i ON i.orgId = r.orgId AND i.showId = r.id
        WHERE r.orgId = ? AND r.id <> ?
        GROUP BY r.id
        ORDER BY r.serviceDate DESC, r.scheduledStartTime DESC, r.createdAt DESC
        LIMIT 50`,
      )
      .bind(access.orgId, showId)
      .all<{
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

async function recoverMobileTemplateSave(request: Request, url: URL, showId: string, env: MobileApiEnvironment, review: boolean) {
  const access = await authorize(request, url, env.DB, ["rundown:edit"]);
  if (access instanceof Response) return access;
  const { templateSaveCommandSchema } = await import("./template-save-contract");
  const parsed = templateSaveCommandSchema.safeParse(await readJson(request));
  if (!parsed.success) return json({ error: "Check the template name and reviewed rundown items." }, 400);
  const command = parsed.data;
  if (command.orgId !== access.orgId || command.userId !== access.identity.userId || command.showId !== showId)
    return json({ error: "Your account or show changed. Reopen the template draft." }, 403);
  const session = await getAuth().api.getSession({ headers: request.headers, query: { disableCookieCache: true } });
  if (!session || session.user.id !== command.userId) return json({ error: "Sign in again before reviewing the template save." }, 401);
  const { writeTemplateSave, TemplateSaveRequestError } = await import("./template-save-write.server");
  const { RundownDetailsAccessError } = await import("./rundown-details-authority.server");
  // The supplied production database is D1; use its complete typed binding for
  // this transactional writer just as the other retained native writers do.
  const { getD1 } = await import("./d1");
  try {
    markDatabaseWrite();
    return json(await writeTemplateSave(getD1(), command, { sessionId: session.session.id, pin: getPresentedRundownPin(request, access.orgId) }, review ? "review" : "save"));
  } catch (error) {
    if (error instanceof TemplateSaveRequestError || error instanceof RundownDetailsAccessError)
      return json({ error: error.message }, 409);
    throw error;
  }
}

async function saveMobileRundownTemplate(
  request: Request,
  url: URL,
  showId: string,
  db: MobileApiDatabase,
): Promise<Response> {
  const body = await readJson(request);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const requestId =
    typeof body?.requestId === "string" ? body.requestId.trim() : "";
  if (
    !validId(requestId) ||
    requestId.length > 100 ||
    !name ||
    name.length > 200
  ) {
    return json(
      { error: "A template name and valid requestId are required." },
      400,
    );
  }
  const access = await authorize(request, url, db, ["rundown:edit"]);
  if (access instanceof Response) return access;
  const show = await db
    .prepare(
      `SELECT id, serviceDate, name, scheduledStartTime
       FROM rundown WHERE id = ? AND orgId = ? LIMIT 1`,
    )
    .bind(showId, access.orgId)
    .first<{
      id: string;
      serviceDate: string;
      name: string;
      scheduledStartTime: string | null;
    }>();
  if (!show) return json({ error: "Show not found." }, 404);
  const existing = await db
    .prepare(
      "SELECT value FROM app_setting WHERE orgId = ? AND key = ? LIMIT 1",
    )
    .bind(access.orgId, `rundown-saved:${requestId}`)
    .first<{ value: string }>();

  const [itemsResult, timezone] = await Promise.all([
    db
      .prepare(
        `SELECT itemId, title, type, duration, notes, assignee, cue, status,
              sortOrder, hardStop, lowerThirdId, scheduledStart, expectedEnd,
              actualStart, actualEnd
         FROM rundown_item WHERE orgId = ? AND showId = ?
        ORDER BY sortOrder ASC, createdAt ASC`,
      )
      .bind(access.orgId, showId)
      .all<MobileRundownItemRow>(),
    db
      .prepare(
        "SELECT value FROM app_setting WHERE orgId = ? AND key = 'org-timezone' LIMIT 1",
      )
      .bind(access.orgId)
      .first<{ value: string }>(),
  ]);
  const items = parseRelayRundownItems(
    (itemsResult.results ?? []).map((item, index) => ({
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
    })),
  );
  if (!items)
    return json(
      { error: "The current rundown cannot be saved as a template." },
      400,
    );

  // Use the same immutable receipt as web saves. An ID alone is not proof that
  // the current contents were accepted, and deletion must survive a late retry.
  const result = await createSavedRundown(db, access.orgId, {
    id: requestId,
    name,
    serviceName: show.name,
    scheduledStartTime: formatTimeInput(show.scheduledStartTime, timezone?.value || "Africa/Accra"),
    items,
  });
  markDatabaseWrite();
  if (!result.ok) return json({ error: result.reason === "removed"
    ? "This template was saved and then removed. Review saved templates before starting another save."
    : "This request already belongs to different template contents. Review saved templates before starting another save." }, 409);
  return json({ ok: true, id: result.id, created: !existing }, existing ? 200 : 201);
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
  return relay.fetch(
    rundownInternalRequest(relayUrl, input.env.BETTER_AUTH_SECRET, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: input.action,
        id: input.requestId,
        expectedRevision: input.expectedRevision,
        payload: input.payload,
      }),
    }),
  );
}

async function loadMobileRundownTemplate(
  request: Request,
  url: URL,
  showId: string,
  templateId: string,
  env: MobileApiEnvironment,
): Promise<Response> {
  const body = await readJson(request);
  const requestId =
    typeof body?.requestId === "string" ? body.requestId.trim() : "";
  const expectedRevision = body?.expectedRevision;
  if (
    !validId(requestId) ||
    requestId.length > 100 ||
    typeof expectedRevision !== "number" ||
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 0
  )
    return json(
      { error: "A valid requestId and live revision are required." },
      400,
    );
  const access = await authorize(request, url, env.DB, ["rundown:edit"]);
  if (access instanceof Response) return access;
  const show = await env.DB.prepare(
    `SELECT id, serviceDate FROM rundown WHERE id = ? AND orgId = ? LIMIT 1`,
  )
    .bind(showId, access.orgId)
    .first<{ id: string; serviceDate: string }>();
  if (!show) return json({ error: "Show not found." }, 404);
  const setting = await env.DB.prepare(
    "SELECT value FROM app_setting WHERE orgId = ? AND key = ? LIMIT 1",
  )
    .bind(access.orgId, `rundown-saved:${templateId}`)
    .first<{ value: string }>();
  const template = setting ? parseMobileRundownTemplate(setting.value) : null;
  if (!template || template.id !== templateId)
    return json({ error: "Template not found." }, 404);
  const timezone = await env.DB.prepare(
    "SELECT value FROM app_setting WHERE orgId = ? AND key = 'org-timezone' LIMIT 1",
  )
    .bind(access.orgId)
    .first<{ value: string }>();
  const freshItems = parseRelayRundownItems(
    template.items.map((item, index) => ({
      ...item,
      id: `${requestId}-item-${index}`,
      status: "upcoming",
      sortOrder: index,
      actualStart: null,
      actualEnd: null,
    })),
  );
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
  if (!relayResponse)
    return json(
      { error: "Live rundown editing is temporarily unavailable." },
      503,
    );
  const relayBody: unknown = await relayResponse.json();
  if (relayResponse.status === 409) {
    return json(
      {
        error: "Another operator changed the rundown first.",
        conflict: relayBody,
      },
      409,
    );
  }
  if (!relayResponse.ok)
    return json({ error: "The template was not accepted by live sync." }, 502);
  return json({
    ok: true,
    revision:
      isRecord(relayBody) && typeof relayBody.revision === "number"
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
  const requestId =
    typeof body?.requestId === "string" ? body.requestId.trim() : "";
  const expectedRevision = body?.expectedRevision;
  if (
    showId === sourceShowId ||
    !validId(requestId) ||
    requestId.length > 100 ||
    typeof expectedRevision !== "number" ||
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 0
  )
    return json(
      { error: "Choose a different previous show and current live revision." },
      400,
    );
  const access = await authorize(request, url, env.DB, ["rundown:edit"]);
  if (access instanceof Response) return access;
  const [target, source, timezone] = await Promise.all([
    env.DB.prepare(
      "SELECT id, serviceDate FROM rundown WHERE id = ? AND orgId = ? LIMIT 1",
    )
      .bind(showId, access.orgId)
      .first<{ id: string; serviceDate: string }>(),
    env.DB.prepare(
      `SELECT id, serviceDate, name, scheduledStartTime, location
         FROM rundown WHERE id = ? AND orgId = ? LIMIT 1`,
    )
      .bind(sourceShowId, access.orgId)
      .first<{
        id: string;
        serviceDate: string;
        name: string;
        scheduledStartTime: string | null;
        location: string;
      }>(),
    env.DB.prepare(
      "SELECT value FROM app_setting WHERE orgId = ? AND key = 'org-timezone' LIMIT 1",
    )
      .bind(access.orgId)
      .first<{ value: string }>(),
  ]);
  if (!target || !source)
    return json({ error: "Previous show not found." }, 404);
  const itemsResult = await env.DB.prepare(
    `SELECT itemId, title, type, duration, notes, assignee, cue, status,
            sortOrder, hardStop, lowerThirdId, scheduledStart, expectedEnd,
            actualStart, actualEnd
       FROM rundown_item WHERE orgId = ? AND showId = ?
      ORDER BY sortOrder ASC, createdAt ASC`,
  )
    .bind(access.orgId, source.id)
    .all<MobileRundownItemRow>();
  const freshItems = parseRelayRundownItems(
    (itemsResult.results ?? []).map((item, index) => ({
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
    })),
  );
  if (!freshItems)
    return json({ error: "The previous rundown is invalid." }, 400);
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
      scheduledStartTime: serviceTimeToIso(
        target.serviceDate,
        sourceStartTime,
        timeZone,
      ),
      location: source.location,
    },
  });
  if (!relayResponse)
    return json(
      { error: "Live rundown editing is temporarily unavailable." },
      503,
    );
  const relayBody: unknown = await relayResponse.json();
  if (relayResponse.status === 409) {
    return json(
      {
        error: "Another operator changed the rundown first.",
        conflict: relayBody,
      },
      409,
    );
  }
  if (!relayResponse.ok)
    return json(
      { error: "The previous rundown was not accepted by live sync." },
      502,
    );
  return json({
    ok: true,
    revision:
      isRecord(relayBody) && typeof relayBody.revision === "number"
        ? relayBody.revision
        : expectedRevision,
    serviceName: source.name,
    scheduledStartTime: sourceStartTime,
    itemCount: freshItems.length,
  });
}

async function changeMobileRundown(
  request: Request,
  url: URL,
  showId: string,
  env: MobileApiEnvironment,
  mode: "edit" | "reset" | "stage",
) {
  const access = await authorize(request, url, env.DB, mode === "stage" ? ["rundown:edit", "rundown:control"] : [mode === "reset" ? "rundown:control" : "rundown:edit"]);
  if (access instanceof Response) return access;
  const { rundownChangeCommandSchema } =
    await import("../../../mobile/src/lib/rundown-change-recovery");
  const parsed = rundownChangeCommandSchema.safeParse(await readJson(request));
  if (!parsed.success)
    return json(
      { error: "Review the original rundown action and its revision." },
      400,
    );
  const command = parsed.data;
  const actionMode = command.action === "reset" ? "reset" : command.action === "stage-message" || command.action === "stage-clear" ? "stage" : "edit";
  if (mode !== actionMode)
    return json({ error: "Use the original rundown action endpoint." }, 400);
  if (
    command.orgId !== access.orgId ||
    command.userId !== access.identity.userId ||
    command.showId !== showId
  )
    return json(
      {
        error:
          "Your account or show changed. Reopen the original rundown action.",
      },
      403,
    );
  const session = await getAuth().api.getSession({
    headers: request.headers,
    query: { disableCookieCache: true },
  });
  if (!session || session.user.id !== command.userId)
    return json({ error: "Sign in again before changing this rundown." }, 401);
  if (!env.RUNDOWN_RELAY)
    return json({ error: "Live rundown editing is unavailable." }, 503);
  const { getD1 } = await import("./d1");
  const { applyMobileRundownChange } =
    await import("./mobile-rundown-change.server");
  markDatabaseWrite();
  try {
    return json(
      await applyMobileRundownChange(
        { DB: getD1(), RUNDOWN_RELAY: env.RUNDOWN_RELAY },
        command,
        {
          userId: session.user.id,
          sessionId: session.session.id,
          pin: getPresentedRundownPin(request, command.orgId),
          stageAccess: access.identity.permissions.includes("rundown:edit") ? "edit" : "control",
        },
      ),
    );
  } catch {
    return json(
      {
        error:
          "The rundown action could not be confirmed. Check your rundown access and retry the original request.",
      },
      503,
    );
  }
}

async function recoverMobileRundownDetails(
  request: Request, url: URL, showId: string, env: MobileApiEnvironment,
  mode: "read" | "save" | "review",
): Promise<Response> {
  const access = await authorize(request, url, env.DB, ["rundown:edit"]);
  if (access instanceof Response) return access;
  const { rundownDetailsCommandSchema, rundownDetailsReadSchema } = await import("./rundown-details-contract");
  const parsed = mode === "read"
    ? rundownDetailsReadSchema.safeParse({ orgId: url.searchParams.get("orgId"), userId: url.searchParams.get("userId"), showId })
    : rundownDetailsCommandSchema.safeParse(await readJson(request));
  if (!parsed.success) return json({ error: "Check the original rundown details and reviewed revision." }, 400);
  const data = parsed.data;
  if (data.orgId !== access.orgId || data.userId !== access.identity.userId || data.showId !== showId)
    return json({ error: "Your account or rundown selection changed. Reopen the editor." }, 403);
  const session = await getAuth().api.getSession({ headers: request.headers, query: { disableCookieCache: true } });
  if (!session || session.user.id !== data.userId) return json({ error: "Sign in again before editing this rundown." }, 401);
  if (!env.RUNDOWN_RELAY || !env.BETTER_AUTH_SECRET) return json({ error: "Live rundown editing is temporarily unavailable." }, 503);
  const relay = env.RUNDOWN_RELAY.get(env.RUNDOWN_RELAY.idFromName(rundownRelayKey(data.orgId, "", "", showId)));
  if (mode !== "read") markDatabaseWrite();
  return relay.fetch(new Request(`https://rundown.internal/internal/rundown-details?orgId=${encodeURIComponent(data.orgId)}`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-showpilot-internal-secret": env.BETTER_AUTH_SECRET },
    body: JSON.stringify({ mode, ...(mode === "read" ? { scope: data } : { command: data }), sessionId: session.session.id,
      pin: getPresentedRundownPin(request, data.orgId) }),
  }));
}

async function recoverMobileRundownReplacement(request: Request,url: URL,showId: string,env: MobileApiEnvironment,mode: "read"|"save"|"review") {
  const access=await authorize(request,url,env.DB,["rundown:edit"]);
  if(access instanceof Response) return access;
  const {replacementReadSchema,replacementCommandSchema}=await import("./rundown-replacement-contract");
  const parsed=mode === "read" ? replacementReadSchema.safeParse({orgId:url.searchParams.get("orgId"),userId:url.searchParams.get("userId"),showId,
    source:{kind:url.searchParams.get("sourceKind"),id:url.searchParams.get("sourceId")}}) : replacementCommandSchema.safeParse(await readJson(request));
  if(!parsed.success) return json({error:"Check the original reviewed rundown replacement."},400);
  const data=parsed.data;
  if(data.orgId !== access.orgId || data.userId !== access.identity.userId || data.showId !== showId)
    return json({error:"Your account or show changed. Reopen the original replacement."},403);
  const session=await getAuth().api.getSession({headers:request.headers,query:{disableCookieCache:true}});
  if(!session || session.user.id !== data.userId) return json({error:"Sign in again before reviewing this replacement."},401);
  if(!env.RUNDOWN_RELAY || !env.BETTER_AUTH_SECRET) return json({error:"Live rundown editing is temporarily unavailable."},503);
  const relay=env.RUNDOWN_RELAY.get(env.RUNDOWN_RELAY.idFromName(rundownRelayKey(data.orgId,"","",showId)));
  if(mode !== "read") markDatabaseWrite();
  return relay.fetch(new Request(`https://rundown.internal/internal/rundown-replacement?orgId=${encodeURIComponent(data.orgId)}`,{
    method:"POST",headers:{"Content-Type":"application/json","x-showpilot-internal-secret":env.BETTER_AUTH_SECRET},
    body:JSON.stringify({mode,...(mode === "read" ? {scope:data}:{command:data}),sessionId:session.session.id,pin:getPresentedRundownPin(request,data.orgId)}),
  }));
}

async function updateMobileRundownMeta(
  request: Request,
  url: URL,
  showId: string,
  env: MobileApiEnvironment,
): Promise<Response> {
  const body = await readJson(request);
  const requestId =
    typeof body?.requestId === "string" ? body.requestId.trim() : "";
  const expectedRevision = body?.expectedRevision;
  const name = typeof body?.name === "string" ? body.name.trim() : null;
  const location =
    typeof body?.location === "string" ? body.location.trim() : null;
  const startTime =
    typeof body?.startTime === "string" ? body.startTime.trim() : null;
  const callTime =
    typeof body?.callTime === "string" ? body.callTime.trim() : undefined;
  if (
    !validId(requestId) ||
    requestId.length > 100 ||
    typeof expectedRevision !== "number" ||
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 0 ||
    name === null ||
    name.length > 120 ||
    location === null ||
    location.length > 240 ||
    startTime === null ||
    !/^$|^([01]\d|2[0-3]):[0-5]\d$/.test(startTime) ||
    (callTime !== undefined && !/^$|^([01]\d|2[0-3]):[0-5]\d$/.test(callTime))
  )
    return json(
      { error: "Check the show title, start time, and location." },
      400,
    );
  const access = await authorize(request, url, env.DB, ["rundown:edit"]);
  if (access instanceof Response) return access;
  const show = await env.DB.prepare(
    "SELECT id, serviceDate FROM rundown WHERE id = ? AND orgId = ? LIMIT 1",
  )
    .bind(showId, access.orgId)
    .first<{ id: string; serviceDate: string }>();
  if (!show) return json({ error: "Show not found." }, 404);
  const timezone = await env.DB.prepare(
    "SELECT value FROM app_setting WHERE orgId = ? AND key = 'org-timezone' LIMIT 1",
  )
    .bind(access.orgId)
    .first<{ value: string }>();
  const timeZone = timezone?.value || "Africa/Accra";
  const scheduledStartTime = serviceTimeToIso(
    show.serviceDate,
    startTime,
    timeZone,
  );
  const scheduledCallTime =
    callTime === undefined
      ? undefined
      : serviceTimeToIso(show.serviceDate, callTime, timeZone);
  const relayResponse = await postMobileRundownRelayCommand({
    env,
    orgId: access.orgId,
    showId: show.id,
    serviceDate: show.serviceDate,
    timeZone,
    requestId,
    expectedRevision,
    action: "update-meta",
    payload: {
      serviceName: name,
      scheduledStartTime,
      ...(scheduledCallTime !== undefined ? { scheduledCallTime } : {}),
      location,
    },
  });
  if (!relayResponse)
    return json(
      { error: "Live rundown editing is temporarily unavailable." },
      503,
    );
  const relayBody: unknown = await relayResponse.json();
  if (relayResponse.status === 409) {
    return json(
      {
        error: "Another operator changed the show details first.",
        conflict: relayBody,
      },
      409,
    );
  }
  if (!relayResponse.ok)
    return json(
      { error: "The show details were not accepted by live sync." },
      502,
    );
  return json({
    ok: true,
    revision:
      isRecord(relayBody) && typeof relayBody.revision === "number"
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
  const access = await authorize(request, url, db, ["rundown:edit"]);
  if (access instanceof Response) return access;
  const show = await db
    .prepare("SELECT id FROM rundown WHERE id = ? AND orgId = ? LIMIT 1")
    .bind(showId, access.orgId)
    .first<{ id: string }>();
  if (!show) return json({ error: "Show not found." }, 404);
  const body = z.union([
    z.object({ userId: idSchema, requestId: idSchema }).strict(),
    z.object({}).strict(), // Installed clients send an empty body.
  ]).safeParse(await readJson(request));
  if (!body.success) return json({ error: "Check the original template deletion request." }, 400);
  if ("userId" in body.data && body.data.userId !== access.identity.userId)
    return json({ error: "Your account changed. Reopen the original template deletion." }, 403);
  const session = await getAuth().api.getSession({ headers: request.headers, query: { disableCookieCache: true } });
  if (!session || session.user.id !== access.identity.userId) return json({ error: "Sign in again before deleting this template." }, 401);
  const { getD1 } = await import("./d1");
  const { RundownDetailsAccessError } = await import("./rundown-details-authority.server");
  try {
    await removeSavedRundown(getD1(), access.orgId, templateId, {
      userId: session.user.id, sessionId: session.session.id, pin: getPresentedRundownPin(request, access.orgId),
    });
  } catch (error) {
    if (error instanceof RundownDetailsAccessError) return json({ error: error.message }, 403);
    throw error;
  }
  markDatabaseWrite();
  return json({ ok: true, ...("requestId" in body.data ? { orgId: access.orgId, userId: session.user.id, showId, templateId, requestId: body.data.requestId } : {}) });
}

/** Retained native creation uses the same durable receipt and cancellation fence
 * as the web form. Legacy installed clients retain their existing response. */
async function recoverMobileShowCreation(request: Request, db: MobileApiDatabase, review: boolean): Promise<Response> {
  const parsed = reviewShowCreationSchema.safeParse(await readJson(request));
  if (!parsed.success || Boolean(parsed.data.copyFrom) !== Boolean(parsed.data.copyFromShowId))
    return json({ error: "Check the show details and choose one valid rundown source." }, 400);
  const input = parsed.data;
  const url = new URL(request.url);
  url.searchParams.set("orgId", input.orgId);
  const access = await authorize(request, url, db, ["schedule:manage"]);
  if (access instanceof Response) return access;
  if (input.userId !== access.identity.userId)
    return json({ error: "Your account changed. Reopen the show form." }, 403);
  try {
    const result = review
      ? await (await import("./show-creation-review.server")).reviewShowCreationRequest(request.headers, input)
      : { kind: "created" as const, result: await createServiceForOrg(input, request.headers) };
    return json({ orgId: input.orgId, userId: input.userId, requestId: input.requestId, result }, review ? 200 : 201);
  } catch (error) {
    if (error instanceof PlanLimitError) return json({ error: error.message }, error.status);
    throw error;
  }
}

async function createRundown(
  request: Request,
  db: MobileApiDatabase,
): Promise<Response> {
  const body = await readJson(request);
  if (!body) return json({ error: "Choose a valid workspace and date." }, 400);
  const optional = (value: unknown) => value === "" ? undefined : typeof value === "string" ? value.trim() : value;
  const parsed = createShowInputSchema.safeParse({
    ...body,
    name: body.name === undefined ? "" : body.name,
    location: body.location === undefined ? "" : body.location,
    startTime: optional(body.startTime),
    callTime: optional(body.callTime),
    inventoryId: optional(body.inventoryId),
    copyFrom: optional(body.copyFrom),
    copyFromShowId: optional(body.copyFromShowId),
  });
  if (!parsed.success || Boolean(parsed.data.copyFrom) !== Boolean(parsed.data.copyFromShowId)) {
    return json({ error: "Check the show details and choose one valid rundown source." }, 400);
  }

  const url = new URL(request.url);
  url.searchParams.set("orgId", parsed.data.orgId);
  const access = await authorize(request, url, db, ["schedule:manage"]);
  if (access instanceof Response) return access;

  try {
    const result = await createServiceForOrg({ ...parsed.data, orgId: access.orgId }, request.headers);
    return json(result, 201);
  } catch (error) {
    if (error instanceof PlanLimitError)
      return json({ error: error.message }, error.status);
    throw error;
  }
}

function validChecklistCategory(value: unknown): value is DepartmentKey {
  return (
    typeof value === "string" &&
    DEPARTMENT_ORDER.some((category) => category === value)
  );
}

async function getChecklistShow(
  orgId: string,
  showId: string,
  db: MobileApiDatabase,
) {
  return db
    .prepare(
      `SELECT id, serviceDate, name, scheduledStartTime, location, status
     FROM rundown WHERE id = ? AND orgId = ? LIMIT 1`,
    )
    .bind(showId, orgId)
    .first<Omit<MobileRundownRow, "itemCount">>();
}

async function buildMobileChecklistDraft(
  orgId: string,
  showId: string,
  db: MobileApiDatabase,
) {
  const show = await getChecklistShow(orgId, showId, db);
  if (!show) return null;
  const [templatesResult, entriesResult, itemsResult] = await Promise.all([
    db
      .prepare(
        `SELECT id, label FROM checklist_template
       WHERE orgId = ? ORDER BY sortOrder ASC, createdAt ASC`,
      )
      .bind(orgId)
      .all<MobileChecklistTemplateRow>(),
    db
      .prepare(
        `SELECT templateId FROM checklist_entry
       WHERE orgId = ? AND showId = ?`,
      )
      .bind(orgId, showId)
      .all<{ templateId: string }>(),
    db
      .prepare(
        `SELECT itemId AS id, title, type, duration, notes, assignee, cue, hardStop
       FROM rundown_item WHERE orgId = ? AND showId = ?
       ORDER BY sortOrder ASC, createdAt ASC`,
      )
      .bind(orgId, showId)
      .all<MobileChecklistRundownItemRow>(),
  ]);
  const entryTemplateIds = new Set(
    (entriesResult.results ?? []).map((entry) => entry.templateId),
  );
  const templatesByLabel = new Map(
    (templatesResult.results ?? []).map((template) => [
      normalizeChecklistLabel(template.label),
      template,
    ]),
  );
  const items = (itemsResult.results ?? []).map(
    (item): ChecklistRundownItem => ({
      ...item,
      hardStop: Boolean(item.hardStop),
    }),
  );
  const suggestions = deriveChecklistSuggestions(items).flatMap(
    (suggestion) => {
      const existing = templatesByLabel.get(
        normalizeChecklistLabel(suggestion.label),
      );
      if (existing && entryTemplateIds.has(existing.id)) return [];
      return [{ ...suggestion, existingTemplateId: existing?.id ?? null }];
    },
  );
  return { show, suggestions };
}

async function checklist(
  request: Request,
  url: URL,
  db: MobileApiDatabase,
): Promise<Response> {
  const access = await authorize(request, url, db, [
    "checklist:view",
    "checklist:access",
  ]);
  if (access instanceof Response) return access;
  const showId = url.searchParams.get("showId");
  if (!validId(showId)) return json({ error: "Choose a valid show." }, 400);
  const show = await getChecklistShow(access.orgId, showId, db);
  if (!show) return json({ error: "Show not found." }, 404);
  const [entriesResult, showsResult] = await Promise.all([
    db
      .prepare(
        `SELECT e.id, e.templateId, e.checked, e.checkedBy, e.checkedAt, e.revision,
              t.label, e.category, t.sortOrder
       FROM checklist_entry e
       JOIN checklist_template t ON t.id = e.templateId AND t.orgId = e.orgId
       WHERE e.orgId = ? AND e.showId = ?
       ORDER BY t.sortOrder ASC, t.createdAt ASC, e.id ASC`,
      )
      .bind(access.orgId, showId)
      .all<MobileChecklistEntryRow>(),
    db
      .prepare(
        `SELECT id, serviceDate, name, scheduledStartTime, location, status
       FROM rundown
       WHERE orgId = ? AND serviceDate BETWEEN ? AND ?
       ORDER BY serviceDate ASC, scheduledStartTime ASC, createdAt ASC
       LIMIT 250`,
      )
      .bind(
        access.orgId,
        shiftDate(show.serviceDate, -180),
        shiftDate(show.serviceDate, 365),
      )
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

async function checklistShows(
  request: Request,
  url: URL,
  db: MobileApiDatabase,
): Promise<Response> {
  const access = await authorize(request, url, db, [
    "checklist:view",
    "checklist:access",
  ]);
  if (access instanceof Response) return access;
  const result = await db
    .prepare(
      `SELECT id, serviceDate, name, scheduledStartTime, location, status
     FROM rundown WHERE orgId = ?
     ORDER BY serviceDate DESC, scheduledStartTime DESC, createdAt DESC
     LIMIT 250`,
    )
    .bind(access.orgId)
    .all<Omit<MobileRundownRow, "itemCount">>();
  return json({ shows: result.results ?? [] });
}

async function addChecklistItemMobile(
  request: Request,
  url: URL,
  db: MobileApiDatabase,
): Promise<Response> {
  const access = await authorize(request, url, db, ["checklist:access"]);
  if (access instanceof Response) return access;
  const body = await readJson(request);
  const showId = body?.showId;
  const label = typeof body?.label === "string" ? body.label.trim() : "";
  const category = body?.category;
  if (
    !validId(showId) ||
    label.length === 0 ||
    label.length > 200 ||
    !normalizeChecklistLabel(label) ||
    !validChecklistCategory(category)
  ) {
    return json(
      { error: "Enter a checklist item, department, and valid show." },
      400,
    );
  }
  const [show, templatesResult] = await Promise.all([
    getChecklistShow(access.orgId, showId, db),
    db
      .prepare(
        `SELECT id, label FROM checklist_template
       WHERE orgId = ? ORDER BY sortOrder ASC, createdAt ASC`,
      )
      .bind(access.orgId)
      .all<MobileChecklistTemplateRow>(),
  ]);
  if (!show) return json({ error: "Show not found." }, 404);
  const existingTemplateId = findChecklistTemplateId(
    templatesResult.results ?? [],
    label,
  );
  const template: ChecklistTemplateWrite = existingTemplateId
    ? { kind: "existing", id: existingTemplateId, category }
    : {
        kind: "new",
        id: await createChecklistTemplateId(access.orgId, label),
        label,
        category,
      };
  const result = await persistChecklistItem(
    {
      orgId: access.orgId,
      showId,
      serviceDate: show.serviceDate,
      template,
    },
    db,
  );
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
  if (
    !body ||
    typeof body.checked !== "boolean" ||
    !Number.isInteger(body.expectedRevision) ||
    Number(body.expectedRevision) < 0
  ) {
    return json({ error: "Choose a valid checklist state." }, 400);
  }
  try {
    const entry = await transitionChecklistEntry({
      orgId: access.orgId,
      entryId,
      checked: body.checked,
      expectedRevision: Number(body.expectedRevision),
      actorName: access.identity.name,
      database: db,
    });
    return json({ ok: true, entry });
  } catch (error) {
    if (error instanceof ChecklistRevisionConflictError)
      return json({ error: error.message }, 409);
    if (error instanceof Error && error.message === "Checklist item not found.")
      return json({ error: error.message }, 404);
    throw error;
  }
}

async function removeChecklistEntryMobile(
  request: Request,
  url: URL,
  entryId: string,
  db: MobileApiDatabase,
): Promise<Response> {
  const access = await authorize(request, url, db, ["checklist:access"]);
  if (access instanceof Response) return access;
  const result = await db
    .prepare("DELETE FROM checklist_entry WHERE id = ? AND orgId = ?")
    .bind(entryId, access.orgId)
    .run();
  if (!changedExactlyOneRow(result))
    return json({ error: "Checklist item not found." }, 404);
  return json({ ok: true });
}

async function updateChecklistCategoryMobile(
  request: Request,
  url: URL,
  entryId: string,
  db: MobileApiDatabase,
): Promise<Response> {
  const access = await authorize(request, url, db, ["checklist:access"]);
  if (access instanceof Response) return access;
  const body = await readJson(request);
  if (!body || !validChecklistCategory(body.category))
    return json({ error: "Choose a valid department." }, 400);
  try {
    return json(
      await setChecklistEntryCategory({
        orgId: access.orgId,
        entryId,
        category: body.category,
        database: db,
      }),
    );
  } catch (error) {
    if (error instanceof Error && error.message === "Checklist item not found.")
      return json({ error: error.message }, 404);
    throw error;
  }
}

async function checklistSuggestions(
  request: Request,
  url: URL,
  db: MobileApiDatabase,
): Promise<Response> {
  const access = await authorize(request, url, db, ["checklist:access"]);
  if (access instanceof Response) return access;
  const showId = url.searchParams.get("showId");
  if (!validId(showId)) return json({ error: "Choose a valid show." }, 400);
  const draft = await buildMobileChecklistDraft(access.orgId, showId, db);
  if (!draft) return json({ error: "Show not found." }, 404);
  return json({ show: draft.show, suggestions: draft.suggestions });
}

async function applyChecklistSuggestions(
  request: Request,
  url: URL,
  db: MobileApiDatabase,
): Promise<Response> {
  const access = await authorize(request, url, db, ["checklist:access"]);
  if (access instanceof Response) return access;
  const body = await readJson(request);
  const showId = body?.showId;
  const suggestionIds = body?.suggestionIds;
  if (
    !validId(showId) ||
    !Array.isArray(suggestionIds) ||
    suggestionIds.length > 30 ||
    suggestionIds.some(
      (id) => typeof id !== "string" || id.length === 0 || id.length > 100,
    )
  ) {
    return json(
      { error: "Choose a valid show and up to 30 checklist suggestions." },
      400,
    );
  }
  const draft = await buildMobileChecklistDraft(access.orgId, showId, db);
  if (!draft) return json({ error: "Show not found." }, 404);
  const requested = new Set(suggestionIds);
  const selected = draft.suggestions.filter((suggestion) =>
    requested.has(suggestion.id),
  );
  let added = 0;
  for (const suggestion of selected) {
    const template: ChecklistTemplateWrite = suggestion.existingTemplateId
      ? {
          kind: "existing",
          id: suggestion.existingTemplateId,
          category: suggestion.category,
        }
      : {
          kind: "new",
          id: await createChecklistTemplateId(access.orgId, suggestion.label),
          label: suggestion.label,
          category: suggestion.category,
        };
    const result = await persistChecklistItem(
      {
        orgId: access.orgId,
        showId,
        serviceDate: draft.show.serviceDate,
        template,
      },
      db,
    );
    if (result.added) added += 1;
  }
  return json({ ok: true, added });
}

function parseStoredRundownItems(
  value: string | null | undefined,
): Record<string, unknown>[] {
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
  const templateRows = await db
    .prepare(
      "SELECT value FROM app_setting WHERE orgId = ? AND key LIKE 'rundown-saved:%'",
    )
    .bind(orgId)
    .all<{ value: string }>();
  const savedTemplates = (templateRows.results ?? [])
    .map((row) => parseMobileRundownTemplate(row.value))
    .filter((template): template is MobileRundownTemplate => template !== null)
    .map((template) => ({
      id: template.id,
      name: template.name,
      itemCount: template.items.length,
    }));
  try {
    const result = await db
      .prepare(
        `SELECT id, name, description, location, defaultStartTime, rundownJson,
              sourceTemplateId, archivedAt, createdAt, updatedAt
       FROM show_inventory_item WHERE orgId = ?
       ORDER BY name ASC, createdAt DESC`,
      )
      .bind(orgId)
      .all<MobileShowInventoryRow>();
    const items = summarizeMobileShowInventory(result.results ?? []);
    return {
      inventory: items.filter((item) => !item.archivedAt),
      archivedInventory: items.filter((item) => Boolean(item.archivedAt)),
      savedTemplates,
    };
  } catch (error) {
    if (!isMissingShowInventoryTable(error)) throw error;
    return {
      inventory: [],
      archivedInventory: [],
      savedTemplates,
    };
  }
}

async function commandMobileShowInventory(
  request: Request,
  url: URL,
  db: MobileApiDatabase,
  review: boolean,
): Promise<Response> {
  const access = await authorize(request, url, db, ["schedule:manage"]);
  if (access instanceof Response) return access;
  const { inventoryCommandSchema } = await import("./show-inventory-contract");
  const parsed = inventoryCommandSchema.safeParse(await readJson(request));
  if (!parsed.success || parsed.data.orgId !== access.orgId)
    return json(
      { error: "Check the inventory request and selected workspace." },
      400,
    );
  if (parsed.data.userId && parsed.data.userId !== access.identity.userId)
    return json(
      { error: "Your account changed. Reopen inventory before continuing." },
      403,
    );
  const { writeShowInventory } = await import("./show-inventory-write.server");
  return json(
    (
      await writeShowInventory(
        parsed.data,
        request.headers,
        review ? "review" : "apply",
      )
    ).result,
  );
}

async function createMobileShowInventory(
  request: Request,
  url: URL,
  db: MobileApiDatabase,
): Promise<Response> {
  const access = await authorize(request, url, db, ["schedule:manage"]);
  if (access instanceof Response) return access;
  const body = await readJson(request);
  const { inventoryCommandSchema } = await import("./show-inventory-contract");
  const parsed = inventoryCommandSchema.safeParse({
    orgId: access.orgId,
    userId: access.identity.userId,
    requestId: body?.requestId,
    operation: { ...body, kind: "create" },
  });
  if (!parsed.success)
    return json({ error: "Check the reusable show details." }, 400);
  const { writeShowInventory } = await import("./show-inventory-write.server");
  const { result, appliedNow } = await writeShowInventory(
    parsed.data,
    request.headers,
  );
  if (result.outcome !== "applied" && result.outcome !== "superseded")
    return json(
      {
        error:
          "This inventory request or source changed. Refresh and review it before trying again.",
      },
      409,
    );
  return json(
    { ok: true, id: result.id, created: appliedNow },
    appliedNow ? 201 : 200,
  );
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
  const expectedUpdatedAt =
    typeof body?.expectedUpdatedAt === "string" ? body.expectedUpdatedAt : "";
  if (
    !expectedUpdatedAt ||
    expectedUpdatedAt.length > 64 ||
    !Number.isFinite(Date.parse(expectedUpdatedAt))
  )
    return json({ error: "Refresh the inventory and try again." }, 400);
  // Existing native builds identify a state change by the reviewed version.
  // Derive the same request identity on retry without changing their wire format.
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      JSON.stringify([
        access.orgId,
        access.identity.userId,
        inventoryId,
        archived,
        new Date(expectedUpdatedAt).toISOString(),
      ]),
    ),
  );
  const requestId =
    body?.requestId ??
    Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  const { inventoryCommandSchema } = await import("./show-inventory-contract");
  const parsed = inventoryCommandSchema.safeParse({
    orgId: access.orgId,
    userId: access.identity.userId,
    requestId,
    operation: {
      kind: "archive",
      id: inventoryId,
      archived,
      expectedUpdatedAt,
    },
  });
  if (!parsed.success)
    return json({ error: "Refresh the inventory and try again." }, 400);
  const { writeShowInventory } = await import("./show-inventory-write.server");
  const { result } = await writeShowInventory(parsed.data, request.headers);
  return result.outcome === "applied" || result.outcome === "superseded"
    ? json({ ok: true })
    : json(
        {
          error:
            "This inventory item changed on another device. Refresh and review it before trying again.",
        },
        409,
      );
}

async function schedule(
  request: Request,
  url: URL,
  db: MobileApiDatabase,
): Promise<Response> {
  const access = await authorize(request, url, db);
  if (access instanceof Response) return access;
  const canViewFull = hasAny(access.identity, [
    "schedule:view",
    "schedule:manage",
  ]);
  const requestedDate = url.searchParams.get("date");
  const requestedAssignmentId = url.searchParams.get("assignment");
  if (
    (requestedDate !== null && !validDate(requestedDate)) ||
    (requestedAssignmentId !== null && !validId(requestedAssignmentId))
  ) {
    return json({ error: "Choose a valid date and assignment." }, 400);
  }
  const [settingsResult, selectedAssignment] = await Promise.all([
    db
      .prepare(
        "SELECT key, value FROM app_setting WHERE orgId = ? AND key IN ('org-timezone', 'default-service-window-minutes', 'default-call-lead-minutes', 'schedule-provider', 'schedule-provider-url', 'schedule-provider-label', 'terminology-profile', 'workspace-type', 'workspace-modules', 'workspace-custom')",
      )
      .bind(access.orgId)
      .all<{ key: string; value: string }>(),
    requestedAssignmentId
      ? db
          .prepare(
            `SELECT a.serviceDate
         FROM service_assignment a
         LEFT JOIN crew_member c ON c.id = a.crewMemberId AND c.orgId = a.orgId
         WHERE a.orgId = ? AND a.id = ? AND (? = 1 OR LOWER(c.email) = ?)
         LIMIT 1`,
          )
          .bind(
            access.orgId,
            requestedAssignmentId,
            canViewFull ? 1 : 0,
            access.identity.email,
          )
          .first<{ serviceDate: string }>()
      : Promise.resolve(null),
  ]);
  const settingMap = Object.fromEntries(
    (settingsResult.results ?? []).map((setting) => [
      setting.key,
      setting.value,
    ]),
  );
  const { serviceWindowMinutes } = readPhaseSettings(settingMap);
  const timeZone = settingMap["org-timezone"] || "Africa/Accra";
  const today = getTodayDateString(timeZone);
  const selectedDate = selectedAssignment?.serviceDate ?? requestedDate;
  const from =
    selectedDate ?? url.searchParams.get("from") ?? shiftDate(today, -7);
  const to = selectedDate ?? url.searchParams.get("to") ?? shiftDate(today, 45);
  if (!validDate(from) || !validDate(to) || from > to)
    return json({ error: "A valid date range is required." }, 400);

  const [servicesResult, assignmentsResult, crewResult, inventoryData] =
    await Promise.all([
      db
        .prepare(
          `SELECT r.id, r.serviceDate, r.name, r.scheduledStartTime, r.scheduledCallTime, r.location, r.status, r.updatedAt,
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
        )
        .bind(
          access.orgId,
          from,
          to,
          canViewFull ? 1 : 0,
          access.identity.email,
        )
        .all<MobileScheduleRow>(),
      db
        .prepare(
          `SELECT a.id, a.showId, a.serviceDate, a.role, a.department, a.status,
              a.callTime, a.notes, a.responseNote, a.crewMemberId, a.invitedAt,
              a.respondedAt, a.updatedAt, v.revision, c.name AS crewName, c.email AS crewEmail,
              r.scheduledStartTime, r.scheduledCallTime,
              COALESCE((
                SELECT SUM(ri.duration) FROM rundown_item ri
                WHERE ri.orgId = a.orgId AND ri.showId = a.showId
              ), 0) AS plannedDurationMs
       FROM service_assignment a
       LEFT JOIN crew_member c ON c.id = a.crewMemberId AND c.orgId = a.orgId
       LEFT JOIN schedule_assignment_revision v ON v.orgId=a.orgId AND v.assignmentId=a.id
       LEFT JOIN rundown r ON r.id = a.showId AND r.orgId = a.orgId
       WHERE a.orgId = ? AND a.serviceDate BETWEEN ? AND ?
         AND (? = 1 OR LOWER(c.email) = ?)
       ORDER BY a.serviceDate ASC, a.department ASC, a.role ASC`,
        )
        .bind(
          access.orgId,
          from,
          to,
          canViewFull ? 1 : 0,
          access.identity.email,
        )
        .all<MobileAssignmentRow>(),
      canViewFull
        ? db
            .prepare(
              `SELECT id, name, role, email FROM crew_member
         WHERE orgId = ? ORDER BY name ASC, createdAt ASC`,
            )
            .bind(access.orgId)
            .all<{ id: string; name: string; role: string; email: string }>()
        : Promise.resolve({
            results: [] as {
              id: string;
              name: string;
              role: string;
              email: string;
            }[],
          }),
      canViewFull
        ? loadMobileShowInventory(db, access.orgId)
        : Promise.resolve({
            inventory: [],
            archivedInventory: [],
            savedTemplates: [],
          }),
    ]);
  const assignments = assignmentsResult.results ?? [];
  const nowMs = Date.now();
  const services = (servicesResult.results ?? []).map((service) => {
    if (canViewFull) return service;
    const ownAssignments = assignments.filter(
      (assignment) => assignment.showId === service.id,
    );
    return {
      ...service,
      crewTotal: ownAssignments.length,
      crewConfirmed: ownAssignments.filter(
        (assignment) => assignment.status === "confirmed",
      ).length,
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
      type: ["native", "planning-center", "faithteams", "other"].includes(
        settingMap["schedule-provider"],
      )
        ? settingMap["schedule-provider"]
        : "native",
      url: settingMap["schedule-provider-url"] ?? "",
      label: settingMap["schedule-provider-label"] ?? "",
    },
    terminologyProfile: legacyTerminologyProfile(
      resolveWorkspaceProfile(settingMap).type,
    ),
    workspaceType: resolveWorkspaceProfile(settingMap).type,
    workspace: resolveWorkspaceProfile(settingMap),
    ...inventoryData,
    services,
    assignments: assignments.map((assignment) => {
      const effectiveCallTime = getAssignmentCallTime({
        ...assignment,
        callLeadMinutes: readPhaseSettings(settingMap).callLeadMinutes,
        timeZone,
      });
      const responseWindow = getCrewScheduleResponseWindow(
        {
          serviceDate: assignment.serviceDate,
          scheduledStartTime: assignment.scheduledStartTime,
          plannedDurationMs: assignment.showId
            ? assignment.plannedDurationMs
            : undefined,
          serviceWindowMinutes,
          timeZone,
        },
        nowMs,
      );
      const isOwner =
        assignment.crewEmail?.toLowerCase() === access.identity.email;
      return {
        ...assignment,
        effectiveCallTime,
        responseVersion: assignmentResponseVersion({
          effectiveCallTime,
          showId: assignment.showId,
          serviceDate: assignment.serviceDate,
          role: assignment.role,
          callTime: assignment.callTime,
          scheduledStartTime: assignment.scheduledStartTime,
        }),
        responseWindow,
        canRespond:
          isOwner &&
          assignment.status === "assigned" &&
          responseWindow.status === "open",
      };
    }),
  });
}

interface MobileScheduleShowWriteRow {
  id: string;
  serviceDate: string;
  scheduledCallTime: string | null;
  status: string;
  updatedAt: string;
}

interface MobileScheduleAssignmentWriteRow {
  id: string;
  orgId: string;
  showId: string | null;
  serviceDate: string;
  crewMemberId: string | null;
  assignedByUserId: string | null;
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

function parseMobileScheduleAssignmentWrite(
  body: Record<string, unknown> | null,
): MobileScheduleAssignmentWrite | null {
  const requestId =
    typeof body?.requestId === "string" ? body.requestId.trim() : "";
  const showId = typeof body?.showId === "string" ? body.showId.trim() : "";
  const role = typeof body?.role === "string" ? body.role.trim() : "";
  const department =
    typeof body?.department === "string" ? body.department.trim() : "";
  const crewMemberId =
    body?.crewMemberId === null || body?.crewMemberId === ""
      ? null
      : typeof body?.crewMemberId === "string"
        ? body.crewMemberId.trim()
        : undefined;
  const callTime =
    typeof body?.callTime === "string" ? body.callTime.trim() : "";
  const notes = typeof body?.notes === "string" ? body.notes.trim() : "";
  const expectedUpdatedAt =
    body?.expectedUpdatedAt === null || body?.expectedUpdatedAt === undefined
      ? null
      : typeof body.expectedUpdatedAt === "string"
        ? body.expectedUpdatedAt
        : undefined;
  if (
    !validId(requestId) ||
    !validId(showId) ||
    role.length < 1 ||
    role.length > 120 ||
    department.length < 1 ||
    department.length > 80 ||
    crewMemberId === undefined ||
    (crewMemberId !== null && !validId(crewMemberId)) ||
    (callTime !== "" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(callTime)) ||
    notes.length > 500 ||
    expectedUpdatedAt === undefined ||
    (expectedUpdatedAt !== null &&
      (expectedUpdatedAt.length < 1 || expectedUpdatedAt.length > 64))
  )
    return null;
  return {
    requestId,
    showId,
    role,
    department,
    crewMemberId,
    callTime,
    notes,
    expectedUpdatedAt,
  };
}

async function getMobileScheduleShow(
  db: MobileApiDatabase,
  orgId: string,
  showId: string,
) {
  return db
    .prepare(
      "SELECT id, serviceDate, scheduledCallTime, status, updatedAt FROM rundown WHERE id = ? AND orgId = ? LIMIT 1",
    )
    .bind(showId, orgId)
    .first<MobileScheduleShowWriteRow>();
}

async function validateMobileScheduleCrew(
  db: MobileApiDatabase,
  orgId: string,
  crewMemberId: string | null,
) {
  if (!crewMemberId) return { ok: true as const, crew: null };
  const crew = await db
    .prepare(
      "SELECT id, name, email FROM crew_member WHERE id = ? AND orgId = ? LIMIT 1",
    )
    .bind(crewMemberId, orgId)
    .first<{ id: string; name: string; email: string }>();
  if (!crew) return { ok: false as const, error: "Crew member not found." };
  if (!crew.email.trim())
    return {
      ok: false as const,
      error: `Add an email address to ${crew.name} before assigning them.`,
    };
  return { ok: true as const, crew };
}

async function clearMobileAssignmentInvitation(
  orgId: string,
  assignmentId: string,
) {
  try {
    const { clearAssignmentInvitation } =
      await import("./assignment-notifications.server");
    await clearAssignmentInvitation(orgId, assignmentId);
  } catch (error) {
    console.error(
      "[Mobile schedule] Failed to clear stale assignment invitation",
      error,
    );
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
    return delivery;
  } catch (error) {
    console.error("[Mobile schedule] Assignment delivery failed", error);
    return { delivered: false, reason: "delivery-failed" as const };
  }
}

async function commandMobileAssignment(
  request: Request,
  url: URL,
  db: MobileApiDatabase,
  review: boolean,
): Promise<Response> {
  const access = await authorize(request, url, db, ["schedule:manage"]);
  if (access instanceof Response) return access;
  const { scheduleAssignmentCommandSchema } =
    await import("./schedule-assignment-contract");
  const parsed = scheduleAssignmentCommandSchema.safeParse(
    await readJson(request),
  );
  if (!parsed.success || parsed.data.orgId !== access.orgId)
    return json(
      { error: "Check the assignment details and selected workspace." },
      400,
    );
  if (parsed.data.userId !== access.identity.userId)
    return json(
      { error: "Your account changed. Reopen Schedule before saving." },
      403,
    );
  const { writeScheduleAssignment, reviewScheduleAssignment } =
    await import("./schedule-assignment.server");
  const result = await (
    review ? reviewScheduleAssignment : writeScheduleAssignment
  )(request.headers, parsed.data);
  return json({
    ...result,
    orgId: access.orgId,
    userId: access.identity.userId,
  });
}

async function readMobileAssignment(
  request: Request,
  url: URL,
  id: string,
  db: MobileApiDatabase,
): Promise<Response> {
  const access = await authorize(request, url, db, ["schedule:manage"]);
  if (access instanceof Response) return access;
  const { readScheduleAssignment } =
    await import("./schedule-assignment.server");
  const result = await readScheduleAssignment(
    request.headers,
    access.orgId,
    id,
  );
  const zone = await db
    .prepare(
      "SELECT value FROM app_setting WHERE orgId=? AND key='org-timezone'",
    )
    .bind(access.orgId)
    .first<{ value: string }>();
  return json({ ...result, timeZone: zone?.value || "UTC" });
}

async function createMobileScheduleAssignment(
  request: Request,
  url: URL,
  db: MobileApiDatabase,
): Promise<Response> {
  const access = await authorize(request, url, db, ["schedule:manage"]);
  if (access instanceof Response) return access;
  const parsed = parseMobileScheduleAssignmentWrite(await readJson(request));
  if (!parsed || parsed.expectedUpdatedAt !== null)
    return json({ error: "Check the assignment details and try again." }, 400);
  const [show, crew, existing] = await Promise.all([
    getMobileScheduleShow(db, access.orgId, parsed.showId),
    validateMobileScheduleCrew(db, access.orgId, parsed.crewMemberId),
    db
      .prepare(
        `SELECT id, orgId, showId, serviceDate, crewMemberId, role, department, status,
              callTime, notes, responseNote, invitedAt, respondedAt, updatedAt
       FROM service_assignment WHERE id = ? LIMIT 1`,
      )
      .bind(parsed.requestId)
      .first<MobileScheduleAssignmentWriteRow>(),
  ]);
  if (!show) return json({ error: "Show not found." }, 404);
  if (!crew.ok) return json({ error: crew.error }, 400);
  if (existing) {
    const sameRequest =
      existing.orgId === access.orgId &&
      existing.showId === show.id &&
      existing.role === parsed.role &&
      existing.department === parsed.department &&
      existing.crewMemberId === parsed.crewMemberId &&
      existing.callTime === parsed.callTime &&
      existing.notes === parsed.notes;
    return sameRequest
      ? json({
          ok: true,
          id: existing.id,
          created: false,
          delivered: Boolean(existing.invitedAt),
        })
      : json(
          {
            error:
              "That assignment request was already used. Refresh and try again.",
          },
          409,
        );
  }
  await db
    .prepare(
      `INSERT INTO service_assignment
      (id, orgId, showId, serviceDate, crewMemberId, assignedByUserId, role, department, status, callTime, notes, responseNote, invitedAt, respondedAt, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'assigned', ?, ?, '', NULL, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    )
    .bind(
      parsed.requestId,
      access.orgId,
      show.id,
      show.serviceDate,
      parsed.crewMemberId,
      access.identity.userId,
      parsed.role,
      parsed.department,
      parsed.callTime,
      parsed.notes,
    )
    .run();
  const delivery = parsed.crewMemberId
    ? await deliverMobileAssignmentInvitation({
        request,
        db,
        orgId: access.orgId,
        assignmentId: parsed.requestId,
        showId: show.id,
        serviceDate: show.serviceDate,
        role: parsed.role,
        crewMemberId: parsed.crewMemberId,
      })
    : { delivered: false, reason: null };
  return json(
    {
      ok: true,
      id: parsed.requestId,
      created: true,
      delivered: delivery.delivered,
    },
    201,
  );
}

async function commandMobileScheduleCopy(
  request: Request,
  url: URL,
  db: MobileApiDatabase,
): Promise<Response> {
  const access = await authorize(request, url, db, ["schedule:manage"]);
  if (access instanceof Response) return access;
  const { copyTeamCommandSchema } = await import("./schedule-copy-contract");
  const parsed = copyTeamCommandSchema.safeParse(await readJson(request));
  if (
    !parsed.success ||
    parsed.data.orgId !== access.orgId ||
    parsed.data.copyFrom > parsed.data.serviceDate
  )
    return json({ error: "Check the source and destination shows." }, 400);
  if (parsed.data.userId !== access.identity.userId)
    return json(
      { error: "Your account changed. Reopen Schedule before copying a team." },
      403,
    );
  const { runCopyScheduleTeam } = await import("./schedule-copy.server");
  return json(await runCopyScheduleTeam(request.headers, parsed.data));
}

async function copyMobileScheduleTeam(
  request: Request,
  url: URL,
  showId: string,
  db: MobileApiDatabase,
): Promise<Response> {
  const access = await authorize(request, url, db, ["schedule:manage"]);
  if (access instanceof Response) return access;
  const body = await readJson(request);
  const legacyRequest =
    typeof body?.requestId === "string" ? body.requestId.trim() : "";
  const sourceShowId =
    typeof body?.sourceShowId === "string" ? body.sourceShowId.trim() : "";
  if (
    !validId(legacyRequest) ||
    legacyRequest.length > 96 ||
    !validId(sourceShowId) ||
    sourceShowId === showId
  )
    return json({ error: "Choose a valid previous show to copy." }, 400);
  // Installed native builds use non-UUID identities. Give that identity a stable
  // namespace; retries must not rebuild the roster from the current source.
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        JSON.stringify([
          "native-copy",
          access.orgId,
          access.identity.userId,
          legacyRequest,
        ]),
      ),
    ),
  );
  digest[6] = (digest[6] & 15) | 80;
  digest[8] = (digest[8] & 63) | 128;
  const hex = Array.from(digest.slice(0, 16), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const requestId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  const stored = await db
    .prepare(
      "SELECT fingerprint FROM schedule_copy_request WHERE orgId=? AND actorId=? AND requestId=?",
    )
    .bind(access.orgId, access.identity.userId, requestId)
    .first<{ fingerprint: string }>();
  let serviceDate: string, copyFrom: string;
  if (stored) {
    const selection = z
      .tuple([z.string(), z.string(), z.string(), z.string()])
      .parse(JSON.parse(stored.fingerprint));
    if (selection[0] !== showId || selection[2] !== sourceShowId)
      return json(
        {
          error:
            "This copy request belongs to different shows. Refresh before copying again.",
        },
        409,
      );
    serviceDate = selection[1];
    copyFrom = selection[3];
  } else {
    const [target, source] = await Promise.all([
      getMobileScheduleShow(db, access.orgId, showId),
      getMobileScheduleShow(db, access.orgId, sourceShowId),
    ]);
    if (!target || !source) return json({ error: "Show not found." }, 404);
    if (source.serviceDate > target.serviceDate)
      return json({ error: "Choose a show that occurs before this one." }, 400);
    serviceDate = target.serviceDate;
    copyFrom = source.serviceDate;
  }
  const { copyTeamCommandSchema, copyTeamBlockedMessage } =
    await import("./schedule-copy-contract");
  const command = copyTeamCommandSchema.parse({
    orgId: access.orgId,
    userId: access.identity.userId,
    requestId,
    showId,
    serviceDate,
    copyFromShowId: sourceShowId,
    copyFrom,
  });
  const { runCopyScheduleTeam } = await import("./schedule-copy.server");
  const result = await runCopyScheduleTeam(request.headers, command);
  if (result.reason)
    return json({ error: copyTeamBlockedMessage(result.reason) }, 409);
  if (result.items.some((item) => item.changed))
    return json({ error: "The original team was copied, but its positions have since changed or been removed. Refresh to review them." }, 409);
  return json(
    {
      ok: true,
      copied: result.copied,
      created: !stored,
      delivered: result.items.filter(
        (item) => item.invitation?.email === "accepted",
      ).length,
      total: result.items.filter((item) => item.invitation !== null).length,
    },
    stored ? 200 : 201,
  );
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
  if (!parsed || parsed.expectedUpdatedAt === null)
    return json(
      { error: "Refresh the schedule and check the assignment details." },
      400,
    );
  const [existing, show, crew] = await Promise.all([
    db
      .prepare(
        `SELECT id, orgId, showId, serviceDate, crewMemberId, role, department, status,
              callTime, notes, responseNote, invitedAt, respondedAt, updatedAt
       FROM service_assignment WHERE id = ? AND orgId = ? LIMIT 1`,
      )
      .bind(assignmentId, access.orgId)
      .first<MobileScheduleAssignmentWriteRow>(),
    getMobileScheduleShow(db, access.orgId, parsed.showId),
    validateMobileScheduleCrew(db, access.orgId, parsed.crewMemberId),
  ]);
  if (!existing || !show || existing.showId !== show.id)
    return json({ error: "Assignment not found." }, 404);
  if (!crew.ok) return json({ error: crew.error }, 400);
  if (existing.updatedAt !== parsed.expectedUpdatedAt) {
    return json(
      {
        error:
          "This assignment changed on another device. Refresh and try again.",
      },
      409,
    );
  }
  const personChanged = existing.crewMemberId !== parsed.crewMemberId;
  if (personChanged && existing.status === "declined") {
    const replacement = await createMobileScheduleAssignment(
      new Request(request.url, {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify({ ...parsed, expectedUpdatedAt: null }),
      }),
      url,
      db,
    );
    return replacement;
  }
  // RETURNING identifies the assignment itself; revision triggers increase total changes.
  const result = await db
    .prepare(
      `UPDATE service_assignment
     SET role = ?, department = ?, crewMemberId = ?, callTime = ?, notes = ?,
         status = CASE WHEN ? = 1 THEN 'assigned' ELSE status END,
         responseNote = CASE WHEN ? = 1 THEN '' ELSE responseNote END,
         respondedAt = CASE WHEN ? = 1 THEN NULL ELSE respondedAt END,
         invitedAt = CASE WHEN ? = 1 THEN NULL ELSE invitedAt END,
         assignedByUserId = CASE WHEN ? = 1 THEN ? ELSE assignedByUserId END,
         updatedAt = CURRENT_TIMESTAMP
     WHERE id = ? AND orgId = ? AND showId = ? AND updatedAt = ? RETURNING id`,
    )
    .bind(
      parsed.role,
      parsed.department,
      parsed.crewMemberId,
      parsed.callTime,
      parsed.notes,
      personChanged ? 1 : 0,
      personChanged ? 1 : 0,
      personChanged ? 1 : 0,
      personChanged ? 1 : 0,
      personChanged ? 1 : 0,
      access.identity.userId,
      assignmentId,
      access.orgId,
      show.id,
      parsed.expectedUpdatedAt,
    )
    .first<{ id: string }>();
  if (!result)
    return json(
      {
        error:
          "This assignment changed on another device. Refresh and try again.",
      },
      409,
    );
  if (personChanged)
    await clearMobileAssignmentInvitation(access.orgId, assignmentId);
  const delivery =
    personChanged && parsed.crewMemberId
      ? await deliverMobileAssignmentInvitation({
          request,
          db,
          orgId: access.orgId,
          assignmentId,
          showId: show.id,
          serviceDate: show.serviceDate,
          role: parsed.role,
          crewMemberId: parsed.crewMemberId,
        })
      : { delivered: false, reason: null };
  return json({
    ok: true,
    id: assignmentId,
    created: false,
    delivered: delivery.delivered,
  });
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
    db
      .prepare("DELETE FROM notification WHERE orgId = ? AND source = ?")
      .bind(access.orgId, assignmentId),
    db
      .prepare("DELETE FROM service_assignment WHERE orgId = ? AND id = ? RETURNING id")
      .bind(access.orgId, assignmentId),
  ]);
  // Revision triggers also change rows; total changes cannot identify this delete.
  const deletion = result[1];
  if (!isRecord(deletion) || !Array.isArray(deletion.results))
    throw new Error("Assignment removal could not be confirmed.");
  return deletion.results.some(row => isRecord(row) && row.id === assignmentId)
    ? json({ ok: true })
    : json({ error: "Assignment not found." }, 404);
}

async function commandMobileScheduleReminder(request: Request, url: URL, db: MobileApiDatabase): Promise<Response> {
  const access = await authorize(request, url, db, ["schedule:manage"]);
  if (access instanceof Response) return access;
  const { scheduleReminderCommandSchema } = await import("./schedule-reminder-contract");
  const parsed = scheduleReminderCommandSchema.safeParse(await readJson(request));
  if (!parsed.success || parsed.data.orgId !== access.orgId)
    return json({ error: "Check the reminder request and selected workspace." }, 400);
  if (parsed.data.userId !== access.identity.userId)
    return json({ error: "Your account changed. Reopen Schedule before sending reminders." }, 403);
  const { runScheduleReminders } = await import("./schedule-reminder.server");
  return json(await runScheduleReminders(request.headers, parsed.data));
}

async function remindMobileScheduleAssignments(
  request: Request,
  url: URL,
  input: { assignmentId?: string; showId?: string },
  db: MobileApiDatabase,
): Promise<Response> {
  const access = await authorize(request, url, db, ["schedule:manage"]);
  if (access instanceof Response) return access;
  const body = await readJson(request);
  const { scheduleReminderCommandSchema } = await import("./schedule-reminder-contract");
  // Installed builds without a request identity still start a fresh reminder.
  // Explicit identities retain the recipients and delivery record on retry.
  const parsed = scheduleReminderCommandSchema.safeParse({
    orgId: access.orgId, userId: access.identity.userId,
    requestId: body?.requestId ?? crypto.randomUUID(),
    target: input.assignmentId ? { kind: "assignment", id: input.assignmentId } : { kind: "show", id: input.showId },
  });
  if (!parsed.success) return json({ error: "Check the reminder request." }, 400);
  const { runScheduleReminders } = await import("./schedule-reminder.server");
  const result = await runScheduleReminders(request.headers, parsed.data);
  return json({ ok: true, delivered: result.items.filter(item => item.email === "accepted").length, total: result.items.filter(item => item.email !== "changed").length });
}

async function commandMobileShowManagement(request: Request, url: URL, env: MobileApiEnvironment, review: boolean): Promise<Response> {
  const { mobileShowManagementSchema } = await import("./mobile-show-management-contract");
  const parsed = mobileShowManagementSchema.safeParse(await readJson(request));
  if (!parsed.success || (review && parsed.data.kind !== "edit"))
    return json({ error: "Check the show details and original request." }, 400);
  const command = parsed.data;
  const access = await authorize(request, url, env.DB, ["schedule:manage"]);
  if (access instanceof Response) return access;
  if (command.orgId !== access.orgId || command.userId !== access.identity.userId)
    return json({ error: "Your account or workspace changed. Reopen Schedule." }, 403);
  const identity = { orgId: command.orgId, userId: command.userId, requestId: command.requestId, showId: command.showId, kind: command.kind };
  if (command.kind === "edit") {
    const { saveShowDetailsRequest } = await import("./show-details.server");
    const result = await saveShowDetailsRequest(request.headers, command, env, review ? "review" : "save");
    return json({ ...identity, result });
  }
  const { deleteServiceForOrg } = await import("./service-deletion.server");
  const { ShowDeletionRejectedError } = await import("./show-deletion-contract");
  try {
    return json({ ...identity, result: await deleteServiceForOrg(command, request.headers) });
  } catch (error) {
    // Once purge starts, errors stay unconfirmed and retries finish the journal.
    // Only the shared lifecycle can classify a definitive rejection.
    if (error instanceof ShowDeletionRejectedError)
      return json({ ...identity, result: { ok: false, message: error.message } });
    throw error;
  }
}

async function readMobileManagedShow(request: Request, url: URL, showId: string, db: MobileApiDatabase): Promise<Response> {
  const { mobileShowReadSchema } = await import("./mobile-show-management-contract");
  const parsed = mobileShowReadSchema.safeParse({ orgId: url.searchParams.get("orgId"), userId: url.searchParams.get("userId"), showId });
  if (!parsed.success) return json({ error: "Choose a valid show and account." }, 400);
  const access = await authorize(request, url, db, ["schedule:manage"]);
  if (access instanceof Response) return access;
  if (access.identity.userId !== parsed.data.userId)
    return json({ error: "Your account changed. Reopen Schedule." }, 403);
  const { readMobileShowDetails } = await import("./mobile-show-management.server");
  return json(await readMobileShowDetails(request.headers, parsed.data));
}

async function updateMobileScheduleService(
  request: Request,
  url: URL,
  showId: string,
  env: MobileApiEnvironment,
): Promise<Response> {
  const db = env.DB;
  const access = await authorize(request, url, db, ["schedule:manage"]);
  if (access instanceof Response) return access;
  const body = await readJson(request);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const startTime =
    typeof body?.startTime === "string" ? body.startTime.trim() : "";
  const callTimeProvided = typeof body?.callTime === "string";
  const callTime = callTimeProvided ? String(body?.callTime).trim() : "";
  const location =
    typeof body?.location === "string" ? body.location.trim() : "";
  const expectedUpdatedAt =
    typeof body?.expectedUpdatedAt === "string" ? body.expectedUpdatedAt : "";
  if (
    name.length > 120 ||
    location.length > 240 ||
    (startTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime)) ||
    (callTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(callTime)) ||
    !expectedUpdatedAt ||
    expectedUpdatedAt.length > 64
  ) {
    return json({ error: "Check the title, start time, and location." }, 400);
  }
  const [show, timezone] = await Promise.all([
    getMobileScheduleShow(db, access.orgId, showId),
    db
      .prepare(
        "SELECT value FROM app_setting WHERE orgId = ? AND key = 'org-timezone' LIMIT 1",
      )
      .bind(access.orgId)
      .first<{ value: string }>(),
  ]);
  if (!show) return json({ error: "Show not found." }, 404);
  if (show.updatedAt !== expectedUpdatedAt)
    return json(
      { error: "This show changed on another device. Refresh and try again." },
      409,
    );
  const scheduledStartTime =
    serviceTimeToIso(show.serviceDate, startTime, timezone?.value) || null;
  const scheduledCallTime = callTimeProvided
    ? serviceTimeToIso(show.serviceDate, callTime, timezone?.value) || null
    : (show.scheduledCallTime ?? null);
  try {
    const result = await updateRundownMetadataThroughRelay({
      env: env as unknown as {
        DB: D1Database;
        RUNDOWN_RELAY?: DurableObjectNamespace<
          import("../durable-objects/RundownRelay").RundownRelay
        >;
      },
      orgId: access.orgId,
      showId,
      serviceDate: show.serviceDate,
      expectedUpdatedAt,
      payload: {
        serviceName: name,
        scheduledStartTime,
        scheduledCallTime,
        location,
      },
    });
    return json({ ok: true, revision: result.revision });
  } catch (error) {
    if (error instanceof RundownMetadataConflictError)
      return json({ error: error.message }, 409);
    throw error;
  }
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
    return json(await deleteServiceForOrg({ orgId: access.orgId, showId }, request.headers));
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to remove show.";
    return json({ error: message }, message === "Show not found" ? 404 : 409);
  }
}

async function saveMobileWorkspace(
  request: Request,
  url: URL,
  db: MobileApiDatabase,
): Promise<Response> {
  const initial = url.pathname.endsWith("/initial");
  const access = await authorize(
    request,
    url,
    db,
    initial ? undefined : ["settings:organization"],
  );
  if (access instanceof Response) return access;
  if (initial && access.identity.role !== "owner")
    return json({ error: "Forbidden" }, 403);
  if (!initial && access.identity.role !== "owner" && access.identity.role !== "admin") return json({ error: "Forbidden" }, 403);
  const body = await readJson(request);
  const kind = initial
    ? "initial"
    : url.pathname.endsWith("/modules")
      ? "modules"
      : "type";
  const command = workspaceCommandSchema.safeParse({
    ...body,
    kind,
    ...(initial
      ? {
          onlyIfUnconfigured: true,
          modules: undefined,
          custom: { label: body?.label ?? "", terms: {} },
        }
      : {}),
  });
  if (!command.success)
    return json({ error: "Choose a valid workspace type and features." }, 400);
  try {
    return json({
      workspace: await writeWorkspaceProfile(
        workspaceD1Store(db, access.orgId),
        command.data,
      ),
    });
  } catch (error) {
    return json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Workspace could not be saved",
      },
      409,
    );
  }
}

async function mobileScheduleProvider(
  request: Request,
  url: URL,
  db: MobileApiDatabase,
): Promise<Response> {
  const access = await authorize(request, url, db, ["schedule:manage"]);
  if (access instanceof Response) return access;
  const { readScheduleProvider, writeScheduleProvider } = await import("./schedule-provider.server");
  const { scheduleProviderCommandSchema, scheduleProviderConfigSchema, scheduleProviderSchema } = await import("./schedule-provider-contract");
  if (request.method === "GET") {
    if (url.searchParams.get("userId") !== access.identity.userId)
      return json({ error: "Your account changed. Reopen Schedule." }, 403);
    return json(await readScheduleProvider(request.headers, access.orgId));
  }
  const body = await readJson(request);
  const modern = !!body && ["config", "userId", "requestId", "expectedRevision", "orgId"].some(key => key in body);
  if (modern) {
    const parsed = scheduleProviderCommandSchema.safeParse(body);
    if (!parsed.success) return json({ error: "Check the scheduling source, URL and original request." }, 400);
    if (parsed.data.orgId !== access.orgId || parsed.data.userId !== access.identity.userId)
      return json({ error: "Your account or organization changed. Reopen Schedule." }, 403);
    const result = await writeScheduleProvider(request.headers, parsed.data);
    return json({ ...result, orgId: access.orgId, userId: access.identity.userId });
  }
  // Installed clients have no request ID or reviewed revision. Preserve their
  // response shape, but use the same atomic authority/revision guard. Workspace
  // language is owned by Workspace settings, never by scheduling-source edits.
  const legacy = z.object({ provider: scheduleProviderSchema, url: z.string().trim().max(500).default(""), label: z.string().trim().max(80).default(""), terminologyProfile: z.enum(["general", "church"]).optional() }).safeParse(body);
  if (!legacy.success) return json({ error: "Check the scheduling source and URL." }, 400);
  const { provider, url: workspaceUrl, label } = legacy.data;
  const config = scheduleProviderConfigSchema.safeParse({ provider, url: provider === "native" ? "" : workspaceUrl, label: provider === "other" ? label : "" });
  if (!config.success) return json({ error: "Enter a valid HTTPS scheduling workspace URL." }, 400);
  const snapshot = await readScheduleProvider(request.headers, access.orgId);
  const result = await writeScheduleProvider(request.headers, {
    orgId: access.orgId, userId: access.identity.userId, requestId: crypto.randomUUID(), expectedRevision: snapshot.revision, config: config.data,
  });
  return result.outcome === "applied" ? json({ ok: true }) : json({ error: "The scheduling source changed. Reopen Schedule before saving." }, 409);
}

async function respondToAssignment(
  request: Request,
  db: MobileApiDatabase,
  review = false,
): Promise<Response> {
  const body = await readJson(request);
  const { personalResponseFieldsSchema, personalResponseCommandSchema } = await import("./personal-assignment-response-contract");
  const recovery = review || (body && ("userId" in body || "requestId" in body || "expectedRevision" in body));
  const parsed = (recovery ? personalResponseCommandSchema : personalResponseFieldsSchema).safeParse(body);
  if (!parsed.success) return json({ error: "Choose a valid response, original request and reviewed assignment." }, 400);
  const url = new URL(request.url);
  url.searchParams.set("orgId", parsed.data.orgId);
  const access = await authorize(request, url, db);
  if (access instanceof Response) return access;
  const modern = recovery ? personalResponseCommandSchema.parse(parsed.data) : null;
  if (modern && modern.userId !== access.identity.userId)
    return json({ error: "Your account changed. Reopen Schedule." }, 403);
  const { writePersonalAssignmentResponse } = await import("./personal-assignment-response.server");
  const result = await writePersonalAssignmentResponse(request.headers, modern ?? {
    ...parsed.data, orgId: access.orgId, userId: access.identity.userId,
    requestId: crypto.randomUUID(), expectedRevision: null,
  }, review);
  if (modern) return json(result);
  if (result.outcome === "applied") return json({ ok: true });
  const unavailable = result.outcome === "unavailable" || result.outcome === "removed";
  return json({ error: unavailable ? "Assignment not found." : result.outcome === "closed"
    ? "This assignment is closed because its scheduled event has ended."
    : "This assignment changed or already has a response. Review the updated details before responding." }, unavailable ? 404 : 409);
}

async function incidents(
  request: Request,
  url: URL,
  db: MobileApiDatabase,
): Promise<Response> {
  const access = await authorize(request, url, db, [
    "incidents:report",
    "incidents:access",
  ]);
  if (access instanceof Response) return access;
  const [result, responders] = await Promise.all([
    db
      .prepare(
        `SELECT id, showId, category, severity, description, reportedBy, serviceDate,
            timestamp, status, assignedTo, assignedName, acknowledgedAt, assignedAt,
            resolvedAt, resolvedBy,
            (SELECT CAST(COUNT(*) AS INTEGER) FROM incident_comment c
             WHERE c.orgId = incident.orgId AND c.incidentId = incident.id) AS commentCount
       FROM incident WHERE orgId = ?
       ORDER BY CASE WHEN status = 'open' THEN 0 ELSE 1 END, timestamp DESC LIMIT 100`,
      )
      .bind(access.orgId)
      .all<MobileIncidentRow>(),
    resolveMobileIncidentResponders(access.orgId, access.identity.today, db),
  ]);
  const incidentRows = result.results ?? [];
  const discussion = await resolveMobileIncidentDiscussion(
    access.orgId,
    incidentRows.map((incident) => incident.id),
    db,
  );
  return json({
    canReport: hasAny(access.identity, [
      "incidents:report",
      "incidents:access",
    ]),
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
  const rows = await Promise.all(
    chunks.map(async (ids) => {
      const placeholders = ids.map(() => "?").join(",");
      return Promise.all([
        db
          .prepare(
            `SELECT id, incidentId, userId, authorName, body, parentId, createdAt
         FROM incident_comment WHERE orgId = ? AND incidentId IN (${placeholders})`,
          )
          .bind(orgId, ...ids)
          .all<MobileIncidentCommentRow>(),
        db
          .prepare(
            `SELECT r.id, r.targetId, r.userId, r.authorName, r.emoji, r.createdAt
         FROM content_reaction r JOIN incident_comment c ON c.id = r.targetId
         WHERE r.orgId = ? AND c.orgId = ? AND r.targetType = 'incident-comment'
           AND c.incidentId IN (${placeholders})`,
          )
          .bind(orgId, orgId, ...ids)
          .all<MobileIncidentReactionRow>(),
      ]);
    }),
  );
  const comments = rows
    .flatMap(([commentResult]) => commentResult.results ?? [])
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const reactions = rows
    .flatMap(([, reactionResult]) => reactionResult.results ?? [])
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  return { comments, reactions };
}

function parseBoundedPositiveInteger(
  value: string | null,
  fallback: number,
  maximum: number,
): number | null {
  if (value === null || value === "") return fallback;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= maximum
    ? parsed
    : null;
}

async function mobileIncidentHistory(
  request: Request,
  url: URL,
  db: MobileApiDatabase,
): Promise<Response> {
  const access = await authorize(request, url, db, [
    "incidents:report",
    "incidents:access",
  ]);
  if (access instanceof Response) return access;
  const status = url.searchParams.get("status") ?? "all";
  const severity = url.searchParams.get("severity") ?? "all";
  const sort = url.searchParams.get("sort") ?? "newest";
  const query = (url.searchParams.get("query") ?? "").trim();
  const category = (url.searchParams.get("category") ?? "").trim();
  const assignee = (url.searchParams.get("assignee") ?? "").trim();
  const from = url.searchParams.get("from") ?? "";
  const to = url.searchParams.get("to") ?? "";
  const page = parseBoundedPositiveInteger(
    url.searchParams.get("page"),
    1,
    10_000,
  );
  const pageSize = parseBoundedPositiveInteger(
    url.searchParams.get("pageSize"),
    30,
    100,
  );
  if (
    !new Set(["all", "open", "resolved"]).has(status) ||
    !new Set(["all", "low", "medium", "high", "critical"]).has(severity) ||
    !new Set(["newest", "oldest", "severity"]).has(sort) ||
    query.length > 200 ||
    category.length > 100 ||
    assignee.length > 200 ||
    (from && !validDate(from)) ||
    (to && !validDate(to)) ||
    (from && to && from > to) ||
    page === null ||
    pageSize === null
  ) {
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
  if (assignee)
    add("lower(i.assignedName) LIKE ?", `%${assignee.toLowerCase()}%`);
  if (from) add("i.serviceDate >= ?", from);
  if (to) add("i.serviceDate <= ?", to);
  if (query) {
    const needle = `%${query.toLowerCase()}%`;
    conditions.push(
      "(lower(i.description) LIKE ? OR lower(i.reportedBy) LIKE ? OR lower(i.assignedName) LIKE ? OR lower(i.category) LIKE ?)",
    );
    params.push(needle, needle, needle, needle);
  }
  const whereSql = conditions.join(" AND ");
  const orderSql =
    sort === "oldest"
      ? "i.timestamp ASC"
      : sort === "severity"
        ? "CASE lower(i.severity) WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC, i.timestamp DESC"
        : "i.timestamp DESC";
  const [countRow, incidentResult, categoryResult] = await Promise.all([
    db
      .prepare(`SELECT COUNT(*) AS total FROM incident i WHERE ${whereSql}`)
      .bind(...params)
      .first<{ total: number }>(),
    db
      .prepare(
        `SELECT id, showId, category, severity, description, reportedBy, serviceDate,
              timestamp, status, assignedTo, assignedName, acknowledgedAt, assignedAt,
              resolvedAt, resolvedBy,
              (SELECT CAST(COUNT(*) AS INTEGER) FROM incident_comment c
               WHERE c.orgId = i.orgId AND c.incidentId = i.id) AS commentCount
       FROM incident i WHERE ${whereSql} ORDER BY ${orderSql} LIMIT ? OFFSET ?`,
      )
      .bind(...params, pageSize, (page - 1) * pageSize)
      .all<MobileIncidentRow>(),
    db
      .prepare(
        `SELECT DISTINCT lower(trim(category)) AS category FROM incident
       WHERE orgId = ? AND trim(category) <> '' ORDER BY category ASC`,
      )
      .bind(access.orgId)
      .all<{ category: string }>(),
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
    return parsed.filter(
      (item): item is Permission =>
        typeof item === "string" && item === "incidents:access",
    );
  } catch {
    return [];
  }
}

async function resolveMobileIncidentResponders(
  orgId: string,
  today: string,
  db: MobileApiDatabase,
) {
  const [membersResult, grantsResult] = await Promise.all([
    db
      .prepare(
        `SELECT m.userId, m.role, u.name
       FROM member m JOIN user u ON u.id = m.userId
       WHERE m.organizationId = ? ORDER BY u.name ASC, m.userId ASC`,
      )
      .bind(orgId)
      .all<MobileIncidentResponderRow>(),
    db
      .prepare(
        `SELECT userId, permissions FROM member_permission_grant
       WHERE orgId = ? AND revokedAt IS NULL AND startsOn <= ?
         AND (expiresOn IS NULL OR expiresOn > ?)`,
      )
      .bind(orgId, today, today)
      .all<MobileIncidentGrantRow>(),
  ]);
  const grantedUsers = new Set(
    (grantsResult.results ?? [])
      .filter((grant) =>
        parsePermissionSnapshot(grant.permissions).includes("incidents:access"),
      )
      .map((grant) => grant.userId),
  );
  return (membersResult.results ?? [])
    .filter(
      (member) =>
        hasPermission(member.role, "incidents:access") ||
        grantedUsers.has(member.userId),
    )
    .map((member) => ({
      userId: member.userId,
      name: member.name,
      role: member.role,
    }));
}

type MobileIncidentCommand =
  | { kind: "claim" }
  | { kind: "assign"; targetUserId: string }
  | { kind: "unassign" }
  | { kind: "acknowledge" }
  | { kind: "resolve" };

function parseIncidentCommand(
  body: Record<string, unknown> | null,
): MobileIncidentCommand | null {
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
    const { notifyOperationalEvent } =
      await import("./operational-notifications.server");
    await notifyOperationalEvent({
      orgId: input.orgId,
      actorId: input.actorId,
      recipientIds:
        input.command.kind === "assign" ? [input.command.targetUserId] : [],
      includeLeadership: true,
      category: "incidents",
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
  const incident = await db
    .prepare(
      "SELECT id, status, assignedTo, acknowledgedAt FROM incident WHERE id = ? AND orgId = ? LIMIT 1",
    )
    .bind(incidentId, access.orgId)
    .first<{
      id: string;
      status: string;
      assignedTo: string | null;
      acknowledgedAt: string | null;
    }>();
  if (!incident) return json({ error: "Incident not found." }, 404);

  if (command.kind === "claim" && incident.status === "resolved") {
    return json({ error: "Resolved incidents cannot be claimed." }, 409);
  }
  if (
    (command.kind === "assign" || command.kind === "unassign") &&
    incident.status === "resolved"
  ) {
    return json({ error: "Resolved incidents cannot be reassigned." }, 409);
  }
  if (command.kind === "acknowledge" && incident.status === "resolved") {
    return json({ error: "Resolved incidents cannot be acknowledged." }, 409);
  }
  if (
    command.kind === "claim" &&
    incident.assignedTo &&
    incident.assignedTo !== access.identity.userId
  ) {
    return json({ error: "Another operator already owns this incident." }, 409);
  }
  if (
    command.kind === "acknowledge" &&
    incident.assignedTo !== access.identity.userId
  ) {
    return json(
      { error: "Only the assigned operator can acknowledge this incident." },
      403,
    );
  }
  if (
    (command.kind === "assign" || command.kind === "unassign") &&
    !isAdminTier(access.identity.role)
  ) {
    return json(
      { error: "Only an Owner, Admin, or Director can reassign incidents." },
      403,
    );
  }
  if (command.kind === "assign" && incident.assignedTo === command.targetUserId)
    return json({ ok: true });
  if (command.kind === "unassign" && incident.assignedTo === null)
    return json({ ok: true });
  let assignmentTarget: { userId: string; name: string } | null = null;
  if (command.kind === "assign") {
    const responders = await resolveMobileIncidentResponders(
      access.orgId,
      access.identity.today,
      db,
    );
    assignmentTarget =
      responders.find(
        (responder) => responder.userId === command.targetUserId,
      ) ?? null;
    if (!assignmentTarget)
      return json(
        { error: "That person cannot manage incidents in this organization." },
        400,
      );
  }
  if (
    command.kind === "claim" &&
    incident.assignedTo === access.identity.userId
  )
    return json({ ok: true });
  if (command.kind === "acknowledge" && incident.acknowledgedAt)
    return json({ ok: true });
  if (command.kind === "resolve" && incident.status === "resolved")
    return json({ ok: true });

  const now = new Date().toISOString();
  let result: ChecklistWriteResult;
  if (command.kind === "claim") {
    result = await db
      .prepare(
        `UPDATE incident SET assignedTo = ?, assignedName = ?, acknowledgedAt = ?, assignedBy = ?, assignedAt = ?
         WHERE id = ? AND orgId = ? AND status <> 'resolved'
           AND (assignedTo IS NULL OR assignedTo = '' OR assignedTo = ?)`,
      )
      .bind(
        access.identity.userId,
        access.identity.name,
        now,
        access.identity.userId,
        now,
        incidentId,
        access.orgId,
        access.identity.userId,
      )
      .run();
  } else if (command.kind === "assign") {
    if (!assignmentTarget)
      return json(
        { error: "That person cannot manage incidents in this organization." },
        400,
      );
    result = await db
      .prepare(
        `UPDATE incident SET assignedTo = ?, assignedName = ?, acknowledgedAt = NULL, assignedBy = ?, assignedAt = ?
       WHERE id = ? AND orgId = ? AND status <> 'resolved'
         AND COALESCE(assignedTo, '') = ?`,
      )
      .bind(
        assignmentTarget.userId,
        assignmentTarget.name,
        access.identity.userId,
        now,
        incidentId,
        access.orgId,
        incident.assignedTo ?? "",
      )
      .run();
  } else if (command.kind === "unassign") {
    result = await db
      .prepare(
        `UPDATE incident SET assignedTo = NULL, assignedName = '', acknowledgedAt = NULL,
               assignedBy = NULL, assignedAt = NULL
       WHERE id = ? AND orgId = ? AND status <> 'resolved'
         AND COALESCE(assignedTo, '') = ?`,
      )
      .bind(incidentId, access.orgId, incident.assignedTo ?? "")
      .run();
  } else if (command.kind === "acknowledge") {
    result = await db
      .prepare(
        `UPDATE incident SET acknowledgedAt = ?
       WHERE id = ? AND orgId = ? AND status <> 'resolved'
         AND assignedTo = ? AND acknowledgedAt IS NULL`,
      )
      .bind(now, incidentId, access.orgId, access.identity.userId)
      .run();
  } else {
    result = await db
      .prepare(
        `UPDATE incident SET status = 'resolved', resolvedAt = ?, resolvedBy = ?
       WHERE id = ? AND orgId = ? AND status <> 'resolved'`,
      )
      .bind(now, access.identity.name, incidentId, access.orgId)
      .run();
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
    return json(
      {
        error:
          "This incident changed on another device. Refresh and try again.",
      },
      409,
    );
  }
  return json({ ok: true });
}

async function addMobileIncidentComment(
  request: Request,
  url: URL,
  incidentId: string,
  db: MobileApiDatabase,
): Promise<Response> {
  const access = await authorize(request, url, db, [
    "incidents:report",
    "incidents:access",
  ]);
  if (access instanceof Response) return access;
  const body = await readJson(request);
  const requestId = validId(body?.requestId) ? body.requestId : null;
  const commentBody = typeof body?.body === "string" ? body.body.trim() : "";
  const parentId =
    body?.parentId === null || body?.parentId === undefined
      ? null
      : validId(body.parentId)
        ? body.parentId
        : undefined;
  if (
    !requestId ||
    commentBody.length < 1 ||
    commentBody.length > 2_000 ||
    parentId === undefined
  ) {
    return json({ error: "Write a comment of up to 2,000 characters." }, 400);
  }
  const contentError = objectionableContentReason(commentBody);
  if (contentError) return json({ error: contentError }, 400);
  const incident = await db
    .prepare(
      "SELECT id, serviceDate, showId FROM incident WHERE id = ? AND orgId = ? LIMIT 1",
    )
    .bind(incidentId, access.orgId)
    .first<{ id: string; serviceDate: string; showId: string | null }>();
  if (!incident) return json({ error: "Incident not found." }, 404);

  let parentAuthorId: string | null = null;
  if (parentId) {
    const parent = await db
      .prepare(
        "SELECT userId FROM incident_comment WHERE id = ? AND incidentId = ? AND orgId = ? LIMIT 1",
      )
      .bind(parentId, incidentId, access.orgId)
      .first<{ userId: string }>();
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
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO incident_comment
     (id, orgId, incidentId, userId, authorName, body, parentId, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      comment.id,
      access.orgId,
      comment.incidentId,
      comment.userId,
      comment.authorName,
      comment.body,
      comment.parentId,
      comment.createdAt,
    )
    .run();
  if (!changedExactlyOneRow(result)) {
    const existing = await db
      .prepare(
        `SELECT id, incidentId, userId, authorName, body, parentId, createdAt
       FROM incident_comment WHERE id = ? AND orgId = ? AND userId = ? LIMIT 1`,
      )
      .bind(requestId, access.orgId, access.identity.userId)
      .first<MobileIncidentCommentRow>();
    if (
      existing &&
      existing.incidentId === incidentId &&
      existing.body === commentBody &&
      existing.parentId === parentId
    ) {
      return json({ comment: existing });
    }
    return json(
      { error: "That comment request conflicts with an existing update." },
      409,
    );
  }

  try {
    const { notifyOperationalEvent } =
      await import("./operational-notifications.server");
    await notifyOperationalEvent({
      orgId: access.orgId,
      actorId: access.identity.userId,
      recipientIds: parentAuthorId ? [parentAuthorId] : [],
      includeLeadership: true,
      category: "incidents",
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

async function setMobileIncidentReaction(
  request: Request,
  url: URL,
  commentId: string,
  db: MobileApiDatabase,
): Promise<Response> {
  const access = await authorize(request, url, db, [
    "incidents:report",
    "incidents:access",
  ]);
  if (access instanceof Response) return access;
  const body = await readJson(request);
  if (
    !body ||
    !isEmojiReaction(body.emoji) ||
    typeof body.active !== "boolean"
  ) {
    return json({ error: "Choose a valid reaction state." }, 400);
  }
  const { active, emoji } = body;
  const target = await db
    .prepare(
      `SELECT c.userId, c.incidentId FROM incident_comment c
     JOIN incident i ON i.id = c.incidentId
     WHERE c.id = ? AND c.orgId = ? AND i.orgId = ? LIMIT 1`,
    )
    .bind(commentId, access.orgId, access.orgId)
    .first<{ userId: string; incidentId: string }>();
  if (!target) return json({ error: "Comment not found." }, 404);

  if (!active) {
    await db
      .prepare(
        `DELETE FROM content_reaction WHERE orgId = ? AND targetType = 'incident-comment'
       AND targetId = ? AND userId = ? AND emoji = ?`,
      )
      .bind(access.orgId, commentId, access.identity.userId, emoji)
      .run();
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
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO content_reaction
     (id, orgId, targetType, targetId, userId, authorName, emoji, createdAt)
     VALUES (?, ?, 'incident-comment', ?, ?, ?, ?, ?)`,
    )
    .bind(
      reaction.id,
      access.orgId,
      reaction.targetId,
      reaction.userId,
      reaction.authorName,
      reaction.emoji,
      reaction.createdAt,
    )
    .run();
  if (
    changedExactlyOneRow(result) &&
    target.userId !== access.identity.userId
  ) {
    try {
      const { notifyOperationalEvent } =
        await import("./operational-notifications.server");
      await notifyOperationalEvent({
        orgId: access.orgId,
        actorId: access.identity.userId,
        recipientIds: [target.userId],
        category: "incidents",
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
  const category =
    typeof body?.category === "string"
      ? body.category.trim().toLowerCase()
      : "";
  const severity =
    typeof body?.severity === "string"
      ? body.severity.trim().toLowerCase()
      : "";
  const description =
    typeof body?.description === "string" ? body.description.trim() : "";
  if (
    !new Set([
      "audio",
      "video",
      "lighting",
      "network",
      "power",
      "software",
      "hardware",
      "stream",
      "other",
    ]).has(category) ||
    !new Set(["low", "medium", "high", "critical"]).has(severity) ||
    description.length < 2 ||
    description.length > 2_000
  ) {
    return json(
      { error: "Choose a category, severity, and description." },
      400,
    );
  }
  const result = await db
    .prepare(
      `UPDATE incident SET category = ?, severity = ?, description = ?
     WHERE id = ? AND orgId = ?`,
    )
    .bind(category, severity, description, incidentId, access.orgId)
    .run();
  if (!changedExactlyOneRow(result))
    return json({ error: "Incident not found." }, 404);
  try {
    const { notifyOperationalEvent } =
      await import("./operational-notifications.server");
    await notifyOperationalEvent({
      orgId: access.orgId,
      actorId: access.identity.userId,
      includeLeadership: true,
      category: "incidents",
      type: "incident-updated",
      severity:
        severity === "high" || severity === "critical" ? "critical" : "warning",
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
  const result = await db
    .prepare("DELETE FROM incident WHERE id = ? AND orgId = ?")
    .bind(incidentId, access.orgId)
    .run();
  return changedExactlyOneRow(result)
    ? json({ ok: true })
    : json({ error: "Incident not found." }, 404);
}

async function createIncident(
  request: Request,
  url: URL,
  db: MobileApiDatabase,
): Promise<Response> {
  const access = await authorize(request, url, db, [
    "incidents:report",
    "incidents:access",
  ]);
  if (access instanceof Response) return access;
  const body = await readJson(request);
  if (!body) return json({ error: "Invalid JSON body." }, 400);
  const category =
    typeof body.category === "string" ? body.category.trim().toLowerCase() : "";
  const severity =
    typeof body.severity === "string" ? body.severity.trim().toLowerCase() : "";
  const description =
    typeof body.description === "string" ? body.description.trim() : "";
  const serviceDate = body.serviceDate;
  const showId =
    body.showId === undefined || body.showId === null || body.showId === ""
      ? null
      : body.showId;
  if (
    !new Set([
      "audio",
      "video",
      "lighting",
      "network",
      "power",
      "software",
      "hardware",
      "stream",
      "other",
    ]).has(category) ||
    !new Set(["low", "medium", "high", "critical"]).has(severity) ||
    description.length < 2 ||
    description.length > 2_000 ||
    !validDate(serviceDate) ||
    (showId !== null && !validId(showId))
  ) {
    return json(
      { error: "Choose a category, severity, date, and description." },
      400,
    );
  }
  if (showId) {
    const show = await db
      .prepare("SELECT id FROM rundown WHERE id = ? AND orgId = ? LIMIT 1")
      .bind(showId, access.orgId)
      .first<{ id: string }>();
    if (!show) return json({ error: "Show not found." }, 404);
  }
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO incident (id, orgId, showId, category, severity, description, reportedBy, serviceDate, timestamp, status, assignedName)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, 'open', '')`,
    )
    .bind(
      id,
      access.orgId,
      showId,
      category,
      severity,
      description,
      access.identity.name,
      serviceDate,
    )
    .run();
  try {
    const { notifyOperationalEvent } =
      await import("./operational-notifications.server");
    await notifyOperationalEvent({
      orgId: access.orgId,
      actorId: access.identity.userId,
      includeLeadership: true,
      category: "incidents",
      type: "incident-created",
      severity:
        severity === "high" || severity === "critical" ? "critical" : "warning",
      title: `New ${severity} ${category} issue`,
      message: description.slice(0, 240),
      actionUrl: `production/incidents?date=${encodeURIComponent(serviceDate)}${showId ? `&show=${encodeURIComponent(showId)}` : ""}&incident=${encodeURIComponent(id)}`,
      source: id,
      pushTag: `incident-${id}`,
    });
  } catch {
    // The incident remains authoritative when notification delivery fails.
  }
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
    // D1 rows are unversioned snapshots. Match the mobile relay normalizer's
    // initial row revision; edit conflicts use the room revision separately.
    revision: 0,
    hardStop: Boolean(item.hardStop),
    lowerThirdId: item.lowerThirdId ?? undefined,
    scheduledStart: item.scheduledStart,
    expectedEnd: item.expectedEnd,
    actualStart: item.actualStart,
    actualEnd: item.actualEnd,
  };
}

async function checkIn(
  request: Request,
  url: URL,
  db: MobileApiDatabase,
): Promise<Response> {
  const access = await authorize(request, url, db, ["checkin:access"]);
  if (access instanceof Response) return access;
  const result = await db
    .prepare(
      `SELECT id, memberId, name, role, photoUrl, isOnline, lastCheckIn, lastCheckOut
     FROM crew_member WHERE orgId = ? ORDER BY name ASC, id ASC`,
    )
    .bind(access.orgId)
    .all<MobileCheckInMemberRow>();
  return json({ members: (result.results ?? []).map(serializeCheckInMember) });
}

async function showBoard(
  request: Request,
  url: URL,
  db: MobileApiDatabase,
): Promise<Response> {
  const access = await authorize(request, url, db, ["showboard:view"]);
  if (access instanceof Response) return access;
  const [result, clockFormat, timeZone] = await Promise.all([
    db
      .prepare(
        `SELECT id, memberId, name, role, photoUrl, isOnline, lastCheckIn, lastCheckOut
       FROM crew_member WHERE orgId = ?
       ORDER BY isOnline DESC, name ASC, id ASC`,
      )
      .bind(access.orgId)
      .all<MobileCheckInMemberRow>(),
    db
      .prepare(
        "SELECT value FROM app_setting WHERE orgId = ? AND key = 'clock-format' LIMIT 1",
      )
      .bind(access.orgId)
      .first<{ value: string }>(),
    db
      .prepare(
        "SELECT value FROM app_setting WHERE orgId = ? AND key = 'org-timezone' LIMIT 1",
      )
      .bind(access.orgId)
      .first<{ value: string }>(),
  ]);
  return json({
    clockFormat: clockFormat?.value === "24hr" ? "24hr" : "12hr",
    timeZone: timeZone?.value || "Africa/Accra",
    members: (result.results ?? []).map(serializeCheckInMember),
  });
}

async function showWorkspace(
  request: Request,
  url: URL,
  db: MobileApiDatabase,
): Promise<Response> {
  const access = await authorize(request, url, db, ["show:view"]);
  if (access instanceof Response) return access;
  const { orgId, identity } = access;
  const [settingsResult, crewResult] = await Promise.all([
    db
      .prepare(
        `SELECT key, value FROM app_setting
       WHERE orgId = ? AND key IN (
         'org-timezone', 'clock-format', 'rundown-adapter', 'ontime-url', 'active-show-id'
       )`,
      )
      .bind(orgId)
      .all<{ key: string; value: string }>(),
    db
      .prepare(
        `SELECT id, memberId, name, role, photoUrl, isOnline, lastCheckIn, lastCheckOut
       FROM crew_member WHERE orgId = ?
       ORDER BY isOnline DESC, name ASC, id ASC`,
      )
      .bind(orgId)
      .all<MobileCheckInMemberRow>(),
  ]);
  const settings = Object.fromEntries(
    (settingsResult.results ?? []).map((setting) => [
      setting.key,
      setting.value,
    ]),
  );
  const timeZone = settings["org-timezone"] || "Africa/Accra";
  const today = getTodayDateString(timeZone);
  const configuredAdapter = new Set([
    "native",
    "ontime",
    "propresenter",
    "planning-center",
  ]).has(settings["rundown-adapter"])
    ? settings["rundown-adapter"]
    : "native";
  const common = {
    clockFormat: settings["clock-format"] === "24hr" ? "24hr" : "12hr",
    timeZone,
    configuredAdapter,
    chatAvailable: identity.permissions.includes("chat:access"),
    showBoardAvailable: identity.permissions.includes("showboard:view"),
    canOpenRundown: hasAny(identity, [
      "rundown:view",
      "rundown:edit",
      "rundown:control",
    ]),
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
  const show = await db
    .prepare(
      `SELECT id, serviceDate, name, scheduledStartTime, scheduledCallTime, location, status, updatedAt
     FROM rundown
     WHERE orgId = ? AND (id = ? OR status IN ('running', 'paused') OR serviceDate >= ?)
     ORDER BY CASE
       WHEN id = ? THEN 0
       WHEN status IN ('running', 'paused') THEN 1
       ELSE 2
     END, serviceDate ASC, scheduledStartTime ASC, createdAt ASC
     LIMIT 1`,
    )
    .bind(orgId, activeShowId, today, activeShowId)
    .first<Omit<MobileRundownRow, "itemCount"> & { updatedAt: string }>();

  if (!show) {
    return json({
      ...common,
      adapterStatus: configuredAdapter === "ontime" ? "fallback" : "ready",
      runtime: {
        kind: "native",
        show: null,
        items: [],
        timer: parseTimer(null),
      },
    });
  }

  const [itemsResult, showTimerSetting, dateTimerSetting, legacyOwner] =
    await Promise.all([
      db
        .prepare(
          `SELECT itemId, title, type, duration, notes, assignee, cue, status,
              sortOrder, hardStop, lowerThirdId, scheduledStart, expectedEnd, actualStart, actualEnd
       FROM rundown_item WHERE orgId = ? AND showId = ?
       ORDER BY sortOrder ASC, createdAt ASC`,
        )
        .bind(orgId, show.id)
        .all<MobileRundownItemRow>(),
      db
        .prepare(
          "SELECT value FROM app_setting WHERE orgId = ? AND key = ? LIMIT 1",
        )
        .bind(orgId, `rundown-timer:${show.id}`)
        .first<{ value: string }>(),
      db
        .prepare(
          "SELECT value FROM app_setting WHERE orgId = ? AND key = ? LIMIT 1",
        )
        .bind(orgId, `rundown-timer:${show.serviceDate}`)
        .first<{ value: string }>(),
      db
        .prepare(
          `SELECT id FROM rundown WHERE orgId = ? AND serviceDate = ?
       ORDER BY scheduledStartTime ASC, createdAt ASC LIMIT 1`,
        )
        .bind(orgId, show.serviceDate)
        .first<{ id: string }>(),
    ]);
  const timer = parseTimer(
    showTimerSetting?.value ??
      (legacyOwner?.id === show.id ? dateTimerSetting?.value : null),
  );
  return json({
    ...common,
    adapterStatus: configuredAdapter === "ontime" ? "fallback" : "ready",
    runtime: {
      kind: "native",
      show: {
        ...show,
        status: mobileRundownStatus(timer.playback, show.status),
      },
      items: (itemsResult.results ?? []).map(serializeMobileRundownItem),
      timer,
    },
  });
}

async function teamMembers(
  request: Request,
  url: URL,
  db: MobileApiDatabase,
): Promise<Response> {
  const access = await authorize(request, url, db, ["settings:members"]);
  if (access instanceof Response) return access;
  const [membersResult, invitationsResult] = await Promise.all([
    db
      .prepare(
        `SELECT m.id, m.userId, m.organizationId, m.role, m.managementRevision, m.createdAt,
              u.name AS userName, u.email AS userEmail, u.image AS userImage
       FROM member m
       JOIN user u ON u.id = m.userId
       WHERE m.organizationId = ?
       ORDER BY m.createdAt ASC, m.id ASC`,
      )
      .bind(access.orgId)
      .all<MobileOrganizationMemberRow>(),
    listTeamInvitations(db, access.orgId),
  ]);
  return json({
    currentUserId: access.identity.userId,
    assignableRoles: [...ASSIGNABLE_ROLES],
    members: (membersResult.results ?? []).map((member) => ({
      id: member.id,
      userId: member.userId,
      organizationId: member.organizationId,
      role: member.role,
      managementRevision: member.managementRevision,
      createdAt: member.createdAt,
      user: {
        id: member.userId,
        name: member.userName,
        email: member.userEmail,
        image: member.userImage,
      },
    })),
    invitations: invitationsResult,
  });
}

function membershipMutationStatus(error: unknown): number {
  if (error instanceof PlanLimitError || error instanceof TeamCommandError) return error.status;
  if (error instanceof Error && "statusCode" in error && typeof error.statusCode === "number"
      && [400, 401, 403, 404, 409, 500].includes(error.statusCode)) return error.statusCode;
  const message = error instanceof Error ? error.message : "";
  const normalized = message.toLowerCase();
  if (
    normalized.includes("not allowed") ||
    normalized.includes("forbidden") ||
    normalized.includes("unauthorized")
  )
    return 403;
  if (normalized.includes("not found")) return 404;
  if (
    normalized.includes("already") ||
    normalized.includes("only owner") ||
    normalized.includes("without an owner")
  )
    return 409;
  return 400;
}

async function inviteTeamMember(
  request: Request,
  url: URL,
  db: MobileApiDatabase,
): Promise<Response> {
  const access = await authorize(request, url, db, ["settings:members"]);
  if (access instanceof Response) return access;
  const body = await readJson(request);
  const email =
    typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  if (
    !/^\S+@\S+\.\S+$/.test(email) ||
    email.length > 254 ||
    !validAssignableRole(body?.role)
  ) {
    return json({ error: "Enter a valid email address and role." }, 400);
  }
  try {
    const invitation = await getAuth().api.createInvitation({
      headers: request.headers,
      body: { email, role: body.role, organizationId: access.orgId, resend: body.resend === true },
    });
    assertTeamCommandSuccess(invitation);
    return json({ invitation: teamInvitationSchema.parse(invitation) }, 201);
  } catch (error) {
    return json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to invite this member.",
      },
      membershipMutationStatus(error),
    );
  }
}

async function retryMobileInvitationDelivery(request: Request, url: URL, db: MobileApiDatabase): Promise<Response> {
  const access = await authorize(request, url, db, ["settings:members"]);
  if (access instanceof Response) return access;
  const body = await readJson(request);
  const parsed = retryInvitationDeliverySchema.safeParse({ ...body, orgId: access.orgId });
  if (!parsed.success) return json({ error: "Choose the invitation and email attempt to retry." }, 400);
  try {
    const result = await getAuth().api.retryInvitationDelivery({ headers: request.headers, body: parsed.data });
    assertTeamCommandSuccess(result);
    return json({ invitation: teamInvitationSchema.parse(result) });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Email retry could not be confirmed." }, membershipMutationStatus(error));
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
  const invitation = await db
    .prepare(
      "SELECT id FROM invitation WHERE id = ? AND organizationId = ? LIMIT 1",
    )
    .bind(invitationId, access.orgId)
    .first<{ id: string }>();
  if (!invitation) return json({ error: "Invitation not found." }, 404);
  try {
    const result = await getAuth().api.cancelInvitation({
      headers: request.headers,
      body: { invitationId: invitation.id },
    });
    assertTeamCommandSuccess(result);
    return json({ ok: true });
  } catch (error) {
    return json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to cancel this invitation.",
      },
      membershipMutationStatus(error),
    );
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
  if (!validAssignableRole(body?.role))
    return json({ error: "Choose a valid member role." }, 400);
  const member = await db
    .prepare(
      "SELECT id FROM member WHERE id = ? AND organizationId = ? LIMIT 1",
    )
    .bind(memberId, access.orgId)
    .first<{ id: string }>();
  if (!member) return json({ error: "Member not found." }, 404);
  try {
    const result = await getAuth().api.updateMemberRole({
      headers: request.headers,
      body: {
        memberId: member.id,
        role: body.role,
        organizationId: access.orgId,
      },
    });
    assertTeamCommandSuccess(result);
    return json({ member: result });
  } catch (error) {
    return json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to update this member.",
      },
      membershipMutationStatus(error),
    );
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
  // The authenticated organization endpoint scopes the target and can replay a
  // committed removal even when the membership no longer exists.
  try {
    const result = await getAuth().api.removeMember({
      headers: request.headers,
      body: { memberIdOrEmail: memberId, organizationId: access.orgId },
    });
    assertTeamCommandSuccess(result);
    return json({ ok: true });
  } catch (error) {
    return json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to remove this member.",
      },
      membershipMutationStatus(error),
    );
  }
}

async function teamCrew(
  request: Request,
  url: URL,
  db: MobileApiDatabase,
): Promise<Response> {
  const access = await authorize(request, url, db, ["settings:members"]);
  if (access instanceof Response) return access;
  const result = await db
    .prepare(
      `SELECT id, memberId, name, role, email, photoUrl, isOnline, lastCheckIn, lastCheckOut, profileRevision
     FROM crew_member WHERE orgId = ? ORDER BY name ASC, id ASC`,
    )
    .bind(access.orgId)
    .all<MobileCheckInMemberRow & { email: string; profileRevision: number }>();
  return json({ members: (result.results ?? []).map(row => ({ ...serializeCheckInMember(row), profileRevision: row.profileRevision })) });
}

async function recoverMobileCrew(request: Request, url: URL, db: MobileApiDatabase, review: boolean) {
  const access = await authorize(request, url, db, ["settings:members"]);
  if (access instanceof Response) return access;
  const { mobileCrewCommandSchema } = await import("./mobile-crew-recovery-contract");
  const parsed = mobileCrewCommandSchema.safeParse(await readJson(request));
  if (!parsed.success || (parsed.data.kind !== "delete" && !validCrewPhoto(parsed.data.photoUrl))) return json({ error: "Check the crew details and original request." }, 400);
  const command = parsed.data;
  if (command.orgId !== access.orgId || command.userId !== access.identity.userId) return json({ error: "Your account or organization changed. Reopen the roster." }, 403);
  try {
    const actor = await crewActor(request.headers);
    if (actor.userId !== command.userId) return json({ error: "Your account changed. Reopen the roster." }, 403);
    const { recoverCrewProfile } = await import("./crew-roster.server");
    const profile = command.kind === "delete" ? command : { memberId: command.memberId, name: command.name, role: command.role, email: command.email, photoUrl: command.photoUrl };
    const input = command.kind === "create" ? { ...command, ...profile }
      : command.kind === "update" ? { orgId: command.orgId, requestId: command.requestId, id: command.id, expectedRevision: command.expectedRevision, updates: profile, kind: command.kind }
      : command;
    const result = await recoverCrewProfile(db, actor, crewProfileCommandSchema.parse(input), review);
    return json({ ...result, orgId: command.orgId, userId: command.userId });
  } catch (error) { return json({ error: error instanceof Error ? error.message : "The crew change could not be confirmed. Retry the original request." }, membershipMutationStatus(error)); }
}
async function readMobileCrewProfile(request: Request, url: URL, db: MobileApiDatabase) {
  const access = await authorize(request, url, db, ["settings:members"]);
  if (access instanceof Response) return access;
  const { mobileCrewReadSchema } = await import("./mobile-crew-recovery-contract");
  const parsed = mobileCrewReadSchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) return json({ error: "Choose the original crew profile." }, 400);
  if (parsed.data.orgId !== access.orgId || parsed.data.userId !== access.identity.userId) return json({ error: "Your account or organization changed. Reopen the roster." }, 403);
  try {
    const actor = await crewActor(request.headers);
    if (actor.userId !== parsed.data.userId) return json({ error: "Your account changed. Reopen the roster." }, 403);
    const { readCrewProfile } = await import("./crew-roster.server");
    return json({ ...parsed.data, snapshot: await readCrewProfile(db, actor, access.orgId, parsed.data.id) });
  } catch (error) { return json({ error: error instanceof Error ? error.message : "Could not load the crew profile." }, membershipMutationStatus(error)); }
}

async function changeTeamCrewMember(
  request: Request, url: URL, db: MobileApiDatabase,
  target: { kind: "create" } | { kind: "update" | "delete"; id: string },
): Promise<Response> {
  const access = await authorize(request, url, db, ["settings:members"]);
  if (access instanceof Response) return access;
  const body = await readJson(request);
  const input = target.kind === "delete" ? null : parseCrewMemberWrite(body);
  if (target.kind !== "delete" && !input)
    return json({ error: "Enter a valid member ID, name, role, email, and photo." }, 400);
  const common = { orgId: access.orgId, requestId: body?.requestId, expectedRevision: body?.expectedRevision };
  const parsed = crewProfileCommandSchema.safeParse(target.kind === "create"
    ? { ...common, ...input, kind: "create" }
    : target.kind === "update" ? { ...common, ...target, updates: input } : { ...common, ...target });
  if (!parsed.success) return json({ error: "The crew request or profile revision is invalid. Refresh the roster and try again." }, 400);
  try {
    const result = await writeCrewProfile(db, await crewActor(request.headers), parsed.data);
    return json({ ok: true, ...result }, target.kind === "create" ? 201 : 200);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "The crew change could not be confirmed. Retry the same request." }, membershipMutationStatus(error));
  }
}
function createTeamCrewMember(request: Request, url: URL, db: MobileApiDatabase) {
  return changeTeamCrewMember(request, url, db, { kind: "create" });
}
function updateTeamCrewMember(request: Request, url: URL, id: string, db: MobileApiDatabase) {
  return changeTeamCrewMember(request, url, db, { kind: "update", id });
}
function removeTeamCrewMember(request: Request, url: URL, id: string, db: MobileApiDatabase) {
  return changeTeamCrewMember(request, url, db, { kind: "delete", id });
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
    return json(
      { error: "Choose whether this crew member is checked in." },
      400,
    );
  }
  const checkedIn = body.checkedIn;
  const update = await db
    .prepare(
      `UPDATE crew_member
     SET isOnline = ?,
         lastCheckIn = CASE WHEN ? = 1 AND isOnline = 0 THEN CURRENT_TIMESTAMP ELSE lastCheckIn END,
         lastCheckOut = CASE WHEN ? = 0 AND isOnline = 1 THEN CURRENT_TIMESTAMP ELSE lastCheckOut END
     WHERE id = ? AND orgId = ?`,
    )
    .bind(
      checkedIn ? 1 : 0,
      checkedIn ? 1 : 0,
      checkedIn ? 1 : 0,
      memberId,
      access.orgId,
    )
    .run();
  if (!changedExactlyOneRow(update))
    return json({ error: "Crew member not found." }, 404);
  const member = await db
    .prepare(
      `SELECT id, memberId, name, role, photoUrl, isOnline, lastCheckIn, lastCheckOut
     FROM crew_member WHERE id = ? AND orgId = ? LIMIT 1`,
    )
    .bind(memberId, access.orgId)
    .first<MobileCheckInMemberRow>();
  return member
    ? json({ member: serializeCheckInMember(member) })
    : json({ error: "Crew member not found." }, 404);
}

async function teamAccess(
  request: Request,
  url: URL,
  db: MobileApiDatabase,
): Promise<Response> {
  const access = await authorize(request, url, db);
  if (access instanceof Response) return access;
  const snapshot = await getAccessManagementSnapshotForActor({
    orgId: access.orgId,
    actorUserId: access.identity.userId,
    database: db,
  });
  return json({
    ...snapshot,
    capabilities: ACCESS_CAPABILITIES.map(({ id, label, description }) => ({
      id,
      label,
      description,
    })),
  });
}

function accessMutationStatus(error: unknown): number {
  if (error instanceof TeamCommandError) return error.status;
  const message = error instanceof Error ? error.message : "";
  if (
    message.startsWith("Only an Owner") ||
    message.startsWith("The on-duty TM")
  )
    return 403;
  if (message.includes("already has")) return 409;
  if (message.includes("not a member") || message.includes("no longer active"))
    return 404;
  return 400;
}

async function grantTeamAccess(
  request: Request,
  url: URL,
  db: MobileApiDatabase,
): Promise<Response> {
  const access = await authorize(request, url, db);
  if (access instanceof Response) return access;
  const body = await readJson(request);
  const parsed = grantAccessSchema.safeParse({ ...body, orgId: access.orgId });
  if (!parsed.success) return json({ error: "Choose a member, capability, valid duration and current duty week." }, 400);
  try {
    const grant = await grantMemberAccessForActor({ ...parsed.data, actor: await readAccessActor(request.headers), database: db });
    return json({ ...grant, grantId: grant.id }, 201);
  } catch (error) {
    return json(
      {
        error:
          error instanceof Error ? error.message : "Unable to grant access.",
      },
      accessMutationStatus(error),
    );
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
  const body = await readJson(request);
  const parsed = revokeAccessSchema.safeParse({ ...body, orgId: access.orgId, grantId });
  if (!parsed.success) return json({ error: "Review the access grant and request before revoking it." }, 400);
  try {
    return json(await revokeMemberAccessForActor({ ...parsed.data, actor: await readAccessActor(request.headers), database: db }));
  } catch (error) {
    return json(
      {
        error:
          error instanceof Error ? error.message : "Unable to revoke access.",
      },
      accessMutationStatus(error),
    );
  }
}

async function retryTeamAccessNotice(
  request: Request,
  url: URL,
  db: MobileApiDatabase,
): Promise<Response> {
  const access = await authorize(request, url, db);
  if (access instanceof Response) return access;
  const parsed = z.object({ requestId: z.uuid() }).safeParse(await readJson(request));
  if (!parsed.success) return json({ error: "Choose a pending access notification to retry." }, 400);
  try {
    return json(await retryAccessNotice(db, await readAccessActor(request.headers), {
      orgId: access.orgId,
      requestId: parsed.data.requestId,
    }));
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unable to retry the access notification." }, accessMutationStatus(error));
  }
}

async function mobileBridgeStatus(
  env: MobileApiEnvironment,
  orgId: string,
): Promise<BridgeRelayStatus> {
  const fallback: BridgeRelayStatus = {
    activeInstallation: null, connections: [],
    bridgeOnline: false,
    timecodeTarget: null,
    clientCount: 0,
    connectedTargets: [],
  };
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
  return moduleRegistry
    .getAll()
    .map((definition) => ({
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
    }))
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
}

function serializeMobileDeviceConfiguration(
  adapter: MobileDeviceAdapter | undefined,
  settings: Record<string, unknown> | null,
) {
  return (adapter?.fields ?? []).map((field) => {
    const raw = settings?.[field.key];
    return {
      ...field,
      value:
        field.type === "password" || isCredentialField(field.key) || raw === CREDENTIAL_MASK || raw === null || raw === undefined
          ? ""
          : String(raw),
      secretConfigured:
        (field.type === "password" || isCredentialField(field.key) || raw === CREDENTIAL_MASK) && typeof raw === "string" && raw.length > 0,
    };
  });
}

async function devices(
  request: Request,
  url: URL,
  env: MobileApiEnvironment,
): Promise<Response> {
  const access = await authorize(request, url, env.DB, ["devices:access"]);
  if (access instanceof Response) return access;
  const [result, bridge, adapters] = await Promise.all([
    env.DB.prepare(
      `SELECT id, name, category, adapterType, enabled, updatedAt, settings
     FROM device WHERE orgId = ? ORDER BY enabled DESC, name ASC`,
    )
      .bind(access.orgId)
      .all<MobileDeviceListRow>(),
    mobileBridgeStatus(env, access.orgId),
    mobileDeviceAdapters(),
  ]);
  const connectedTargets = new Set(bridge.connectedTargets);
  const adaptersByType = new Map(
    adapters.map((adapter) => [adapter.adapterType, adapter]),
  );
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
      const settings = parsedSettings(maskDeviceSettings({ ...device, orgId: access.orgId }));
      const adapter = adaptersByType.get(device.adapterType);
      const remote = settings
        ? resolveRemoteDeviceControl(device.adapterType, settings)
        : null;
      const target = remote?.target ?? null;
      return {
        id: device.id,
        name: device.name,
        category: device.category,
        adapterType: device.adapterType,
        enabled: Boolean(device.enabled),
        connected: Boolean(
          device.enabled && target && connectedTargets.has(target),
        ),
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
  const adapterType =
    typeof body?.adapterType === "string" ? body.adapterType.trim() : "";
  const enabled = typeof body?.enabled === "boolean" ? body.enabled : true;
  const suppliedSettings = isRecord(body?.settings) ? body.settings : {};
  const clear = z.array(z.array(z.string().min(1).max(200)).min(1).max(16)).max(100).safeParse(body?.clearCredentials ?? []);
  if (!clear.success) return { error: "Choose valid credential fields to clear." } as const;
  if (!name || name.length > 200 || !adapterType)
    return { error: "Enter a device name and adapter." } as const;
  const adapter = (await mobileDeviceAdapters()).find(
    (candidate) => candidate.adapterType === adapterType,
  );
  if (!adapter) return { error: "Choose a supported device adapter." } as const;
  const existingSettings =
    existing?.adapterType === adapterType
      ? parsedSettings(existing.settings)
      : null;
  const settings: Record<string, string | number> = {};
  for (const field of adapter.fields) {
    const raw = suppliedSettings[field.key];
    if (
      (field.type === "password" || isCredentialField(field.key)) &&
      (raw === undefined || raw === "" || raw === CREDENTIAL_MASK) &&
      typeof existingSettings?.[field.key] === "string"
    ) {
      if (existingSettings[field.key]) settings[field.key] = CREDENTIAL_MASK;
      continue;
    }
    if (field.type === "number") {
      if (raw === undefined || raw === "") {
        if (field.required)
          return { error: `${field.label} is required.` } as const;
        continue;
      }
      const value = Number(raw);
      if (
        !Number.isFinite(value) ||
        (field.key.toLowerCase().includes("port") &&
          (!Number.isInteger(value) || value < 1 || value > 65_535))
      ) {
        return { error: `${field.label} is not valid.` } as const;
      }
      settings[field.key] = value;
      continue;
    }
    const value = typeof raw === "string" ? raw.trim() : "";
    if (field.required && !value)
      return { error: `${field.label} is required.` } as const;
    if (value.length > 4_096)
      return { error: `${field.label} is too long.` } as const;
    if (
      field.type === "select" &&
      value &&
      !field.options.some((option) => option.value === value)
    ) {
      return { error: `${field.label} is not valid.` } as const;
    }
    settings[field.key] = value;
  }
  const serializedSettings = JSON.stringify(settings);
  if (serializedSettings.length > 20_000)
    return { error: "Device settings are too large." } as const;
  return {
    value: {
      name,
      adapterType,
      category: adapter.category,
      enabled,
      settings: serializedSettings,
      clearCredentials: clear.data,
    },
  } as const;
}

async function createMobileDevice(
  request: Request,
  url: URL,
  env: MobileApiEnvironment,
): Promise<Response> {
  const access = await authorize(request, url, env.DB, ["devices:access"]);
  if (access instanceof Response) return access;
  const parsed = await parseMobileDeviceWrite(await readJson(request), null);
  if ("error" in parsed) return json({ error: parsed.error }, 400);
  const count = await env.DB.prepare(
    "SELECT CAST(COUNT(*) AS INTEGER) AS count FROM device WHERE orgId = ?",
  )
    .bind(access.orgId)
    .first<{ count: number }>();
  try {
    const { checkPlanLimit } = await import("./plan-limits");
    await checkPlanLimit(access.orgId, "devices", count?.count ?? 0);
  } catch (error) {
    return json(
      {
        error: error instanceof Error ? error.message : "Device limit reached.",
      },
      error instanceof PlanLimitError ? error.status : 400,
    );
  }
  const id = crypto.randomUUID();
  let settings: string;
  try {
    settings = await writeDeviceSettings(env.CREDENTIAL_ENCRYPTION_KEYS,
      { id, orgId: access.orgId, adapterType: parsed.value.adapterType }, parsed.value.settings, "{}", parsed.value.clearCredentials);
  } catch (error) { return json({ error: error instanceof Error ? error.message : "Could not save device settings." }, 400); }
  await env.DB.prepare(
    `INSERT INTO device (id, orgId, name, category, adapterType, settings, enabled, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  )
    .bind(
      id,
      access.orgId,
      parsed.value.name,
      parsed.value.category,
      parsed.value.adapterType,
      settings,
      parsed.value.enabled,
    )
    .run();
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
  )
    .bind(deviceId, access.orgId)
    .first<MobileDeviceControlRow>();
  if (!existing) return json({ error: "Device not found." }, 404);
  const parsed = await parseMobileDeviceWrite(
    await readJson(request),
    existing,
  );
  if ("error" in parsed) return json({ error: parsed.error }, 400);
  let settings: string;
  try {
    settings = await writeDeviceSettings(env.CREDENTIAL_ENCRYPTION_KEYS,
      { ...existing, adapterType: parsed.value.adapterType }, parsed.value.settings,
      existing.adapterType === parsed.value.adapterType ? existing.settings : "{}", parsed.value.clearCredentials);
  } catch (error) { return json({ error: error instanceof Error ? error.message : "Could not save device settings." }, 400); }
  const result = await env.DB.prepare(
    `UPDATE device SET name = ?, category = ?, adapterType = ?, settings = ?, enabled = ?, updatedAt = CURRENT_TIMESTAMP
     WHERE id = ? AND orgId = ? AND settings = ? AND adapterType = ? AND updatedAt = ?`,
  )
    .bind(
      parsed.value.name,
      parsed.value.category,
      parsed.value.adapterType,
      settings,
      parsed.value.enabled,
      deviceId,
      access.orgId,
      existing.settings,
      existing.adapterType,
      existing.updatedAt,
    )
    .run();
  return changedExactlyOneRow(result)
    ? json({ ok: true })
    : json({ error: "Device changed elsewhere. Refresh and try again." }, 409);
}

async function deleteMobileDevice(
  request: Request,
  url: URL,
  deviceId: string,
  env: MobileApiEnvironment,
): Promise<Response> {
  const access = await authorize(request, url, env.DB, ["devices:access"]);
  if (access instanceof Response) return access;
  const result = await env.DB.prepare(
    "DELETE FROM device WHERE id = ? AND orgId = ?",
  )
    .bind(deviceId, access.orgId)
    .run();
  return changedExactlyOneRow(result)
    ? json({ ok: true })
    : json({ error: "Device not found." }, 404);
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
  actorUserId: string,
): Promise<BridgeDispatchResult> {
  if (!env.BRIDGE_RELAY)
    return { success: false, error: "Venue Bridge is unavailable" };
  const id = env.BRIDGE_RELAY.idFromName(orgId);
  const stub = env.BRIDGE_RELAY.get(id);
  try {
    return await stub.dispatchBridgeMessage(message, { source: "operator", actorUserId });
  } catch {
    return { success: false, error: "Venue Bridge is unavailable" };
  }
}

function liveFeedbackValue(value: unknown): string | number | boolean | null {
  return typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
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
  actorUserId: string,
) {
  const values: Record<string, unknown> = {};
  let updatedAt: number | null = null;
  let actions = remote.actions;
  const event = bridge.deviceEvents?.[remote.target];
  if (event && remote.definition.parseEvent) {
    Object.assign(
      values,
      remote.definition.parseEvent(event.eventName, event.data, settings),
    );
    updatedAt = event.receivedAt;
  }
  if (!bridge.connectedTargets.includes(remote.target))
    return { values, actions, updatedAt };

  const queries = remote.definition.feedbackQueries?.(settings) ?? [];
  const results = await Promise.all(
    queries.map(async (query) => {
      const result = await bridgeDispatch(env, orgId, {
        type: "command",
        id: `mobile-feedback-${crypto.randomUUID()}`,
        protocol: remote.definition.protocol,
        target: remote.target,
        command: query.command,
      }, actorUserId);
      return { query, result };
    }),
  );
  for (const { query, result } of results) {
    if (!result.success || typeof result.response !== "string") continue;
    Object.assign(values, query.parse(result.response));
    updatedAt = Date.now();
    if (
      adapterType === "homeassistant" &&
      query.command === "GET /api/states"
    ) {
      actions = buildHomeAssistantActions(
        parseHomeAssistantEntities(result.response),
      );
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
  if (!validId(deviceId))
    return json({ error: "A valid deviceId is required." }, 400);
  const access = await authorize(request, url, env.DB, ["devices:access"]);
  if (access instanceof Response) return access;
  const device = await env.DB.prepare(
    `SELECT id, orgId, name, category, adapterType, settings, enabled, updatedAt
     FROM device WHERE id = ? AND orgId = ? LIMIT 1`,
  )
    .bind(deviceId, access.orgId)
    .first<MobileDeviceControlRow>();
  if (!device || !device.enabled)
    return json({ error: "Device not found or disabled." }, 404);
  const settings = await readDeviceSettingsForUse(env.CREDENTIAL_ENCRYPTION_KEYS, device);
  const remote = settings
    ? resolveRemoteDeviceControl(device.adapterType, settings)
    : null;
  if (!settings || !remote)
    return json(
      { error: "This device is missing a valid remote-control configuration." },
      409,
    );
  const bridge = await mobileBridgeStatus(env, access.orgId);
  const connected =
    bridge.bridgeOnline && bridge.connectedTargets.includes(remote.target);
  const refreshed = await refreshRemoteDeviceControl(
    env,
    access.orgId,
    device.adapterType,
    settings,
    remote,
    bridge,
    access.identity.userId,
  );
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
  if (!validId(deviceId))
    return json({ error: "A valid deviceId is required." }, 400);
  const access = await authorize(request, url, env.DB, ["devices:access"]);
  if (access instanceof Response) return access;
  const body = await readJson(request);
  if (!body) return json({ error: "Invalid JSON body." }, 400);
  const operation = body.operation;
  if (
    operation !== "connect" &&
    operation !== "disconnect" &&
    operation !== "action"
  ) {
    return json({ error: "Choose a valid device operation." }, 400);
  }
  const device = await env.DB.prepare(
    `SELECT id, orgId, name, category, adapterType, settings, enabled, updatedAt
     FROM device WHERE id = ? AND orgId = ? LIMIT 1`,
  )
    .bind(deviceId, access.orgId)
    .first<MobileDeviceControlRow>();
  if (!device || !device.enabled)
    return json({ error: "Device not found or disabled." }, 404);
  const settings = await readDeviceSettingsForUse(env.CREDENTIAL_ENCRYPTION_KEYS, device);
  const remote = settings
    ? resolveRemoteDeviceControl(device.adapterType, settings)
    : null;
  if (!settings || !remote)
    return json(
      { error: "This device is missing a valid remote-control configuration." },
      409,
    );
  if (operation === "connect") {
    const result = await bridgeDispatch(env, access.orgId, {
      type: "connect-device",
      protocol: remote.definition.protocol,
      target: remote.target,
      settings: remote.connectionSettings,
    }, access.identity.userId);
    return json(result, result.success ? 200 : 502);
  }
  if (operation === "disconnect") {
    const result = await bridgeDispatch(env, access.orgId, {
      type: "disconnect-device",
      target: remote.target,
    }, access.identity.userId);
    return json(result, result.success ? 200 : 502);
  }

  const actionId = typeof body.actionId === "string" ? body.actionId : "";
  const params = isRecord(body.params) ? body.params : {};
  const bridge = await mobileBridgeStatus(env, access.orgId);
  if (
    !bridge.bridgeOnline ||
    !bridge.connectedTargets.includes(remote.target)
  ) {
    return json(
      {
        error:
          "Connect this device through the venue Bridge before sending commands.",
      },
      409,
    );
  }
  if (device.adapterType === "homeassistant") {
    const discovery = await bridgeDispatch(env, access.orgId, {
      type: "command",
      id: `mobile-discovery-${crypto.randomUUID()}`,
      protocol: remote.definition.protocol,
      target: remote.target,
      command: "GET /api/states",
    }, access.identity.userId);
    const allowed =
      discovery.success && typeof discovery.response === "string"
        ? buildHomeAssistantActions(
            parseHomeAssistantEntities(discovery.response),
          )
        : [];
    if (!allowed.some((action) => action.id === actionId))
      return json(
        { error: "This Home Assistant action is no longer available." },
        409,
      );
  }
  let command: string;
  try {
    command = remote.definition.buildCommand(actionId, params, settings);
  } catch (error) {
    return json(
      {
        error:
          error instanceof Error ? error.message : "Invalid device action.",
      },
      400,
    );
  }
  const result = await bridgeDispatch(env, access.orgId, {
    type: "command",
    id: `mobile-${crypto.randomUUID()}`,
    protocol: remote.definition.protocol,
    target: remote.target,
    command,
  }, access.identity.userId);
  return json(result, result.success ? 200 : 502);
}

async function notificationRead(
  request: Request,
  db: MobileApiDatabase,
): Promise<Response> {
  const body = await readJson(request);
  const markAll = body?.all === true;
  if (
    !body ||
    !validId(body.orgId) ||
    (!markAll && !validId(body.notificationId))
  ) {
    return json(
      { error: "orgId and either notificationId or all are required." },
      400,
    );
  }
  const url = new URL(request.url);
  url.searchParams.set("orgId", body.orgId);
  const access = await authorize(request, url, db);
  if (access instanceof Response) return access;
  if (markAll) {
    await db
      .prepare(
        `UPDATE notification SET readAt = COALESCE(readAt, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       WHERE orgId = ? AND userId = ? AND dismissed = 0`,
      )
      .bind(access.orgId, access.identity.userId)
      .run();
  } else {
    await db
      .prepare(
        `UPDATE notification SET readAt = COALESCE(readAt, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       WHERE id = ? AND orgId = ? AND userId = ?`,
      )
      .bind(body.notificationId, access.orgId, access.identity.userId)
      .run();
  }
  return json({ ok: true });
}

async function notificationPage(
  request: Request,
  url: URL,
  db: MobileApiDatabase,
): Promise<Response> {
  const access = await authorize(request, url, db);
  if (access instanceof Response) return access;
  const beforeCreatedAt = url.searchParams.get("beforeCreatedAt")?.trim();
  const beforeId = url.searchParams.get("beforeId")?.trim();
  if (!beforeCreatedAt || beforeCreatedAt.length > 64 || !validId(beforeId)) {
    return json({ error: "A valid notification cursor is required." }, 400);
  }
  const result = await db
    .prepare(
      `SELECT id, type, severity, title, message, actionUrl, source, createdAt, readAt
     FROM notification
     WHERE orgId = ? AND userId = ? AND dismissed = 0
       AND (julianday(createdAt) < julianday(?) OR (julianday(createdAt) = julianday(?) AND id < ?))
     ORDER BY julianday(createdAt) DESC, id DESC
     LIMIT 51`,
    )
    .bind(
      access.orgId,
      access.identity.userId,
      beforeCreatedAt,
      beforeCreatedAt,
      beforeId,
    )
    .all<MobileNotificationRow>();
  const raw = result.results ?? [];
  const notifications = raw.slice(0, 50);
  const last = notifications.at(-1);
  return json({
    notifications,
    nextCursor:
      raw.length > 50 && last
        ? { createdAt: last.createdAt, id: last.id }
        : null,
  });
}

async function mobileNotificationPreferences(
  request: Request,
  url: URL,
  db: MobileApiDatabase,
): Promise<Response> {
  let body: Record<string, unknown> | null = null;
  if (request.method === "POST") {
    body = await readJson(request);
    if (!body || !validId(body.orgId))
      return json({ error: "A valid orgId is required." }, 400);
    url.searchParams.set("orgId", body.orgId);
  }
  const access = await authorize(request, url, db);
  if (access instanceof Response) return access;

  if (request.method === "POST") {
    const parsed = notificationPreferenceCommandSchema.safeParse(body);
    if (!parsed.success) return json({ error: "Choose a valid notification category and delivery preference." }, 400);
    try {
      const result = await writeNotificationPreference({ command: parsed.data, actor: await readPreferenceActor(request.headers), database: db });
      return json({ ...result, preferences: await readNotificationPreferences(access.orgId,access.identity.userId,db) });
    } catch (error) {
      if (error instanceof NotificationPreferenceError) return json({ error: error.message }, error.status);
      throw error;
    }
  }
  return json({ preferences: await readNotificationPreferences(access.orgId,access.identity.userId,db) });
}

function canonicalDirectMessageParticipants(
  roomId: string,
): [string, string] | null {
  const parts = roomId.split(":");
  return parts.length === 3 &&
    parts[0] === "dm" &&
    Boolean(parts[1]) &&
    parts[1] < parts[2]
    ? [parts[1], parts[2]]
    : null;
}

async function chatMembers(
  request: Request,
  url: URL,
  db: MobileApiDatabase,
): Promise<Response> {
  const access = await authorize(request, url, db, ["chat:access"]);
  if (access instanceof Response) return access;
  const result = await db
    .prepare(
      `SELECT m.userId, m.role, u.name, u.image
     FROM member m
     JOIN user u ON u.id = m.userId
     WHERE m.organizationId = ?
     ORDER BY u.name COLLATE NOCASE ASC, m.createdAt ASC`,
    )
    .bind(access.orgId)
    .all<MobileChatMemberRow>();
  return json({
    currentUserId: access.identity.userId,
    canInvite: CHAT_PASS_CREATORS.has(access.identity.role),
    members: result.results ?? [],
  });
}

async function chatNotificationsEnabled(
  orgId: string,
  db: MobileApiDatabase,
): Promise<boolean> {
  const setting = await db
    .prepare(
      "SELECT value FROM app_setting WHERE orgId = ? AND key = 'notify-app-chat' LIMIT 1",
    )
    .bind(orgId)
    .first<{ value: string }>();
  return setting?.value !== "false";
}

async function notifyMobileChatMessage(
  request: Request,
  url: URL,
  db: MobileApiDatabase,
): Promise<Response> {
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
    roomId.length === 0 ||
    roomId.length > 220 ||
    text.length > 4_000 ||
    mentionedUserIds.length > 20 ||
    (roomId !== "production" && roomId !== "planning" && !directParticipants) ||
    (directParticipants && !directParticipants.includes(access.identity.userId))
  )
    return json({ error: "Invalid chat notification." }, 400);

  const requestId = typeof body?.requestId === "string" ? body.requestId : null;
  if (body?.requestId !== undefined && (!requestId || !z.uuid().safeParse(requestId).success || !messageId))
    return json({ error: "Review this message before retrying notifications." }, 400);
  if (requestId && body?.expectedUserId !== access.identity.userId)
    return json({ error: "The signed-in account changed. Return to the original account before retrying notifications." }, 409);
  const result = (notified: number) => json({ notified, ...(requestId ? {
    orgId: access.orgId, userId: access.identity.userId, requestId, roomId, messageId,
  } : {}) });
  const recipients = new Map<string, "dm" | "mention" | "group">();
  const { groupChatNotificationRecipients } = await import("./chat-notification-recipients.server");
  for (const userId of await groupChatNotificationRecipients(db, access.orgId, access.identity.userId, roomId)) {
    recipients.set(userId, "group");
  }
  if (directParticipants) {
    const recipientId = directParticipants.find(
      (userId) => userId !== access.identity.userId,
    );
    if (recipientId) recipients.set(recipientId, "dm");
  }
  for (const userId of mentionedUserIds) {
    if (recipients.has(userId)) recipients.set(userId, "mention");
  }
  if (
    recipients.size === 0 ||
    !(await chatNotificationsEnabled(access.orgId, db))
  )
    return result(0);

  const validMembers = directParticipants ? await db
    .prepare(
      `SELECT userId FROM member WHERE organizationId = ? AND userId IN (${[...recipients].map(() => "?").join(",")})`,
    )
    .bind(access.orgId, ...recipients.keys())
    .all<{ userId: string }>() : { results: [...recipients.keys()].map((userId) => ({ userId })) };
  const memberIds = new Set(
    (validMembers.results ?? []).map((member) => member.userId),
  );
  const cleanText =
    text.replace(/<@([^|>]+)\|([^>]+)>/g, "@$2").slice(0, 240) ||
    "Shared an attachment";
  const actionUrl = `chat?room=${encodeURIComponent(roomId)}${messageId ? `&message=${encodeURIComponent(messageId)}` : ""}`;
  let notified = 0;
  try {
    const { notifyOperationalEvent } =
      await import("./operational-notifications.server");
    for (const kind of ["dm", "mention", "group"] as const) {
      const recipientIds = [...recipients]
        .filter(
          ([userId, recipientKind]) =>
            recipientKind === kind && memberIds.has(userId),
        )
        .map(([userId]) => userId);
      if (!recipientIds.length) continue;
      const result = await notifyOperationalEvent({
        orgId: access.orgId,
        requireInbox: true,
        actorId: access.identity.userId,
        recipientIds,
        category: "chat",
        type: kind === "dm" ? "chat-direct-message" : kind === "mention" ? "chat-mention" : "chat-group-message",
        title:
          kind === "dm"
            ? `New message from ${access.identity.name}`
            : kind === "mention" ? `${access.identity.name} mentioned you`
              : `${access.identity.name} in ${roomId === "planning" ? "Planning" : "Production"} Chat`,
        message: cleanText,
        actionUrl,
        source: messageId ?? `chat:${roomId}`,
        pushTag: `chat-${kind}-${roomId}`,
        ...(messageId
          ? { dedupeKey: `chat-message:${messageId}:${kind}`, once: true }
          : {}),
      });
      notified += result.notified;
    }
  } catch {
    return json({ error: "The message was delivered, but crew notifications could not be confirmed. Retry notifications." }, 503);
  }
  return result(notified);
}

async function notifyMobileChatReaction(
  request: Request,
  url: URL,
  db: MobileApiDatabase,
): Promise<Response> {
  const access = await authorize(request, url, db, ["chat:access"]);
  if (access instanceof Response) return access;
  const body = await readJson(request);
  const roomId = typeof body?.roomId === "string" ? body.roomId.trim() : "";
  const directParticipants = canonicalDirectMessageParticipants(roomId);
  if (
    !validId(body?.messageId) ||
    !validId(body?.targetUserId) ||
    !isEmojiReaction(body?.emoji) ||
    roomId.length === 0 ||
    roomId.length > 220 ||
    (roomId !== "production" && roomId !== "planning" && !directParticipants) ||
    (directParticipants && !directParticipants.includes(access.identity.userId))
  )
    return json({ error: "Invalid chat reaction notification." }, 400);
  const requestId = typeof body.requestId === "string" ? body.requestId : null;
  if (body.requestId !== undefined && (!requestId || !z.uuid().safeParse(requestId).success))
    return json({ error: "Review this reaction before retrying notifications." }, 400);
  if (requestId && body.expectedUserId !== access.identity.userId)
    return json({ error: "The signed-in account changed. Return to the original account before retrying notifications." }, 409);
  const result = (notified: number) => json({ notified, ...(requestId ? {
    orgId: access.orgId, userId: access.identity.userId, requestId, roomId, messageId: body.messageId,
  } : {}) });
  if (
    body.targetUserId === access.identity.userId ||
    !(await chatNotificationsEnabled(access.orgId, db))
  ) {
    return result(0);
  }
  const target = await db
    .prepare(
      "SELECT userId FROM member WHERE organizationId = ? AND userId = ? LIMIT 1",
    )
    .bind(access.orgId, body.targetUserId)
    .first<{ userId: string }>();
  if (!target) return result(0);
  let notified = 0;
  try {
    const { notifyOperationalEvent } =
      await import("./operational-notifications.server");
    const result = await notifyOperationalEvent({
      orgId: access.orgId,
      requireInbox: true,
      ...(requestId ? { dedupeKey: `chat-reaction:${access.identity.userId}:${requestId}`, once: true } : {}),
      actorId: access.identity.userId,
      recipientIds: [target.userId],
      category: "chat",
      type: "chat-reaction",
      title: `${access.identity.name} reacted ${String(body.emoji)} to your message`,
      message: "Open the conversation to view the reaction.",
      actionUrl: `chat?room=${encodeURIComponent(roomId)}&message=${encodeURIComponent(body.messageId)}`,
      source: body.messageId,
      pushTag: `chat-reaction-${body.messageId}`,
    });
    notified = result.notified;
  } catch {
    return json({ error: "The reaction was saved, but its notification could not be confirmed. Retry notifications." }, 503);
  }
  return result(notified);
}

async function createMobileChatPass(request: Request, url: URL, env: MobileApiEnvironment, scope: "crew-chat" | "planning-chat"): Promise<Response> {
  const access = await authorize(request, url, env.DB, ["chat:access"]);
  if (access instanceof Response) return access;
  if (!env.KIOSK_SECRET) return json({ error: "Chat invitations are not configured." }, 503);
  const session = await getAuth().api.getSession({ headers: request.headers, query: { disableCookieCache: true } });
  if (!session || session.user.id !== access.identity.userId) return json({ error: "Sign in to create a chat link." }, 401);
  const body = await readJson(request);
  if (body?.expectedUserId !== undefined && body.expectedUserId !== session.user.id)
    return json({ error: "The signed-in account changed. Return to the original account before retrying this link." }, 409);
  const parsed = chatPassCommandSchema.safeParse({ ...body, orgId: access.orgId, scope });
  if (!parsed.success) return json({ error: "Choose valid members and an expiry between 1 and 24 hours." }, 400);
  try {
    const pass = await issueChatPass(env.DB, env.KIOSK_SECRET, { userId: session.user.id, name: session.user.name }, parsed.data);
    return json({ ...(parsed.data.requestId ? { orgId: access.orgId, userId: session.user.id, requestId: parsed.data.requestId, scope } : {}), token: pass.token, expiresAt: pass.expiresAt, notifications: pass.notifications,
      ...(scope === "planning-chat" ? { targetCount: pass.targetCount } : {}),
      joinUrl: `${url.origin}/join/chat/${scope === "planning-chat" ? "planning/" : ""}${encodeURIComponent(pass.token)}` });
  } catch (error) { return json({ error: chatPassCreationMessage(error) }, error instanceof ChatPassCreationError ? error.status : 503); }
}

async function pushToken(
  request: Request,
  db: MobileApiDatabase,
): Promise<Response> {
  const body = await readJson(request);
  const validToken =
    typeof body?.token === "string" &&
    /^Expo(?:nent)?PushToken\[[^\]]{8,200}\]$/.test(body.token);
  const validPlatform =
    body?.platform === "ios" || body?.platform === "android";
  if (!body || !validId(body.orgId) || !validToken || !validPlatform) {
    return json(
      { error: "A valid orgId, Expo push token, and platform are required." },
      400,
    );
  }
  const url = new URL(request.url);
  url.searchParams.set("orgId", body.orgId);
  const access = await authorize(request, url, db);
  if (access instanceof Response) return access;
  if (body.enabled === false) {
    // Signing out is device-wide. Remove this user's token from every
    // organization so a previous workspace cannot keep notifying the device.
    await db
      .prepare(
        "DELETE FROM push_subscription WHERE endpoint = ? AND userId = ?",
      )
      .bind(body.token, access.identity.userId)
      .run();
    return json({ ok: true });
  }
  await db.batch([
    // An Expo token identifies one app installation. Registration by a new
    // account transfers that device away from every previous account even if
    // the old client's best-effort sign-out cleanup never reached the server.
    db
      .prepare(
        "DELETE FROM push_subscription WHERE endpoint = ? AND userId <> ?",
      )
      .bind(body.token, access.identity.userId),
    db
      .prepare(
        `INSERT INTO push_subscription (id, orgId, userId, endpoint, p256dh, auth, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, 'expo', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT(endpoint, orgId) DO UPDATE SET userId = excluded.userId,
         p256dh = 'expo', auth = excluded.auth, updatedAt = CURRENT_TIMESTAMP`,
      )
      .bind(
        crypto.randomUUID(),
        access.orgId,
        access.identity.userId,
        body.token,
        body.platform,
      ),
  ]);
  return json({ ok: true });
}

function decodePathId(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    if (!validId(decoded) || /[\\/?#\u0000-\u001F\u007F]/.test(decoded))
      return null;
    return decoded;
  } catch {
    return null;
  }
}

const cueColumnColors = new Set([
  "slate",
  "amber",
  "green",
  "blue",
  "purple",
  "pink",
  "cyan",
  "red",
]);
const equipmentStatuses = new Set<string>(EQUIPMENT_STATUSES);
const equipmentCategories = new Set<string>(EQUIPMENT_CATEGORIES);
const micTypes = new Set([
  "wireless-handheld",
  "wireless-lav",
  "wired",
  "headset",
  "di-box",
  "other",
]);
const micGroups = new Set(["vocals", "band", "playback", "sfx", "other"]);

function boundedText(
  value: unknown,
  maximum: number,
  required = false,
): string | null {
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
): Promise<{
  id: string;
  serviceDate: string;
  name: string;
  status: string;
  scheduledStartTime: string | null;
} | null> {
  if (requestedShowId !== undefined && !validId(requestedShowId)) return null;
  if (typeof requestedShowId === "string") {
    return db
      .prepare(
        "SELECT id, serviceDate, name, status, scheduledStartTime FROM rundown WHERE id = ? AND orgId = ? LIMIT 1",
      )
      .bind(requestedShowId, orgId)
      .first();
  }
  return db
    .prepare(
      `SELECT r.id, r.serviceDate, r.name, r.status, r.scheduledStartTime
       FROM rundown r
       LEFT JOIN app_setting active
         ON active.orgId = r.orgId AND active.key = 'active-show-id'
      WHERE r.orgId = ?
      ORDER BY CASE WHEN active.value = r.id THEN 0 ELSE 1 END,
        CASE WHEN r.serviceDate >= ? THEN 0 ELSE 1 END,
        CASE WHEN r.serviceDate >= ? THEN r.serviceDate END ASC, r.serviceDate DESC,
        r.scheduledStartTime ASC, r.createdAt ASC LIMIT 1`,
    )
    .bind(orgId, today, today)
    .first();
}

async function mobileCueSheet(
  request: Request,
  url: URL,
  db: MobileApiDatabase,
): Promise<Response> {
  const access = await authorize(request, url, db, [
    "cuesheet:view",
    "cuesheet:edit",
    "cuesheet:add_notes",
  ]);
  if (access instanceof Response) return access;
  const show = await resolveMobileShow(
    db,
    access.orgId,
    access.identity.today,
    url.searchParams.get("showId") ?? undefined,
  );
  if (!show) {
    const shows = await db
      .prepare(
        "SELECT id, serviceDate, name, scheduledStartTime FROM rundown WHERE orgId = ? ORDER BY serviceDate DESC, scheduledStartTime DESC",
      )
      .bind(access.orgId)
      .all<Record<string, unknown>>();
    return json({
      show: null,
      shows: shows.results ?? [],
      canEdit: hasAny(access.identity, ["cuesheet:edit"]),
      canAddNotes: hasAny(access.identity, [
        "cuesheet:edit",
        "cuesheet:add_notes",
      ]),
      columns: [],
      rows: [],
    });
  }
  const [columnsResult, itemResult, noteResult, showsResult] =
    await Promise.all([
      db
        .prepare(
          "SELECT id, label, color, sortOrder, width FROM cue_column WHERE orgId = ? ORDER BY sortOrder, createdAt",
        )
        .bind(access.orgId)
        .all<{
          id: string;
          label: string;
          color: string;
          sortOrder: number;
          width: number;
        }>(),
      db
        .prepare(
          `SELECT itemId AS id, title, type, duration, assignee, cue, status, sortOrder
       FROM rundown_item WHERE orgId = ? AND showId = ? ORDER BY sortOrder, createdAt`,
        )
        .bind(access.orgId, show.id)
        .all<Record<string, unknown>>(),
      db
        .prepare(
          "SELECT itemId, columnId, text, updatedAt, updatedBy FROM cue_note WHERE orgId = ? AND showId = ?",
        )
        .bind(access.orgId, show.id)
        .all<Record<string, unknown>>(),
      db
        .prepare(
          "SELECT id, serviceDate, name, scheduledStartTime FROM rundown WHERE orgId = ? ORDER BY serviceDate DESC, scheduledStartTime DESC",
        )
        .bind(access.orgId)
        .all<Record<string, unknown>>(),
    ]);
  const notes = new Map(
    (noteResult.results ?? []).map((note) => [
      `${note.itemId}:${note.columnId}`,
      note,
    ]),
  );
  const columns = columnsResult.results ?? [];
  return json({
    show,
    shows: showsResult.results ?? [],
    canEdit: hasAny(access.identity, ["cuesheet:edit"]),
    canAddNotes: hasAny(access.identity, [
      "cuesheet:edit",
      "cuesheet:add_notes",
    ]),
    columns,
    rows: (itemResult.results ?? []).map((item) => ({
      ...item,
      notes: columns.map(
        (column) =>
          notes.get(`${item.id}:${column.id}`) ?? {
            itemId: item.id,
            columnId: column.id,
            text: "",
            updatedAt: null,
            updatedBy: "",
          },
      ),
    })),
  });
}

async function writeMobileCueSheet(
  request: Request,
  url: URL,
  db: MobileApiDatabase,
): Promise<Response> {
  const body = await readJson(request);
  const action = body?.action;
  const permissions: Permission[] =
    action === "upsert-note"
      ? ["cuesheet:edit", "cuesheet:add_notes"]
      : ["cuesheet:edit"];
  const access = await authorize(request, url, db, permissions);
  if (access instanceof Response) return access;
  if (action === "upsert-note") {
    if (
      !validId(body?.showId) ||
      !validId(body?.itemId) ||
      !validId(body?.columnId)
    )
      return json({ error: "Valid cue targets are required." }, 400);
    const text = boundedText(body?.text, 2_000);
    if (text === null)
      return json(
        { error: "Cue notes may contain at most 2,000 characters." },
        400,
      );
    const targets = await db
      .prepare(
        `SELECT 1 AS valid FROM rundown_item i JOIN cue_column c ON c.id = ? AND c.orgId = i.orgId
       WHERE i.orgId = ? AND i.showId = ? AND i.itemId = ? LIMIT 1`,
      )
      .bind(body.columnId, access.orgId, body.showId, body.itemId)
      .first<{ valid: number }>();
    if (!targets) return json({ error: "Cue row or column not found." }, 404);
    await db
      .prepare(
        `INSERT INTO cue_note (id, orgId, showId, serviceDate, itemId, columnId, text, updatedAt, updatedBy)
       SELECT ?, ?, id, serviceDate, ?, ?, ?, CURRENT_TIMESTAMP, ? FROM rundown WHERE id = ? AND orgId = ?
       ON CONFLICT(orgId, showId, itemId, columnId) DO UPDATE SET
         text = excluded.text, updatedAt = CURRENT_TIMESTAMP, updatedBy = excluded.updatedBy`,
      )
      .bind(
        crypto.randomUUID(),
        access.orgId,
        body.itemId,
        body.columnId,
        text,
        access.identity.name,
        body.showId,
        access.orgId,
      )
      .run();
    return json({ ok: true });
  }
  if (action === "add-column") {
    const label = boundedText(body?.label, 80, true);
    const color =
      typeof body?.color === "string" && cueColumnColors.has(body.color)
        ? body.color
        : "slate";
    if (!label) return json({ error: "A column label is required." }, 400);
    const next = await db
      .prepare(
        "SELECT COALESCE(MAX(sortOrder), -1) + 1 AS value FROM cue_column WHERE orgId = ?",
      )
      .bind(access.orgId)
      .first<{ value: number }>();
    const id = crypto.randomUUID();
    await db
      .prepare(
        "INSERT INTO cue_column (id, orgId, label, color, sortOrder, width, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, 160, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
      )
      .bind(id, access.orgId, label, color, next?.value ?? 0)
      .run();
    return json({ ok: true, id });
  }
  if (action === "update-column" || action === "move-column") {
    if (!validId(body?.columnId))
      return json({ error: "A valid column is required." }, 400);
    const current = await db
      .prepare(
        "SELECT label, color, sortOrder FROM cue_column WHERE id = ? AND orgId = ?",
      )
      .bind(body.columnId, access.orgId)
      .first<{ label: string; color: string; sortOrder: number }>();
    if (!current) return json({ error: "Cue column not found." }, 404);
    const label =
      body.label === undefined
        ? current.label
        : boundedText(body.label, 80, true);
    const color =
      body.color === undefined
        ? current.color
        : typeof body.color === "string" && cueColumnColors.has(body.color)
          ? body.color
          : null;
    const sortOrder =
      action === "move-column" &&
      typeof body.sortOrder === "number" &&
      Number.isInteger(body.sortOrder)
        ? Math.max(0, Math.min(100, body.sortOrder))
        : current.sortOrder;
    if (!label || !color)
      return json({ error: "Column values are invalid." }, 400);
    if (action === "move-column" && sortOrder !== current.sortOrder) {
      await db
        .prepare(
          "UPDATE cue_column SET sortOrder = ?, updatedAt = CURRENT_TIMESTAMP WHERE orgId = ? AND sortOrder = ? AND id <> ?",
        )
        .bind(current.sortOrder, access.orgId, sortOrder, body.columnId)
        .run();
    }
    await db
      .prepare(
        "UPDATE cue_column SET label = ?, color = ?, sortOrder = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ? AND orgId = ?",
      )
      .bind(label, color, sortOrder, body.columnId, access.orgId)
      .run();
    return json({ ok: true });
  }
  if (action === "remove-column" && validId(body?.columnId)) {
    await db
      .prepare("DELETE FROM cue_column WHERE id = ? AND orgId = ?")
      .bind(body.columnId, access.orgId)
      .run();
    return json({ ok: true });
  }
  return json({ error: "Unsupported cue-sheet action." }, 400);
}

async function mobileAssets(
  request: Request,
  url: URL,
  db: MobileApiDatabase,
): Promise<Response> {
  const access = await authorize(request, url, db, [
    "assets:view",
    "assets:manage",
  ]);
  if (access instanceof Response) return access;
  const result = await db
    .prepare(
      `SELECT id, name, category, status, location, serialNumber, notes, lastServiced, nextService, revision, updatedAt
     FROM equipment WHERE orgId = ? ORDER BY category, name, createdAt`,
    )
    .bind(access.orgId)
    .all<Record<string, unknown>>();
  return json({
    canManage: hasAny(access.identity, ["assets:manage"]),
    assets: result.results ?? [],
  });
}

function parseAssetWrite(body: Record<string, unknown> | null) {
  const name = boundedText(body?.name, 200, true);
  const category =
    typeof body?.category === "string" ? body.category.toLowerCase() : "";
  const status =
    typeof body?.status === "string" ? body.status.toLowerCase() : "";
  const location = boundedText(body?.location, 240);
  const serialNumber = boundedText(body?.serialNumber, 240);
  const notes = boundedText(body?.notes, 2_000);
  if (
    !name ||
    !equipmentCategories.has(category) ||
    !equipmentStatuses.has(status) ||
    location === null ||
    serialNumber === null ||
    notes === null
  )
    return null;
  return { name, category, status, location, serialNumber, notes };
}

async function writeMobileAsset(
  request: Request,
  url: URL,
  db: MobileApiDatabase,
  assetId?: string,
): Promise<Response> {
  const access = await authorize(request, url, db, ["assets:manage"]);
  if (access instanceof Response) return access;
  const body = await readJson(request);
  if (!body) return json({ error: "Asset details are required." }, 400);
  if (body?.action === "remove" && assetId) {
    if (
      !Number.isInteger(body.expectedRevision) ||
      Number(body.expectedRevision) < 0
    ) {
      return json({ error: "Refresh this asset before deleting it." }, 400);
    }
    const result = await db
      .prepare(
        "DELETE FROM equipment WHERE id = ? AND orgId = ? AND revision = ?",
      )
      .bind(assetId, access.orgId, body.expectedRevision)
      .run();
    if (changedExactlyOneRow(result)) return json({ ok: true });
    const exists = await db
      .prepare("SELECT revision FROM equipment WHERE id = ? AND orgId = ?")
      .bind(assetId, access.orgId)
      .first<{ revision: number }>();
    return exists
      ? json(
          {
            error:
              "This asset changed on another device. Your delete was not applied.",
            conflict: true,
          },
          409,
        )
      : json({ error: "Asset not found." }, 404);
  }
  const write = parseAssetWrite(body);
  if (!write) return json({ error: "Asset details are invalid." }, 400);
  if (assetId) {
    if (
      !Number.isInteger(body?.expectedRevision) ||
      Number(body.expectedRevision) < 0
    ) {
      return json({ error: "Refresh this asset before saving it." }, 400);
    }
    const result = await db
      .prepare(
        `UPDATE equipment SET name = ?, category = ?, status = ?, location = ?, serialNumber = ?, notes = ?,
        revision = revision + 1, updatedAt = CURRENT_TIMESTAMP
       WHERE id = ? AND orgId = ? AND revision = ?`,
      )
      .bind(
        write.name,
        write.category,
        write.status,
        write.location,
        write.serialNumber,
        write.notes,
        assetId,
        access.orgId,
        body.expectedRevision,
      )
      .run();
    if (changedExactlyOneRow(result))
      return json({ ok: true, revision: Number(body.expectedRevision) + 1 });
    const current = await db
      .prepare(
        `SELECT id, name, category, status, location, serialNumber, notes, revision
         FROM equipment WHERE id = ? AND orgId = ?`,
      )
      .bind(assetId, access.orgId)
      .first<Record<string, unknown>>();
    return current
      ? json(
          {
            error:
              "This asset changed on another device. Your draft was not applied.",
            conflict: true,
            current,
          },
          409,
        )
      : json({ error: "Asset not found." }, 404);
  }
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO equipment (id, orgId, name, category, status, location, serialNumber, notes, revision, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    )
    .bind(
      id,
      access.orgId,
      write.name,
      write.category,
      write.status,
      write.location,
      write.serialNumber,
      write.notes,
    )
    .run();
  return json({ ok: true, id });
}

async function mobileStreaming(
  request: Request,
  url: URL,
  db: MobileApiDatabase,
): Promise<Response> {
  const access = await authorize(request, url, db, [
    "stream_health:view",
    "stream_health:manage",
    "streaming_suite:access",
  ]);
  if (access instanceof Response) return access;
  const [inputs, destinations] = await Promise.all([
    db
      .prepare(
        "SELECT id, name, status, rtmpUrl, srtUrl, createdAt FROM live_input WHERE orgId = ? ORDER BY createdAt",
      )
      .bind(access.orgId)
      .all<Record<string, unknown>>(),
    db
      .prepare(
        `SELECT id, name, platform, rtmpUrl, enabled, cfOutputId, liveInputId, createdAt,
        CASE WHEN streamKey = '' THEN 0 ELSE 1 END AS hasStreamKey
       FROM stream_destination WHERE orgId = ? ORDER BY createdAt`,
      )
      .bind(access.orgId)
      .all<Record<string, unknown>>(),
  ]);
  const inputRows = inputs.results ?? [];
  const liveStatuses = await Promise.all(
    inputRows.map((row) =>
      getLiveInputStatusForOrg(access.orgId, String(row.id)),
    ),
  );
  return json({
    canManage: hasAny(access.identity, ["stream_health:manage"]),
    inputs: inputRows.map((row, index) => ({
      ...row,
      ...(liveStatuses[index] ?? { status: "unknown", error: "This input is no longer available. Refresh streaming." }),
    })),
    destinations: (destinations.results ?? []).map((row) => ({
      ...row,
      enabled: Boolean(row.enabled),
      connected:
        typeof row.cfOutputId === "string" && row.cfOutputId.length > 0 && !row.cfOutputId.startsWith("pending:"),
      hasStreamKey: Boolean(row.hasStreamKey),
    })),
  });
}

async function writeMobileDestination(
  request: Request,
  url: URL,
  db: MobileApiDatabase,
  destinationId?: string,
): Promise<Response> {
  const access = await authorize(request, url, db, ["stream_health:manage"]);
  if (access instanceof Response) return access;
  const body = await readJson(request);
  const requestId = body?.requestId;
  if (requestId !== undefined && (typeof requestId !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(requestId))) {
    return json({ error: "The destination request ID is invalid." }, 400);
  }

  if (body?.action === "remove" && destinationId) {
    try {
      await deleteStreamDestinationForOrg(access.orgId, destinationId, { actorId: access.identity.userId, requestId });
      return json({ ok: true });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Destination removal failed.";
      return json({ error: message }, /not found/i.test(message) ? 404 : 502);
    }
  }
  if (
    body?.action === "toggle" &&
    destinationId &&
    typeof body.enabled === "boolean"
  ) {
    try {
      await setStreamDestinationEnabledForOrg(
        access.orgId,
        destinationId,
        body.enabled,
        { actorId: access.identity.userId, requestId },
      );
      return json({ ok: true });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Destination toggle failed.";
      return json({ error: message }, /not found/i.test(message) ? 404 : 502);
    }
  }
  const name = boundedText(body?.name, 200, true);
  const platform = boundedText(body?.platform, 50, true)?.toLowerCase() ?? null;
  const rtmpUrl = boundedText(body?.rtmpUrl, 500);
  const streamKey =
    body?.streamKey === undefined
      ? undefined
      : boundedText(body.streamKey, 500);
  if (
    !name ||
    !platform ||
    rtmpUrl === null ||
    streamKey === null ||
    !/^rtmps?:\/\//i.test(rtmpUrl)
  ) {
    return json(
      { error: "A name, platform, and valid RTMP URL are required." },
      400,
    );
  }
  try {
    const fields = { name, platform, rtmpUrl, ...(streamKey === undefined ? {} : { streamKey }) };
    let id: string;
    if (destinationId) id = await saveStreamDestinationForOrg({ orgId: access.orgId, actorId: access.identity.userId, requestId, kind: "update", id: destinationId, fields });
    else {
      if (!streamKey) return json({ error: "A stream key is required for a new destination." }, 400);
      id = await saveStreamDestinationForOrg({ orgId: access.orgId, actorId: access.identity.userId, requestId, kind: "create", fields: { name, platform, rtmpUrl, streamKey } });
    }
    return json({ ok: true, id });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The destination save could not be confirmed. Retry the same change.";
    return json({ error: message }, /not found/i.test(message) ? 404 : /Disable this destination|changed elsewhere|different destination changes/.test(message) ? 409 : 502);
  }
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

async function mobileGraphics(
  request: Request,
  url: URL,
  db: MobileApiDatabase,
): Promise<Response> {
  const access = await authorize(request, url, db, [
    "lowerthird:view",
    "lowerthird:trigger",
    "lowerthird:configure",
  ]);
  if (access instanceof Response) return access;
  const [org, templates, active] = await Promise.all([
    db
      .prepare(
        "SELECT cloud_enabled AS cloudEnabled FROM organization WHERE id = ?",
      )
      .bind(access.orgId)
      .first<{ cloudEnabled: number | boolean }>(),
    db
      .prepare(
        "SELECT id, name, title, subtitle, style, createdAt, updatedAt FROM graphic_template WHERE orgId = ? ORDER BY createdAt",
      )
      .bind(access.orgId)
      .all<Record<string, unknown>>(),
    db
      .prepare(
        "SELECT value FROM app_setting WHERE orgId = ? AND key = 'active-graphics'",
      )
      .bind(access.orgId)
      .first<{ value: string }>(),
  ]);
  return json({
    cloudEnabled: Boolean(org?.cloudEnabled),
    canConfigure: hasAny(access.identity, ["lowerthird:configure"]),
    canTrigger: hasAny(access.identity, ["lowerthird:trigger"]),
    activeIds: parseActiveGraphicIds(active?.value),
    templates: templates.results ?? [],
  });
}

async function writeMobileGraphic(
  request: Request,
  url: URL,
  db: MobileApiDatabase,
  graphicId?: string,
): Promise<Response> {
  const body = await readJson(request);
  const triggerAction = body?.action === "toggle" || body?.action === "clear";
  const access = await authorize(request, url, db, [
    triggerAction ? "lowerthird:trigger" : "lowerthird:configure",
  ]);
  if (access instanceof Response) return access;
  const org = await db
    .prepare("SELECT cloud_enabled AS enabled FROM organization WHERE id = ?")
    .bind(access.orgId)
    .first<{ enabled: number | boolean }>();
  if (!org?.enabled)
    return json(
      { error: "Cloud graphics are not enabled for this organization." },
      403,
    );
  if (body?.action === "clear") {
    await db
      .prepare(
        "DELETE FROM app_setting WHERE orgId = ? AND key IN ('active-graphics', 'active-graphic')",
      )
      .bind(access.orgId)
      .run();
    return json({ ok: true, activeIds: [] });
  }
  if (body?.action === "toggle" && graphicId) {
    const owns = await db
      .prepare("SELECT id FROM graphic_template WHERE id = ? AND orgId = ?")
      .bind(graphicId, access.orgId)
      .first<{ id: string }>();
    if (!owns) return json({ error: "Graphic not found." }, 404);
    const stored = await db
      .prepare(
        "SELECT value FROM app_setting WHERE orgId = ? AND key = 'active-graphics'",
      )
      .bind(access.orgId)
      .first<{ value: string }>();
    const current = parseActiveGraphicIds(stored?.value);
    const next = current.includes(graphicId)
      ? current.filter((id) => id !== graphicId)
      : [...current, graphicId];
    await db
      .prepare(
        `INSERT INTO app_setting (id, orgId, key, value) VALUES (?, ?, 'active-graphics', ?)
       ON CONFLICT(orgId, key) DO UPDATE SET value = excluded.value`,
      )
      .bind(crypto.randomUUID(), access.orgId, JSON.stringify(next))
      .run();
    return json({ ok: true, activeIds: next });
  }
  if (body?.action === "remove" && graphicId) {
    await db
      .prepare("DELETE FROM graphic_template WHERE id = ? AND orgId = ?")
      .bind(graphicId, access.orgId)
      .run();
    return json({ ok: true });
  }
  const name = boundedText(body?.name, 200, true);
  const title = boundedText(body?.title, 500, true);
  const subtitle = boundedText(body?.subtitle, 500);
  if (!name || !title || subtitle === null)
    return json({ error: "Graphic details are invalid." }, 400);
  if (graphicId) {
    const result = await db
      .prepare(
        "UPDATE graphic_template SET name = ?, title = ?, subtitle = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ? AND orgId = ?",
      )
      .bind(name, title, subtitle, graphicId, access.orgId)
      .run();
    return changedExactlyOneRow(result)
      ? json({ ok: true })
      : json({ error: "Graphic not found." }, 404);
  }
  const id = crypto.randomUUID();
  await db
    .prepare(
      "INSERT INTO graphic_template (id, orgId, name, title, subtitle, style, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
    )
    .bind(id, access.orgId, name, title, subtitle)
    .run();
  return json({ ok: true, id });
}

async function mobileDashboard(
  request: Request,
  url: URL,
  db: MobileApiDatabase,
  kind: "pm" | "tm",
): Promise<Response> {
  const permission: Permission =
    kind === "pm" ? "dashboard:pm" : "dashboard:tm";
  const access = await authorize(request, url, db, [permission]);
  if (access instanceof Response) return access;
  const show = await resolveMobileShow(
    db,
    access.orgId,
    access.identity.today,
    url.searchParams.get("showId") ?? undefined,
  );
  const showId = show?.id ?? "";
  const [
    items,
    assignments,
    checklist,
    incidents,
    incidentTotal,
    equipment,
    equipmentAttention,
    inputs,
    destinations,
    devices,
  ] = await Promise.all([
    db
      .prepare(
        "SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'complete' THEN 1 ELSE 0 END) AS complete, SUM(CASE WHEN duration <= 0 THEN 1 ELSE 0 END) AS missingDuration, SUM(CASE WHEN TRIM(assignee) = '' THEN 1 ELSE 0 END) AS missingOwner FROM rundown_item WHERE orgId = ? AND showId = ? AND LOWER(TRIM(type)) NOT IN ('header', 'heading', 'section')",
      )
      .bind(access.orgId, showId)
      .first<Record<string, number | null>>(),
    db
      .prepare(
        "SELECT status, COUNT(*) AS count FROM service_assignment WHERE orgId = ? AND showId = ? GROUP BY status",
      )
      .bind(access.orgId, showId)
      .all<Record<string, unknown>>(),
    db
      .prepare(
        "SELECT COUNT(*) AS total, SUM(CASE WHEN checked = 1 THEN 1 ELSE 0 END) AS complete FROM checklist_entry WHERE orgId = ? AND showId = ?",
      )
      .bind(access.orgId, showId)
      .first<Record<string, number | null>>(),
    db
      .prepare(
        "SELECT id, category, severity, description, status, assignedName, timestamp FROM incident WHERE orgId = ? AND status <> 'resolved' ORDER BY timestamp DESC LIMIT 12",
      )
      .bind(access.orgId)
      .all<Record<string, unknown>>(),
    db
      .prepare(
        "SELECT COUNT(*) AS count FROM incident WHERE orgId = ? AND status <> 'resolved'",
      )
      .bind(access.orgId)
      .first<{ count: number }>(),
    db
      .prepare(
        "SELECT id, name, category, status, nextService FROM equipment WHERE orgId = ? ORDER BY CASE status WHEN 'operational' THEN 1 ELSE 0 END, name LIMIT 30",
      )
      .bind(access.orgId)
      .all<Record<string, unknown>>(),
    db
      .prepare(
        "SELECT COUNT(*) AS count FROM equipment WHERE orgId = ? AND status <> 'operational'",
      )
      .bind(access.orgId)
      .first<{ count: number }>(),
    db
      .prepare(
        "SELECT id, name, status FROM live_input WHERE orgId = ? ORDER BY createdAt",
      )
      .bind(access.orgId)
      .all<Record<string, unknown>>(),
    db
      .prepare(
        "SELECT id, name, platform, enabled, cfOutputId FROM stream_destination WHERE orgId = ? ORDER BY createdAt",
      )
      .bind(access.orgId)
      .all<Record<string, unknown>>(),
    db
      .prepare(
        "SELECT id, name, category, adapterType, enabled FROM device WHERE orgId = ? ORDER BY name",
      )
      .bind(access.orgId)
      .all<Record<string, unknown>>(),
  ]);
  return json({
    kind,
    show,
    items: {
      total: items?.total ?? 0,
      complete: items?.complete ?? 0,
      missingDuration: items?.missingDuration ?? 0,
      missingOwner: items?.missingOwner ?? 0,
    },
    assignments: assignments.results ?? [],
    checklist: {
      total: checklist?.total ?? 0,
      complete: checklist?.complete ?? 0,
    },
    incidents: incidents.results ?? [],
    equipment: equipment.results ?? [],
    totals: {
      openIncidents: incidentTotal?.count ?? 0,
      equipmentAttention: equipmentAttention?.count ?? 0,
    },
    inputs: inputs.results ?? [],
    destinations: (destinations.results ?? []).map((row) => ({
      ...row,
      enabled: Boolean(row.enabled),
      connected: typeof row.cfOutputId === "string" && row.cfOutputId.length > 0 && !row.cfOutputId.startsWith("pending:"),
    })),
    devices: (devices.results ?? []).map((row) => ({
      ...row,
      enabled: Boolean(row.enabled),
    })),
  });
}

async function mobileReports(
  request: Request,
  url: URL,
  db: MobileApiDatabase,
): Promise<Response> {
  const access = await authorize(request, url, db, ["show:view"]);
  if (access instanceof Response) return access;
  const [result, noteResult] = await Promise.all([
    db
      .prepare(MOBILE_REPORT_SUMMARY_SQL)
      .bind(
        access.orgId,
        access.orgId,
        access.orgId,
        access.orgId,
        access.orgId,
      )
      .all<Record<string, unknown>>(),
    db
      .prepare(
        `SELECT id, showId, userId, authorName, role, summary, wins, issues,
            followUps, createdAt, updatedAt
       FROM show_report_note
      WHERE orgId = ? AND showId IN (
        SELECT id FROM rundown WHERE orgId = ?
        ORDER BY serviceDate DESC, scheduledStartTime DESC, createdAt DESC LIMIT 100
      )
      ORDER BY CASE role WHEN 'pm' THEN 0 ELSE 1 END, updatedAt ASC`,
      )
      .bind(access.orgId, access.orgId)
      .all<Record<string, unknown>>(),
  ]);
  return json({
    organization: access.orgId,
    generatedAt: new Date().toISOString(),
    reports: result.results ?? [],
    notes: noteResult.results ?? [],
    viewer: {
      userId: access.identity.userId,
      writableNoteLanes: (["pm", "tm"] as const).filter((lane) =>
        hasAny(access.identity, [
          lane === "pm" ? "dashboard:pm" : "dashboard:tm",
        ]),
      ),
    },
  });
}

async function writeMobileReportNote(
  request: Request,
  url: URL,
  db: MobileApiDatabase,
  showId: string,
): Promise<Response> {
  const body = await readJson(request);
  const lane = body?.role === "pm" || body?.role === "tm" ? body.role : null;
  if (!lane) return json({ error: "A PM or TM note lane is required." }, 400);
  const permission: Permission =
    lane === "pm" ? "dashboard:pm" : "dashboard:tm";
  const access = await authorize(request, url, db, [permission]);
  if (access instanceof Response) return access;
  const fields = {
    summary: boundedText(body?.summary, 4_000),
    wins: boundedText(body?.wins, 4_000),
    issues: boundedText(body?.issues, 4_000),
    followUps: boundedText(body?.followUps, 4_000),
  };
  if (Object.values(fields).some((value) => value === null)) {
    return json(
      { error: "Each report note field may contain at most 4,000 characters." },
      400,
    );
  }
  const show = await db
    .prepare("SELECT id FROM rundown WHERE id = ? AND orgId = ? LIMIT 1")
    .bind(showId, access.orgId)
    .first<{ id: string }>();
  if (!show) return json({ error: "Show not found." }, 404);
  await db
    .prepare(
      `INSERT INTO show_report_note
       (id, orgId, showId, userId, authorName, role, summary, wins, issues,
        followUps, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT(orgId, showId, userId) DO UPDATE SET
       authorName = excluded.authorName,
       role = excluded.role,
       summary = excluded.summary,
       wins = excluded.wins,
       issues = excluded.issues,
       followUps = excluded.followUps,
       updatedAt = CURRENT_TIMESTAMP`,
    )
    .bind(
      crypto.randomUUID(),
      access.orgId,
      showId,
      access.identity.userId,
      access.identity.name,
      lane,
      fields.summary,
      fields.wins,
      fields.issues,
      fields.followUps,
    )
    .run();
  const note = await db
    .prepare(
      `SELECT id, showId, userId, authorName, role, summary, wins, issues,
            followUps, createdAt, updatedAt
       FROM show_report_note
      WHERE orgId = ? AND showId = ? AND userId = ? LIMIT 1`,
    )
    .bind(access.orgId, showId, access.identity.userId)
    .first<Record<string, unknown>>();
  return note
    ? json({ note })
    : json({ error: "The report note did not save." }, 500);
}

async function mobileAudio(
  request: Request,
  url: URL,
  db: MobileApiDatabase,
): Promise<Response> {
  const access = await authorize(request, url, db, ["dashboard:tm"]);
  if (access instanceof Response) return access;
  const show = await resolveMobileShow(
    db,
    access.orgId,
    access.identity.today,
    url.searchParams.get("showId") ?? undefined,
  );
  const [assignments, mixers, shows] = await Promise.all([
    db
      .prepare(
        `SELECT id, showId, channel, label, micType, micModel, notes, gainDb, phantom, muted, "group",
        mixerConsole, mixerChannel, mixerChannelType, serviceDate, updatedAt
       FROM mic_assignment WHERE orgId = ? AND showId = ? ORDER BY channel, createdAt`,
      )
      .bind(access.orgId, show?.id ?? "")
      .all<Record<string, unknown>>(),
    db
      .prepare(
        "SELECT id, name, adapterType FROM device WHERE orgId = ? AND category = 'mixer' AND enabled = 1 ORDER BY name",
      )
      .bind(access.orgId)
      .all<Record<string, unknown>>(),
    db
      .prepare(
        "SELECT id, serviceDate, name, scheduledStartTime FROM rundown WHERE orgId = ? ORDER BY serviceDate DESC, scheduledStartTime DESC",
      )
      .bind(access.orgId)
      .all<Record<string, unknown>>(),
  ]);
  return json({
    show,
    shows: shows.results ?? [],
    mixers: mixers.results ?? [],
    assignments: (assignments.results ?? []).map((row) => ({
      ...row,
      phantom: Boolean(row.phantom),
      muted: Boolean(row.muted),
    })),
  });
}

async function writeMobileAudio(
  request: Request,
  url: URL,
  db: MobileApiDatabase,
  assignmentId?: string,
): Promise<Response> {
  const access = await authorize(request, url, db, ["dashboard:tm"]);
  if (access instanceof Response) return access;
  const body = await readJson(request);
  if (body?.action === "remove" && assignmentId) {
    const result = await db
      .prepare("DELETE FROM mic_assignment WHERE id = ? AND orgId = ?")
      .bind(assignmentId, access.orgId)
      .run();
    return changedExactlyOneRow(result)
      ? json({ ok: true })
      : json({ error: "Audio assignment not found." }, 404);
  }
  if (
    !validId(body?.showId) ||
    typeof body?.channel !== "number" ||
    !Number.isInteger(body.channel) ||
    body.channel < 1 ||
    body.channel > 512
  ) {
    return json(
      { error: "A show and channel from 1 to 512 are required." },
      400,
    );
  }
  const label = boundedText(body.label, 200, true);
  const micType =
    typeof body.micType === "string" && micTypes.has(body.micType)
      ? body.micType
      : null;
  const group =
    typeof body.group === "string" && micGroups.has(body.group)
      ? body.group
      : null;
  const micModel = boundedText(body.micModel, 200);
  const notes = boundedText(body.notes, 2_000);
  const mixerConsole = boundedText(body.mixerConsole, 200);
  if (
    !label ||
    !micType ||
    !group ||
    micModel === null ||
    notes === null ||
    mixerConsole === null
  )
    return json({ error: "Audio assignment details are invalid." }, 400);
  const gainDb =
    body.gainDb === null || body.gainDb === undefined
      ? null
      : typeof body.gainDb === "number" &&
          Number.isFinite(body.gainDb) &&
          body.gainDb >= -200 &&
          body.gainDb <= 200
        ? body.gainDb
        : undefined;
  const mixerChannel =
    body.mixerChannel === null || body.mixerChannel === undefined
      ? null
      : typeof body.mixerChannel === "number" &&
          Number.isInteger(body.mixerChannel) &&
          body.mixerChannel >= 0 &&
          body.mixerChannel <= 10_000
        ? body.mixerChannel
        : undefined;
  const mixerChannelType = boundedText(body.mixerChannelType, 80);
  if (
    gainDb === undefined ||
    mixerChannel === undefined ||
    mixerChannelType === null
  ) {
    return json(
      { error: "Audio gain and mixer channel details are invalid." },
      400,
    );
  }
  const show = await db
    .prepare("SELECT id, serviceDate FROM rundown WHERE id = ? AND orgId = ?")
    .bind(body.showId, access.orgId)
    .first<{ id: string; serviceDate: string }>();
  if (!show) return json({ error: "Show not found." }, 404);
  const values = [
    body.channel,
    label,
    micType,
    micModel,
    notes,
    gainDb,
    body.phantom === true,
    body.muted === true,
    group,
    mixerConsole,
    mixerChannel,
    mixerChannelType,
  ] as const;
  if (assignmentId) {
    const result = await db
      .prepare(
        `UPDATE mic_assignment SET showId = ?, serviceDate = ?, channel = ?, label = ?, micType = ?, micModel = ?, notes = ?, gainDb = ?, phantom = ?, muted = ?, "group" = ?, mixerConsole = ?, mixerChannel = ?, mixerChannelType = ?, updatedAt = CURRENT_TIMESTAMP
       WHERE id = ? AND orgId = ? AND showId = ?`,
      )
      .bind(
        show.id,
        show.serviceDate,
        ...values,
        assignmentId,
        access.orgId,
        show.id,
      )
      .run();
    return changedExactlyOneRow(result)
      ? json({ ok: true })
      : json(
          {
            error:
              "This input belongs to another show. Reopen that show before saving it.",
          },
          409,
        );
  }
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO mic_assignment (id, orgId, showId, channel, label, micType, micModel, notes, gainDb, phantom, muted, "group", mixerConsole, mixerChannel, mixerChannelType, serviceDate, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    )
    .bind(id, access.orgId, show.id, ...values, show.serviceDate)
    .run();
  return json({ ok: true, id });
}

const reportReasons = new Set([
  "harassment",
  "hate",
  "sexual",
  "violence",
  "spam",
  "other",
]);

async function mobileContentSafety(
  request: Request,
  url: URL,
  db: MobileApiDatabase,
): Promise<Response> {
  const access = await authorize(request, url, db);
  if (access instanceof Response) return access;
  const rows = await db
    .prepare(
      "SELECT blockedUserId FROM content_block WHERE orgId = ? AND blockerUserId = ? ORDER BY createdAt ASC",
    )
    .bind(access.orgId, access.identity.userId)
    .all<{ blockedUserId: string }>();
  return json({
    blockedUserIds: (rows.results ?? []).map((row) => row.blockedUserId),
  });
}

async function reportMobileContent(
  request: Request,
  url: URL,
  db: MobileApiDatabase,
): Promise<Response> {
  const access = await authorize(request, url, db);
  if (access instanceof Response) return access;
  const body = await readJson(request);
  const targetType =
    body?.targetType === "chat-message" ||
    body?.targetType === "incident-comment"
      ? body.targetType
      : null;
  const reason =
    typeof body?.reason === "string" && reportReasons.has(body.reason)
      ? body.reason
      : null;
  const details = boundedText(body?.details, 1_000);
  const targetAuthorId = validId(body?.targetAuthorId)
    ? body.targetAuthorId
    : null;
  if (!targetType || !validId(body?.targetId) || !reason || details === null) {
    return json({ error: "Choose a reason for this report." }, 400);
  }
  const reportId = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO content_report (id, orgId, reporterUserId, targetType, targetId, targetAuthorId, reason, details, status, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', CURRENT_TIMESTAMP)`,
    )
    .bind(
      reportId,
      access.orgId,
      access.identity.userId,
      targetType,
      body.targetId,
      targetAuthorId,
      reason,
      details,
    )
    .run();

  const reviewers = await db
    .prepare(
      "SELECT userId FROM member WHERE organizationId = ? AND role IN ('owner', 'admin', 'td', 'cd', 'pd')",
    )
    .bind(access.orgId)
    .all<{ userId: string }>();
  try {
    const { notifyOperationalEvent } =
      await import("./operational-notifications.server");
    await notifyOperationalEvent({
      orgId: access.orgId,
      actorId: access.identity.userId,
      recipientIds: (reviewers.results ?? []).map(
        (reviewer) => reviewer.userId,
      ),
      category: "system",
      type: "content-report",
      severity: "warning",
      title: "Content report needs review",
      message: `${access.identity.name} reported ${targetType.replace("-", " ")} for ${reason}.`,
      actionUrl: "team",
      source: reportId,
      pushTag: `content-report-${reportId}`,
      dedupeKey: `content-report:${reportId}`,
    });
  } catch {
    // The report remains available to reviewers when notification delivery fails.
  }
  return json({ ok: true, reportId }, 201);
}

async function blockMobileUser(
  request: Request,
  url: URL,
  db: MobileApiDatabase,
): Promise<Response> {
  const access = await authorize(request, url, db);
  if (access instanceof Response) return access;
  const body = await readJson(request);
  if (
    !validId(body?.blockedUserId) ||
    body.blockedUserId === access.identity.userId
  ) {
    return json({ error: "Choose another organization member to block." }, 400);
  }
  const member = await db
    .prepare(
      "SELECT userId FROM member WHERE organizationId = ? AND userId = ? LIMIT 1",
    )
    .bind(access.orgId, body.blockedUserId)
    .first<{ userId: string }>();
  if (!member)
    return json({ error: "That person is not in this organization." }, 404);
  await db
    .prepare(
      `INSERT OR IGNORE INTO content_block (id, orgId, blockerUserId, blockedUserId, createdAt)
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    )
    .bind(
      crypto.randomUUID(),
      access.orgId,
      access.identity.userId,
      body.blockedUserId,
    )
    .run();
  return json({ ok: true });
}

export async function handleMobileApi(
  request: Request,
  env: MobileApiEnvironment,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/mobile/v1/")) return null;
  if (contentLengthExceeds(request, 3_250_000)) {
    return json({ error: "Request payload is too large." }, 413);
  }
  if ((url.pathname === "/api/mobile/v1/workspace/change" && ["GET", "POST"].includes(request.method)) ||
      (url.pathname === "/api/mobile/v1/workspace/review-change" && request.method === "POST")) {
    const { workspaceScopeSchema, workspaceChangeSchema } = await import("@showpilot/shared/workspace-change");
    const { readWorkspaceChange, writeWorkspaceChange, WorkspaceChangeAccessError } = await import("./workspace/change.server");
    const { getD1 } = await import("./d1");
    const read = request.method === "GET";
    const parsed = read ? workspaceScopeSchema.safeParse({ orgId: url.searchParams.get("orgId"), userId: url.searchParams.get("userId") })
      : workspaceChangeSchema.safeParse(await readJson(request));
    if (!parsed.success) return json({ error: "Check the workspace change and account." }, 400);
    try {
      if (read) return json(await readWorkspaceChange(request.headers, parsed.data, getD1()));
      return json(await writeWorkspaceChange(request.headers, workspaceChangeSchema.parse(parsed.data), url.pathname.endsWith("/review-change") ? "review" : "save", getD1()));
    } catch (error) {
      return json({ error: error instanceof WorkspaceChangeAccessError ? error.message : "Workspace change could not be confirmed. Retry or review the original change." }, error instanceof WorkspaceChangeAccessError ? 403 : 503);
    }
  }
  if (
    [
      "/api/mobile/v1/workspace/type",
      "/api/mobile/v1/workspace/modules",
      "/api/mobile/v1/workspace/initial",
    ].includes(url.pathname) &&
    request.method === "POST"
  )
    return saveMobileWorkspace(request, url, env.DB);
  if (url.pathname === "/api/mobile/v1/timecode/choices" && request.method === "GET")
    return timecodeChoices(request, url, env);
  if (url.pathname === "/api/mobile/v1/timecode/shows" && request.method === "GET")
    return timecodeShows(request, url, env.DB);
  if (url.pathname === "/api/mobile/v1/bootstrap" && request.method === "GET")
    return bootstrap(request, url, env.DB);
  if (["/api/mobile/v1/shows/create", "/api/mobile/v1/shows/review-creation"].includes(url.pathname) && request.method === "POST")
    return recoverMobileShowCreation(request, env.DB, url.pathname.endsWith("/review-creation"));
  if (url.pathname === "/api/mobile/v1/rundowns" && request.method === "POST")
    return createRundown(request, env.DB);
  if (url.pathname === "/api/mobile/v1/schedule" && request.method === "GET")
    return schedule(request, url, env.DB);
  if (request.method === "POST" && ["/api/mobile/v1/schedule/shows/command", "/api/mobile/v1/schedule/shows/review"].includes(url.pathname))
    return commandMobileShowManagement(request, url, env, url.pathname.endsWith("/review"));
  const managedShowRead = url.pathname.match(/^\/api\/mobile\/v1\/schedule\/shows\/([^/]+)$/);
  if (managedShowRead && request.method === "GET")
    return readMobileManagedShow(request, url, decodeURIComponent(managedShowRead[1]), env.DB);
  if (request.method === "POST" && ["/api/mobile/v1/schedule/assignments/command", "/api/mobile/v1/schedule/assignments/review"].includes(url.pathname))
    return commandMobileAssignment(request, url, env.DB, url.pathname.endsWith("/review"));
  const mobileAssignmentRead = url.pathname.match(/^\/api\/mobile\/v1\/schedule\/assignments\/([^/]+)$/);
  if (mobileAssignmentRead && request.method === "GET")
    return readMobileAssignment(request, url, decodeURIComponent(mobileAssignmentRead[1]), env.DB);
  if (url.pathname === "/api/mobile/v1/schedule/copy-team" && request.method === "POST")
    return commandMobileScheduleCopy(request, url, env.DB);
  if (url.pathname === "/api/mobile/v1/schedule/reminders" && request.method === "POST")
    return commandMobileScheduleReminder(request, url, env.DB);
  if (
    url.pathname === "/api/mobile/v1/schedule/respond" &&
    request.method === "POST"
  )
    return respondToAssignment(request, env.DB);
  if (url.pathname === "/api/mobile/v1/schedule/review-response" && request.method === "POST")
    return respondToAssignment(request, env.DB, true);
  if (
    url.pathname === "/api/mobile/v1/schedule/assignments" &&
    request.method === "POST"
  )
    return createMobileScheduleAssignment(request, url, env.DB);
  if ((url.pathname === "/api/mobile/v1/schedule/inventory/command" || url.pathname === "/api/mobile/v1/schedule/inventory/review") && request.method === "POST")
    return commandMobileShowInventory(request, url, env.DB, url.pathname.endsWith("/review"));
  if (
    url.pathname === "/api/mobile/v1/schedule/inventory" &&
    request.method === "POST"
  )
    return createMobileShowInventory(request, url, env.DB);
  if (
    url.pathname === "/api/mobile/v1/schedule/provider" &&
    (request.method === "POST" || request.method === "GET")
  )
    return mobileScheduleProvider(request, url, env.DB);
  if (
    url.pathname === "/api/mobile/v1/incidents/history" &&
    request.method === "GET"
  )
    return mobileIncidentHistory(request, url, env.DB);
  if (url.pathname === "/api/mobile/v1/incidents" && request.method === "GET")
    return incidents(request, url, env.DB);
  if (url.pathname === "/api/mobile/v1/incidents" && request.method === "POST")
    return createIncident(request, url, env.DB);
  if (
    url.pathname === "/api/mobile/v1/chat/members" &&
    request.method === "GET"
  )
    return chatMembers(request, url, env.DB);
  if (
    url.pathname === "/api/mobile/v1/chat/notify" &&
    request.method === "POST"
  )
    return notifyMobileChatMessage(request, url, env.DB);
  if (
    url.pathname === "/api/mobile/v1/chat/reaction-notify" &&
    request.method === "POST"
  )
    return notifyMobileChatReaction(request, url, env.DB);
  if (
    url.pathname === "/api/mobile/v1/content-safety" &&
    request.method === "GET"
  )
    return mobileContentSafety(request, url, env.DB);
  if (
    url.pathname === "/api/mobile/v1/content-safety/report" &&
    request.method === "POST"
  )
    return reportMobileContent(request, url, env.DB);
  if (
    url.pathname === "/api/mobile/v1/content-safety/block" &&
    request.method === "POST"
  )
    return blockMobileUser(request, url, env.DB);
  if (
    url.pathname === "/api/mobile/v1/chat/passes/crew" &&
    request.method === "POST"
  )
    return createMobileChatPass(request, url, env, "crew-chat");
  if (
    url.pathname === "/api/mobile/v1/chat/passes/planning" &&
    request.method === "POST"
  )
    return createMobileChatPass(request, url, env, "planning-chat");
  if (url.pathname === "/api/mobile/v1/checkin" && request.method === "GET")
    return checkIn(request, url, env.DB);
  if (url.pathname === "/api/mobile/v1/show-board" && request.method === "GET")
    return showBoard(request, url, env.DB);
  if (
    url.pathname === "/api/mobile/v1/show-workspace" &&
    request.method === "GET"
  )
    return showWorkspace(request, url, env.DB);
  if (
    url.pathname === "/api/mobile/v1/team/members" &&
    request.method === "GET"
  )
    return teamMembers(request, url, env.DB);
  if (
    url.pathname === "/api/mobile/v1/team/invitations" &&
    request.method === "POST"
  )
    return inviteTeamMember(request, url, env.DB);
  if (url.pathname === "/api/mobile/v1/team/invitations/retry-delivery" && request.method === "POST")
    return retryMobileInvitationDelivery(request, url, env.DB);
  if (["/api/mobile/v1/team/crew/command", "/api/mobile/v1/team/crew/review"].includes(url.pathname) && request.method === "POST")
    return recoverMobileCrew(request, url, env.DB, url.pathname.endsWith("/review"));
  if (url.pathname === "/api/mobile/v1/team/crew/profile" && request.method === "GET")
    return readMobileCrewProfile(request, url, env.DB);
  if (url.pathname === "/api/mobile/v1/team/crew" && request.method === "GET")
    return teamCrew(request, url, env.DB);
  if (url.pathname === "/api/mobile/v1/team/crew" && request.method === "POST")
    return createTeamCrewMember(request, url, env.DB);
  if (url.pathname === "/api/mobile/v1/team/access" && request.method === "GET")
    return teamAccess(request, url, env.DB);
  if (url.pathname === "/api/mobile/v1/team/access/retry-notification" && request.method === "POST")
    return retryTeamAccessNotice(request, url, env.DB);
  if (
    url.pathname === "/api/mobile/v1/team/access/grants" &&
    request.method === "POST"
  )
    return grantTeamAccess(request, url, env.DB);
  if (url.pathname === "/api/mobile/v1/devices" && request.method === "GET")
    return devices(request, url, env);
  if (url.pathname === "/api/mobile/v1/devices" && request.method === "POST")
    return createMobileDevice(request, url, env);
  if (
    url.pathname === "/api/mobile/v1/checklist/shows" &&
    request.method === "GET"
  )
    return checklistShows(request, url, env.DB);
  if (url.pathname === "/api/mobile/v1/checklist" && request.method === "GET")
    return checklist(request, url, env.DB);
  if (
    url.pathname === "/api/mobile/v1/checklist/items" &&
    request.method === "POST"
  )
    return addChecklistItemMobile(request, url, env.DB);
  if (
    url.pathname === "/api/mobile/v1/checklist/suggestions" &&
    request.method === "GET"
  )
    return checklistSuggestions(request, url, env.DB);
  if (
    url.pathname === "/api/mobile/v1/checklist/suggestions/apply" &&
    request.method === "POST"
  )
    return applyChecklistSuggestions(request, url, env.DB);
  if (
    url.pathname === "/api/mobile/v1/notifications/read" &&
    request.method === "POST"
  )
    return notificationRead(request, env.DB);
  if (
    url.pathname === "/api/mobile/v1/notifications" &&
    request.method === "GET"
  )
    return notificationPage(request, url, env.DB);
  if (
    url.pathname === "/api/mobile/v1/notification-preferences" &&
    (request.method === "GET" || request.method === "POST")
  ) {
    return mobileNotificationPreferences(request, url, env.DB);
  }
  if (url.pathname === "/api/mobile/v1/push-token" && request.method === "POST")
    return pushToken(request, env.DB);
  if (url.pathname === "/api/mobile/v1/cue-sheets") {
    if (request.method === "GET") return mobileCueSheet(request, url, env.DB);
    if (request.method === "POST")
      return writeMobileCueSheet(request, url, env.DB);
  }
  if (url.pathname === "/api/mobile/v1/assets") {
    if (request.method === "GET") return mobileAssets(request, url, env.DB);
    if (request.method === "POST")
      return writeMobileAsset(request, url, env.DB);
  }
  if (url.pathname === "/api/mobile/v1/streaming" && request.method === "GET")
    return mobileStreaming(request, url, env.DB);
  if (
    url.pathname === "/api/mobile/v1/streaming/destinations" &&
    request.method === "POST"
  )
    return writeMobileDestination(request, url, env.DB);
  if (url.pathname === "/api/mobile/v1/graphics") {
    if (request.method === "GET") return mobileGraphics(request, url, env.DB);
    if (request.method === "POST")
      return writeMobileGraphic(request, url, env.DB);
  }
  if (url.pathname === "/api/mobile/v1/reports" && request.method === "GET")
    return mobileReports(request, url, env.DB);
  if (url.pathname === "/api/mobile/v1/audio") {
    if (request.method === "GET") return mobileAudio(request, url, env.DB);
    if (request.method === "POST")
      return writeMobileAudio(request, url, env.DB);
  }
  const mobileDashboardMatch = url.pathname.match(
    /^\/api\/mobile\/v1\/dashboards\/(pm|tm)$/,
  );
  if (mobileDashboardMatch && request.method === "GET")
    return mobileDashboard(
      request,
      url,
      env.DB,
      mobileDashboardMatch[1] as "pm" | "tm",
    );
  const mobileReportNoteMatch = url.pathname.match(
    /^\/api\/mobile\/v1\/reports\/([^/]+)\/notes$/,
  );
  if (mobileReportNoteMatch && request.method === "POST") {
    const showId = decodePathId(mobileReportNoteMatch[1]);
    return showId
      ? writeMobileReportNote(request, url, env.DB, showId)
      : json({ error: "Show not found." }, 404);
  }
  const mobileAssetMatch = url.pathname.match(
    /^\/api\/mobile\/v1\/assets\/([^/]+)$/,
  );
  if (mobileAssetMatch && request.method === "POST") {
    const assetId = decodePathId(mobileAssetMatch[1]);
    return assetId
      ? writeMobileAsset(request, url, env.DB, assetId)
      : json({ error: "Asset not found." }, 404);
  }
  const mobileDestinationMatch = url.pathname.match(
    /^\/api\/mobile\/v1\/streaming\/destinations\/([^/]+)$/,
  );
  if (mobileDestinationMatch && request.method === "POST") {
    const destinationId = decodePathId(mobileDestinationMatch[1]);
    return destinationId
      ? writeMobileDestination(request, url, env.DB, destinationId)
      : json({ error: "Destination not found." }, 404);
  }
  const mobileGraphicMatch = url.pathname.match(
    /^\/api\/mobile\/v1\/graphics\/([^/]+)$/,
  );
  if (mobileGraphicMatch && request.method === "POST") {
    const graphicId = decodePathId(mobileGraphicMatch[1]);
    return graphicId
      ? writeMobileGraphic(request, url, env.DB, graphicId)
      : json({ error: "Graphic not found." }, 404);
  }
  const mobileAudioMatch = url.pathname.match(
    /^\/api\/mobile\/v1\/audio\/([^/]+)$/,
  );
  if (mobileAudioMatch && request.method === "POST") {
    const assignmentId = decodePathId(mobileAudioMatch[1]);
    return assignmentId
      ? writeMobileAudio(request, url, env.DB, assignmentId)
      : json({ error: "Audio assignment not found." }, 404);
  }
  const checkInMemberMatch = url.pathname.match(
    /^\/api\/mobile\/v1\/checkin\/members\/([^/]+)\/status$/,
  );
  if (checkInMemberMatch && request.method === "POST") {
    const memberId = decodePathId(checkInMemberMatch[1]);
    return memberId
      ? setCheckInStatus(request, url, memberId, env.DB)
      : json({ error: "Not found." }, 404);
  }
  const incidentMatch = url.pathname.match(
    /^\/api\/mobile\/v1\/incidents\/([^/]+)\/(command|update|remove)$/,
  );
  if (incidentMatch && request.method === "POST") {
    const incidentId = decodeURIComponent(incidentMatch[1] ?? "");
    if (!validId(incidentId))
      return json({ error: "A valid incident id is required." }, 400);
    if (incidentMatch[2] === "command")
      return commandIncident(request, url, incidentId, env.DB);
    if (incidentMatch[2] === "update")
      return updateMobileIncident(request, url, incidentId, env.DB);
    return deleteMobileIncident(request, url, incidentId, env.DB);
  }
  const incidentCommentMatch = url.pathname.match(
    /^\/api\/mobile\/v1\/incidents\/([^/]+)\/comments$/,
  );
  if (incidentCommentMatch && request.method === "POST") {
    const incidentId = decodePathId(incidentCommentMatch[1]);
    return incidentId
      ? addMobileIncidentComment(request, url, incidentId, env.DB)
      : json({ error: "Not found." }, 404);
  }
  const incidentReactionMatch = url.pathname.match(
    /^\/api\/mobile\/v1\/incident-comments\/([^/]+)\/reaction$/,
  );
  if (incidentReactionMatch && request.method === "POST") {
    const commentId = decodePathId(incidentReactionMatch[1]);
    return commentId
      ? setMobileIncidentReaction(request, url, commentId, env.DB)
      : json({ error: "Not found." }, 404);
  }
  const teamGrantMatch = url.pathname.match(
    /^\/api\/mobile\/v1\/team\/access\/grants\/([^/]+)\/revoke$/,
  );
  if (teamGrantMatch && request.method === "POST") {
    const grantId = decodePathId(teamGrantMatch[1]);
    return grantId
      ? revokeTeamAccess(request, url, grantId, env.DB)
      : json({ error: "Not found." }, 404);
  }
  const teamInvitationMatch = url.pathname.match(
    /^\/api\/mobile\/v1\/team\/invitations\/([^/]+)\/cancel$/,
  );
  if (teamInvitationMatch && request.method === "POST") {
    const invitationId = decodeURIComponent(teamInvitationMatch[1] ?? "");
    if (!validId(invitationId))
      return json({ error: "A valid invitationId is required." }, 400);
    return cancelTeamInvitation(request, url, invitationId, env.DB);
  }
  const teamMemberMatch = url.pathname.match(
    /^\/api\/mobile\/v1\/team\/members\/([^/]+)\/(role|remove)$/,
  );
  if (teamMemberMatch && request.method === "POST") {
    const memberId = decodeURIComponent(teamMemberMatch[1] ?? "");
    if (!validId(memberId))
      return json({ error: "A valid memberId is required." }, 400);
    return teamMemberMatch[2] === "role"
      ? updateTeamMemberRole(request, url, memberId, env.DB)
      : removeTeamMember(request, url, memberId, env.DB);
  }
  const teamCrewMatch = url.pathname.match(
    /^\/api\/mobile\/v1\/team\/crew\/([^/]+)\/(update|remove)$/,
  );
  if (teamCrewMatch && request.method === "POST") {
    const memberId = decodeURIComponent(teamCrewMatch[1] ?? "");
    if (!validId(memberId))
      return json({ error: "A valid crew member id is required." }, 400);
    return teamCrewMatch[2] === "update"
      ? updateTeamCrewMember(request, url, memberId, env.DB)
      : removeTeamCrewMember(request, url, memberId, env.DB);
  }
  const checklistEntryMatch = url.pathname.match(
    /^\/api\/mobile\/v1\/checklist\/entries\/([^/]+)\/(toggle|remove)$/,
  );
  if (checklistEntryMatch && request.method === "POST") {
    const entryId = decodePathId(checklistEntryMatch[1]);
    if (!entryId) return json({ error: "Not found." }, 404);
    return checklistEntryMatch[2] === "toggle"
      ? toggleChecklistEntryMobile(request, url, entryId, env.DB)
      : removeChecklistEntryMobile(request, url, entryId, env.DB);
  }
  const checklistEntryCategoryMatch = url.pathname.match(
    /^\/api\/mobile\/v1\/checklist\/entries\/([^/]+)\/category$/,
  );
  if (checklistEntryCategoryMatch && request.method === "POST") {
    const entryId = decodePathId(checklistEntryCategoryMatch[1]);
    return entryId
      ? updateChecklistCategoryMobile(request, url, entryId, env.DB)
      : json({ error: "Not found." }, 404);
  }
  const deviceControlMatch = url.pathname.match(
    /^\/api\/mobile\/v1\/devices\/([^/]+)\/control$/,
  );
  if (
    deviceControlMatch &&
    (request.method === "GET" || request.method === "POST")
  ) {
    const deviceId = decodePathId(deviceControlMatch[1]);
    if (!deviceId) return json({ error: "Not found." }, 404);
    return request.method === "GET"
      ? deviceControlState(request, url, deviceId, env)
      : controlDevice(request, url, deviceId, env);
  }
  const deviceWriteMatch = url.pathname.match(
    /^\/api\/mobile\/v1\/devices\/([^/]+)(?:\/(remove))?$/,
  );
  if (deviceWriteMatch && request.method === "POST") {
    const deviceId = decodePathId(deviceWriteMatch[1]);
    if (!deviceId) return json({ error: "Not found." }, 404);
    return deviceWriteMatch[2] === "remove"
      ? deleteMobileDevice(request, url, deviceId, env)
      : updateMobileDevice(request, url, deviceId, env);
  }
  const scheduleAssignmentMatch = url.pathname.match(
    /^\/api\/mobile\/v1\/schedule\/assignments\/([^/]+)(?:\/(remove|remind))?$/,
  );
  if (scheduleAssignmentMatch && request.method === "POST") {
    const assignmentId = decodePathId(scheduleAssignmentMatch[1]);
    if (!assignmentId) return json({ error: "Not found." }, 404);
    if (scheduleAssignmentMatch[2] === "remove")
      return deleteMobileScheduleAssignment(request, url, assignmentId, env.DB);
    if (scheduleAssignmentMatch[2] === "remind")
      return remindMobileScheduleAssignments(
        request,
        url,
        { assignmentId },
        env.DB,
      );
    return updateMobileScheduleAssignment(request, url, assignmentId, env.DB);
  }
  const scheduleInventoryMatch = url.pathname.match(
    /^\/api\/mobile\/v1\/schedule\/inventory\/([^/]+)\/(archive|restore)$/,
  );
  if (scheduleInventoryMatch && request.method === "POST") {
    const inventoryId = decodePathId(scheduleInventoryMatch[1]);
    if (!inventoryId) return json({ error: "Inventory item not found." }, 404);
    return setMobileShowInventoryArchived(
      request,
      url,
      inventoryId,
      scheduleInventoryMatch[2] === "archive",
      env.DB,
    );
  }
  const scheduleServiceMatch = url.pathname.match(
    /^\/api\/mobile\/v1\/schedule\/services\/([^/]+)(?:\/(remove|remind|copy-team))?$/,
  );
  if (scheduleServiceMatch && request.method === "POST") {
    const showId = decodePathId(scheduleServiceMatch[1]);
    if (!showId) return json({ error: "Not found." }, 404);
    if (scheduleServiceMatch[2] === "remove")
      return deleteMobileScheduleService(request, url, showId, env.DB);
    if (scheduleServiceMatch[2] === "remind")
      return remindMobileScheduleAssignments(request, url, { showId }, env.DB);
    if (scheduleServiceMatch[2] === "copy-team")
      return copyMobileScheduleTeam(request, url, showId, env.DB);
    return updateMobileScheduleService(request, url, showId, env);
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
  const rundownTemplatesMatch = url.pathname.match(
    /^\/api\/mobile\/v1\/rundowns\/([^/]+)\/templates$/,
  );
  if (rundownTemplatesMatch) {
    const showId = decodePathId(rundownTemplatesMatch[1]);
    if (!showId) return json({ error: "Not found." }, 404);
    if (request.method === "GET")
      return mobileRundownTemplates(request, url, showId, env.DB);
    if (request.method === "POST")
      return saveMobileRundownTemplate(request, url, showId, env.DB);
  }
  const templateSaveMatch = url.pathname.match(/^\/api\/mobile\/v1\/rundowns\/([^/]+)\/templates\/(command|review)$/);
  if (templateSaveMatch && request.method === "POST") {
    const showId = decodePathId(templateSaveMatch[1]);
    return showId ? recoverMobileTemplateSave(request, url, showId, env, templateSaveMatch[2] === "review") : json({ error: "Not found." }, 404);
  }
  const replacementMatch=url.pathname.match(/^\/api\/mobile\/v1\/rundowns\/([^/]+)\/replacement(?:\/(command|review))?$/);
  if(replacementMatch && ((request.method === "GET" && !replacementMatch[2]) || (request.method === "POST" && replacementMatch[2]))) {
    const showId=decodePathId(replacementMatch[1]);
    return showId ? recoverMobileRundownReplacement(request,url,showId,env,replacementMatch[2] === "command" ? "save" : replacementMatch[2] === "review" ? "review" : "read") : json({error:"Not found."},404);
  }
  const rundownChangeMatch=url.pathname.match(/^\/api\/mobile\/v1\/rundowns\/([^/]+)\/(change|reset|stage)$/);
  if(rundownChangeMatch && request.method === "POST"){
    const showId=decodePathId(rundownChangeMatch[1]);
    return showId ? changeMobileRundown(request,url,showId,env,rundownChangeMatch[2] === "reset" ? "reset" : rundownChangeMatch[2] === "stage" ? "stage" : "edit") : json({error:"Not found."},404);
  }
  const rundownDetailsMatch = url.pathname.match(/^\/api\/mobile\/v1\/rundowns\/([^/]+)\/details(?:\/(command|review))?$/);
  if (rundownDetailsMatch && ((request.method === "GET" && !rundownDetailsMatch[2]) || (request.method === "POST" && rundownDetailsMatch[2]))) {
    const showId = decodePathId(rundownDetailsMatch[1]);
    return showId ? recoverMobileRundownDetails(request, url, showId, env,
      request.method === "GET" ? "read" : rundownDetailsMatch[2] === "review" ? "review" : "save") : json({ error: "Not found." }, 404);
  }
  const rundownMetaMatch = url.pathname.match(
    /^\/api\/mobile\/v1\/rundowns\/([^/]+)\/meta$/,
  );
  if (rundownMetaMatch && request.method === "POST") {
    const showId = decodePathId(rundownMetaMatch[1]);
    return showId
      ? updateMobileRundownMeta(request, url, showId, env)
      : json({ error: "Not found." }, 404);
  }
  const rundownProPresenterMatch = url.pathname.match(
    /^\/api\/mobile\/v1\/rundowns\/([^/]+)\/propresenter(?:\/(prepare|execute|check))?$/,
  );
  if (rundownProPresenterMatch && request.method === "POST") {
    const showId = decodePathId(rundownProPresenterMatch[1]);
    return showId
      ? controlMobileProPresenter(request, url, showId, env, rundownProPresenterMatch[2] === "prepare" ? "prepare" : rundownProPresenterMatch[2] === "check" ? "check" : "execute")
      : json({ error: "Not found." }, 404);
  }
  if (url.pathname === "/api/mobile/v1/propresenter/output" && ["GET", "POST"].includes(request.method)) {
    return mobileProPresenterOutput(request, url, env);
  }
  const rundownProPresenterStageDisplayMatch = url.pathname.match(
    /^\/api\/mobile\/v1\/rundowns\/([^/]+)\/propresenter\/stage-display$/,
  );
  if (rundownProPresenterStageDisplayMatch && request.method === "POST") {
    const showId = decodePathId(rundownProPresenterStageDisplayMatch[1]);
    return showId
      ? json({ error: "Update the app before changing ProPresenter output." }, 400)
      : json({ error: "Not found." }, 404);
  }
  const rundownMatch = url.pathname.match(
    /^\/api\/mobile\/v1\/rundowns\/([^/]+)$/,
  );
  if (rundownMatch && request.method === "GET") {
    const showId = decodePathId(rundownMatch[1]);
    return showId
      ? rundown(request, url, showId, env)
      : json({ error: "Not found." }, 404);
  }
  return json({ error: "Not found." }, 404);
}
