import { z } from "zod";
import { fetch as expoFetch, type FetchRequestInit } from "expo/fetch";
import { File, Paths } from "expo-file-system";
import { Platform } from "react-native";
import { getAuthenticatedFetchCredentials, getNativeCookieHeader } from "@/lib/auth-transport";
import { SHOWPILOT_URL } from "@/lib/env";

const managedAvatarPath = /^\/api\/user\/avatar\/[^/?#]+\.jpg$/;

export function resolveMobileAvatarUrl(value: string | null | undefined): string | null {
  const candidate = value?.trim();
  if (!candidate) return null;

  if (candidate.startsWith("/")) {
    const parsed = new URL(candidate, SHOWPILOT_URL);
    return managedAvatarPath.test(parsed.pathname)
      ? `${SHOWPILOT_URL}${parsed.pathname}${parsed.search}`
      : null;
  }

  try {
    const parsed = new URL(candidate);
    if (managedAvatarPath.test(parsed.pathname)) {
      return `${SHOWPILOT_URL}${parsed.pathname}${parsed.search}`;
    }
    if (parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

const avatarUploadSchema = z.object({
  url: z.string().refine((value) => resolveMobileAvatarUrl(value) !== null, "Invalid avatar URL"),
});

const rundownSchema = z.object({
  id: z.string(),
  serviceDate: z.string(),
  name: z.string(),
  scheduledStartTime: z.string().nullable(),
  location: z.string(),
  status: z.string(),
  itemCount: z.number(),
});

const notificationSchema = z.object({
  id: z.string(),
  type: z.string(),
  severity: z.string(),
  title: z.string(),
  message: z.string(),
  actionUrl: z.string(),
  source: z.string(),
  createdAt: z.string(),
  readAt: z.string().nullable(),
});

const chatMemberSchema = z.object({
  userId: z.string(),
  role: z.string(),
  name: z.string(),
  image: z.string().nullable(),
});

const chatMembersSchema = z.object({
  currentUserId: z.string(),
  canInvite: z.boolean(),
  members: z.array(chatMemberSchema),
});

const chatNotificationResultSchema = z.object({ notified: z.number().int().nonnegative() });
const chatAttachmentSchema = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string(),
  mimeType: z.string(),
  size: z.number().nonnegative(),
});
const chatPassSchema = z.object({
  token: z.string(),
  expiresAt: z.number(),
  joinUrl: z.string().url(),
  targetCount: z.number().int().positive().optional(),
});

const accessAuthoritySchema = z.object({
  canManage: z.boolean(),
  kind: z.enum(["permanent", "on-duty-tm", "none"]),
  weekStart: z.string(),
  weekEndExclusive: z.string(),
  today: z.string(),
});

export const bootstrapSchema = z.object({
  organization: z.object({ id: z.string(), name: z.string(), slug: z.string() }),
  timeZone: z.string().min(1),
  identity: z.object({ userId: z.string(), name: z.string(), role: z.string(), permissions: z.array(z.string()) }),
  shows: z.array(rundownSchema),
  notifications: z.array(notificationSchema),
  unreadNotifications: z.number(),
  accessAuthority: accessAuthoritySchema.optional(),
});

export type MobileBootstrap = z.infer<typeof bootstrapSchema>;

export const rundownItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  type: z.string(),
  duration: z.number(),
  notes: z.string(),
  assignee: z.string(),
  cue: z.string(),
  status: z.string(),
  sortOrder: z.number(),
  hardStop: z.boolean(),
  lowerThirdId: z.string().optional(),
  scheduledStart: z.string().nullable().optional(),
  expectedEnd: z.string().nullable().optional(),
  actualStart: z.string().nullable().optional(),
  actualEnd: z.string().nullable().optional(),
});

export const timerSchema = z.object({
  playback: z.enum(["stop", "play", "pause"]).default("stop"),
  currentItemId: z.string().nullable().default(null),
  elapsed: z.number().default(0),
  startedAt: z.number().nullable().default(null),
  pausedAt: z.number().nullable().default(null),
  mode: z.enum(["count-down", "count-up", "clock"]).default("count-down"),
  serverTime: z.number().optional(),
});

export const mobileRundownSchema = z.object({
  show: rundownSchema.omit({ itemCount: true }).extend({ updatedAt: z.string() }),
  timeZone: z.string().min(1),
  canEdit: z.boolean(),
  canControl: z.boolean(),
  proPresenter: z.object({
    configured: z.boolean(),
    cuesEnabled: z.boolean(),
    stageDisplayEnabled: z.boolean().default(false),
    bridgeOnline: z.boolean(),
    connected: z.boolean(),
  }),
  items: z.array(rundownItemSchema),
  timer: timerSchema,
});

export type MobileRundown = z.infer<typeof mobileRundownSchema>;
export type RundownItem = z.infer<typeof rundownItemSchema>;
export type RundownTimer = z.infer<typeof timerSchema>;

