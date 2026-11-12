import { showDetailsRelayRequestSchema } from "@/lib/show-details-contract";
import { writeShowDetails, readCommittedShowDetails, ShowDetailsRequestError, type PendingShowDetails } from "@/lib/show-details-write.server";
import { RundownMetadataConflictError } from "@/lib/rundown-metadata-conflict";
import { reportRelayError } from "@/lib/operational-errors.server";
import { parseLocalRundownJournal, reconcileLocalRundown } from "@showpilot/shared/local-rundown";
import { applyRundownTransport, parseRundownTransport } from "@showpilot/shared/rundown-transport";
import { readStoredRundownItems, rundownItemDiffStatements, rundownItemStorageStatements, samePersistedRundownItem, type RundownDatabase, type RundownStatement } from "@/lib/rundown-item-storage.server";
import { renewSocketReadLease, socketReadLeaseAllows, refreshSocketReadLeases, scheduleSocketReadRefresh } from "@/lib/socket-read-authority.server";
import type { RelayPPSlide } from "@/lib/rundown-relay-payload";
import { DurableObject } from "cloudflare:workers";
import { displaySocketMayReceive } from "@/lib/display-access.server";
import {
  canApplyRundownRelayAction,
  classifyRelayCommand,
  parseRundownRelayHttpCommand,
  type RundownRelayWriteAccess,
} from "@/lib/rundown-command-protocol";
import {
  inferRundownRelayInitialized,
  shouldAcceptRundownSeed,
} from "@/lib/rundown-relay-initialization";
import {
  parseExactRelayOrder,
  parseRelayItemUpdates,
  parseRelayPPSlide,
  parseRelayRundownItem,
  parseRelayRundownItems,
  parseRelayTimer,
} from "@/lib/rundown-relay-payload";
import { SerialCommandExecutor } from "@/lib/serial-command-executor";
import { persistedRundownStatus } from "@/lib/rundown-status";
import { projectRundownDisplayState } from "@/lib/rundown-display";
import {
  hasLiveRundownAuthority,
  type LiveRundownAuthorityClaim,
} from "@/lib/live-rundown-authority.server";
import { getPresentedRundownPin } from "@/lib/rundown-pin.server";
import { restoreRundownItem } from "@/lib/rundown-undo";

interface Env {
  DB: RundownDatabase;
  BETTER_AUTH_SECRET?: string;
}

export type ItemType =
  | "segment"
  | "song"
  | "header"
  | "prayer"
  | "announcement"
  | "offering"
  | "custom";

export type ItemStatus = "upcoming" | "live" | "complete";

export interface RundownItem {
  id: string;
  title: string;
  type: ItemType;
  duration: number; // ms
  notes: string;
  assignee: string;
  cue: string;
  status: ItemStatus;
  sortOrder: number;
  hardStop: boolean;
  lowerThirdId?: string;
  scheduledStart?: string | null;
  expectedEnd?: string | null;
  actualStart?: string | null; // ISO timestamp
  actualEnd?: string | null;   // ISO timestamp
}

export interface TimerState {
  playback: "stop" | "play" | "pause";
  currentItemId: string | null;
  elapsed: number; // ms
  startedAt: number | null; // timestamp
  pausedAt: number | null;
  mode: "count-up" | "count-down" | "clock";
}

interface PPSlideState extends RelayPPSlide {
  updatedAt: number;
}

interface RundownState {
  initialized: boolean;
  items: RundownItem[];
  timer: TimerState;
  ppSlide: PPSlideState | null;
  ppPreviewSlide: PPSlideState | null;
  ppOutputEnabled: boolean;
  stageMessage: string;
  serviceDate?: string;
  showId?: string;
  serviceName?: string;
  scheduledStartTime?: string | null;
  scheduledCallTime?: string | null;
  location?: string;
  revision: number;
  recentCommandIds: string[];
  removedItems: Array<{ item: RundownItem; index: number; nextId: string | null; expiresAt: number }>;
}

type StoredRundownState = Omit<RundownState, "items"> & { items?: RundownItem[]; itemIds?: string[] };

const DEFAULT_TIMER: TimerState = {
  playback: "stop",
  currentItemId: null,
  elapsed: 0,
  startedAt: null,
  pausedAt: null,
  mode: "count-down",
};

export class RundownRelay extends DurableObject {
  private state: RundownState = {
    initialized: false,
    items: [],
    timer: { ...DEFAULT_TIMER },
    ppSlide: null,
    ppPreviewSlide: null,
    ppOutputEnabled: false,
    stageMessage: "",
    revision: 0,
    recentCommandIds: [],
    removedItems: [],
  };
  private retired = false;
  private deletionFence: { orgId: string; showId: string; nonce: string } | null = null;
  private hydrated = false;
  private hydrationPromise: Promise<void> | null = null;
  private orgId = "";
  private readonly commands = new SerialCommandExecutor();
  private persistedItems = new Map<string, RundownItem>();
  private itemRowsInitialized = false;

  /** Load state from durable storage on first access */
  private async hydrateFromStorage(): Promise<void> {
    if (this.hydrated) {
      await this.recoverPendingShowDetails();
      return;
    }
    if (!this.hydrationPromise) {
      this.hydrationPromise = (async () => {
        const [stored, retired, fence] = await Promise.all([
          this.ctx.storage.get<StoredRundownState>("state"),
          this.ctx.storage.get<boolean>("retired"),
          this.ctx.storage.get<{ orgId: string; showId: string; nonce: string }>("show-deletion-fence"),
        ]);
        this.retired = retired ?? false;
        this.deletionFence = fence ?? null;
        const ppOutputEnabled = typeof stored?.ppOutputEnabled === "boolean"
          ? stored.ppOutputEnabled
          : await this.readProPresenterStageDisplaySetting();
        if (stored) {
          let items = stored.items ?? [];
          if (stored.itemIds) {
            const rows = new Map<string, RundownItem>();
            // The asynchronous storage API accepts at most 128 keys per get.
            for (let offset = 0; offset < stored.itemIds.length; offset += 128) {
              const chunk = await this.ctx.storage.get<RundownItem>(stored.itemIds.slice(offset, offset + 128).map(id => `rundown-item:${id}`));
              for (const [key, value] of chunk) rows.set(key, value);
            }
            items = stored.itemIds.map(id => {
              const item = rows.get(`rundown-item:${id}`);
              if (!item) throw new Error("Rundown item storage is incomplete.");
              return item;
            });
            this.itemRowsInitialized = true;
          }
          this.state = {
            initialized: inferRundownRelayInitialized({ ...stored, items }),
            items: items.map((item, sortOrder) => ({ ...item, sortOrder })),
            timer: stored.timer ?? { ...DEFAULT_TIMER },
            ppSlide: stored.ppSlide ?? null,
            ppPreviewSlide: stored.ppPreviewSlide ?? null,
            ppOutputEnabled,
            stageMessage: stored.stageMessage ?? "",
            serviceDate: stored.serviceDate,
            showId: stored.showId,
            serviceName: stored.serviceName,
            scheduledStartTime: stored.scheduledStartTime,
            scheduledCallTime: stored.scheduledCallTime,
            location: stored.location,
            revision: Number.isFinite(stored.revision) ? stored.revision : 0,
            recentCommandIds: Array.isArray(stored.recentCommandIds)
              ? stored.recentCommandIds.slice(-100)
              : [],
            removedItems: (stored.removedItems ?? []).filter((removed) => removed.expiresAt > Date.now()),
          };
          this.persistedItems = new Map(items.map(item => [item.id, { ...item }]));
        } else {
          this.state.ppOutputEnabled = ppOutputEnabled;
        }
        this.hydrated = true;
      })().finally(() => {
        this.hydrationPromise = null;
      });
    }
    await this.hydrationPromise;
    await this.recoverPendingShowDetails();
  }

