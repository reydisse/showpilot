import { z } from "zod";
import { parseLocalRundownJournal } from "@showpilot/shared/local-rundown";
import { invokeDesktopLocalShow } from "./desktop-runtime";

const id = z.string().regex(/^[A-Za-z0-9:_-]{1,100}$/);
const timestamp = z.number().int().nonnegative();
const timer = z.object({
  playback: z.enum(["play", "pause", "stop"]),
  currentItemId: id.nullable(),
  elapsed: z.number().finite(),
  startedAt: timestamp.nullable(),
  pausedAt: timestamp.nullable(),
  mode: z.enum(["count-up", "count-down", "clock"]),
});
const item = z.object({
  id,
  title: z.string().max(1000),
  type: z.string().max(50),
  duration: timestamp.max(86_400_000),
  notes: z.string().max(10000),
  assignee: z.string().max(1000),
  cue: z.string().max(1000),
  status: z.enum(["upcoming", "live", "complete"]),
  actualStart: z.string().nullable().optional(),
  actualEnd: z.string().nullable().optional(),
});
const journal = z.object({
  version: z.literal(1),
  sessionId: id,
  orgId: id,
  showId: id,
  serviceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  baseRevision: timestamp,
  startedAt: timestamp,
  endedAt: timestamp,
  operations: z
    .array(
      z.object({
        at: timestamp,
        action: z.string().max(50),
        payload: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .max(2000),
});
const common = {
  installationId: id.nullable(),
  commandSource: z.enum([
    "cloud",
    "entering-local",
    "local",
    "local-held",
    "leaving-local",
    "stopped",
  ]),
  storageError: z.string().max(2000).nullable().optional(),
};
const statusSchema = z.discriminatedUnion("mode", [
  z.object({ ...common, mode: z.literal("empty") }),
  z.object({
    ...common,
    mode: z.enum(["prepared", "active", "finished", "reconciled"]),
    sessionId: id,
    orgId: id,
    showId: id,
    serviceDate: z.string(),
    title: z.string().max(500),
    baseRevision: timestamp,
    sequence: timestamp,
    preparedAt: timestamp,
    expiresAt: timestamp,
    serverTime: timestamp,
    ready: z.boolean(),
    items: z.array(item).max(1000),
    timer,
    actions: z
      .array(z.object({ id, label: z.string().max(500), deviceId: id }))
      .max(500),
    results: z
      .array(
        z.object({
          kind: z.literal("device"),
          requestId: id,
          at: timestamp,
          actionId: id,
          result: z.enum([
            "pending",
            "acknowledged",
            "sent",
            "failed",
            "unknown",
          ]),
        }),
      )
      .max(2000),
    journal: journal.nullable(),
  }),
]);
export type DesktopLocalShowStatus = z.infer<typeof statusSchema>;
export type PreparedDesktopLocalShow = Exclude<
  DesktopLocalShowStatus,
  { mode: "empty" }
>;
export type LocalShowTarget = {
  orgId: string;
  showId: string;
  serviceDate: string;
};

export function parseDesktopLocalShowStatus(
  value: unknown,
): DesktopLocalShowStatus {
  const parsed = statusSchema.safeParse(value);
  if (!parsed.success)
    throw new Error(
      "Update ShowPilot Desktop and refresh local status. The engine returned an unsupported local show.",
    );
  const status = parsed.data;
  if (status.mode !== "empty") {
    if (
      (status.mode === "finished" || status.mode === "reconciled") !==
      (status.journal !== null)
    )
      throw new Error(
        "The local journal is incomplete. Keep it for recovery and refresh the engine.",
      );
    if (status.journal) {
      const parsedJournal = parseLocalRundownJournal(
        status.journal,
        status.serverTime,
      );
      if (
        !parsedJournal ||
        parsedJournal.sessionId !== status.sessionId ||
        parsedJournal.orgId !== status.orgId ||
        parsedJournal.showId !== status.showId ||
        parsedJournal.serviceDate !== status.serviceDate ||
        parsedJournal.baseRevision !== status.baseRevision
      )
        throw new Error(
          "The local journal does not match its prepared show. Keep it for recovery.",
        );
      // Project validated timer fields back to the wire format. Unknown payload
      // fields, including private device settings, never enter sync or export.
      status.journal = {
        ...parsedJournal,
        operations: parsedJournal.operations.map(({ at, command }) => {
          const { type: action, ...payload } = command;
          return { at, action, payload };
        }),
      };
    }
  }
  return status;
}
export function matchesLocalShow(
  status: DesktopLocalShowStatus,
  target: LocalShowTarget,
): status is PreparedDesktopLocalShow {
  return (
    status.mode !== "empty" &&
    status.orgId === target.orgId &&
    status.showId === target.showId &&
    status.serviceDate === target.serviceDate
  );
}
export async function readDesktopLocalShow(): Promise<DesktopLocalShowStatus> {
  return parseDesktopLocalShowStatus(
    await invokeDesktopLocalShow({ operation: "status" }),
  );
}
export async function discardDesktopLocalShow(
  status: PreparedDesktopLocalShow,
): Promise<DesktopLocalShowStatus> {
  if (status.mode === "active" || status.commandSource !== "cloud")
    throw new Error("Finish local control before discarding the saved record.");
  const saved = parseDesktopLocalShowStatus(
    await invokeDesktopLocalShow({
      operation: "discard",
      sessionId: status.sessionId,
      confirmed: true,
    }),
  );
  if (saved.mode !== "empty")
    throw new Error(
      "The local engine did not confirm discarding the record. Refresh its saved status.",
    );
  return saved;
}
const syncResponse = z.object({
  ok: z.boolean(),
  showId: id,
  serviceDate: z.string(),
  revision: timestamp,
  reason: z.string().optional(),
  duplicate: z.boolean().optional(),
});

/** Reuse the authenticated rundown command endpoint and the original revision.
 * A lost reply retries the same journal ID. Devices are absent from this payload.
 */
export async function syncDesktopLocalShow(
  status: PreparedDesktopLocalShow,
  target: LocalShowTarget,
): Promise<
  | { kind: "conflict"; revision: number }
  | { kind: "synced"; revision: number; status: DesktopLocalShowStatus }
> {
  if (
    !matchesLocalShow(status, target) ||
    status.mode !== "finished" ||
    !status.journal ||
    status.commandSource !== "cloud"
  )
    throw new Error(
      "Finish local control and open its saved show before syncing timer progress.",
    );
  const params = new URLSearchParams({
    showId: target.showId,
    serviceDate: target.serviceDate,
  });
  let response: Response;
  try {
    response = await fetch(
      `/api/rundown/${encodeURIComponent(target.orgId)}/command?${params}`,
      {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(15000),
        body: JSON.stringify({
          action: "reconcile-local",
          id: `local:${status.sessionId}`,
          expectedRevision: status.baseRevision,
          payload: status.journal,
        }),
      },
    );
  } catch {
    throw new Error(
      "Cloud sync could not be confirmed. Your local journal is saved; retry uses the same session and never replays devices.",
    );
  }
  if (response.status === 401 || response.status === 403)
    throw new Error(
      "Sign in and unlock rundown control before syncing the saved timer progress.",
    );
  const result = syncResponse.safeParse(
    await response.json().catch(() => null),
  );
  if (
    !result.success ||
    result.data.showId !== target.showId ||
    result.data.serviceDate !== target.serviceDate
  )
    throw new Error(
      "The cloud did not confirm this show's timer progress. Keep the local journal and retry.",
    );
  if (response.status === 409 && result.data.reason === "revision-conflict")
    return { kind: "conflict", revision: result.data.revision };
  if (!response.ok || !result.data.ok)
    throw new Error(
      "The cloud rejected the saved timer journal. Download it for review; no device commands were replayed.",
    );
  try {
    const saved = parseDesktopLocalShowStatus(
      await invokeDesktopLocalShow({
        operation: "reconciled",
        sessionId: status.sessionId,
        expectedSequence: status.sequence,
      }),
    );
    if (
      !matchesLocalShow(saved, target) ||
      saved.sessionId !== status.sessionId ||
      saved.mode !== "reconciled"
    )
      throw new Error("Unexpected local receipt");
    return { kind: "synced", revision: result.data.revision, status: saved };
  } catch {
    throw new Error(
      "The cloud accepted timer progress, but this computer did not confirm saving the sync receipt. Retry saved sync to confirm it without replaying any actions.",
    );
  }
}

export function downloadLocalShowRecord(
  status: PreparedDesktopLocalShow,
): void {
  const record = {
    version: 1,
    sessionId: status.sessionId,
    orgId: status.orgId,
    showId: status.showId,
    serviceDate: status.serviceDate,
    title: status.title,
    baseRevision: status.baseRevision,
    items: status.items,
    timer: status.timer,
    actions: status.actions,
    results: status.results,
    journal: status.journal,
  };
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(record, null, 2)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `showpilot-local-${status.showId}-${status.serviceDate}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
