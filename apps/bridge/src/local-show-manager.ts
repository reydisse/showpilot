import {
  applyRundownTransport,
  parseRundownTransport,
  type RundownTransportCommand,
} from "@showpilot/shared/rundown-transport";
import type { BridgeEndpoint } from "@showpilot/shared/bridge-target";
import { LocalShowStoreError } from "./local-show-store.js";
import {
  isLocalId,
  isRecord,
  isTimestamp,
  LOCAL_SHOW_LIMIT,
  LOCAL_SHOW_MAX_AGE,
  LocalShowError,
  parsePreparedLocalShow,
  type LocalShowAction,
  type PreparedLocalShow,
} from "./local-show-model.js";
import type { LocalShowRequest } from "./local-show-control.js";

type DeviceResult = "pending" | "acknowledged" | "failed" | "unknown";
type Entry = { requestId: string; at: number } & (
  | { kind: "transport"; command: RundownTransportCommand }
  | { kind: "device"; actionId: string; result: DeviceResult }
);
type Session = { startedAt: number; entries: Entry[] } & (
  | { phase: "active" }
  | { phase: "finished" | "reconciled"; endedAt: number }
);
interface SavedShow {
  version: 1;
  prepared: PreparedLocalShow;
  clockOffset: number;
  session: Session | null;
}
interface Dependencies {
  store: { load(): unknown; save(value: unknown): void };
  scope: { orgId: string; installationId: string };
  now?: () => number;
  /** Must stop cloud command intake before opening the prepared local devices. */
  activate(prepared: PreparedLocalShow): Promise<void>;
  /** Must close local device connections before restoring cloud command intake. */
  deactivate(): Promise<void>;
  /** A fulfilled promise means the adapter acknowledged execution. Rejection is
   * conservatively unknown: it may have failed after sending to the equipment. */
  execute(action: LocalShowAction): Promise<"acknowledged" | "failed">;
}

function transportPayload(command: RundownTransportCommand) {
  const { type, ...payload } = command;
  return { action: type, payload };
}
function parseSavedShow(value: unknown): SavedShow | null {
  if (value === null) return null;
  const invalid = (): never => {
    throw new LocalShowError(
      "The local show journal is invalid. Keep it for recovery and prepare another copy after reconnecting.",
    );
  };
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.clockOffset !== "number" ||
    !Number.isSafeInteger(value.clockOffset) ||
    Math.abs(value.clockOffset) > LOCAL_SHOW_MAX_AGE
  )
    return invalid();
  const prepared = parsePreparedLocalShow(value.prepared);
  if (value.session === null)
    return {
      version: 1,
      prepared,
      clockOffset: value.clockOffset,
      session: null,
    };
  const raw = value.session;
  if (
    !isRecord(raw) ||
    !isTimestamp(raw.startedAt) ||
    raw.startedAt < prepared.preparedAt ||
    raw.startedAt > prepared.expiresAt ||
    !Array.isArray(raw.entries) ||
    raw.entries.length > LOCAL_SHOW_LIMIT
  )
    return invalid();
  let previous = raw.startedAt;
  const startedAt = raw.startedAt;
  const ids = new Set<string>();
  const entries = raw.entries.map((entry: unknown): Entry => {
    if (
      !isRecord(entry) ||
      !isLocalId(entry.requestId) ||
      ids.has(entry.requestId) ||
      !isTimestamp(entry.at) ||
      entry.at < previous ||
      entry.at - startedAt > LOCAL_SHOW_MAX_AGE
    )
      return invalid();
    ids.add(entry.requestId);
    previous = entry.at;
    if (entry.kind === "transport" && isRecord(entry.command)) {
      const command = parseRundownTransport(entry.command.type, entry.command);
      if (command)
        return {
          kind: "transport",
          requestId: entry.requestId,
          at: entry.at,
          command,
        };
    }
    if (
      entry.kind === "device" &&
      isLocalId(entry.actionId) &&
      prepared.actions.some((action) => action.id === entry.actionId) &&
      (entry.result === "pending" ||
        entry.result === "acknowledged" ||
        entry.result === "failed" ||
        entry.result === "unknown")
    ) {
      return {
        kind: "device",
        requestId: entry.requestId,
        at: entry.at,
        actionId: entry.actionId,
        result: entry.result,
      };
    }
    return invalid();
  });
  let session: Session;
  if (raw.phase === "active")
    session = { phase: "active", startedAt: raw.startedAt, entries };
  else if (
    (raw.phase === "finished" || raw.phase === "reconciled") &&
    isTimestamp(raw.endedAt) &&
    raw.endedAt >= previous &&
    raw.endedAt - raw.startedAt <= LOCAL_SHOW_MAX_AGE
  )
    session = {
      phase: raw.phase,
      startedAt: raw.startedAt,
      entries,
      endedAt: raw.endedAt,
    };
  else return invalid();
  const saved: SavedShow = {
    version: 1,
    prepared,
    clockOffset: value.clockOffset,
    session,
  };
  // Replay validates item references and timer transitions, not just JSON shape.
  localState(saved);
  return saved;
}
function localState(saved: SavedShow) {
  let state = { items: saved.prepared.items, timer: saved.prepared.timer };
  for (const entry of saved.session?.entries ?? [])
    if (entry.kind === "transport") {
      const next = applyRundownTransport(state, entry.command, entry.at);
      if (!next)
        throw new LocalShowError(
          "The saved local timer contains an invalid transition.",
        );
      state = next;
    }
  if (saved.session && saved.session.phase !== "active") {
    const held = applyRundownTransport(
      state,
      { type: "timer-pause" },
      saved.session.endedAt,
    );
    if (held) state = held;
  }
  return state;
}