  private async recoverPendingShowDetails(): Promise<void> {
    if (this.retired) return;
    const pending = await this.ctx.storage.get<PendingShowDetails>("pending-show-details");
    if (!pending) return;
    if (pending.orgId !== this.orgId || (this.state.showId && this.state.showId !== pending.showId))
      throw new Error("Show detail recovery belongs to a different room.");
    const snapshot = await readCommittedShowDetails(this.env.DB, pending);
    if (snapshot) {
      const changed = this.state.showId !== snapshot.id || this.state.serviceDate !== snapshot.serviceDate
        || this.state.serviceName !== snapshot.name || this.state.location !== snapshot.location
        || this.state.scheduledStartTime !== snapshot.scheduledStartTime || this.state.scheduledCallTime !== snapshot.scheduledCallTime;
      this.state = { ...this.state, showId: snapshot.id, serviceDate: snapshot.serviceDate,
        serviceName: snapshot.name, location: snapshot.location, scheduledStartTime: snapshot.scheduledStartTime,
        scheduledCallTime: snapshot.scheduledCallTime,
        revision: Math.max(pending.revision, this.state.revision + (changed ? 1 : 0)) };
      await this.persistState();
    }
    await this.ctx.storage.delete("pending-show-details");
    if (snapshot) this.broadcastState();
  }

  private async showDeletionBlocksWrites(): Promise<boolean> {
    if (this.retired) return true;
    if (!this.deletionFence) return false;
    const fence = this.deletionFence;
    const operation = await this.env.DB.prepare("SELECT stage FROM show_deletion WHERE orgId=? AND showId=? AND nonce=?")
      .bind(fence.orgId, fence.showId, fence.nonce).first<{ stage: string }>();
    if (operation) return true;
    // A rejected preparation is reversible. Recover locally even if the
    // coordinator lost its reply before it could notify this room.
    await this.ctx.storage.delete("show-deletion-fence");
    this.deletionFence = null;
    return false;
  }

  /** Persist the authoritative state before any client sees the revision. */
  private async persistState(): Promise<void> {
    const { items, ...metadata } = this.state;
    const current = new Map(items.map(item => [item.id, { ...item }]));
    await this.ctx.storage.transaction(async storage => {
      for (const id of this.persistedItems.keys()) {
        if (!current.has(id)) await storage.delete(`rundown-item:${id}`);
      }
      for (const [id, item] of current) {
        const previous = this.persistedItems.get(id);
        if (!this.itemRowsInitialized || !previous || !samePersistedRundownItem(previous, item)) {
          await storage.put(`rundown-item:${id}`, item);
        }
      }
      await storage.put("state", { ...metadata, itemIds: items.map(item => item.id) });
    });
    this.persistedItems = current;
    this.itemRowsInitialized = true;
  }

  private cloneState(): RundownState {
    return {
      ...this.state,
      items: this.state.items.map((item) => ({ ...item })),
      timer: { ...this.state.timer },
      ppSlide: this.state.ppSlide ? { ...this.state.ppSlide } : null,
      ppPreviewSlide: this.state.ppPreviewSlide ? { ...this.state.ppPreviewSlide } : null,
      recentCommandIds: [...this.state.recentCommandIds],
    };
  }