const mobileRundownTemplatesSchema = z.object({
  templates: z.array(z.object({
    id: z.string(),
    name: z.string(),
    serviceName: z.string(),
    scheduledStartTime: z.string(),
    itemCount: z.number().int().nonnegative(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })),
  previousShows: z.array(z.object({
    id: z.string(),
    serviceDate: z.string(),
    name: z.string(),
    scheduledStartTime: z.string().nullable(),
    location: z.string(),
    itemCount: z.number().int().nonnegative(),
  })),
});

export type MobileRundownTemplate = z.infer<typeof mobileRundownTemplatesSchema>["templates"][number];
export type MobilePreviousRundown = z.infer<typeof mobileRundownTemplatesSchema>["previousShows"][number];

const createMobileRundownResponseSchema = z.object({
  ok: z.literal(true),
  showId: z.string(),
  serviceDate: z.string(),
});

const showInventoryItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  location: z.string(),
  defaultStartTime: z.string().nullable(),
  sourceTemplateId: z.string().nullable(),
  itemCount: z.number().int().nonnegative(),
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const savedRundownSourceSchema = z.object({
  id: z.string(),
  name: z.string(),
  itemCount: z.number().int().nonnegative(),
});

const scheduleSchema = z.object({
  from: z.string(),
  to: z.string(),
  timeZone: z.string().min(1),
  canViewFull: z.boolean(),
  canManage: z.boolean(),
  services: z.array(rundownSchema.extend({
    updatedAt: z.string(),
    completedItems: z.number(),
    crewTotal: z.number(),
    crewConfirmed: z.number(),
    crewOpen: z.number(),
    incidentCount: z.number(),
  })),
  assignments: z.array(z.object({
    id: z.string(),
    showId: z.string().nullable(),
    serviceDate: z.string(),
    role: z.string(),
    department: z.string(),
    status: z.string(),
    callTime: z.string(),
    notes: z.string(),
    responseNote: z.string(),
    crewName: z.string().nullable(),
    crewEmail: z.string().nullable(),
    crewMemberId: z.string().nullable(),
    invitedAt: z.string().nullable(),
    respondedAt: z.string().nullable(),
    updatedAt: z.string(),
    canRespond: z.boolean(),
    responseWindow: z.discriminatedUnion("status", [
      z.object({ status: z.literal("open"), closesAt: z.string().datetime() }),
      z.object({ status: z.literal("closed"), closedAt: z.string().datetime().nullable() }),
    ]),
  })),
  crew: z.array(z.object({
    id: z.string(),
    name: z.string(),
    role: z.string(),
    email: z.string(),
  })),
  provider: z.object({
    type: z.enum(["native", "planning-center", "faithteams", "other"]),
    url: z.string(),
    label: z.string(),
  }),
  terminologyProfile: z.enum(["general", "church"]),
  inventory: z.array(showInventoryItemSchema).default([]),
  archivedInventory: z.array(showInventoryItemSchema).default([]),
  savedTemplates: z.array(savedRundownSourceSchema).default([]),
});

const scheduleWriteResultSchema = z.object({
  ok: z.literal(true),
  id: z.string(),
  created: z.boolean(),
  delivered: z.boolean(),
});

const scheduleReminderResultSchema = z.object({
  ok: z.literal(true),
  delivered: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});

const scheduleTeamCopyResultSchema = z.object({
  ok: z.literal(true),
  copied: z.number().int().positive(),
  created: z.boolean(),
  delivered: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});

const showInventoryWriteResultSchema = z.object({
  ok: z.literal(true),
  id: z.string(),
  created: z.boolean(),
});

const incidentSchema = z.object({
  id: z.string(),
  showId: z.string().nullable(),
  category: z.string(),
  severity: z.string(),
  description: z.string(),
  reportedBy: z.string(),
  serviceDate: z.string(),
  timestamp: z.string(),
  status: z.string(),
  assignedTo: z.string().nullable(),
  assignedName: z.string(),
  acknowledgedAt: z.string().nullable(),
  assignedAt: z.string().nullable(),
  resolvedAt: z.string().nullable(),
  resolvedBy: z.string().nullable(),
  commentCount: z.number(),
});

const incidentCommentSchema = z.object({
  id: z.string(),
  incidentId: z.string(),
  userId: z.string(),
  authorName: z.string(),
  body: z.string(),
  parentId: z.string().nullable(),
  createdAt: z.string(),
});

const incidentReactionEmojiSchema = z.enum(["👍", "❤️", "🎉", "👀", "🙏"]);

const incidentReactionSchema = z.object({
  id: z.string(),
  targetId: z.string(),
  userId: z.string(),
  authorName: z.string(),
  emoji: incidentReactionEmojiSchema,
  createdAt: z.string(),
});

const incidentsSchema = z.object({
  canReport: z.boolean(),
  canManage: z.boolean(),
  canAssignResponders: z.boolean().default(false),
  discussionEnabled: z.boolean().default(false),
  historyEnabled: z.boolean().default(false),
  incidents: z.array(incidentSchema),
  responders: z.array(z.object({ userId: z.string(), name: z.string(), role: z.string() })).default([]),
  comments: z.array(incidentCommentSchema).default([]),
  reactions: z.array(incidentReactionSchema).default([]),
});

const incidentHistorySchema = z.object({
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
  categories: z.array(z.string()),
  incidents: z.array(incidentSchema),
});

const checkInMemberSchema = z.object({
  id: z.string(),
  memberId: z.string(),
  name: z.string(),
  role: z.string(),
  photoUrl: z.string(),
  isOnline: z.boolean(),
  lastCheckIn: z.string().nullable(),
  lastCheckOut: z.string().nullable(),
});

const checkInSchema = z.object({
  members: z.array(checkInMemberSchema),
});

const showBoardSchema = checkInSchema.extend({
  clockFormat: z.enum(["12hr", "24hr"]),
  timeZone: z.string().min(1),
});

const ontimeEventSchema = z.object({
  id: z.string(),
  type: z.literal("event"),
  title: z.string(),
  cue: z.string(),
  timeStart: z.number(),
  timeEnd: z.number(),
  duration: z.number(),
  colour: z.string(),
  note: z.string(),
  skip: z.boolean(),
});

const ontimeTimerSchema = z.object({
  addedTime: z.number(),
  current: z.number().nullable(),
  duration: z.number().nullable(),
  elapsed: z.number().nullable(),
  playback: z.enum(["play", "pause", "armed", "stop", "roll"]),
  startedAt: z.number().nullable(),
  expectedFinish: z.number().nullable(),
  finishedAt: z.number().nullable(),
});

const showWorkspaceSchema = z.object({
  clockFormat: z.enum(["12hr", "24hr"]),
  timeZone: z.string().min(1),
  configuredAdapter: z.enum(["native", "ontime", "propresenter", "planning-center"]),
  adapterStatus: z.enum(["ready", "fallback"]),
  chatAvailable: z.boolean(),
  showBoardAvailable: z.boolean(),
  canOpenRundown: z.boolean(),
  crew: z.array(checkInMemberSchema),
  runtime: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("native"),
      show: rundownSchema.omit({ itemCount: true }).extend({ updatedAt: z.string() }).nullable(),
      items: z.array(rundownItemSchema),
      timer: timerSchema,
    }),
    z.object({
      kind: z.literal("ontime"),
      timer: ontimeTimerSchema,
      eventNow: ontimeEventSchema.nullable(),
      eventNext: ontimeEventSchema.nullable(),
      clock: z.number(),
      events: z.array(ontimeEventSchema),
      connected: z.literal(true),
    }),
  ]),
});

const checkInStatusSchema = z.object({ member: checkInMemberSchema });

const teamCrewMemberSchema = checkInMemberSchema.extend({ email: z.string() });
const teamCrewSchema = z.object({ members: z.array(teamCrewMemberSchema) });

const teamAccessMemberSchema = z.object({
  userId: z.string(),
  role: z.string(),
  user: z.object({ name: z.string(), email: z.string(), image: z.string().nullable() }),
});

const teamAccessGrantSchema = z.object({
  id: z.string(),
  userId: z.string(),
  capability: z.string(),
  permissions: z.string(),
  startsOn: z.string(),
  expiresOn: z.string().nullable(),
  reason: z.string(),
  grantedByUserId: z.string(),
  createdAt: z.string(),
  grantedBy: z.object({ name: z.string() }),
  canRevoke: z.boolean(),
});

const teamAccessCapabilitySchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string(),
});

const teamAccessSchema = z.object({
  authority: accessAuthoritySchema,
  currentUserId: z.string(),
  members: z.array(teamAccessMemberSchema),
  grants: z.array(teamAccessGrantSchema),
  capabilities: z.array(teamAccessCapabilitySchema),
});

const organizationMemberSchema = z.object({
  id: z.string(),
  userId: z.string(),
  organizationId: z.string(),
  role: z.string(),
  createdAt: z.string(),
  user: z.object({
    id: z.string(),
    name: z.string(),
    email: z.string(),
    image: z.string().nullable(),
  }),
});

const organizationInvitationSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: z.string().nullable(),
  status: z.string(),
  expiresAt: z.string(),
  createdAt: z.string(),
});

const teamMembersSchema = z.object({
  currentUserId: z.string(),
  assignableRoles: z.array(z.string()),
  members: z.array(organizationMemberSchema),
  invitations: z.array(organizationInvitationSchema),
});

const inviteTeamMemberResponseSchema = z.object({ invitation: organizationInvitationSchema });

export const checklistDepartmentSchema = z.enum(["audio", "video", "lighting", "stream", "general"]);

const checklistShowSchema = rundownSchema.omit({ itemCount: true });

const checklistEntrySchema = z.object({
  id: z.string(),
  templateId: z.string(),
  checked: z.boolean(),
  checkedBy: z.string().nullable(),
  checkedAt: z.string().nullable(),
  label: z.string(),
  category: checklistDepartmentSchema,
  sortOrder: z.number(),
});

const mobileChecklistSchema = z.object({
  show: checklistShowSchema,
  shows: z.array(checklistShowSchema),
  canManage: z.boolean(),
  entries: z.array(checklistEntrySchema),
});

const checklistSuggestionSchema = z.object({
  id: z.string(),
  label: z.string(),
  category: checklistDepartmentSchema,
  reason: z.string(),
  sourceItemIds: z.array(z.string()),
  existingTemplateId: z.string().nullable(),
});

const mobileChecklistDraftSchema = z.object({
  show: checklistShowSchema,
  suggestions: z.array(checklistSuggestionSchema),
});

const okSchema = z.object({ ok: z.literal(true) });
const checklistApplySchema = okSchema.extend({ added: z.number().int().nonnegative() });

const mobileDeviceActionSchema = z.object({
  id: z.string(),
  label: z.string(),
  category: z.string(),
  params: z.array(z.object({
    id: z.string(),
    label: z.string(),
    type: z.enum(["number", "boolean", "string", "select"]),
    options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    step: z.number().optional(),
    default: z.union([z.number(), z.boolean(), z.string()]).optional(),
  })),
});

const mobileDeviceFieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  placeholder: z.string(),
  type: z.enum(["text", "number", "password", "select"]),
  required: z.boolean(),
  options: z.array(z.object({ value: z.string(), label: z.string() })),
});

const mobileDeviceAdapterSchema = z.object({
  adapterType: z.string(),
  displayName: z.string(),
  category: z.string(),
  connectivity: z.enum(["browser-direct", "bridge-required"]),
  description: z.string(),
  fields: z.array(mobileDeviceFieldSchema),
});

const devicesSchema = z.object({
  bridge: z.object({
    online: z.boolean(),
    clientCount: z.number().int().nonnegative(),
    version: z.string().nullable(),
    deviceCount: z.number().int().nonnegative(),
    uptime: z.number().nonnegative().nullable(),
  }),
  adapters: z.array(mobileDeviceAdapterSchema),
  devices: z.array(z.object({
    id: z.string(),
    name: z.string(),
    category: z.string(),
    adapterType: z.string(),
    enabled: z.boolean(),
    connected: z.boolean(),
    updatedAt: z.string(),
    configuration: z.array(mobileDeviceFieldSchema.extend({
      value: z.string(),
      secretConfigured: z.boolean(),
    })),
    controls: z.array(mobileDeviceActionSchema),
    feedbackCount: z.number().int().nonnegative(),
  })),
});

