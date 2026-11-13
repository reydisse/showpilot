import { chatMutationCommandSchema, chatMutationResultSchema, chatMutationOutcomeMessage, type ChatMutationCommand, type ChatMutationResult } from "./chat-mutation";

export type ChatMutationWork = { command: ChatMutationCommand; at: number } & (
  | { state: "sending" }
  | { state: "unknown"; error: string }
  | { state: "settled"; result: ChatMutationResult }
);
type Scope = Pick<ChatMutationCommand, "userId" | "orgId" | "roomId">;
type Transport = { send(command: ChatMutationCommand): void; confirmed(command: ChatMutationCommand, result: ChatMutationResult): void };
type Waiter = { resolve(): void; reject(error: Error): void };
export class ChatMutationTrackedError extends Error {}
const unknownOutcome = "This change was not confirmed. Recover the original change before trying another action on this message.";

/** Retained by actor/workspace/room, independently of mounted web or native views.
 * Transport ownership changes on navigation; operation identity never changes. */
export class ChatMutationTracker {
  private work: ChatMutationWork[] = [];
  private listeners = new Set<() => void>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private waiters = new Map<string, Waiter>();
  private transport: Transport | null = null;
  constructor(private scope: Scope) {}
  snapshot = () => this.work;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(work: ChatMutationWork[]) { this.work = work; for (const listener of this.listeners) listener(); }
  bind(transport: Transport) {
    if (this.transport && this.transport !== transport) this.disconnect();
    this.transport = transport;
    return () => { if (this.transport === transport) this.disconnect(); };
  }
  private disconnect() {
    this.transport = null;
    for (const item of this.work) if (item.state === "sending") this.unknown(item.command.requestId, unknownOutcome);
  }
  private clearTimer(id: string) { clearTimeout(this.timers.get(id)); this.timers.delete(id); }
  private unknown(id: string, error: string) {
    this.clearTimer(id);
    this.update(this.work.map(item => item.command.requestId === id && item.state === "sending" ? { command: item.command, at: Date.now(), state: "unknown", error } : item));
    this.waiters.get(id)?.reject(new ChatMutationTrackedError(error)); this.waiters.delete(id);
  }
  start(input: ChatMutationCommand): Promise<void> {
    const command = chatMutationCommandSchema.parse(input);
    if (command.orgId !== this.scope.orgId || command.userId !== this.scope.userId || command.roomId !== this.scope.roomId) return Promise.reject(new Error("Chat account or room changed. Review this change again."));
    if (!this.transport) return Promise.reject(new Error("Chat is not ready. Reconnect before changing this message."));
    if (this.work.some(item => item.command.messageId === command.messageId && (item.state !== "settled" || item.result.cleanup !== "complete"))) return Promise.reject(new ChatMutationTrackedError(unknownOutcome));
    if (this.work.some(item => item.command.requestId === command.requestId)) return Promise.reject(new Error("Recover the existing request before starting another change."));
    const item: ChatMutationWork = { command, state: "sending", at: Date.now() };
    this.update([...this.work, item]);
    return new Promise<void>((resolve, reject) => {
      this.waiters.set(command.requestId, { resolve, reject });
      this.transmit(item);
    });
  }
  private transmit(item: ChatMutationWork) {
    const id = item.command.requestId;
    this.clearTimer(id);
    this.timers.set(id, setTimeout(() => this.unknown(id, unknownOutcome), 8_000));
    try {
      if (!this.transport) throw new Error("Chat disconnected. Reconnect to recover this change.");
      this.transport.send(item.command);
    } catch (error) { this.unknown(id, error instanceof Error ? error.message : unknownOutcome); }
  }
  retry(id: string) {
    const item = this.work.find(item => item.command.requestId === id);
    if (!item || item.state === "sending" || (item.state === "settled" && item.result.cleanup === "complete") || !this.transport) return;
    const next: ChatMutationWork = { command: item.command, at: Date.now(), state: "sending" };
    this.update(this.work.map(current => current === item ? next : current)); this.transmit(next);
  }
  dismiss(id: string) {
    this.update(this.work.filter(item => item.command.requestId !== id || item.state !== "settled" || item.result.cleanup !== "complete"));
  }
  unconfirmed(id: string, error: string) {
    if (this.work.some(item => item.command.requestId === id && item.state === "sending")) this.unknown(id, error);
  }
  receive(input: unknown): boolean {
    const parsed = chatMutationResultSchema.safeParse(input);
    if (!parsed.success) return false;
    const result = parsed.data, id = result.command.requestId;
    const item = this.work.find(item => item.command.requestId === id);
    if (!item || JSON.stringify(item.command) !== JSON.stringify(result.command)) return false;
    if (item.state === "settled" && item.result.cleanup === "complete") return true;
    this.clearTimer(id);
    const waiter = this.waiters.get(id); this.waiters.delete(id);
    const successful = result.outcome === "applied" && result.cleanup === "complete";
    // Notify only once, while the authoritative reply still confirms the change.
    // Recovery may use a replacement adapter, but never a different actor/room.
    if (result.outcome === "applied" && item.state !== "settled") this.transport?.confirmed(item.command, result);
    if (successful && waiter) this.update(this.work.filter(current => current !== item));
    else this.update(this.work.map(current => current === item ? { command: item.command, at: Date.now(), state: "settled", result } : current));
    if (successful) waiter?.resolve();
    else waiter?.reject(new ChatMutationTrackedError(chatMutationOutcomeMessage(result)));
    return true;
  }
}
const sharedTrackers = new Map<string, ChatMutationTracker>();
const ownedTrackers = new WeakMap<object, Map<string, ChatMutationTracker>>();
export function chatMutationTracker(scope: Scope, owner?: object) {
  let trackers = owner ? ownedTrackers.get(owner) : sharedTrackers;
  if (!trackers) { trackers = new Map(); if (owner) ownedTrackers.set(owner, trackers); }
  const key = JSON.stringify([scope.userId, scope.orgId, scope.roomId]);
  let tracker = trackers.get(key);
  if (!tracker) { tracker = new ChatMutationTracker(scope); trackers.set(key, tracker); }
  return tracker;
}