  /** Persist in the same serialized order in which relay commands are accepted. */
  private async persistAuthoritativeSnapshot(
    action: string,
    previousState: RundownState,
    metadataGuard?: { expectedUpdatedAt: string; fields: Record<string, unknown> },
  ): Promise<void> {
    if (!this.orgId || (!this.state.showId && !this.state.serviceDate)) return;
    const persistsFullItems = action === "activate" || action === "seed"
      || action === "add-item"
      || action === "update-item"
      || action === "remove-item"
      || action === "restore-item"
      || action === "reorder"
      || action === "reset"
      || action === "clear-all";
    const persistsTimer = persistsFullItems || action.startsWith("timer-") || action === "reconcile-local";
    const persistsMessage = action === "stage-message" || action === "stage-clear";
    const persistsMeta = action === "update-meta"
      || action === "seed" && this.state.serviceName !== undefined;
    const persistsPpOutput = action === "pp-output-enabled";
    const persistsPpSlide = action === "pp-preview"
      || action === "pp-slide"
      || persistsPpOutput;
    if (!persistsTimer && !persistsMessage && !persistsMeta && !persistsPpOutput && !persistsPpSlide) return;

    const env = this.env as unknown as Env;
    const identity = this.state.showId ?? this.state.serviceDate;
    const statements: RundownStatement[] = [];

    if (persistsTimer) {
      statements.push(env.DB.prepare(
        `INSERT INTO app_setting (id, orgId, key, value)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(orgId, key) DO UPDATE SET value = excluded.value`,
      ).bind(
        crypto.randomUUID(),
        this.orgId,
        `rundown-timer:${identity}`,
        JSON.stringify({ ...this.state.timer, serverTime: Date.now() }),
      ));
      if (this.state.showId) {
        statements.push(env.DB.prepare(
          "UPDATE rundown SET status = ?, updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', MAX(julianday('now'), julianday(updatedAt) + 1.0 / 86400000)) WHERE id = ? AND orgId = ?",
        ).bind(
          persistedRundownStatus(this.state.timer.playback),
          this.state.showId,
          this.orgId,
        ));
      }
    }

    if (persistsTimer) {
      const scope = { orgId: this.orgId, showId: this.state.showId, serviceDate: this.state.serviceDate ?? "" };
      const baseline = action === "seed" || action === "activate" ? await readStoredRundownItems(env.DB, scope) : previousState.items;
      statements.push(...rundownItemDiffStatements(env.DB, scope, baseline, this.state.items));
      if (persistsFullItems) statements.push(...rundownItemStorageStatements(env.DB, scope));
    }

    if (persistsMeta && this.state.showId) {
      const assignments: string[] = [];
      const values: unknown[] = [];
      if ((this.state.serviceName !== previousState.serviceName || metadataGuard?.fields.serviceName !== undefined) && this.state.serviceName !== undefined) {
        assignments.push("name = ?");
        values.push(this.state.serviceName);
      }
      if ((this.state.scheduledStartTime !== previousState.scheduledStartTime || metadataGuard?.fields.scheduledStartTime !== undefined) && this.state.scheduledStartTime !== undefined) {
        assignments.push("scheduledStartTime = ?");
        values.push(this.state.scheduledStartTime);
      }
      if ((this.state.scheduledCallTime !== previousState.scheduledCallTime || metadataGuard?.fields.scheduledCallTime !== undefined) && this.state.scheduledCallTime !== undefined) {
        assignments.push("scheduledCallTime = ?");
        values.push(this.state.scheduledCallTime);
      }
      if ((this.state.location !== previousState.location || metadataGuard?.fields.location !== undefined) && this.state.location !== undefined) {
        assignments.push("location = ?");
        values.push(this.state.location);
      }
      if (assignments.length > 0) {
        const guard = metadataGuard
          ? " AND serviceDate = ? AND updatedAt = ? AND NOT EXISTS (SELECT 1 FROM app_setting WHERE orgId = rundown.orgId AND key = 'show-deleting:' || rundown.id)"
          : "";
        statements.push(env.DB.prepare(
          `UPDATE rundown SET ${assignments.join(", ")}, updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', MAX(julianday('now'), julianday(updatedAt) + 1.0 / 86400000)) WHERE id = ? AND orgId = ?${guard}`,
        ).bind(...values, this.state.showId, this.orgId,
          ...(metadataGuard ? [this.state.serviceDate, metadataGuard.expectedUpdatedAt] : [])));
      }
    }

    if (persistsMessage) {
      if (this.state.stageMessage) {
        statements.push(env.DB.prepare(
          `INSERT INTO app_setting (id, orgId, key, value)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(orgId, key) DO UPDATE SET value = excluded.value`,
        ).bind(
          crypto.randomUUID(),
          this.orgId,
          `rundown-message:${identity}`,
          this.state.stageMessage,
        ));
      } else {
        statements.push(env.DB.prepare(
          "DELETE FROM app_setting WHERE orgId = ? AND key = ?",
        ).bind(this.orgId, `rundown-message:${identity}`));
      }
    }

    if (persistsPpOutput) {
      statements.push(env.DB.prepare(
        `INSERT INTO app_setting (id, orgId, key, value)
         VALUES (?, ?, 'propresenter-stage-display', ?)
         ON CONFLICT(orgId, key) DO UPDATE SET value = excluded.value`,
      ).bind(
        crypto.randomUUID(),
        this.orgId,
        this.state.ppOutputEnabled ? "true" : "false",
      ));
    }

    if (persistsPpSlide) {
      statements.push(env.DB.prepare(
        `INSERT INTO app_setting (id, orgId, key, value)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(orgId, key) DO UPDATE SET value = excluded.value`,
      ).bind(
        crypto.randomUUID(),
        this.orgId,
        `rundown-ppslide:${identity}`,
        this.state.ppSlide ? JSON.stringify(this.state.ppSlide) : "null",
      ));
    }

    if (action === "activate") {
      // Both pointer values and the prepared room's rows/timer commit together.
      // The scalar subquery fails the entire batch via NOT NULL if the show was
      // removed or rescheduled while activation waited for storage.
      statements.push(env.DB.prepare(
        `INSERT INTO app_setting (id, orgId, key, value)
         VALUES (?, ?, 'active-show-id', (SELECT id FROM rundown WHERE id = ? AND orgId = ? AND serviceDate = ? AND NOT EXISTS (SELECT 1 FROM app_setting WHERE orgId = rundown.orgId AND key = 'show-deleting:' || rundown.id)))
         ON CONFLICT(orgId, key) DO UPDATE SET value = excluded.value`,
      ).bind(crypto.randomUUID(), this.orgId, this.state.showId, this.orgId, this.state.serviceDate));
      statements.push(env.DB.prepare(
        `INSERT INTO app_setting (id, orgId, key, value)
         VALUES (?, ?, 'active-service-date', ?)
         ON CONFLICT(orgId, key) DO UPDATE SET value = excluded.value`,
      ).bind(crypto.randomUUID(), this.orgId, this.state.serviceDate));
    }

    // A metadata command can be valid yet make no durable change (for
    // example, saving an unchanged show title). Avoid depending on whether a
    // runtime accepts an empty D1 batch.
    if (statements.length === 0) return;
    const results = await env.DB.batch(statements);
    // Guarded update-meta contains only the metadata UPDATE. A rejected compare
    // and swap writes nothing; the caller restores the unbroadcast room state.
    if (metadataGuard && results[0]?.meta.changes !== 1) throw new RundownMetadataConflictError();
  }

  private async readProPresenterStageDisplaySetting(): Promise<boolean> {
    if (!this.orgId) return false;

    try {
      const row = await this.env.DB.prepare(
        "SELECT value FROM app_setting WHERE orgId = ? AND key = ? LIMIT 1"
      )
        .bind(this.orgId, "propresenter-stage-display")
        .first<{ value: string | null }>();

      return row?.value === "true";
    } catch {
      return false;
    }
  }

  private async reconcileProPresenterOutputSetting(): Promise<void> {
    const enabled = await this.readProPresenterStageDisplaySetting();
    if (enabled === this.state.ppOutputEnabled) return;
    this.state.ppOutputEnabled = enabled;
    this.state.ppSlide = enabled && this.state.ppPreviewSlide
      ? { ...this.state.ppPreviewSlide, updatedAt: Date.now() }
      : null;
    await this.persistState();
  }

  private resolvedTarget() {
    return { showId: this.state.showId ?? null, serviceDate: this.state.serviceDate ?? null };
  }

  private targetJson(data: object, init?: ResponseInit): Response {
    return Response.json({ ...data, ...this.resolvedTarget() }, init);
  }

