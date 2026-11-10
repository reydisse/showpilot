import { env } from "cloudflare:workers";
import { z } from "zod";
import { getAuth } from "./auth";
import { getActiveRundownRelayTarget } from "./active-rundown-relay";
import { resolveEffectiveAccess } from "./effective-access";
import {
  getPresentedRundownPin,
  RUNDOWN_PIN_HEADER,
  resolveRundownAccess,
} from "./rundown-pin.server";
import { nextPlayableItem } from "./rundown-transport";
import { withOperationTimeout } from "./operation-timeout";
import {
  tmRundownCommandSchema,
  tmRundownResultSchema,
  tmRundownSnapshotSchema,
  type TmRundownCommand,
  type TmRundownResult,
} from "./tm-rundown-contract";

const stateSchema = z.object({
  showId: z.string().nullable(),
  serviceDate: z.string().nullable(),
  initialized: z.boolean(),
  revision: z.number().int().nonnegative(),
  items: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      type: z.string(),
      status: z.string(),
    }),
  ),
  timer: z.object({
    playback: z.enum(["play", "pause", "stop"]),
    currentItemId: z.string().nullable(),
    elapsed: z.number(),
    serverTime: z.number(),
  }),
  ppOutputEnabled: z.boolean(),
});
async function authority(orgId: string, headers: Headers) {
  const session = await getAuth().api.getSession({
    headers,
    query: { disableCookieCache: true },
  });
  if (!session) throw new Error("Sign in before using rundown controls.");
  const access = await resolveEffectiveAccess(env.DB, session.user.id, orgId);
  if (!access?.permissions.includes("dashboard:tm"))
    throw new Error("Forbidden");
  if (
    await env.DB.prepare(
      "SELECT id FROM app_setting WHERE orgId=? AND key='organization-deleting'",
    )
      .bind(orgId)
      .first()
  )
    throw new Error("This workspace is being deleted.");
  const pin = getPresentedRundownPin(
    new Request("https://showpilot.local", { headers }),
    orgId,
  );
  const rundown = await resolveRundownAccess(env.DB, orgId, access, pin);
  return {
    userId: session.user.id,
    sessionId: session.session.id,
    pin,
    canControl: rundown.permissions.includes("rundown:control"),
    blockedReason: rundown.permissions.includes("rundown:control")
      ? null
      : rundown.pin === "locked"
        ? "Unlock the rundown with its PIN before using these controls."
        : "You do not have permission to control this rundown.",
  };
}
type Actor = Awaited<ReturnType<typeof authority>>;
type Target = Awaited<ReturnType<typeof getActiveRundownRelayTarget>>;
async function relay(
  orgId: string,
  actor: Actor,
  target: Target,
  body?: string,
) {
  const url = new URL(
    body ? "https://rundown/command" : "https://rundown/state",
  );
  url.searchParams.set("orgId", orgId);
  url.searchParams.set("access", body ? "control" : "observe");
  url.searchParams.set("authUserId", actor.userId);
  url.searchParams.set("authSessionId", actor.sessionId);
  // The room key pins identity. Do not pass relabelling parameters: a control
  // read or retry must never initialize, switch, or clear an existing room.
  const headers = new Headers({ "Content-Type": "application/json" });
  if (actor.pin) headers.set(RUNDOWN_PIN_HEADER, actor.pin);
  const stub = env.RUNDOWN_RELAY.get(env.RUNDOWN_RELAY.idFromName(target.key));
  return withOperationTimeout(
    stub.fetch(
      new Request(url, { method: body ? "POST" : "GET", headers, body }),
    ),
    7_000,
    "Rundown feedback was not confirmed. Retry to recover the result.",
  );
}
async function readState(orgId: string, actor: Actor, target: Target) {
  const response = await relay(orgId, actor, target);
  if (!response.ok) throw new Error("Could not confirm rundown feedback.");
  return stateSchema.parse(await response.json());
}
const matches = (
  state: { showId: string | null; serviceDate: string | null },
  target: { showId: string | null; serviceDate: string },
) => state.showId === target.showId && state.serviceDate === target.serviceDate;
export async function readTmRundown(orgId: string, headers: Headers) {
  const actor = await authority(orgId, headers),
    target = await getActiveRundownRelayTarget(env.DB, orgId),
    state = await readState(orgId, actor, target);
  if (state.initialized && !matches(state, target))
    throw new Error(
      "Show identity changed. Open the rundown to review its current state.",
    );
  const currentIndex = state.items.findIndex(
    (item) => item.id === state.timer.currentItemId,
  );
  return tmRundownSnapshotSchema.parse({
    target,
    revision: state.revision,
    initialized: state.initialized,
    serverTime: state.timer.serverTime,
    timer: state.timer,
    currentItem: state.items[currentIndex] ?? null,
    nextItem: nextPlayableItem(state.items, state.timer.currentItemId),
    firstItem:
      state.items.find(
        (item) => item.type !== "header" && item.status !== "complete",
      ) ?? null,
    hasPrevious: state.items
      .slice(0, Math.max(0, currentIndex))
      .some((item) => item.type !== "header"),
    lyricsEnabled: state.ppOutputEnabled,
    canControl: actor.canControl,
    blockedReason: actor.blockedReason,
  });
}
function relayCommand(
  command: TmRundownCommand,
  state: z.infer<typeof stateSchema>,
) {
  switch (command.action) {
    case "timer-start":
      return state.timer.playback === "pause"
        ? { action: "timer-resume" }
        : {
            action: "timer-start",
            payload: {
              itemId:
                state.timer.currentItemId ??
                state.items.find(
                  (item) =>
                    item.type !== "header" && item.status !== "complete",
                )?.id,
            },
          };
    case "timer-stop":
      return { action: "timer-stop" };
    case "rundown-next":
      return { action: "timer-next" };
    case "rundown-previous":
      return { action: "timer-prev" };
    case "timer-add":
      return { action: "timer-adjust", payload: { deltaMs: 60000 } };
    case "timer-subtract":
      return { action: "timer-adjust", payload: { deltaMs: -60000 } };
    case "lyrics-on":
      return { action: "pp-output-enabled", payload: { enabled: true } };
    case "lyrics-off":
      return { action: "pp-output-enabled", payload: { enabled: false } };
  }
}
export async function executeTmRundown(
  input: TmRundownCommand,
  headers: Headers,
): Promise<TmRundownResult> {
  const command = tmRundownCommandSchema.parse(input),
    actor = await authority(command.orgId, headers);
  if (!actor.canControl) throw new Error(actor.blockedReason ?? "Forbidden");
  const scope = [command.orgId, actor.userId, command.requestId],
    fingerprint = JSON.stringify(command);
  const readReceipt = () =>
    env.DB.prepare(
      "SELECT fingerprint,relayBody,outcome FROM tm_rundown_command_receipt WHERE orgId=? AND actorId=? AND requestId=?",
    )
      .bind(...scope)
      .first<{
        fingerprint: string;
        relayBody: string;
        outcome: string | null;
      }>();
  let receipt = await readReceipt();
  if (receipt && receipt.fingerprint !== fingerprint)
    throw new Error(
      "This request already belongs to a different rundown command.",
    );
  if (receipt?.outcome)
    return tmRundownResultSchema.parse({
      requestId: command.requestId,
      outcome: receipt.outcome,
    });
  const target = await getActiveRundownRelayTarget(env.DB, command.orgId);
  if (!receipt) {
    if (command.expiresAt > Date.now() + 5000)
      throw new Error(
        "The command deadline is too far ahead. Refresh rundown feedback.",
      );
    const state = await readState(command.orgId, actor, target);
    const outcome = !matches(target, command.target)
      ? "target-changed"
      : command.expiresAt <= Date.now()
        ? "expired"
        : !state.initialized || !matches(state, command.target)
          ? "unavailable"
          : null;
    // The receipt binds one actor's request to its original payload. The relay
    // remains the single writer and owns revision/expiry checks and deduplication.
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(scope)),
    );
    const id = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    const relayBody = JSON.stringify({
      ...relayCommand(command, state),
      id,
      expectedRevision: command.expectedRevision,
      expiresAt: command.expiresAt,
    });
    await env.DB.prepare(
      "INSERT INTO tm_rundown_command_receipt(orgId,actorId,requestId,fingerprint,relayBody,outcome) VALUES(?,?,?,?,?,?) ON CONFLICT(orgId,actorId,requestId) DO NOTHING",
    )
      .bind(...scope, fingerprint, relayBody, outcome)
      .run();
    receipt = await readReceipt();
    if (!receipt || receipt.fingerprint !== fingerprint)
      throw new Error(
        "This request already belongs to a different rundown command.",
      );
    if (receipt.outcome)
      return tmRundownResultSchema.parse({
        requestId: command.requestId,
        outcome: receipt.outcome,
      });
  }
  let outcome: TmRundownResult["outcome"];
  if (!matches(target, command.target)) outcome = "target-changed";
  else {
    const response = await relay(
      command.orgId,
      actor,
      target,
      receipt.relayBody,
    );
    if (!response.ok && response.status !== 409)
      throw new Error(
        "Rundown command was not confirmed. Check your permission and retry the same request.",
      );
    const result = z
      .discriminatedUnion("ok", [
        z.object({ ok: z.literal(true) }),
        z.object({
          ok: z.literal(false),
          reason: z.enum(["revision-conflict", "expired"]),
        }),
      ])
      .parse(await response.json());
    outcome = result.ok ? "applied" : result.reason;
  }
  await env.DB.prepare(
    "UPDATE tm_rundown_command_receipt SET outcome=? WHERE orgId=? AND actorId=? AND requestId=? AND outcome IS NULL",
  )
    .bind(outcome, ...scope)
    .run();
  const saved = await readReceipt();
  return tmRundownResultSchema.parse({
    requestId: command.requestId,
    outcome: saved?.outcome,
  });
}
