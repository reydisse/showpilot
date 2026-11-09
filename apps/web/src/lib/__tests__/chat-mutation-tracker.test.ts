import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChatMutationTracker } from "@showpilot/shared/chat-mutation-tracker";
import type { ChatMutationCommand, ChatMutationResult } from "@showpilot/shared/chat-mutation";
const scope = { orgId: "org", userId: "actor", roomId: "production" };
const command = (): ChatMutationCommand => ({ ...scope, messageId: "message", requestId: crypto.randomUUID(), expiresAt: Date.now() + 10_000, operation: { kind: "reaction", emoji: "👍", active: true } });
const result = (command: ChatMutationCommand, outcome: ChatMutationResult["outcome"] = "applied"): ChatMutationResult => ({ command, outcome, at: Date.now(), cleanup: "complete" });
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
it("retains an uncertain command and retries its exact identity on a replacement transport", async () => {
  const tracker = new ChatMutationTracker(scope), first = { send: vi.fn(), confirmed: vi.fn() };
  const detach = tracker.bind(first), original = command();
  const changing = tracker.start(original); const rejected = expect(changing).rejects.toThrow("not confirmed");
  await vi.advanceTimersByTimeAsync(8001); await rejected;
  expect(tracker.snapshot()).toMatchObject([{ state: "unknown", command: original }]);
  await expect(tracker.start(command())).rejects.toThrow("Recover the original");
  tracker.dismiss(original.requestId); expect(tracker.snapshot()).toHaveLength(1);
  detach(); const next = { send: vi.fn(), confirmed: vi.fn() }; tracker.bind(next);
  tracker.retry(original.requestId); tracker.retry(original.requestId);
  expect(next.send).toHaveBeenCalledExactlyOnceWith(original);
  expect(tracker.receive(result(original))).toBe(true);
  expect(next.confirmed).toHaveBeenCalledExactlyOnceWith(original, expect.objectContaining({ outcome: "applied" }));
  tracker.receive(result(original)); expect(next.confirmed).toHaveBeenCalledOnce();
  expect(tracker.snapshot()).toMatchObject([{ state: "settled" }]);
  tracker.dismiss(original.requestId); expect(tracker.snapshot()).toEqual([]);
});
it("does not let a retiring transport detach its replacement", async () => {
  const tracker = new ChatMutationTracker(scope), old = { send: vi.fn(), confirmed: vi.fn() }, next = { send: vi.fn(), confirmed: vi.fn() };
  const retire = tracker.bind(old); tracker.bind(next); retire();
  const original = command(), changing = tracker.start(original);
  tracker.receive(result(original)); await changing;
  expect(next.send).toHaveBeenCalledOnce(); expect(old.send).not.toHaveBeenCalled();
});
it.each(["orgId", "userId", "roomId", "messageId", "requestId"] as const)("ignores a receipt belonging to another %s", async field => {
  const tracker = new ChatMutationTracker(scope); const detach = tracker.bind({ send: vi.fn(), confirmed: vi.fn() });
  const original = command(), changing = tracker.start(original), rejected = expect(changing).rejects.toThrow("not confirmed");
  expect(tracker.receive(result({ ...original, [field]: field === "requestId" ? crypto.randomUUID() : "other" }))).toBe(false);
  expect(tracker.snapshot()[0].state).toBe("sending"); detach(); await rejected;
});
it("rejects changed operation receipts and keeps the captured edit draft", async () => {
  const tracker = new ChatMutationTracker(scope); const detach = tracker.bind({ send: vi.fn(), confirmed: vi.fn() });
  const original: ChatMutationCommand = { ...command(), operation: { kind: "edit", expectedEditTime: 100, text: "Original draft" } };
  const changing = tracker.start(original), rejected = expect(changing).rejects.toThrow("not confirmed");
  expect(tracker.receive(result({ ...original, operation: { ...original.operation, kind: "edit", expectedEditTime: 100, text: "Other draft" } }))).toBe(false);
  detach(); await rejected;
  expect(tracker.snapshot()[0].command.operation).toEqual(original.operation);
});
it("retains a conflict for review and does not retry it as a new edit", async () => {
  const tracker = new ChatMutationTracker(scope), transport = { send: vi.fn(), confirmed: vi.fn() }; tracker.bind(transport);
  const original = command(), changing = tracker.start(original), rejected = expect(changing).rejects.toThrow("message changed");
  tracker.receive(result(original, "conflict")); await rejected;
  tracker.retry(original.requestId); expect(transport.send).toHaveBeenCalledOnce();
  expect(transport.confirmed).not.toHaveBeenCalled();
  tracker.dismiss(original.requestId); expect(tracker.snapshot()).toEqual([]);
});
it("keeps cleanup recovery attached to an already applied deletion", async () => {
  const tracker = new ChatMutationTracker(scope), transport = { send: vi.fn(), confirmed: vi.fn() }; tracker.bind(transport);
  const original: ChatMutationCommand = { ...command(), operation: { kind: "delete", expectedEditTime: 100 } };
  const changing = tracker.start(original), rejected = expect(changing).rejects.toThrow("Message deleted");
  tracker.receive({ ...result(original), cleanup: "failed" }); await rejected;
  tracker.dismiss(original.requestId); expect(tracker.snapshot()).toHaveLength(1);
  tracker.retry(original.requestId); expect(transport.send).toHaveBeenLastCalledWith(original);
  tracker.receive(result(original)); expect(tracker.snapshot()).toMatchObject([{ state: "settled", result: { cleanup: "complete" } }]);
  tracker.dismiss(original.requestId); expect(tracker.snapshot()).toEqual([]);
});
