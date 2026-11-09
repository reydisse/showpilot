import { z } from "zod";
import {
  hasLivePermissionAuthority,
  hasLiveRundownAuthority,
  type LiveRundownAuthorityClaim,
} from "./live-rundown-authority.server";
import {
  resolveTimecodeTarget,
  getShowTimecodeRelay,
  timecodeTargetUrl,
} from "./timecode-target.server";
import { rundownInternalRequest } from "./rundown-internal-request.server";
import { rundownRelayKey } from "./rundown-relay-key";
import { resolveTimecodeDeviceAction } from "./timecode-device-actions";
import { authorizeBridgeTarget } from "./bridge-targets.server";
import type { BridgeEndpoint } from "@showpilot/shared/bridge-target";
import type { LocalShowPreparationInput } from "./local-show-protocol";
export {
  localShowPreparationInput,
  type LocalShowPreparationInput,
} from "./local-show-protocol";

const localId = z.string().regex(/^[A-Za-z0-9:_-]{1,100}$/);
type Bindings = Pick<
  Cloudflare.Env,
  "DB" | "RUNDOWN_RELAY" | "TIMECODE_RELAY"
> & { BETTER_AUTH_SECRET?: string; CREDENTIAL_ENCRYPTION_KEYS?: string };
const timestamp = z.number().int().nonnegative();
const snapshotSchema = z.object({
  initialized: z.literal(true),
  showId: localId,
  serviceDate: z.string(),
  serviceName: z.string().max(500).optional(),
  revision: timestamp,
  items: z
    .array(
      z.object({
        id: localId,
        title: z.string().max(1000),
        type: z.string().max(50),
        duration: timestamp.max(86_400_000),
        notes: z.string().max(10000),
        assignee: z.string().max(1000),
        cue: z.string().max(1000),
        status: z.enum(["upcoming", "live", "complete"]),
        actualStart: z.string().nullable().optional(),
        actualEnd: z.string().nullable().optional(),
      }),
    )
    .max(1000),
  timer: z.object({
    playback: z.enum(["play", "pause", "stop"]),
    currentItemId: localId.nullable(),
    elapsed: z.number().finite(),
    startedAt: timestamp.nullable(),
    pausedAt: timestamp.nullable(),
    mode: z.enum(["count-up", "count-down", "clock"]),
  }),
});
const cuesSchema = z
  .array(
    z.object({
      id: localId,
      label: z.string().max(500),
      action: z.string(),
      enabled: z.boolean().optional(),
      payload: z.record(z.string(), z.unknown()),
      targetDeviceId: z.string().optional(),
      targetActionId: z.string().optional(),
    }),
  )
  .max(2000);

export async function assertLocalShowAuthority(
  db: D1Database,
  claim: LiveRundownAuthorityClaim,
  orgId: string,
): Promise<void> {
  if (
    claim.orgId !== orgId ||
    !(await hasLiveRundownAuthority(db, claim, "rundown:control")) ||
    !(await hasLivePermissionAuthority(db, claim, "devices:access")) ||
    !(await hasLivePermissionAuthority(db, claim, "timecode:access"))
  )
    throw new Error(
      "Local preparation requires current rundown control, device access and timecode access. Check your permissions and rundown PIN.",
    );
}

/** Build private preparation data only inside the Worker. Browser input supplies
 * identities and a revision, never device commands, passwords or approvals.
 */
