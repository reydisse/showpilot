import type { WorkspaceProfile, WorkspaceType } from "./workspace/types";
import {
  workspaceOperationSchema, workspaceSnapshotSchema, workspaceChangeResultSchema,
  workspaceChangeMessage, type WorkspaceChange, type WorkspaceChangeResult,
  type WorkspaceOperation, type WorkspaceSnapshot,
} from "./workspace-change";

export type WorkspaceDraft = {
  type: WorkspaceType; reset: boolean; changing: boolean;
  custom: { label: string; terms: { event: string; events: string; item: string; items: string } };
};
function draft(profile: WorkspaceProfile): WorkspaceDraft {
  return { type: profile.type, reset: false, changing: false, custom: {
    label: profile.label ?? "", terms: { event: profile.terms.eventTitle, events: profile.terms.eventPlural, item: profile.terms.item, items: profile.terms.itemPlural },
  } };
}
type Attempt = { command: WorkspaceChange } & (
  | { kind: "pending" }
  | { kind: "unknown" }
  | { kind: "confirmed"; result: WorkspaceChangeResult; refresh: "pending" | "failed" | "done" }
);
type State = {
  snapshot: WorkspaceSnapshot | null; draft: WorkspaceDraft; dirty: boolean;
  loading: boolean; error: string; notice: string; attempt: Attempt | null;
};
type Ports = {
  uuid: () => string;
  read: (signal: AbortSignal) => Promise<unknown>;
  send: (command: WorkspaceChange, mode: "save" | "review", signal: AbortSignal) => Promise<unknown>;
  refresh: (snapshot: WorkspaceSnapshot, signal: AbortSignal) => Promise<void>;
};
async function bounded<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error("Workspace request timed out.")); }, 12000);
  });
  try { return await Promise.race([Promise.resolve().then(() => work(controller.signal)), timeout]); }
  finally { clearTimeout(timer!); }
}
/** One account/workspace owns the draft and frozen request across navigation.
 * A timeout never claims that a write failed or discards its request identity. */
export class WorkspaceEditor {
  private state: State;
  private listeners = new Set<() => void>();
  private loadOwner = 0;
  constructor(private scope: { orgId: string; userId: string }, profile: WorkspaceProfile, private ports: Ports) {
    this.state = { snapshot: null, draft: draft(profile), dirty: false, loading: false, error: "", notice: "", attempt: null };
  }
  subscribe = (notify: () => void) => { this.listeners.add(notify); return () => { this.listeners.delete(notify); }; };
  getSnapshot = () => this.state;
  private set(next: Partial<State>) { this.state = { ...this.state, ...next }; for (const notify of this.listeners) notify(); }
  private checkScope(value: { orgId: string; userId: string }) {
    if (value.orgId !== this.scope.orgId || value.userId !== this.scope.userId) throw new Error("Your account or workspace changed. Reopen Workspace settings.");
  }
  async load() {
    if (this.state.loading || this.state.attempt) return;
    const owner = ++this.loadOwner;
    this.set({ loading: true, error: "" });
    try {
      const snapshot = workspaceSnapshotSchema.parse(await bounded(this.ports.read));
      this.checkScope(snapshot);
      if (owner !== this.loadOwner) return;
      this.set({ snapshot, ...(!this.state.dirty ? { draft: draft(snapshot.profile) } : {}) });
    } catch (error) {
      if (owner === this.loadOwner) this.set({ error: error instanceof Error ? error.message : "Workspace settings could not load. Retry loading." });
    } finally { if (owner === this.loadOwner) this.set({ loading: false }); }
  }
  edit(next: WorkspaceDraft) {
    if (this.state.attempt) return;
    this.set({ draft: next, dirty: true, error: "", notice: "" });
  }
  submit(operation: WorkspaceOperation) {
    if (!this.state.snapshot || this.state.loading || this.state.attempt) return;
    const parsed = workspaceOperationSchema.safeParse(operation);
    if (!parsed.success) { this.set({ error: parsed.error.issues[0]?.message ?? "Check your workspace settings." }); return; }
    const command = { ...this.scope, requestId: this.ports.uuid(), expectedRevision: this.state.snapshot.revision, operation: parsed.data };
    void this.execute(command, "save");
  }
  private async execute(command: WorkspaceChange, mode: "save" | "review") {
    const owner: Attempt = { command, kind: "pending" };
    ++this.loadOwner;
    this.set({ attempt: owner, loading: false, error: "", notice: "" });
    try {
      const result = workspaceChangeResultSchema.parse(await bounded(signal => this.ports.send(command, mode, signal)));
      this.checkScope(result); this.checkScope(result.snapshot);
      if (result.requestId !== command.requestId) throw new Error("Workspace reply does not match this save.");
      if (this.state.attempt !== owner) return;
      this.set({ snapshot: result.snapshot, attempt: { command, kind: "confirmed", result, refresh: "done" } });
      await this.refresh();
    } catch {
      if (this.state.attempt === owner) this.set({ attempt: { command, kind: "unknown" } });
    }
  }
  retry() { const a = this.state.attempt; if (a?.kind === "unknown") void this.execute(a.command, "save"); }
  review() { const a = this.state.attempt; if (a?.kind === "unknown") void this.execute(a.command, "review"); }
  async refresh() {
    const attempt = this.state.attempt;
    if (attempt?.kind !== "confirmed" || attempt.refresh === "pending") return;
    const owner: Attempt = { ...attempt, refresh: "pending" };
    this.set({ attempt: owner });
    try {
      await bounded(signal => this.ports.refresh(attempt.result.snapshot, signal));
      if (this.state.attempt !== owner) return;
      if (attempt.result.outcome === "applied") {
        const next = this.state.draft;
        this.set({ attempt: null, notice: workspaceChangeMessage(attempt.result),
          ...(attempt.command.operation.kind === "custom" ? { dirty: false } : {}),
          draft: attempt.command.operation.kind === "custom" ? draft(attempt.result.snapshot.profile)
            : attempt.command.operation.kind === "type" ? { ...next, changing: false } : next,
        });
      } else this.set({ attempt: { ...attempt, refresh: "done" } });
    } catch { if (this.state.attempt === owner) this.set({ attempt: { ...attempt, refresh: "failed" } }); }
  }
  useCurrent() {
    const a = this.state.attempt;
    if (a?.kind !== "confirmed" || a.refresh !== "done") return;
    this.set({ attempt: null, draft: draft(a.result.snapshot.profile), dirty: false, notice: "Current workspace settings loaded. You can make a new change." });
  }
}