const mobileDeviceControlStateSchema = z.object({
  connected: z.boolean(),
  bridgeOnline: z.boolean(),
  controls: z.array(mobileDeviceActionSchema),
  feedbacks: z.array(z.object({
    id: z.string(),
    label: z.string(),
    type: z.enum(["boolean", "number", "string", "enum"]),
    value: z.union([z.string(), z.number(), z.boolean()]).nullable(),
    available: z.boolean(),
  })),
  refreshedAt: z.number().nullable(),
});

const mobileOperationalShowSchema = z.object({
  id: z.string(),
  serviceDate: z.string(),
  name: z.string(),
  status: z.string().optional(),
  scheduledStartTime: z.string().nullable().optional(),
});

const cueNoteSchema = z.object({
  itemId: z.string(),
  columnId: z.string(),
  text: z.string(),
  updatedAt: z.string().nullable(),
  updatedBy: z.string(),
});

const cueSheetSchema = z.object({
  show: mobileOperationalShowSchema.nullable(),
  shows: z.array(mobileOperationalShowSchema),
  canEdit: z.boolean().default(false),
  canAddNotes: z.boolean().default(false),
  columns: z.array(z.object({ id: z.string(), label: z.string(), color: z.string(), sortOrder: z.number(), width: z.number() })),
  rows: z.array(z.object({
    id: z.string(),
    title: z.string(),
    type: z.string(),
    duration: z.number(),
    assignee: z.string(),
    cue: z.string(),
    status: z.string(),
    sortOrder: z.number(),
    notes: z.array(cueNoteSchema),
  })),
});

const assetSchema = z.object({
  id: z.string(), name: z.string(), category: z.string(), status: z.string(), location: z.string(),
  serialNumber: z.string(), notes: z.string(), lastServiced: z.string().nullable(), nextService: z.string().nullable(), updatedAt: z.string(),
});
const assetsSchema = z.object({ canManage: z.boolean(), assets: z.array(assetSchema) });

const streamingSchema = z.object({
  canManage: z.boolean(),
  inputs: z.array(z.object({
    id: z.string(), name: z.string(), status: z.string(), rtmpUrl: z.string(), srtUrl: z.string(), createdAt: z.string(),
    providerStatus: z.string().optional(), checkedAt: z.string().optional(), error: z.string().optional(),
  })),
  destinations: z.array(z.object({
    id: z.string(), name: z.string(), platform: z.string(), rtmpUrl: z.string(), enabled: z.boolean(), connected: z.boolean(),
    hasStreamKey: z.boolean(), cfOutputId: z.string(), liveInputId: z.string(), createdAt: z.string(),
  })),
});

const graphicsSchema = z.object({
  cloudEnabled: z.boolean(), canConfigure: z.boolean(), canTrigger: z.boolean(), activeIds: z.array(z.string()),
  templates: z.array(z.object({ id: z.string(), name: z.string(), title: z.string(), subtitle: z.string(), style: z.string(), createdAt: z.string(), updatedAt: z.string() })),
});

const dashboardSchema = z.object({
  kind: z.enum(["pm", "tm"]),
  show: mobileOperationalShowSchema.nullable(),
  items: z.object({ total: z.number(), complete: z.number(), missingDuration: z.number(), missingOwner: z.number() }),
  assignments: z.array(z.object({ status: z.string(), count: z.number() })),
  checklist: z.object({ total: z.number(), complete: z.number() }),
  incidents: z.array(z.object({ id: z.string(), category: z.string(), severity: z.string(), description: z.string(), status: z.string(), assignedName: z.string().nullable(), timestamp: z.string().nullable() })),
  equipment: z.array(z.object({ id: z.string(), name: z.string(), category: z.string(), status: z.string(), nextService: z.string().nullable() })),
  inputs: z.array(z.object({ id: z.string(), name: z.string(), status: z.string() })),
  destinations: z.array(z.object({ id: z.string(), name: z.string(), platform: z.string(), enabled: z.boolean(), connected: z.boolean(), cfOutputId: z.string() })),
  devices: z.array(z.object({ id: z.string(), name: z.string(), category: z.string(), adapterType: z.string(), enabled: z.boolean() })),
});

const reportsSchema = z.object({
  organization: z.string(), generatedAt: z.string(),
  reports: z.array(z.object({
    id: z.string(), serviceDate: z.string(), name: z.string(), location: z.string(), status: z.string(), scheduledStartTime: z.string().nullable(),
    itemCount: z.number(), completedItems: z.number(), incidentCount: z.number(), assignmentCount: z.number(), confirmedAssignments: z.number(), checklistCount: z.number(), completedChecks: z.number(),
  })),
});

const audioAssignmentSchema = z.object({
  id: z.string(), showId: z.string().nullable(), channel: z.number(), label: z.string(), micType: z.string(), micModel: z.string(), notes: z.string(),
  gainDb: z.number().nullable(), phantom: z.boolean(), muted: z.boolean(), group: z.string(), mixerConsole: z.string(), mixerChannel: z.number().nullable(),
  mixerChannelType: z.string(), serviceDate: z.string(), updatedAt: z.string(),
});
const audioSchema = z.object({
  show: mobileOperationalShowSchema.nullable(), shows: z.array(mobileOperationalShowSchema),
  mixers: z.array(z.object({ id: z.string(), name: z.string(), adapterType: z.string() })), assignments: z.array(audioAssignmentSchema),
});

const timecodeValueSchema = z.object({ hours: z.number(), minutes: z.number(), seconds: z.number(), frames: z.number() });
const timecodeStateSchema = z.object({
  timecode: timecodeValueSchema,
  display: z.string(),
  source: z.enum(["internal-freerun", "internal-rundown", "mtc", "ltc-bridge", "network"]),
  format: z.object({ frameRate: z.union([z.literal(24), z.literal(25), z.literal(29.97), z.literal(30)]), dropFrame: z.enum(["df", "ndf"]) }),
  running: z.boolean(), serverTime: z.number(), totalFrames: z.number(),
});
const timecodeEventSchema = z.object({
  id: z.string(), label: z.string(), triggerTimecode: timecodeValueSchema, triggerFrame: z.number(),
  action: z.enum(["lower-third-show", "lower-third-clear", "rundown-advance", "rundown-start-item", "custom-webhook"]),
  payload: z.record(z.string(), z.unknown()), fired: z.boolean(), toleranceFrames: z.number().optional(),
});

export type MobileSchedule = z.infer<typeof scheduleSchema>;
export type MobileIncident = z.infer<typeof incidentSchema>;
export type MobileIncidents = z.infer<typeof incidentsSchema>;
export type MobileIncidentComment = z.infer<typeof incidentCommentSchema>;
export type MobileIncidentReaction = z.infer<typeof incidentReactionSchema>;
export type MobileIncidentReactionEmoji = z.infer<typeof incidentReactionEmojiSchema>;
export type MobileIncidentHistory = z.infer<typeof incidentHistorySchema>;
export type MobileCheckIn = z.infer<typeof checkInSchema>;
export type MobileCheckInMember = z.infer<typeof checkInMemberSchema>;
export type MobileShowBoard = z.infer<typeof showBoardSchema>;
export type MobileShowWorkspace = z.infer<typeof showWorkspaceSchema>;
export type MobileTeamCrewMember = z.infer<typeof teamCrewMemberSchema>;
export type MobileTeamAccess = z.infer<typeof teamAccessSchema>;
export type MobileTeamAccessGrant = z.infer<typeof teamAccessGrantSchema>;
export type MobileOrganizationMember = z.infer<typeof organizationMemberSchema>;
export type MobileOrganizationInvitation = z.infer<typeof organizationInvitationSchema>;
export type MobileTeamMembers = z.infer<typeof teamMembersSchema>;
export type MobileDevices = z.infer<typeof devicesSchema>;
export type MobileChatMember = z.infer<typeof chatMemberSchema>;
export type MobileChatAttachment = z.infer<typeof chatAttachmentSchema>;
export type MobileDevice = MobileDevices["devices"][number];
export type MobileDeviceAdapter = z.infer<typeof mobileDeviceAdapterSchema>;
export type MobileDeviceAction = z.infer<typeof mobileDeviceActionSchema>;
export type MobileDeviceControlState = z.infer<typeof mobileDeviceControlStateSchema>;
export type ChecklistDepartment = z.infer<typeof checklistDepartmentSchema>;
export type MobileChecklist = z.infer<typeof mobileChecklistSchema>;
export type MobileChecklistEntry = z.infer<typeof checklistEntrySchema>;
export type MobileChecklistDraft = z.infer<typeof mobileChecklistDraftSchema>;
export type MobileChecklistSuggestion = z.infer<typeof checklistSuggestionSchema>;
export type MobileCueSheet = z.infer<typeof cueSheetSchema>;
export type MobileAsset = z.infer<typeof assetSchema>;
export type MobileAssets = z.infer<typeof assetsSchema>;
export type MobileStreaming = z.infer<typeof streamingSchema>;
export type MobileGraphics = z.infer<typeof graphicsSchema>;
export type MobileDashboard = z.infer<typeof dashboardSchema>;
export type MobileReports = z.infer<typeof reportsSchema>;
export type MobileAudio = z.infer<typeof audioSchema>;
export type MobileAudioAssignment = z.infer<typeof audioAssignmentSchema>;
export type MobileTimecodeState = z.infer<typeof timecodeStateSchema>;
export type MobileTimecodeEvent = z.infer<typeof timecodeEventSchema>;