export async function buildLocalShowPreparation(
  bindings: Bindings,
  input: LocalShowPreparationInput,
  claim: LiveRundownAuthorityClaim,
) {
  await assertLocalShowAuthority(bindings.DB, claim, input.orgId);
  const target = await resolveTimecodeTarget(
    bindings.DB,
    input.orgId,
    input.showId,
  );
  if (!target || target.serviceDate !== input.serviceDate)
    throw new Error(
      "This show is unavailable or its date changed. Refresh before preparing it.",
    );
  const timecode = await getShowTimecodeRelay(bindings, target);
  const eventsUrl = timecodeTargetUrl(target, "/events");
  eventsUrl.searchParams.set("access", "write");
  eventsUrl.searchParams.set("authUserId", claim.userId);
  eventsUrl.searchParams.set("authSessionId", claim.sessionId);
  const eventResponse = await timecode.fetch(eventsUrl);
  if (!eventResponse.ok)
    throw new Error(
      "The show device cues could not be read. Refresh your session and try again.",
    );
  const events = cuesSchema.parse(await eventResponse.json());
  const actions = [];
  const approvedTargets = new Map<string, BridgeEndpoint>();
  for (const event of events) {
    if (
      event.enabled === false ||
      (event.action !== "device-action" && event.action !== "lighting-scene")
    )
      continue;
    if (actions.length >= 500)
      throw new Error(
        "This show has more than 500 local device cues. Split it into smaller shows before preparing local control.",
      );
    let action;
    try {
      action = await resolveTimecodeDeviceAction(
        bindings.DB,
        input.orgId,
        { ...event, action: event.action },
        bindings.CREDENTIAL_ENCRYPTION_KEYS,
      );
    } catch {
      throw new Error(
        `Device cue “${event.label}” cannot be prepared. Check its device and saved action settings.`,
      );
    }
    const actor = { source: "operator" as const, actorUserId: claim.userId };
    const endpoints = await authorizeBridgeTarget(
      bindings.DB,
      input.orgId,
      {
        type: "connect-device",
        protocol: action.protocol,
        target: action.target,
        settings: action.connectionSettings,
      },
      actor,
    );
    const commandEndpoints = await authorizeBridgeTarget(
      bindings.DB,
      input.orgId,
      {
        type: "command",
        protocol: action.protocol,
        target: action.target,
        command: action.command,
        settings: action.connectionSettings,
      },
      actor,
    );
    for (const endpoint of [...endpoints, ...commandEndpoints])
      approvedTargets.set(
        JSON.stringify([endpoint.protocol, endpoint.host, endpoint.port]),
        endpoint,
      );
    actions.push({
      id: event.id,
      label: event.label,
      deviceId: action.deviceId,
      protocol: action.protocol,
      target: action.target,
      command: action.command,
      settings: action.connectionSettings,
    });
  }
  // Read the live revision after resolving device settings. Stale browser state
  // must refresh instead of silently preparing a different rundown snapshot.
  const url = new URL("https://rundown.internal/state");
  for (const [key, value] of Object.entries({ ...target, access: "observe" }))
    url.searchParams.set(key, value);
  const rundown = bindings.RUNDOWN_RELAY.getByName(
    rundownRelayKey(target.orgId, target.serviceDate, "", target.showId),
  );
  const response = await rundown.fetch(
    rundownInternalRequest(url, bindings.BETTER_AUTH_SECRET),
  );
  if (!response.ok)
    throw new Error(
      "The live rundown could not be read. Reconnect and try again.",
    );
  const parsed = snapshotSchema.safeParse(await response.json());
  if (!parsed.success)
    throw new Error(
      "Open the saved show and wait for its rundown to load before preparing local control.",
    );
  const snapshot = parsed.data;
  if (
    snapshot.showId !== input.showId ||
    snapshot.serviceDate !== input.serviceDate
  )
    throw new Error(
      "The live rundown belongs to another show. Refresh before preparing local control.",
    );
  if (snapshot.revision !== input.expectedRevision)
    throw new Error(
      "The rundown changed. Refresh it before preparing local control.",
    );
  const preparedAt = Date.now();
  return {
    version: 1 as const,
    sessionId: input.sessionId,
    orgId: input.orgId,
    installationId: input.installationId,
    showId: input.showId,
    serviceDate: input.serviceDate,
    title: snapshot.serviceName ?? "Local show",
    baseRevision: snapshot.revision,
    preparedAt,
    expiresAt: preparedAt + 86_400_000,
    items: snapshot.items,
    timer: snapshot.timer,
    actions,
    approvedTargets: [...approvedTargets.values()],
  };
}