/** The encrypted journal is the authority. Device receipts are saved before
 * dispatch and never replayed; only timer transitions enter cloud reconciliation.
 * All state writes are synchronous. Slow equipment promises never hold a timer lock.
 */
export class LocalShowManager {
  private saved: SavedShow | null;
  private snapshot: ReturnType<typeof localState> | null;
  private ready = false;
  private transition = false;
  private storageError: string | null = null;
  private readonly inFlight = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly dependencies: Dependencies) {
    this.now = dependencies.now ?? Date.now;
    this.saved = parseSavedShow(dependencies.store.load());
    this.snapshot = this.saved ? localState(this.saved) : null;
    if (
      this.saved &&
      (this.saved.prepared.orgId !== dependencies.scope.orgId ||
        this.saved.prepared.installationId !==
          dependencies.scope.installationId)
    )
      throw new LocalShowError(
        "This local show belongs to another workspace or Bridge installation.",
      );
    if (
      this.saved?.session?.entries.some(
        (entry) => entry.kind === "device" && entry.result === "pending",
      )
    ) {
      const recovered = structuredClone(this.saved);
      for (const entry of recovered.session?.entries ?? [])
        if (entry.kind === "device" && entry.result === "pending")
          entry.result = "unknown";
      try {
        this.persist(recovered);
      } catch {
        /* Retain the cache and expose storageError. Never execute during recovery. */
      }
    }
  }

  private persist(
    next: SavedShow | null,
    updatedSnapshot?: ReturnType<typeof localState>,
  ) {
    next = structuredClone(next);
    // Rebuild once at startup. Polls and device receipts never replay thousands
    // of timer transitions; each accepted transport updates this derived cache.
    const snapshot = !next
      ? null
      : !next.session
        ? { items: next.prepared.items, timer: next.prepared.timer }
        : (updatedSnapshot ?? this.snapshot ?? localState(next));
    try {
      this.dependencies.store.save(next);
      this.saved = next;
      this.snapshot = snapshot;
    } catch (error) {
      // A rename can succeed before its final directory fsync fails. Adopt that
      // committed receipt, block all further writes, and never dispatch it.
      if (error instanceof LocalShowStoreError && error.committed) {
        this.saved = next;
        this.snapshot = snapshot;
      }
      this.storageError =
        "Local storage could not confirm the save. Restart the local engine after checking the disk and keychain. Device actions will not be retried automatically.";
      this.ready = false;
      throw new LocalShowError(this.storageError);
    }
  }
  private writable() {
    if (this.storageError) throw new LocalShowError(this.storageError);
    if (this.transition)
      throw new LocalShowError(
        "The local engine is switching modes. Wait for it to finish.",
      );
  }
  private forSession(id: string) {
    if (!this.saved || this.saved.prepared.sessionId !== id)
      throw new LocalShowError(
        "The prepared show changed. Refresh before continuing.",
      );
    return this.saved;
  }
  private time(saved: SavedShow, finishing = false) {
    const previous =
      saved.session?.entries.at(-1)?.at ??
      saved.session?.startedAt ??
      saved.prepared.preparedAt;
    const now =
      finishing && saved.session
        ? Math.min(
            this.now() + saved.clockOffset,
            saved.session.startedAt + LOCAL_SHOW_MAX_AGE,
          )
        : this.now() + saved.clockOffset;
    const at = Math.max(previous, now);
    if (
      !isTimestamp(at) ||
      (saved.session && at - saved.session.startedAt > LOCAL_SHOW_MAX_AGE)
    )
      throw new LocalShowError(
        "The local session exceeded its 24-hour limit. Keep its journal and reconnect for review.",
      );
    return at;
  }
  private sequence(saved: SavedShow, expected: number) {
    if (expected !== (saved.session?.entries.length ?? 0))
      throw new LocalShowError(
        "Local show changed. Refresh its state before sending another action.",
      );
  }

  /** Call only from the active, authenticated Bridge preparation receiver. */
  prepare(value: unknown, currentApprovedTargets: readonly BridgeEndpoint[]) {
    this.writable();
    if (this.saved?.session && this.saved.session.phase !== "reconciled")
      throw new LocalShowError(
        "Reconcile or explicitly discard the previous local show before replacing it.",
      );
    const prepared = parsePreparedLocalShow(value);
    if (
      prepared.orgId !== this.dependencies.scope.orgId ||
      prepared.installationId !== this.dependencies.scope.installationId
    )
      throw new LocalShowError(
        "Local preparation does not match this workspace and Bridge installation.",
      );
    const endpointKey = (endpoint: BridgeEndpoint) =>
      JSON.stringify([endpoint.protocol, endpoint.host, endpoint.port]);
    const approved = new Set(currentApprovedTargets.map(endpointKey));
    if (
      !prepared.approvedTargets.every((endpoint) =>
        approved.has(endpointKey(endpoint)),
      )
    )
      throw new LocalShowError(
        "Local preparation contains an unapproved device destination.",
      );
    // preparedAt is sampled by the authenticated server immediately before delivery.
    const clockOffset = prepared.preparedAt - this.now();
    if (
      !Number.isSafeInteger(clockOffset) ||
      Math.abs(clockOffset) > LOCAL_SHOW_MAX_AGE
    )
      throw new LocalShowError(
        "Check the computer clock before preparing this show.",
      );
    this.persist({ version: 1, prepared, clockOffset, session: null });
    return this.status();
  }

  status() {
    if (!this.saved)
      return { mode: "empty" as const, storageError: this.storageError };
    const { prepared, session } = this.saved;
    const journal =
      session && session.phase !== "active"
        ? {
            version: 1,
            sessionId: prepared.sessionId,
            orgId: prepared.orgId,
            showId: prepared.showId,
            serviceDate: prepared.serviceDate,
            baseRevision: prepared.baseRevision,
            startedAt: session.startedAt,
            endedAt: session.endedAt,
            operations: session.entries.flatMap((entry) =>
              entry.kind === "transport"
                ? [{ at: entry.at, ...transportPayload(entry.command) }]
                : [],
            ),
          }
        : null;
    // Explicit projection: no host, command, private settings, or approval policy.
    return structuredClone({
      mode: session?.phase ?? "prepared",
      ready: this.ready,
      storageError: this.storageError,
      sessionId: prepared.sessionId,
      orgId: prepared.orgId,
      showId: prepared.showId,
      serviceDate: prepared.serviceDate,
      title: prepared.title,
      baseRevision: prepared.baseRevision,
      sequence: session?.entries.length ?? 0,
      preparedAt: prepared.preparedAt,
      expiresAt: prepared.expiresAt,
      serverTime: this.now() + this.saved.clockOffset,
      ...(this.snapshot ?? localState(this.saved)),
      actions: prepared.actions.map((action) => ({
        id: action.id,
        label: action.label,
        deviceId: action.deviceId,
      })),
      results:
        session?.entries.filter((entry) => entry.kind === "device") ?? [],
      journal,
    });
  }

  async handle(
    request: LocalShowRequest,
  ): Promise<ReturnType<LocalShowManager["status"]>> {
    if (request.operation === "status") return this.status();
    this.writable();
    const saved = this.forSession(request.sessionId);
    if (request.operation === "begin") {
      if (saved.session && saved.session.phase !== "active")
        throw new LocalShowError(
          "This local session has ended. Review its journal before preparing another show.",
        );
      if (this.ready) return this.status();
      const at = this.time(saved);
      if (at > saved.prepared.expiresAt)
        throw new LocalShowError(
          "This prepared show expired. Reconnect to refresh its device approvals.",
        );
      this.transition = true;
      try {
        await this.dependencies.activate(structuredClone(saved.prepared));
        if (!saved.session)
          this.persist({
            ...saved,
            session: { phase: "active", startedAt: at, entries: [] },
          });
        this.ready = true;
      } finally {
        this.transition = false;
      }
      return this.status();
    }
    if (request.operation === "discard") {
      if (this.ready || saved.session?.phase === "active" || this.inFlight.size)
        throw new LocalShowError(
          "Finish local control before discarding its journal.",
        );
      this.persist(null);
      return this.status();
    }
    if (request.operation === "reconciled") {
      this.sequence(saved, request.expectedSequence);
      if (!saved.session || saved.session.phase === "active")
        throw new LocalShowError(
          "Finish local control before accepting cloud reconciliation.",
        );
      this.persist({
        ...saved,
        session: { ...saved.session, phase: "reconciled" },
      });
      return this.status();
    }
    if (request.operation === "finish") {
      this.sequence(saved, request.expectedSequence);
      if (!saved.session)
        throw new LocalShowError("Local control has not started.");
      if (this.inFlight.size)
        throw new LocalShowError(
          "A device action has not finished. Check its result before returning control to the cloud.",
        );
      if (saved.session.phase === "active") {
        const endedAt = this.time(saved, true);
        const held = applyRundownTransport(
          this.snapshot ?? localState(saved),
          { type: "timer-pause" },
          endedAt,
        );
        this.persist(
          {
            ...saved,
            session: {
              ...saved.session,
              phase: "finished",
              endedAt,
            },
          },
          held ?? undefined,
        );
      }
      this.ready = false;
      this.transition = true;
      try {
        await this.dependencies.deactivate();
      } finally {
        this.transition = false;
      }
      return this.status();
    }
    const existing = saved.session?.entries.find(
      (entry) => entry.requestId === request.requestId,
    );
    if (existing) {
      const matches =
        request.operation === "transport"
          ? existing.kind === "transport" &&
            JSON.stringify(existing.command) === JSON.stringify(request.command)
          : existing.kind === "device" &&
            existing.actionId === request.actionId;
      if (!matches)
        throw new LocalShowError(
          "This request ID already belongs to a different local action.",
        );
      return this.status();
    }
    this.sequence(saved, request.expectedSequence);
    if (!this.ready || !saved.session || saved.session.phase !== "active")
      throw new LocalShowError(
        "Enable local control before sending an action.",
      );
    if (saved.session.entries.length >= LOCAL_SHOW_LIMIT)
      throw new LocalShowError(
        "The local journal is full. Reconcile before starting another local session.",
      );
    const at = this.time(saved);
    if (request.operation === "transport") {
      const updated = applyRundownTransport(
        this.snapshot ?? localState(saved),
        request.command,
        at,
      );
      if (!updated)
        throw new LocalShowError(
          "This timer action is not valid for the current item.",
        );
      this.persist(
        {
          ...saved,
          session: {
            ...saved.session,
            entries: [
              ...saved.session.entries,
              {
                kind: "transport",
                requestId: request.requestId,
                at,
                command: request.command,
              },
            ],
          },
        },
        updated,
      );
      return this.status();
    }
    if (at > saved.prepared.expiresAt)
      throw new LocalShowError(
        "Device approvals expired. Reconnect to refresh the prepared show.",
      );
    const action = saved.prepared.actions.find(
      (action) => action.id === request.actionId,
    );
    if (!action)
      throw new LocalShowError(
        "This device action is not part of the prepared show.",
      );
    if (this.inFlight.size >= 8)
      throw new LocalShowError(
        "Eight local device actions are still pending. Check their results before continuing.",
      );
    // Serialize commands for the same output, but leave independent devices and
    // all timer transitions available while equipment is waiting for a reply.
    if (
      saved.session.entries.some(
        (entry) =>
          entry.kind === "device" &&
          this.inFlight.has(entry.requestId) &&
          saved.prepared.actions.find(
            (candidate) => candidate.id === entry.actionId,
          )?.target === action.target,
      )
    )
      throw new LocalShowError(
        "This device still has a pending action. Check its result before continuing.",
      );
    this.persist({
      ...saved,
      session: {
        ...saved.session,
        entries: [
          ...saved.session.entries,
          {
            kind: "device",
            requestId: request.requestId,
            at,
            actionId: action.id,
            result: "pending",
          },
        ],
      },
    });
    this.inFlight.add(request.requestId);
    let result: Exclude<DeviceResult, "pending"> = "unknown";
    try {
      result = await this.dependencies.execute(structuredClone(action));
    } catch {
      /* A rejected adapter may already have sent the command. Never retry it. */
    } finally {
      this.inFlight.delete(request.requestId);
    }
    const latest = this.forSession(request.sessionId);
    if (!latest.session)
      throw new LocalShowError(
        "Local session disappeared during device execution.",
      );
    if (this.storageError) throw new LocalShowError(this.storageError);
    this.persist({
      ...latest,
      session: {
        ...latest.session,
        entries: latest.session.entries.map((entry) =>
          entry.requestId === request.requestId && entry.kind === "device"
            ? { ...entry, result }
            : entry,
        ),
      },
    });
    return this.status();
  }
}