  fetch(request: Request): Promise<Response> {
    // Reads and reconnects also reconcile/persist state. Keep them, room opens,
    // and purge operations behind the same writer as commands so they cannot
    // observe or save a mutation whose D1 transaction is still pending.
    return this.commands.run(() => this.handleRequest(request));
  }

  private async handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    this.orgId = url.searchParams.get("orgId") ?? this.orgId;
    if (url.pathname === "/internal/purge-org" && request.method === "POST") {
      if (!this.env.BETTER_AUTH_SECRET || request.headers.get("x-showpilot-internal-secret") !== this.env.BETTER_AUTH_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }
      for (const socket of this.ctx.getWebSockets()) socket.close(4404, "Organization deleted");
      await this.ctx.storage.deleteAll();
      this.retired = false;
      this.deletionFence = null;
      this.persistedItems.clear();
      this.itemRowsInitialized = false;
      this.state = {
        initialized: false,
        items: [],
        timer: { ...DEFAULT_TIMER },
        ppSlide: null,
        ppPreviewSlide: null,
        ppOutputEnabled: false,
        stageMessage: "",
        revision: 0,
        recentCommandIds: [],
        removedItems: [],
      };
      this.hydrated = true;
      this.hydrationPromise = null;
      return this.targetJson({ ok: true });
    }
    if (url.pathname === "/internal/show-details" && request.method === "POST") {
      if (!this.env.BETTER_AUTH_SECRET || request.headers.get("x-showpilot-internal-secret") !== this.env.BETTER_AUTH_SECRET)
        return new Response("Unauthorized", { status: 401 });
      const parsed = showDetailsRelayRequestSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success || parsed.data.command.orgId !== this.orgId)
        return this.targetJson({ error: "Invalid show details request." }, { status: 400 });
      const { command, sessionId, mode } = parsed.data;
      await this.hydrateFromStorage();
      if (this.state.showId && this.state.showId !== command.showId)
        return this.targetJson({ error: "Choose the correct show before editing it." }, { status: 400 });
      try {
        const result = await writeShowDetails(this.env.DB, command, sessionId, mode, async () => {
          await this.ctx.storage.put("pending-show-details", { orgId: this.orgId, showId: command.showId,
            actorId: command.userId, requestId: command.requestId, revision: this.state.revision + 1 } satisfies PendingShowDetails);
        });
        await this.recoverPendingShowDetails();
        return Response.json(result);
      } catch (error) {
        reportRelayError(this.ctx, this.env.DB, this.orgId, "rundown_persistence", error);
        return Response.json({ error: error instanceof ShowDetailsRequestError ? error.message : "Could not confirm the show details save. Retry the original save or review it before editing." }, { status: 503 });
      }
    }
    if (url.pathname === "/internal/prepare-show-deletion" && request.method === "POST") {
      if (!this.env.BETTER_AUTH_SECRET || request.headers.get("x-showpilot-internal-secret") !== this.env.BETTER_AUTH_SECRET)
        return new Response("Unauthorized", { status: 401 });
      await this.hydrateFromStorage();
      if (this.retired) return this.targetJson({ ok: true });
      const showId = url.searchParams.get("showId"), serviceDate = url.searchParams.get("serviceDate"), nonce = url.searchParams.get("nonce");
      const belongs = url.searchParams.get("force") === "1" || this.state.showId === showId || (!this.state.showId && this.state.serviceDate === serviceDate);
      if (!belongs) return this.targetJson({ ok: true, skipped: true });
      if (!showId || !nonce || this.state.timer.playback !== "stop") return this.targetJson({ error: "Stop the show before deleting it" }, { status: 409 });
      const operation = await this.env.DB.prepare("SELECT stage FROM show_deletion WHERE orgId=? AND showId=? AND nonce=? AND stage IN ('preparing','purging')")
        .bind(this.orgId, showId, nonce).first();
      if (!operation) return this.targetJson({ error: "Deletion preparation changed" }, { status: 409 });
      const fence = { orgId: this.orgId, showId, nonce };
      await this.ctx.storage.put("show-deletion-fence", fence);
      this.deletionFence = fence;
      return this.targetJson({ ok: true });
    }
    if (url.pathname === "/internal/purge-show" && request.method === "POST") {
      if (!this.env.BETTER_AUTH_SECRET || request.headers.get("x-showpilot-internal-secret") !== this.env.BETTER_AUTH_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }
      await this.hydrateFromStorage();
      if (this.retired) return this.targetJson({ ok: true });
      const targetShowId = url.searchParams.get("showId");
      const targetServiceDate = url.searchParams.get("serviceDate");
      const force = url.searchParams.get("force") === "1";
      const belongsToTarget = force
        || (targetShowId !== null && this.state.showId === targetShowId)
        || (!this.state.showId && targetServiceDate !== null && this.state.serviceDate === targetServiceDate);
      if (!belongsToTarget) return this.targetJson({ ok: true, skipped: true });
      if (this.state.timer.playback !== "stop") return this.targetJson({ error: "Stop the show before deleting it" }, { status: 409 });
      const nonce = url.searchParams.get("nonce");
      if (nonce && !await this.env.DB.prepare("SELECT 1 FROM show_deletion WHERE orgId=? AND showId=? AND nonce=? AND stage IN ('purging','deleted')")
        .bind(this.orgId, targetShowId, nonce).first()) return this.targetJson({ error: "Deletion was not accepted" }, { status: 409 });

      for (const socket of this.ctx.getWebSockets()) socket.close(4404, "Show deleted");
      await this.ctx.storage.transaction(async storage => {
        let startAfter: string | undefined;
        while (true) {
          const keys = [...(await storage.list({ limit: 128, ...(startAfter ? { startAfter } : {}) })).keys()];
          if (!keys.length) break;
          await storage.delete(keys);
          startAfter = keys.at(-1);
        }
        await storage.put("retired", true);
      });
      this.retired = true;
      this.deletionFence = null;
      this.persistedItems.clear();
      this.itemRowsInitialized = false;
      this.state = {
        initialized: false,
        items: [],
        timer: { ...DEFAULT_TIMER },
        ppSlide: null,
        ppPreviewSlide: null,
        ppOutputEnabled: false,
        stageMessage: "",
        revision: 0,
        recentCommandIds: [],
        removedItems: [],
      };
      this.hydrated = true;
      this.hydrationPromise = null;
      return this.targetJson({ ok: true });
    }
    const internal = ["/internal/command", "/internal/state", "/internal/activate"].includes(url.pathname);
    if (internal && (!this.env.BETTER_AUTH_SECRET
      || request.headers.get("x-showpilot-internal-secret") !== this.env.BETTER_AUTH_SECRET
      || request.method !== (url.pathname === "/internal/state" ? "GET" : "POST"))) {
      return new Response("Unauthorized", { status: 401 });
    }
    const path = internal ? url.pathname.slice("/internal".length) : url.pathname;
    await this.hydrateFromStorage();
    if (this.retired) {
      if (path === "/state") return this.targetJson({ ...this.getPublicState(), retired: true });
      return this.targetJson({ error: "This show's rundown has been retired" }, { status: 410 });
    }
    await this.reconcileProPresenterOutputSetting();
    const serviceDate = url.searchParams.get("serviceDate");
    const showId = url.searchParams.get("showId");
    const access = url.searchParams.get("access");
    const authClaim = this.readAuthorityClaim(url, request);
    const writeAccess = access === "edit" || access === "control" ? access : null;
    const authority = { writeAccess, authClaim } satisfies {
      writeAccess: RundownRelayWriteAccess | null;
      authClaim: LiveRundownAuthorityClaim | null;
    };
    const canWrite = writeAccess !== null && (internal || await this.socketCanWrite(authority));
    const canObserve = access === "observe" && (internal || await this.socketCanObserve(authClaim));
    if (canWrite && await this.showDeletionBlocksWrites()) {
      if (path === "/state") return this.targetJson({ ...this.getPublicState(), deleting: true });
      return this.targetJson({ ok: false, reason: "show-deleting", revision: this.state.revision }, { status: 409 });
    }
    if (
      canWrite &&
      ((showId && showId !== this.state.showId) ||
        (!showId && serviceDate && serviceDate !== this.state.serviceDate))
    ) {
      // A room is active for one service at a time. Relabelling the old
      // rows as a newly opened date made the cue sheet show a hybrid of
      // two services. Empty first; the editor then seeds this date's D1 rows.
      this.state.serviceDate = serviceDate ?? undefined;
      this.state.showId = showId ?? undefined;
      this.state.serviceName = undefined;
      this.state.scheduledStartTime = undefined;
      this.state.scheduledCallTime = undefined;
      this.state.location = undefined;
      this.state.initialized = false;
      this.state.items = [];
      this.state.timer = { ...DEFAULT_TIMER };
      this.state.ppSlide = null;
      this.state.ppPreviewSlide = null;
      this.state.revision += 1;
      this.state.recentCommandIds = [];
      this.state.removedItems = [];
      await this.persistState();
    }

    if (internal && path === "/activate") {
      if (!showId || !serviceDate || !canWrite) {
        return this.targetJson({ ok: false, error: "Choose a saved show before taking it live." }, { status: 400 });
      }
      try {
        const body = parseRundownRelayHttpCommand(await request.json());
        if (!body || body.action !== "seed" || body.payload?.force === true) {
          return this.targetJson({ ok: false, error: "Invalid show preparation." }, { status: 400 });
        }
        const available = await this.env.DB.prepare(
          "SELECT id FROM rundown WHERE id = ? AND orgId = ? AND serviceDate = ? AND NOT EXISTS (SELECT 1 FROM app_setting WHERE orgId = rundown.orgId AND key = 'show-deleting:' || rundown.id)",
        ).bind(showId, this.orgId, serviceDate).first();
        if (!available) return this.targetJson({ ok: false, error: "This show is unavailable or its date changed. Refresh before taking it live." }, { status: 409 });
        // A stable show can be rescheduled without replacing its live cue state.
        this.state.serviceDate = serviceDate;
        // Loader data may be older than the live room. Ordinary seed is ignored
        // once initialized, including an intentional empty rundown.
        if (!await this.handleCommand("seed", body.payload)) throw new Error("Show preparation was not saved.");
        // Durable Object storage and D1 have no shared transaction. Prepare the
        // room durably first; publishing the pointer is the final commit. A
        // failed publication leaves this room available for retry, never active.
        await this.persistState();
        await this.persistAuthoritativeSnapshot("activate", this.cloneState());
        return this.targetJson({ ok: true, showId: this.state.showId, serviceDate: this.state.serviceDate, revision: this.state.revision });
      } catch (error) {
        reportRelayError(this.ctx, this.env.DB, this.orgId, "rundown_activation", error);
        return this.targetJson({ ok: false, error: "Could not confirm this show is live. Refresh the active show before retrying.", showId: this.state.showId, serviceDate: this.state.serviceDate }, { status: 503 });
      }
    }

    if (url.pathname === "/ws") {
      if (authClaim && !canWrite && !canObserve) return new Response("Unauthorized", { status: 401 });
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment?.({
        writeAccess: canWrite ? writeAccess : null,
        canObserve,
        orgId: this.orgId,
        serviceDate: serviceDate ?? null,
        showId: showId ?? null,
        authClaim,
        displayExpiresAt: url.searchParams.has("authDisplayExpiresAt") ? Number(url.searchParams.get("authDisplayExpiresAt")) : undefined,
      });

      if (canWrite || canObserve) renewSocketReadLease(server);
      await scheduleSocketReadRefresh(this.ctx, socket => this.socketNeedsReadLease(socket));

      // Hydrate with current state
      server.send(
        JSON.stringify({
          type: "hydrate",
          ...this.resolvedTarget(),          state: canWrite || canObserve
            ? this.getPublicState()
            : this.getDisplayState(),
        })
      );

      return new Response(null, { status: 101, webSocket: client });
    }

    if (path === "/state") {
      return this.targetJson(
        canWrite || canObserve ? this.getPublicState() : this.getDisplayState(),
      );
    }

    if (path === "/command" && request.method === "POST") {
      if (!canWrite || !writeAccess) {
        return new Response("Unauthorized", { status: 401 });
      }
      let rawBody: unknown;
      try {
        rawBody = await request.json();
      } catch {
        return this.targetJson({ ok: false, reason: "invalid-command" }, { status: 400 });
      }
      const body = parseRundownRelayHttpCommand(rawBody);
      if (!body || !canApplyRundownRelayAction(writeAccess, body.action)) {
        return this.targetJson({ ok: false, reason: "invalid-command" }, { status: 400 });
      }
      if (!internal && !(await this.socketCanWrite(authority))) return new Response("Unauthorized", { status: 401 });
      const decision = classifyRelayCommand(
        this.state.revision,
        this.state.recentCommandIds,
        body.id,
        body.expectedRevision,
        body.expiresAt,
      );
      if (decision === "duplicate") {
        return this.targetJson({ ok: true, duplicate: true, revision: this.state.revision });
      }
      if (decision === "revision-conflict" || decision === "expired") {
        return this.targetJson({
          ok: false,
          reason: decision,
          revision: this.state.revision,
          state: this.getPublicState(),
        }, { status: 409 });
      }
      let accepted: boolean;
      try {
        accepted = await this.handleCommand(body.action, body.payload, body.id);
      } catch (error) {
        if (!(error instanceof RundownMetadataConflictError)) throw error;
        return this.targetJson({ ok: false, reason: "metadata-conflict", revision: this.state.revision }, { status: 409 });
      }
      return this.targetJson(
        {
          ok: accepted,
          reason: accepted ? undefined : "invalid-command",
          revision: this.state.revision,
          state: accepted ? this.getPublicState() : undefined,
        },
        { status: accepted ? 200 : 400 },
      );
    }

    return new Response("Not found", { status: 404 });
  }

  webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    return this.commands.run(() => this.handleSocketMessage(ws, data));
  }

  private async handleSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    const attachment = ws.deserializeAttachment?.() as {
      writeAccess?: RundownRelayWriteAccess | null;
      canObserve?: boolean;
      orgId?: string;
      authClaim?: LiveRundownAuthorityClaim | null;
    } | null;
    if (attachment?.orgId) this.orgId = attachment.orgId;
    await this.hydrateFromStorage();
    if (this.retired) { ws.close(4404, "Show deleted"); return; }
    try {
      const raw: unknown = JSON.parse(data as string);
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return;
      if ((raw as Record<string, unknown>).type === "ping") {
        socketReadLeaseAllows(ws, Boolean(attachment?.writeAccess || attachment?.canObserve));
        return;
      }
      if ((raw as Record<string, unknown>).type === "command") {
        // WebSocket messages cross the same untrusted boundary as HTTP
        // commands. Parse both through one envelope contract before touching
        // authoritative state.
        const parsed = parseRundownRelayHttpCommand(raw);
        if (!parsed) {
          ws.send(JSON.stringify({
            type: "command-result",
            ...this.resolvedTarget(),
            accepted: false,
            reason: "invalid-command",
            revision: this.state.revision,
          }));
          return;
        }
        if (!attachment?.writeAccess) { ws.close(4403, "Rundown write access required"); return; }
        if (!canApplyRundownRelayAction(attachment.writeAccess, parsed.action)) {
          ws.send(JSON.stringify({
            type: "command-result",
            ...this.resolvedTarget(),
            id: parsed.id,
            accepted: false,
            reason: "invalid-command",
            revision: this.state.revision,
          }));
          return;
        }

        if (!(await this.socketCanWrite(attachment))) {
          ws.send(JSON.stringify({
            type: "command-result",
            ...this.resolvedTarget(),
            id: parsed.id,
            accepted: false,
            reason: "forbidden",
            revision: this.state.revision,
          }));
          ws.close(4403, "Rundown access changed");
          return;
        }
        if (await this.showDeletionBlocksWrites()) {
          ws.send(JSON.stringify({ type: "command-result", ...this.resolvedTarget(), id: parsed.id,
            accepted: false, reason: "show-deleting", revision: this.state.revision }));
          return;
        }
        renewSocketReadLease(ws);
        const decision = classifyRelayCommand(
          this.state.revision,
          this.state.recentCommandIds,
          parsed.id,
          parsed.expectedRevision,
          parsed.expiresAt,
        );
        if (decision === "duplicate") {
          ws.send(JSON.stringify({
            type: "command-result",
            ...this.resolvedTarget(),
            id: parsed.id,
            accepted: true,
            duplicate: true,
            revision: this.state.revision,
          }));
          return;
        }

        if (decision === "revision-conflict" || decision === "expired") {
          this.sendStateToSocket(ws);
          ws.send(JSON.stringify({
            type: "command-result",
            ...this.resolvedTarget(),
            id: parsed.id,
            accepted: false,
            reason: decision,
            revision: this.state.revision,
          }));
          return;
        }

        let accepted: boolean;
        try {
          accepted = await this.handleCommand(parsed.action, parsed.payload, parsed.id);
        } catch (error) {
          if (!(error instanceof RundownMetadataConflictError)) throw error;
          this.sendStateToSocket(ws);
          ws.send(JSON.stringify({ type: "command-result", ...this.resolvedTarget(), id: parsed.id,
            accepted: false, reason: "metadata-conflict", revision: this.state.revision }));
          return;
        }
        if (!accepted) this.sendStateToSocket(ws);
        ws.send(JSON.stringify({
          type: "command-result",
          ...this.resolvedTarget(),
          id: parsed.id,
          accepted,
          reason: accepted ? undefined : "invalid-command",
          revision: this.state.revision,
        }));
      }
    } catch {
      // Ignore
    }
  }

  webSocketClose(_ws: WebSocket) {
    // No manual session tracking needed — using ctx.getWebSockets()
  }

  webSocketError(_ws: WebSocket) {
    // No manual session tracking needed
  }

  private readAuthorityClaim(url: URL, request: Request): LiveRundownAuthorityClaim | null {
    const userId = url.searchParams.get("authUserId")?.trim();
    const sessionId = url.searchParams.get("authSessionId")?.trim();
    if (!userId || !sessionId || !this.orgId) return null;
    return {
      userId,
      sessionId,
      orgId: this.orgId,
      rundownPin: getPresentedRundownPin(request, this.orgId),
    };
  }

  private async socketCanObserve(claim: LiveRundownAuthorityClaim | null | undefined): Promise<boolean> {
    return Boolean(claim && await hasLiveRundownAuthority(this.env.DB, claim, [
      "show:view", "rundown:view", "rundown:edit", "cuesheet:view", "cuesheet:edit", "cuesheet:add_notes",
    ]));
  }

  private async socketCanWrite(attachment: {
    writeAccess?: RundownRelayWriteAccess | null;
    authClaim?: LiveRundownAuthorityClaim | null;
  }): Promise<boolean> {
    if (!attachment.writeAccess) return false;
    if (!attachment.authClaim) return false;
    return hasLiveRundownAuthority(
      this.env.DB,
      attachment.authClaim,
      attachment.writeAccess === "edit" ? "rundown:edit" : "rundown:control",
    );
  }

  private async handleCommand(
    action: string,
    payload?: Record<string, unknown>,
    commandId?: string,
  ): Promise<boolean> {
    const previousState = this.cloneState();
    let metadataGuard: { expectedUpdatedAt: string; fields: Record<string, unknown> } | undefined;

    switch (action) {
      case "seed": {
        const force = payload?.force === true;
        const items = parseRelayRundownItems(payload?.items);
        const timer = payload?.timer === undefined ? null : parseRelayTimer(payload.timer);
        const serviceName = payload?.serviceName;
        const scheduledStartTime = payload?.scheduledStartTime;
        const scheduledCallTime = payload?.scheduledCallTime;
        const location = payload?.location;
        if (
          !items
          || (payload?.timer !== undefined && !timer)
          || (serviceName !== undefined && (typeof serviceName !== "string" || serviceName.length > 120))
          || (location !== undefined && (typeof location !== "string" || location.length > 240))
          || (
            scheduledStartTime !== undefined
            && scheduledStartTime !== null
            && (typeof scheduledStartTime !== "string" || !Number.isFinite(Date.parse(scheduledStartTime)))
          )
          || (
            scheduledCallTime !== undefined
            && scheduledCallTime !== null
            && (typeof scheduledCallTime !== "string" || !Number.isFinite(Date.parse(scheduledCallTime)))
          )
        ) return false;
        // Empty is valid, authoritative state after clear-all. Only a room
        // that has never been initialized may accept an ordinary loader seed.
        if (!shouldAcceptRundownSeed(this.state.initialized, force)) return true;
        this.state.items = items;
        this.state.removedItems = [];
        this.state.initialized = true;
        if (timer) this.state.timer = timer;
        if (serviceName !== undefined) this.state.serviceName = serviceName;
        if (location !== undefined) this.state.location = location;
        if (scheduledStartTime !== undefined) {
          this.state.scheduledStartTime = scheduledStartTime === null
            ? null
            : new Date(scheduledStartTime).toISOString();
        }
        if (scheduledCallTime !== undefined) {
          this.state.scheduledCallTime = scheduledCallTime === null
            ? null
            : new Date(scheduledCallTime).toISOString();
        }
        break;
      }

      case "add-item": {
        const item = parseRelayRundownItem({
          ...payload,
          status: "upcoming",
          sortOrder: this.state.items.length,
        }, this.state.items.length);
        if (!item || this.state.items.some((existing) => existing.id === item.id)) return false;
        this.state.initialized = true;
        this.state.items.push(item);
        break;
      }

      case "update-item": {
        const id = typeof payload?.id === "string" ? payload.id : "";
        const updates = parseRelayItemUpdates(payload?.updates);
        const idx = this.state.items.findIndex((i) => i.id === id);
        if (idx < 0 || !updates) return false;
        this.state.items[idx] = { ...this.state.items[idx], ...updates };
        break;
      }

      case "remove-item": {
        const id = typeof payload?.id === "string" ? payload.id : "";
        const index = this.state.items.findIndex((item) => item.id === id);
        if (index < 0) return false;
        const item = { ...this.state.items[index] };
        if (this.state.timer.currentItemId === id) {
          item.status = "complete";
          item.actualEnd ??= new Date().toISOString();
          this.state.timer = { ...DEFAULT_TIMER, mode: this.state.timer.mode };
        }
        this.state.removedItems = [
          ...this.state.removedItems.filter((removed) => removed.expiresAt > Date.now()).slice(-19),
          { item, index, nextId: this.state.items[index + 1]?.id ?? null, expiresAt: Date.now() + 30000 },
        ];
        this.state.items = this.state.items.filter((i) => i.id !== id);
        break;
      }

      case "restore-item": {
        const removed = this.state.removedItems.find((entry) => entry.item.id === payload?.id && entry.expiresAt > Date.now());
        if (!removed || this.state.items.some((item) => item.id === removed.item.id)) return false;
        this.state.items = restoreRundownItem(this.state.items, removed).map((item, sortOrder) => ({ ...item, sortOrder }));
        this.state.removedItems = this.state.removedItems.filter((entry) => entry !== removed);
        break;
      }

      case "reorder": {
        const order = parseExactRelayOrder(payload?.order, this.state.items.map((item) => item.id));
        if (!order) return false;
        const map = new Map(this.state.items.map((item) => [item.id, item]));
        this.state.items = order.map((id, sortOrder) => ({ ...map.get(id)!, sortOrder }));
        break;
      }

      case "reconcile-local": {
        const journal = parseLocalRundownJournal(payload, Date.now());
        if (!journal || !this.state.showId || !this.state.serviceDate) return false;
        const result = reconcileLocalRundown(this.state, {
          orgId: this.orgId,
          showId: this.state.showId,
          serviceDate: this.state.serviceDate,
          revision: this.state.revision,
        }, journal);
        if (!result.ok) return false;
        this.state.items = result.state.items;
        this.state.timer = result.state.timer;
        break;
      }

      case "timer-goto": case "timer-start": case "timer-resume": case "timer-pause": case "timer-stop":
      case "timer-next": case "timer-prev": case "timer-adjust": case "timer-mode": {
        const command = parseRundownTransport(action, payload);
        if (!command) return false;
        const next = applyRundownTransport(this.state, command, Date.now());
        if (!next) return false;
        this.state.items = next.items;
        this.state.timer = next.timer;
        break;
      }

      case "pp-slide": {
        const slide = payload?.slide === null ? null : parseRelayPPSlide(payload?.slide);
        if (payload?.slide !== null && !slide) return false;
        this.state.ppSlide = this.state.ppOutputEnabled && slide
          ? { ...slide, updatedAt: Date.now() }
          : null;
        break;
      }

      case "pp-preview": {
        const slide = payload?.slide === null ? null : parseRelayPPSlide(payload?.slide);
        if (payload?.slide !== null && !slide) return false;
        if (typeof payload?.outputEnabled === "boolean") {
          this.state.ppOutputEnabled = payload.outputEnabled;
        }
        this.state.ppPreviewSlide = slide ? { ...slide, updatedAt: Date.now() } : null;
        this.state.ppSlide = this.state.ppOutputEnabled && slide
          ? { ...slide, updatedAt: Date.now() }
          : null;
        break;
      }

      case "pp-output-enabled": {
        if (typeof payload?.enabled !== "boolean") return false;
        this.state.ppOutputEnabled = payload.enabled;
        this.state.ppSlide = payload.enabled && this.state.ppPreviewSlide
          ? { ...this.state.ppPreviewSlide, updatedAt: Date.now() }
          : null;
        break;
      }

      case "reset": {
        if (this.state.timer.playback === "play") return false;
        this.state.removedItems = [];
        this.state.items.forEach((item) => {
          item.status = "upcoming";
          item.actualStart = null;
          item.actualEnd = null;
        });
        this.state.timer = {
          playback: "stop",
          currentItemId: null,
          elapsed: 0,
          startedAt: null,
          pausedAt: null,
          mode: this.state.timer.mode,
        };
        break;
      }

      case "clear-all": {
        this.state.removedItems = [];
        this.state.initialized = true;
        this.state.items = [];
        this.state.timer = {
          playback: "stop",
          currentItemId: null,
          elapsed: 0,
          startedAt: null,
          pausedAt: null,
          mode: this.state.timer.mode,
        };
        break;
      }

      case "stage-message": {
        const msg = payload?.message;
        if (typeof msg !== "string" || msg.length > 2_000) return false;
        this.state.stageMessage = msg;
        break;
      }

      case "stage-clear": {
        this.state.stageMessage = "";
        break;
      }

      case "update-meta": {
        const expectedUpdatedAt = payload?.expectedUpdatedAt;
        if (expectedUpdatedAt !== undefined) {
          if (typeof expectedUpdatedAt !== "string" || expectedUpdatedAt.length > 64
            || !Number.isFinite(Date.parse(expectedUpdatedAt)) || !this.state.showId || !payload) return false;
          metadataGuard = { expectedUpdatedAt, fields: payload };
        }
        const serviceName = payload?.serviceName;
        const scheduledStartTime = payload?.scheduledStartTime;
        const scheduledCallTime = payload?.scheduledCallTime;
        const location = payload?.location;
        if (
          serviceName === undefined && scheduledStartTime === undefined && scheduledCallTime === undefined && location === undefined
          || (serviceName !== undefined && (typeof serviceName !== "string" || serviceName.length > 120))
          || (location !== undefined && (typeof location !== "string" || location.length > 240))
          || (
            scheduledStartTime !== undefined
            && scheduledStartTime !== null
            && (typeof scheduledStartTime !== "string" || !Number.isFinite(Date.parse(scheduledStartTime)))
          )
          || (
            scheduledCallTime !== undefined
            && scheduledCallTime !== null
            && (typeof scheduledCallTime !== "string" || !Number.isFinite(Date.parse(scheduledCallTime)))
          )
        ) return false;
        if (serviceName !== undefined) this.state.serviceName = serviceName;
        if (location !== undefined) this.state.location = location;
        if (scheduledStartTime !== undefined) {
          this.state.scheduledStartTime = scheduledStartTime === null
            ? null
            : new Date(scheduledStartTime).toISOString();
        }
        if (scheduledCallTime !== undefined) {
          this.state.scheduledCallTime = scheduledCallTime === null
            ? null
            : new Date(scheduledCallTime).toISOString();
        }
        break;
      }

      default:
        return false;
    }

    this.state.items = this.state.items.map((item, sortOrder) => item.sortOrder === sortOrder ? item : { ...item, sortOrder });
    try {
      await this.persistAuthoritativeSnapshot(action, previousState, metadataGuard);
    } catch (error) {
      this.state = previousState;
      if (error instanceof RundownMetadataConflictError) throw error;
      reportRelayError(this.ctx, this.env.DB, this.orgId, "rundown_persistence", error);
      return false;
    }

    this.state.revision += 1;
    if (commandId) {
      this.state.recentCommandIds = [...this.state.recentCommandIds, commandId].slice(-100);
    }
    await this.persistState();
    this.broadcastState();

    return true;
  }

  private getPublicState() {
    return {
      // Each saved show owns its room. Readers use this identity to check
      // that the state on the wire belongs to the show on screen.
      serviceDate: this.state.serviceDate ?? null,
      showId: this.state.showId ?? null,
      ...(this.state.serviceName === undefined ? {} : { serviceName: this.state.serviceName }),
      ...(this.state.scheduledStartTime === undefined
        ? {}
        : { scheduledStartTime: this.state.scheduledStartTime }),
      ...(this.state.scheduledCallTime === undefined
        ? {}
        : { scheduledCallTime: this.state.scheduledCallTime }),
      ...(this.state.location === undefined ? {} : { location: this.state.location }),
      initialized: this.state.initialized,
      revision: this.state.revision,
      items: this.state.items,
      timer: {
        ...this.state.timer,
        serverTime: Date.now(),
      },
      ppSlide: this.state.ppSlide,
      ppPreviewSlide: this.state.ppPreviewSlide,
      ppOutputEnabled: this.state.ppOutputEnabled,
      stageMessage: this.state.stageMessage,
    };
  }

  /** Minimum state needed by an authorized confidence timer. */
  private getDisplayState() {
    return projectRundownDisplayState({
      serviceDate: this.state.serviceDate ?? null,
      showId: this.state.showId ?? null,
      initialized: this.state.initialized,
      revision: this.state.revision,
      items: this.state.items,
      timer: this.state.timer,
      ppSlide: this.state.ppSlide,
      stageMessage: this.state.stageMessage,
    });
  }

  private sendStateToSocket(ws: WebSocket): void {
    if (!displaySocketMayReceive(ws)) return;
    const attachment = ws.deserializeAttachment?.() as {
      writeAccess?: RundownRelayWriteAccess | null;
      canObserve?: boolean;
      authClaim?: LiveRundownAuthorityClaim | null;
    } | null;
    if (!socketReadLeaseAllows(ws, Boolean(attachment?.writeAccess || attachment?.canObserve))) return;
    ws.send(JSON.stringify({
      type: "state",
      ...this.resolvedTarget(),      state: attachment?.writeAccess || attachment?.canObserve
        ? this.getPublicState()
        : this.getDisplayState(),
    }));
  }

  private broadcastState(): void {
    for (const socket of this.ctx.getWebSockets()) {
      try { this.sendStateToSocket(socket); }
      catch { try { socket.close(1011, "Broadcast failed"); } catch {} }
    }
  }

  private socketNeedsReadLease(socket: WebSocket): boolean {
    const attachment = socket.deserializeAttachment() as { writeAccess?: RundownRelayWriteAccess | null; canObserve?: boolean } | null;
    return Boolean(attachment?.writeAccess || attachment?.canObserve);
  }

  /** Worker-only RPC; command authority still comes from live per-message checks. */
  async refreshReadAuthority(userId?: string): Promise<void> {
    await refreshSocketReadLeases(this.ctx.getWebSockets(), async socket => {
      const attachment = socket.deserializeAttachment() as {
        writeAccess?: RundownRelayWriteAccess | null; canObserve?: boolean; authClaim?: LiveRundownAuthorityClaim | null;
      } | null;
      if (!attachment?.writeAccess && !attachment?.canObserve) return null;
      if (userId && attachment.authClaim?.userId !== userId) return null;
      return attachment.writeAccess ? this.socketCanWrite(attachment) : this.socketCanObserve(attachment.authClaim);
    });
    await scheduleSocketReadRefresh(this.ctx, socket => this.socketNeedsReadLease(socket));
  }

  async alarm(): Promise<void> { await this.refreshReadAuthority(); }

}