export function parseMobileTimecodeState(value: unknown): MobileTimecodeState | null {
  const result = timecodeStateSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function parseMobileTimecodeEvents(value: unknown): MobileTimecodeEvent[] | null {
  const result = z.array(timecodeEventSchema).safeParse(value);
  return result.success ? result.data : null;
}

export function parseMobileTimecodeEvent(value: unknown): MobileTimecodeEvent | null {
  const result = timecodeEventSchema.safeParse(value);
  return result.success ? result.data : null;
}

async function authenticatedFetch(path: string, init?: FetchRequestInit) {
  const nativeCookieHeader = await getNativeCookieHeader();
  const response = await expoFetch(`${SHOWPILOT_URL}${path}`, {
    ...init,
    credentials: getAuthenticatedFetchCredentials() ?? init?.credentials,
    headers: {
      Accept: "application/json",
      ...(typeof init?.body === "string" ? { "Content-Type": "application/json" } : {}),
      ...nativeCookieHeader,
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const body = await response.text();
    let apiError = "";
    try {
      const parsed: unknown = JSON.parse(body);
      if (typeof parsed === "object" && parsed !== null && "error" in parsed && typeof parsed.error === "string") {
        apiError = parsed.error.trim();
      }
    } catch {}
    if (apiError) throw new Error(apiError);
    throw new Error(body || `ShowPilot request failed (${response.status})`);
  }
  return response;
}

export async function uploadMobileAvatar(uri: string) {
  const form = new FormData();
  if (Platform.OS === "web") {
    const fileResponse = await expoFetch(uri);
    if (!fileResponse.ok) throw new Error("The selected photo could not be opened.");
    const image = await fileResponse.blob();
    if (image.size === 0) throw new Error("The selected photo is empty.");
    if (image.type !== "image/jpeg") throw new Error("The prepared profile photo is not a JPEG image.");
    form.append("file", image, "avatar.jpg");
  } else {
    const image = new File(uri);
    if (!image.exists || image.size === 0) throw new Error("The selected photo could not be opened.");
    if (image.type !== "image/jpeg") throw new Error("The prepared profile photo is not a JPEG image.");
    form.append("file", image);
  }
  const response = await authenticatedFetch("/api/user/avatar", { method: "POST", body: form });
  return avatarUploadSchema.parse(await response.json());
}

export async function getMobileBootstrap(orgId: string): Promise<MobileBootstrap> {
  const response = await authenticatedFetch(`/api/mobile/v1/bootstrap?orgId=${encodeURIComponent(orgId)}`);
  return bootstrapSchema.parse(await response.json());
}

export async function getMobileChatMembers(orgId: string) {
  const response = await authenticatedFetch(`/api/mobile/v1/chat/members?orgId=${encodeURIComponent(orgId)}`);
  return chatMembersSchema.parse(await response.json());
}

export async function notifyMobileChatMessage(input: {
  orgId: string;
  roomId: string;
  text: string;
  mentionedUserIds: string[];
  messageId: string;
}) {
  const response = await authenticatedFetch(
    `/api/mobile/v1/chat/notify?orgId=${encodeURIComponent(input.orgId)}`,
    { method: "POST", body: JSON.stringify(input) },
  );
  return chatNotificationResultSchema.parse(await response.json());
}

export async function notifyMobileChatReaction(input: {
  orgId: string;
  roomId: string;
  messageId: string;
  targetUserId: string;
  emoji: "👍" | "❤️" | "🎉" | "👀" | "🙏";
}) {
  const response = await authenticatedFetch(
    `/api/mobile/v1/chat/reaction-notify?orgId=${encodeURIComponent(input.orgId)}`,
    { method: "POST", body: JSON.stringify(input) },
  );
  return chatNotificationResultSchema.parse(await response.json());
}

export async function uploadMobileChatAttachment(input: {
  orgId: string;
  roomId: string;
  uri: string;
  name?: string | null;
}) {
  const form = new FormData();
  if (Platform.OS === "web") {
    const fileResponse = await expoFetch(input.uri);
    if (!fileResponse.ok) throw new Error("The selected attachment could not be opened.");
    const file = await fileResponse.blob();
    if (file.size === 0) throw new Error("The selected attachment is empty.");
    form.append("file", file, input.name?.trim() || "attachment");
  } else {
    const file = new File(input.uri);
    if (!file.exists || file.size === 0) throw new Error("The selected attachment could not be opened.");
    form.append("file", file);
  }
  const response = await authenticatedFetch(
    `/api/chat/${encodeURIComponent(input.orgId)}/upload?room=${encodeURIComponent(input.roomId)}`,
    { method: "POST", body: form },
  );
  return chatAttachmentSchema.parse(await response.json());
}

export async function downloadMobileChatAttachment(attachment: MobileChatAttachment) {
  const response = await authenticatedFetch(attachment.url);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const safeName = attachment.name.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 120) || "attachment";
  const file = new File(Paths.cache, `showpilot-${attachment.id}-${safeName}`);
  if (file.exists) file.delete();
  file.create();
  file.write(bytes);
  return file.uri;
}

export async function createMobileCrewChatPass(input: { orgId: string; hours: number }) {
  const response = await authenticatedFetch(
    `/api/mobile/v1/chat/passes/crew?orgId=${encodeURIComponent(input.orgId)}`,
    { method: "POST", body: JSON.stringify({ hours: input.hours }) },
  );
  return chatPassSchema.parse(await response.json());
}

export async function createMobilePlanningChatPass(input: { orgId: string; hours: number; targetUserIds: string[] }) {
  const response = await authenticatedFetch(
    `/api/mobile/v1/chat/passes/planning?orgId=${encodeURIComponent(input.orgId)}`,
    { method: "POST", body: JSON.stringify({ hours: input.hours, targetUserIds: input.targetUserIds }) },
  );
  return chatPassSchema.parse(await response.json());
}

export async function getMobileRundown(orgId: string, showId: string): Promise<MobileRundown> {
  const response = await authenticatedFetch(
    `/api/mobile/v1/rundowns/${encodeURIComponent(showId)}?orgId=${encodeURIComponent(orgId)}`,
  );
  return mobileRundownSchema.parse(await response.json());
}

export async function getMobileRundownTemplates(orgId: string, showId: string) {
  const response = await authenticatedFetch(
    `/api/mobile/v1/rundowns/${encodeURIComponent(showId)}/templates?orgId=${encodeURIComponent(orgId)}`,
  );
  return mobileRundownTemplatesSchema.parse(await response.json());
}

export async function saveMobileRundownTemplate(input: {
  orgId: string;
  showId: string;
  requestId: string;
  name: string;
}) {
  const response = await authenticatedFetch(
    `/api/mobile/v1/rundowns/${encodeURIComponent(input.showId)}/templates?orgId=${encodeURIComponent(input.orgId)}`,
    { method: "POST", body: JSON.stringify({ requestId: input.requestId, name: input.name }) },
  );
  return z.object({ ok: z.literal(true), id: z.string(), created: z.boolean() }).parse(await response.json());
}

export async function loadMobileRundownTemplate(input: {
  orgId: string;
  showId: string;
  templateId: string;
  requestId: string;
  expectedRevision: number;
}) {
  const response = await authenticatedFetch(
    `/api/mobile/v1/rundowns/${encodeURIComponent(input.showId)}/templates/${encodeURIComponent(input.templateId)}/load?orgId=${encodeURIComponent(input.orgId)}`,
    { method: "POST", body: JSON.stringify({ requestId: input.requestId, expectedRevision: input.expectedRevision }) },
  );
  return z.object({
    ok: z.literal(true),
    revision: z.number(),
    serviceName: z.string(),
    scheduledStartTime: z.string(),
    itemCount: z.number().int().nonnegative(),
  }).parse(await response.json());
}

export async function loadMobilePreviousRundown(input: {
  orgId: string;
  showId: string;
  sourceShowId: string;
  requestId: string;
  expectedRevision: number;
}) {
  const response = await authenticatedFetch(
    `/api/mobile/v1/rundowns/${encodeURIComponent(input.showId)}/previous/${encodeURIComponent(input.sourceShowId)}/load?orgId=${encodeURIComponent(input.orgId)}`,
    { method: "POST", body: JSON.stringify({ requestId: input.requestId, expectedRevision: input.expectedRevision }) },
  );
  return z.object({
    ok: z.literal(true),
    revision: z.number(),
    serviceName: z.string(),
    scheduledStartTime: z.string(),
    itemCount: z.number().int().nonnegative(),
  }).parse(await response.json());
}

export async function deleteMobileRundownTemplate(input: {
  orgId: string;
  showId: string;
  templateId: string;
}) {
  const response = await authenticatedFetch(
    `/api/mobile/v1/rundowns/${encodeURIComponent(input.showId)}/templates/${encodeURIComponent(input.templateId)}/remove?orgId=${encodeURIComponent(input.orgId)}`,
    { method: "POST", body: JSON.stringify({}) },
  );
  return z.object({ ok: z.literal(true) }).parse(await response.json());
}

export async function updateMobileRundownMeta(input: {
  orgId: string;
  showId: string;
  requestId: string;
  expectedRevision: number;
  name: string;
  startTime: string;
  location: string;
}) {
  const response = await authenticatedFetch(
    `/api/mobile/v1/rundowns/${encodeURIComponent(input.showId)}/meta?orgId=${encodeURIComponent(input.orgId)}`,
    {
      method: "POST",
      body: JSON.stringify({
        requestId: input.requestId,
        expectedRevision: input.expectedRevision,
        name: input.name,
        startTime: input.startTime,
        location: input.location,
      }),
    },
  );
  return z.object({ ok: z.literal(true), revision: z.number() }).parse(await response.json());
}

export async function controlMobileProPresenter(input: {
  orgId: string;
  showId: string;
  command: "next" | "previous" | "clear";
}) {
  const response = await authenticatedFetch(
    `/api/mobile/v1/rundowns/${encodeURIComponent(input.showId)}/propresenter?orgId=${encodeURIComponent(input.orgId)}`,
    { method: "POST", body: JSON.stringify({ command: input.command }) },
  );
  return z.object({ success: z.literal(true), response: z.string().optional() }).parse(await response.json());
}

export async function updateMobileProPresenterStageDisplay(input: {
  orgId: string;
  showId: string;
  enabled: boolean;
}) {
  const response = await authenticatedFetch(
    `/api/mobile/v1/rundowns/${encodeURIComponent(input.showId)}/propresenter/stage-display?orgId=${encodeURIComponent(input.orgId)}`,
    { method: "POST", body: JSON.stringify({ enabled: input.enabled }) },
  );
  return z.object({ ok: z.literal(true), enabled: z.boolean() }).parse(await response.json());
}

export async function createMobileRundown(input: {
  orgId: string;
  requestId?: string;
  serviceDate: string;
  name?: string;
  startTime?: string;
  location?: string;
  inventoryId?: string;
  copyFrom?: string;
  copyFromShowId?: string;
}) {
  const response = await authenticatedFetch("/api/mobile/v1/rundowns", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return createMobileRundownResponseSchema.parse(await response.json());
}

export async function getMobileSchedule(
  orgId: string,
  selection: { serviceDate?: string; assignmentId?: string } = {},
): Promise<MobileSchedule> {
  const query = new URLSearchParams({ orgId });
  if (selection.serviceDate) query.set("date", selection.serviceDate);
  if (selection.assignmentId) query.set("assignment", selection.assignmentId);
  const response = await authenticatedFetch(`/api/mobile/v1/schedule?${query}`);
  return scheduleSchema.parse(await response.json());
}

export async function respondToMobileAssignment(input: {
  orgId: string;
  assignmentId: string;
  response: "confirmed" | "declined";
  reason?: string;
}) {
  await authenticatedFetch("/api/mobile/v1/schedule/respond", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function createMobileScheduleAssignment(input: {
  orgId: string;
  requestId: string;
  showId: string;
  role: string;
  department: string;
  crewMemberId: string | null;
  callTime: string;
  notes: string;
}) {
  const response = await authenticatedFetch(
    `/api/mobile/v1/schedule/assignments?orgId=${encodeURIComponent(input.orgId)}`,
    { method: "POST", body: JSON.stringify({ ...input, expectedUpdatedAt: null }) },
  );
  return scheduleWriteResultSchema.parse(await response.json());
}

export async function updateMobileScheduleAssignment(input: {
  orgId: string;
  assignmentId: string;
  requestId: string;
  showId: string;
  role: string;
  department: string;
  crewMemberId: string | null;
  callTime: string;
  notes: string;
  expectedUpdatedAt: string;
}) {
  const response = await authenticatedFetch(
    `/api/mobile/v1/schedule/assignments/${encodeURIComponent(input.assignmentId)}?orgId=${encodeURIComponent(input.orgId)}`,
    { method: "POST", body: JSON.stringify(input) },
  );
  return scheduleWriteResultSchema.parse(await response.json());
}

export async function removeMobileScheduleAssignment(input: { orgId: string; assignmentId: string }) {
  const response = await authenticatedFetch(
    `/api/mobile/v1/schedule/assignments/${encodeURIComponent(input.assignmentId)}/remove?orgId=${encodeURIComponent(input.orgId)}`,
    { method: "POST", body: JSON.stringify({}) },
  );
  return okSchema.parse(await response.json());
}

export async function remindMobileScheduleAssignment(input: { orgId: string; assignmentId: string }) {
  const response = await authenticatedFetch(
    `/api/mobile/v1/schedule/assignments/${encodeURIComponent(input.assignmentId)}/remind?orgId=${encodeURIComponent(input.orgId)}`,
    { method: "POST", body: JSON.stringify({}) },
  );
  return scheduleReminderResultSchema.parse(await response.json());
}

export async function remindAllMobileScheduleAssignments(input: { orgId: string; showId: string }) {
  const response = await authenticatedFetch(
    `/api/mobile/v1/schedule/services/${encodeURIComponent(input.showId)}/remind?orgId=${encodeURIComponent(input.orgId)}`,
    { method: "POST", body: JSON.stringify({}) },
  );
  return scheduleReminderResultSchema.parse(await response.json());
}

export async function copyMobileScheduleTeam(input: {
  orgId: string;
  showId: string;
  sourceShowId: string;
  requestId: string;
}) {
  const response = await authenticatedFetch(
    `/api/mobile/v1/schedule/services/${encodeURIComponent(input.showId)}/copy-team?orgId=${encodeURIComponent(input.orgId)}`,
    { method: "POST", body: JSON.stringify(input) },
  );
  return scheduleTeamCopyResultSchema.parse(await response.json());
}

export async function updateMobileScheduleService(input: {
  orgId: string;
  showId: string;
  name: string;
  startTime: string;
  location: string;
  expectedUpdatedAt: string;
}) {
  const response = await authenticatedFetch(
    `/api/mobile/v1/schedule/services/${encodeURIComponent(input.showId)}?orgId=${encodeURIComponent(input.orgId)}`,
    { method: "POST", body: JSON.stringify(input) },
  );
  return okSchema.parse(await response.json());
}

export async function removeMobileScheduleService(input: { orgId: string; showId: string }) {
  const response = await authenticatedFetch(
    `/api/mobile/v1/schedule/services/${encodeURIComponent(input.showId)}/remove?orgId=${encodeURIComponent(input.orgId)}`,
    { method: "POST", body: JSON.stringify({}) },
  );
  return okSchema.parse(await response.json());
}

export async function saveMobileScheduleProvider(input: {
  orgId: string;
  provider: "native" | "planning-center" | "faithteams" | "other";
  url: string;
  label: string;
  terminologyProfile: "general" | "church";
}) {
  const response = await authenticatedFetch(
    `/api/mobile/v1/schedule/provider?orgId=${encodeURIComponent(input.orgId)}`,
    { method: "POST", body: JSON.stringify(input) },
  );
  return okSchema.parse(await response.json());
}

export async function createMobileShowInventoryItem(input: {
  orgId: string;
  requestId: string;
  name: string;
  description: string;
  location: string;
  defaultStartTime: string;
  sourceTemplateId: string | null;
}) {
  const response = await authenticatedFetch(
    `/api/mobile/v1/schedule/inventory?orgId=${encodeURIComponent(input.orgId)}`,
    { method: "POST", body: JSON.stringify(input) },
  );
  return showInventoryWriteResultSchema.parse(await response.json());
}

export async function setMobileShowInventoryArchived(input: {
  orgId: string;
  inventoryId: string;
  expectedUpdatedAt: string;
  archived: boolean;
}) {
  const action = input.archived ? "archive" : "restore";
  const response = await authenticatedFetch(
    `/api/mobile/v1/schedule/inventory/${encodeURIComponent(input.inventoryId)}/${action}?orgId=${encodeURIComponent(input.orgId)}`,
    { method: "POST", body: JSON.stringify({ expectedUpdatedAt: input.expectedUpdatedAt }) },
  );
  return okSchema.parse(await response.json());
}

export async function getMobileIncidents(orgId: string): Promise<MobileIncidents> {
  const response = await authenticatedFetch(`/api/mobile/v1/incidents?orgId=${encodeURIComponent(orgId)}`);
  return incidentsSchema.parse(await response.json());
}

export interface MobileIncidentHistoryFilters {
  query?: string;
  status: "all" | "open" | "resolved";
  severity: "all" | "low" | "medium" | "high" | "critical";
  category?: string;
  assignee?: string;
  from?: string;
  to?: string;
  sort: "newest" | "oldest" | "severity";
  page: number;
}

export async function getMobileIncidentHistory(orgId: string, filters: MobileIncidentHistoryFilters): Promise<MobileIncidentHistory> {
  const query = new URLSearchParams({
    orgId,
    status: filters.status,
    severity: filters.severity,
    sort: filters.sort,
    page: String(filters.page),
  });
  if (filters.query) query.set("query", filters.query);
  if (filters.category) query.set("category", filters.category);
  if (filters.assignee) query.set("assignee", filters.assignee);
  if (filters.from) query.set("from", filters.from);
  if (filters.to) query.set("to", filters.to);
  const response = await authenticatedFetch(`/api/mobile/v1/incidents/history?${query}`);
  return incidentHistorySchema.parse(await response.json());
}

export async function reportMobileIncident(input: {
  orgId: string;
  showId?: string | null;
  category: "audio" | "video" | "stream" | "lighting" | "other";
  severity: "low" | "medium" | "high";
  description: string;
  serviceDate: string;
}) {
  const response = await authenticatedFetch(`/api/mobile/v1/incidents?orgId=${encodeURIComponent(input.orgId)}`, {
    method: "POST",
    body: JSON.stringify(input),
  });
  return okSchema.parse(await response.json());
}

export async function commandMobileIncident(input: {
  orgId: string;
  incidentId: string;
  action: "claim" | "assign" | "unassign" | "acknowledge" | "resolve";
  targetUserId?: string;
}) {
  const response = await authenticatedFetch(
    `/api/mobile/v1/incidents/${encodeURIComponent(input.incidentId)}/command?orgId=${encodeURIComponent(input.orgId)}`,
    { method: "POST", body: JSON.stringify({ action: input.action, targetUserId: input.targetUserId }) },
  );
  return okSchema.parse(await response.json());
}

export async function updateMobileIncident(input: {
  orgId: string;
  incidentId: string;
  category: "audio" | "video" | "stream" | "lighting" | "other";
  severity: "low" | "medium" | "high";
  description: string;
}) {
  const response = await authenticatedFetch(
    `/api/mobile/v1/incidents/${encodeURIComponent(input.incidentId)}/update?orgId=${encodeURIComponent(input.orgId)}`,
    { method: "POST", body: JSON.stringify(input) },
  );
  return okSchema.parse(await response.json());
}

export async function removeMobileIncident(input: { orgId: string; incidentId: string }) {
  const response = await authenticatedFetch(
    `/api/mobile/v1/incidents/${encodeURIComponent(input.incidentId)}/remove?orgId=${encodeURIComponent(input.orgId)}`,
    { method: "POST", body: JSON.stringify({}) },
  );
  return okSchema.parse(await response.json());
}

export async function addMobileIncidentComment(input: {
  orgId: string;
  incidentId: string;
  requestId: string;
  body: string;
  parentId?: string | null;
}) {
  const response = await authenticatedFetch(
    `/api/mobile/v1/incidents/${encodeURIComponent(input.incidentId)}/comments?orgId=${encodeURIComponent(input.orgId)}`,
    { method: "POST", body: JSON.stringify(input) },
  );
  return z.object({ comment: incidentCommentSchema }).parse(await response.json());
}

export async function setMobileIncidentCommentReaction(input: {
  orgId: string;
  commentId: string;
  emoji: MobileIncidentReactionEmoji;
  active: boolean;
}) {
  const response = await authenticatedFetch(
    `/api/mobile/v1/incident-comments/${encodeURIComponent(input.commentId)}/reaction?orgId=${encodeURIComponent(input.orgId)}`,
    { method: "POST", body: JSON.stringify({ emoji: input.emoji, active: input.active }) },
  );
  return z.object({ active: z.boolean(), reaction: incidentReactionSchema.optional() }).parse(await response.json());
}

export async function getMobileCheckIn(orgId: string): Promise<MobileCheckIn> {
  const response = await authenticatedFetch(`/api/mobile/v1/checkin?orgId=${encodeURIComponent(orgId)}`);
  return checkInSchema.parse(await response.json());
}

export async function getMobileShowBoard(orgId: string): Promise<MobileShowBoard> {
  const response = await authenticatedFetch(`/api/mobile/v1/show-board?orgId=${encodeURIComponent(orgId)}`);
  return showBoardSchema.parse(await response.json());
}

export async function getMobileShowWorkspace(orgId: string): Promise<MobileShowWorkspace> {
  const response = await authenticatedFetch(`/api/mobile/v1/show-workspace?orgId=${encodeURIComponent(orgId)}`);
  return showWorkspaceSchema.parse(await response.json());
}

export async function setMobileCheckInStatus(input: {
  orgId: string;
  memberId: string;
  checkedIn: boolean;
}) {
  const response = await authenticatedFetch(
    `/api/mobile/v1/checkin/members/${encodeURIComponent(input.memberId)}/status?orgId=${encodeURIComponent(input.orgId)}`,
    { method: "POST", body: JSON.stringify({ checkedIn: input.checkedIn }) },
  );
  return checkInStatusSchema.parse(await response.json());
}

export async function getMobileTeamAccess(orgId: string): Promise<MobileTeamAccess> {
  const response = await authenticatedFetch(`/api/mobile/v1/team/access?orgId=${encodeURIComponent(orgId)}`);
  return teamAccessSchema.parse(await response.json());
}

export async function grantMobileTeamAccess(input: {
  orgId: string;
  userId: string;
  capability: string;
  duration: "this-week" | "until-revoked";
  reason: string;
}) {
  const response = await authenticatedFetch(
    `/api/mobile/v1/team/access/grants?orgId=${encodeURIComponent(input.orgId)}`,
    { method: "POST", body: JSON.stringify(input) },
  );
  return z.object({ ok: z.literal(true), grantId: z.string() }).parse(await response.json());
}

export async function revokeMobileTeamAccess(input: { orgId: string; grantId: string }) {
  const response = await authenticatedFetch(
    `/api/mobile/v1/team/access/grants/${encodeURIComponent(input.grantId)}/revoke?orgId=${encodeURIComponent(input.orgId)}`,
    { method: "POST", body: JSON.stringify({}) },
  );
  return okSchema.parse(await response.json());
}

export async function getMobileTeamMembers(orgId: string): Promise<MobileTeamMembers> {
  const response = await authenticatedFetch(`/api/mobile/v1/team/members?orgId=${encodeURIComponent(orgId)}`);
  return teamMembersSchema.parse(await response.json());
}

export async function inviteMobileTeamMember(input: { orgId: string; email: string; role: string }) {
  const response = await authenticatedFetch(`/api/mobile/v1/team/invitations?orgId=${encodeURIComponent(input.orgId)}`, {
    method: "POST",
    body: JSON.stringify({ email: input.email, role: input.role }),
  });
  return inviteTeamMemberResponseSchema.parse(await response.json()).invitation;
}

export async function cancelMobileTeamInvitation(input: { orgId: string; invitationId: string }) {
  const response = await authenticatedFetch(
    `/api/mobile/v1/team/invitations/${encodeURIComponent(input.invitationId)}/cancel?orgId=${encodeURIComponent(input.orgId)}`,
    { method: "POST", body: JSON.stringify({}) },
  );
  return okSchema.parse(await response.json());
}

export async function updateMobileTeamMemberRole(input: { orgId: string; memberId: string; role: string }) {
  await authenticatedFetch(
    `/api/mobile/v1/team/members/${encodeURIComponent(input.memberId)}/role?orgId=${encodeURIComponent(input.orgId)}`,
    { method: "POST", body: JSON.stringify({ role: input.role }) },
  );
}

export async function removeMobileTeamMember(input: { orgId: string; memberId: string }) {
  const response = await authenticatedFetch(
    `/api/mobile/v1/team/members/${encodeURIComponent(input.memberId)}/remove?orgId=${encodeURIComponent(input.orgId)}`,
    { method: "POST", body: JSON.stringify({}) },
  );
  return okSchema.parse(await response.json());
}

export async function getMobileTeamCrew(orgId: string) {
  const response = await authenticatedFetch(`/api/mobile/v1/team/crew?orgId=${encodeURIComponent(orgId)}`);
  return teamCrewSchema.parse(await response.json());
}

export interface MobileTeamCrewWrite {
  orgId: string;
  memberId: string;
  name: string;
  role: string;
  email: string;
  photoUrl: string;
}

export async function createMobileTeamCrewMember(input: MobileTeamCrewWrite) {
  const response = await authenticatedFetch(`/api/mobile/v1/team/crew?orgId=${encodeURIComponent(input.orgId)}`, {
    method: "POST",
    body: JSON.stringify(input),
  });
  return z.object({ ok: z.literal(true), id: z.string() }).parse(await response.json());
}

export async function updateMobileTeamCrewMember(input: MobileTeamCrewWrite & { id: string }) {
  const response = await authenticatedFetch(
    `/api/mobile/v1/team/crew/${encodeURIComponent(input.id)}/update?orgId=${encodeURIComponent(input.orgId)}`,
    { method: "POST", body: JSON.stringify(input) },
  );
  return okSchema.parse(await response.json());
}

export async function removeMobileTeamCrewMember(input: { orgId: string; id: string }) {
  const response = await authenticatedFetch(
    `/api/mobile/v1/team/crew/${encodeURIComponent(input.id)}/remove?orgId=${encodeURIComponent(input.orgId)}`,
    { method: "POST", body: JSON.stringify({}) },
  );
  return okSchema.parse(await response.json());
}

export async function getMobileChecklist(orgId: string, showId: string): Promise<MobileChecklist> {
  const query = new URLSearchParams({ orgId, showId });
  const response = await authenticatedFetch(`/api/mobile/v1/checklist?${query}`);
  return mobileChecklistSchema.parse(await response.json());
}

export async function addMobileChecklistItem(input: {
  orgId: string;
  showId: string;
  label: string;
  category: ChecklistDepartment;
}) {
  const response = await authenticatedFetch(
    `/api/mobile/v1/checklist/items?orgId=${encodeURIComponent(input.orgId)}`,
    { method: "POST", body: JSON.stringify(input) },
  );
  return okSchema.parse(await response.json());
}

export async function toggleMobileChecklistEntry(input: {
  orgId: string;
  entryId: string;
  checked: boolean;
}) {
  const response = await authenticatedFetch(
    `/api/mobile/v1/checklist/entries/${encodeURIComponent(input.entryId)}/toggle?orgId=${encodeURIComponent(input.orgId)}`,
    { method: "POST", body: JSON.stringify({ checked: input.checked }) },
  );
  return okSchema.parse(await response.json());
}

export async function removeMobileChecklistEntry(input: {
  orgId: string;
  entryId: string;
}) {
  const response = await authenticatedFetch(
    `/api/mobile/v1/checklist/entries/${encodeURIComponent(input.entryId)}/remove?orgId=${encodeURIComponent(input.orgId)}`,
    { method: "POST", body: JSON.stringify({}) },
  );
  return okSchema.parse(await response.json());
}

export async function updateMobileChecklistCategory(input: {
  orgId: string;
  templateId: string;
  category: ChecklistDepartment;
}) {
  const response = await authenticatedFetch(
    `/api/mobile/v1/checklist/templates/${encodeURIComponent(input.templateId)}/category?orgId=${encodeURIComponent(input.orgId)}`,
    { method: "POST", body: JSON.stringify({ category: input.category }) },
  );
  return okSchema.parse(await response.json());
}

export async function getMobileChecklistDraft(orgId: string, showId: string): Promise<MobileChecklistDraft> {
  const query = new URLSearchParams({ orgId, showId });
  const response = await authenticatedFetch(`/api/mobile/v1/checklist/suggestions?${query}`);
  return mobileChecklistDraftSchema.parse(await response.json());
}

export async function applyMobileChecklistDraft(input: {
  orgId: string;
  showId: string;
  suggestionIds: string[];
}) {
  const response = await authenticatedFetch(
    `/api/mobile/v1/checklist/suggestions/apply?orgId=${encodeURIComponent(input.orgId)}`,
    { method: "POST", body: JSON.stringify(input) },
  );
  return checklistApplySchema.parse(await response.json());
}

export async function getMobileDevices(orgId: string): Promise<MobileDevices> {
  const response = await authenticatedFetch(`/api/mobile/v1/devices?orgId=${encodeURIComponent(orgId)}`);
  return devicesSchema.parse(await response.json());
}

export async function createMobileDevice(input: {
  orgId: string;
  name: string;
  adapterType: string;
  enabled: boolean;
  settings: Record<string, string>;
}) {
  const response = await authenticatedFetch(`/api/mobile/v1/devices?orgId=${encodeURIComponent(input.orgId)}`, {
    method: "POST",
    body: JSON.stringify(input),
  });
  return z.object({ ok: z.literal(true), id: z.string() }).parse(await response.json());
}

export async function updateMobileDevice(input: {
  orgId: string;
  deviceId: string;
  name: string;
  adapterType: string;
  enabled: boolean;
  settings: Record<string, string>;
}) {
  const response = await authenticatedFetch(
    `/api/mobile/v1/devices/${encodeURIComponent(input.deviceId)}?orgId=${encodeURIComponent(input.orgId)}`,
    { method: "POST", body: JSON.stringify(input) },
  );
  return okSchema.parse(await response.json());
}

export async function removeMobileDevice(input: { orgId: string; deviceId: string }) {
  const response = await authenticatedFetch(
    `/api/mobile/v1/devices/${encodeURIComponent(input.deviceId)}/remove?orgId=${encodeURIComponent(input.orgId)}`,
    { method: "POST", body: JSON.stringify({}) },
  );
  return okSchema.parse(await response.json());
}

export async function controlMobileDevice(input: {
  orgId: string;
  deviceId: string;
  operation: "connect" | "disconnect" | "action";
  actionId?: string;
  params?: Record<string, number | boolean | string>;
}) {
  const response = await authenticatedFetch(
    `/api/mobile/v1/devices/${encodeURIComponent(input.deviceId)}/control?orgId=${encodeURIComponent(input.orgId)}`,
    { method: "POST", body: JSON.stringify(input) },
  );
  return z.object({ success: z.literal(true), response: z.string().optional() }).parse(await response.json());
}

export async function getMobileDeviceControlState(input: { orgId: string; deviceId: string }) {
  const response = await authenticatedFetch(
    `/api/mobile/v1/devices/${encodeURIComponent(input.deviceId)}/control?orgId=${encodeURIComponent(input.orgId)}`,
  );
  return mobileDeviceControlStateSchema.parse(await response.json());
}

export async function getMobileCueSheet(orgId: string, showId?: string): Promise<MobileCueSheet> {
  const query = new URLSearchParams({ orgId });
  if (showId) query.set("showId", showId);
  const response = await authenticatedFetch(`/api/mobile/v1/cue-sheets?${query}`);
  return cueSheetSchema.parse(await response.json());
}

export async function writeMobileCueSheet(input: {
  orgId: string;
  action: "upsert-note" | "add-column" | "update-column" | "move-column" | "remove-column";
  showId?: string;
  itemId?: string;
  columnId?: string;
  text?: string;
  label?: string;
  color?: string;
  sortOrder?: number;
}) {
  const response = await authenticatedFetch(`/api/mobile/v1/cue-sheets?orgId=${encodeURIComponent(input.orgId)}`, {
    method: "POST",
    body: JSON.stringify(input),
  });
  return okSchema.extend({ id: z.string().optional() }).parse(await response.json());
}

export interface MobileAssetWrite {
  orgId: string;
  name: string;
  category: string;
  status: string;
  location: string;
  serialNumber: string;
  notes: string;
}

export async function getMobileAssets(orgId: string): Promise<MobileAssets> {
  const response = await authenticatedFetch(`/api/mobile/v1/assets?orgId=${encodeURIComponent(orgId)}`);
  return assetsSchema.parse(await response.json());
}

export async function createMobileAsset(input: MobileAssetWrite) {
  const response = await authenticatedFetch(`/api/mobile/v1/assets?orgId=${encodeURIComponent(input.orgId)}`, {
    method: "POST", body: JSON.stringify(input),
  });
  return okSchema.extend({ id: z.string() }).parse(await response.json());
}

export async function updateMobileAsset(input: MobileAssetWrite & { id: string }) {
  const response = await authenticatedFetch(`/api/mobile/v1/assets/${encodeURIComponent(input.id)}?orgId=${encodeURIComponent(input.orgId)}`, {
    method: "POST", body: JSON.stringify(input),
  });
  return okSchema.parse(await response.json());
}

export async function removeMobileAsset(input: { orgId: string; id: string }) {
  const response = await authenticatedFetch(`/api/mobile/v1/assets/${encodeURIComponent(input.id)}?orgId=${encodeURIComponent(input.orgId)}`, {
    method: "POST", body: JSON.stringify({ action: "remove" }),
  });
  return okSchema.parse(await response.json());
}

export async function getMobileStreaming(orgId: string): Promise<MobileStreaming> {
  const response = await authenticatedFetch(`/api/mobile/v1/streaming?orgId=${encodeURIComponent(orgId)}`);
  return streamingSchema.parse(await response.json());
}

export interface MobileDestinationWrite {
  orgId: string;
  name: string;
  platform: string;
  rtmpUrl: string;
  streamKey?: string;
}

export async function createMobileDestination(input: MobileDestinationWrite) {
  const response = await authenticatedFetch(`/api/mobile/v1/streaming/destinations?orgId=${encodeURIComponent(input.orgId)}`, {
    method: "POST", body: JSON.stringify(input),
  });
  return okSchema.extend({ id: z.string() }).parse(await response.json());
}

export async function updateMobileDestination(input: MobileDestinationWrite & { id: string }) {
  const response = await authenticatedFetch(`/api/mobile/v1/streaming/destinations/${encodeURIComponent(input.id)}?orgId=${encodeURIComponent(input.orgId)}`, {
    method: "POST", body: JSON.stringify(input),
  });
  return okSchema.parse(await response.json());
}

export async function commandMobileDestination(input: { orgId: string; id: string; action: "toggle" | "remove"; enabled?: boolean }) {
  const response = await authenticatedFetch(`/api/mobile/v1/streaming/destinations/${encodeURIComponent(input.id)}?orgId=${encodeURIComponent(input.orgId)}`, {
    method: "POST", body: JSON.stringify(input),
  });
  return okSchema.parse(await response.json());
}

export async function getMobileGraphics(orgId: string): Promise<MobileGraphics> {
  const response = await authenticatedFetch(`/api/mobile/v1/graphics?orgId=${encodeURIComponent(orgId)}`);
  return graphicsSchema.parse(await response.json());
}

export interface MobileGraphicWrite {
  orgId: string;
  name: string;
  title: string;
  subtitle: string;
}

export async function createMobileGraphic(input: MobileGraphicWrite) {
  const response = await authenticatedFetch(`/api/mobile/v1/graphics?orgId=${encodeURIComponent(input.orgId)}`, {
    method: "POST", body: JSON.stringify(input),
  });
  return okSchema.extend({ id: z.string() }).parse(await response.json());
}

export async function updateMobileGraphic(input: MobileGraphicWrite & { id: string }) {
  const response = await authenticatedFetch(`/api/mobile/v1/graphics/${encodeURIComponent(input.id)}?orgId=${encodeURIComponent(input.orgId)}`, {
    method: "POST", body: JSON.stringify(input),
  });
  return okSchema.parse(await response.json());
}

export async function commandMobileGraphic(input: { orgId: string; id?: string; action: "toggle" | "clear" | "remove" }) {
  const path = input.id ? `/api/mobile/v1/graphics/${encodeURIComponent(input.id)}` : "/api/mobile/v1/graphics";
  const response = await authenticatedFetch(`${path}?orgId=${encodeURIComponent(input.orgId)}`, {
    method: "POST", body: JSON.stringify(input),
  });
  return okSchema.extend({ activeIds: z.array(z.string()).optional() }).parse(await response.json());
}

export async function getMobileDashboard(orgId: string, kind: "pm" | "tm", showId?: string): Promise<MobileDashboard> {
  const query = new URLSearchParams({ orgId });
  if (showId) query.set("showId", showId);
  const response = await authenticatedFetch(`/api/mobile/v1/dashboards/${kind}?${query}`);
  return dashboardSchema.parse(await response.json());
}

export async function getMobileReports(orgId: string): Promise<MobileReports> {
  const response = await authenticatedFetch(`/api/mobile/v1/reports?orgId=${encodeURIComponent(orgId)}`);
  return reportsSchema.parse(await response.json());
}

export async function getMobileAudio(orgId: string, showId?: string): Promise<MobileAudio> {
  const query = new URLSearchParams({ orgId });
  if (showId) query.set("showId", showId);
  const response = await authenticatedFetch(`/api/mobile/v1/audio?${query}`);
  return audioSchema.parse(await response.json());
}

export interface MobileAudioWrite {
  orgId: string;
  showId: string;
  channel: number;
  label: string;
  micType: string;
  micModel: string;
  notes: string;
  gainDb?: number | null;
  phantom: boolean;
  muted: boolean;
  group: string;
  mixerConsole: string;
  mixerChannel?: number | null;
  mixerChannelType: string;
}

export async function createMobileAudioAssignment(input: MobileAudioWrite) {
  const response = await authenticatedFetch(`/api/mobile/v1/audio?orgId=${encodeURIComponent(input.orgId)}`, {
    method: "POST", body: JSON.stringify(input),
  });
  return okSchema.extend({ id: z.string() }).parse(await response.json());
}

export async function updateMobileAudioAssignment(input: MobileAudioWrite & { id: string }) {
  const response = await authenticatedFetch(`/api/mobile/v1/audio/${encodeURIComponent(input.id)}?orgId=${encodeURIComponent(input.orgId)}`, {
    method: "POST", body: JSON.stringify(input),
  });
  return okSchema.parse(await response.json());
}

export async function removeMobileAudioAssignment(input: { orgId: string; id: string }) {
  const response = await authenticatedFetch(`/api/mobile/v1/audio/${encodeURIComponent(input.id)}?orgId=${encodeURIComponent(input.orgId)}`, {
    method: "POST", body: JSON.stringify({ action: "remove" }),
  });
  return okSchema.parse(await response.json());
}

export async function getMobileTimecode(orgId: string): Promise<{ state: MobileTimecodeState; events: MobileTimecodeEvent[] }> {
  const root = `/api/timecode/${encodeURIComponent(orgId)}`;
  const [stateResponse, eventsResponse] = await Promise.all([
    authenticatedFetch(`${root}/state`),
    authenticatedFetch(`${root}/events`),
  ]);
  return {
    state: timecodeStateSchema.parse(await stateResponse.json()),
    events: z.array(timecodeEventSchema).parse(await eventsResponse.json()),
  };
}

export async function commandMobileTimecode(input: {
  orgId: string;
  action: "start" | "stop" | "set-timecode" | "set-source" | "set-format" | "add-event" | "update-event" | "remove-event" | "reset-events";
  payload?: Record<string, unknown>;
}) {
  const response = await authenticatedFetch(`/api/timecode/${encodeURIComponent(input.orgId)}/command`, {
    method: "POST", body: JSON.stringify({ action: input.action, payload: input.payload }),
  });
  return okSchema.parse(await response.json());
}

export async function markNotificationRead(orgId: string, notificationId: string) {
  await authenticatedFetch("/api/mobile/v1/notifications/read", {
    method: "POST",
    body: JSON.stringify({ orgId, notificationId }),
  });
}

export async function markAllNotificationsRead(orgId: string) {
  await authenticatedFetch("/api/mobile/v1/notifications/read", {
    method: "POST",
    body: JSON.stringify({ orgId, all: true }),
  });
}

export async function saveMobilePushToken(
  orgId: string,
  token: string,
  platform: "ios" | "android",
  enabled = true,
) {
  await authenticatedFetch("/api/mobile/v1/push-token", {
    method: "POST",
    body: JSON.stringify({ orgId, token, platform, enabled }),
  });
}
