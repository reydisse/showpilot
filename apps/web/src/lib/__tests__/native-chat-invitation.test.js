import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useChatInvitation, useChatInviteSharing } from "../../test/native-chat-invitation-hook.js";
const scope = { userId: "operator", orgId: "org", scope: "crew-chat" };
const reply = (command, more = {}) => ({ ...command, token: "fixture-pass", joinUrl: `https://fixture.invalid/join/chat/${command.scope === "planning-chat" ? "planning/" : ""}fixture-pass`, expiresAt: Date.now() + 3600000, notifications: { status: "not-needed" }, ...more });
beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.useRealTimers(); });
function setup(send = vi.fn(async command => reply(command)), initialProps = scope) {
  const client = new QueryClient(), wrapper = ({ children }) => React.createElement(QueryClientProvider, { client }, children);
  const mount = (props = initialProps) => renderHook(value => useChatInvitation(value, { active: true, send }), { wrapper, initialProps: props });
  const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
  return { ...mount(), mount, client, send, flush };
}
it.each(["userId", "orgId", "scope"])("retains invitation choices separately for each %s", async field => {
  const f = setup(); await act(async () => f.result.current.setFields({ hours: 8, targetUserIds: ["crew"] }));
  const oldSetter = f.result.current.setFields;
  f.rerender({ ...scope, [field]: field === "scope" ? "planning-chat" : "other" });
  expect(f.result.current.draft.hours).toBe(4);
  await act(async () => oldSetter({ hours: 24 })); expect(f.result.current.draft.hours).toBe(4);
  f.rerender(scope); expect(f.result.current.draft).toMatchObject({ hours: 8, targetUserIds: ["crew"] });
});
it("bounds a missing reply and retries the exact request after unmount", async () => {
  let late; const send = vi.fn().mockImplementationOnce(() => new Promise(resolve => { late = resolve; })).mockImplementation(async command => reply(command));
  const f = setup(send);
  await act(async () => { f.result.current.create([]); f.result.current.create([]); });
  expect(send).toHaveBeenCalledTimes(1); const command = send.mock.calls[0][0];
  await act(async () => f.result.current.setFields({ hours: 24 })); expect(f.result.current.draft.hours).toBe(4);
  f.unmount(); await act(async () => vi.advanceTimersByTimeAsync(15001));
  expect(send.mock.calls[0][1].aborted).toBe(true);
  const next = f.mount(); expect(next.result.current.attempt.kind).toBe("failed");
  await act(async () => next.result.current.retry()); await f.flush();
  expect(send.mock.calls[1][0]).toEqual(command); expect(next.result.current.pass.token).toBe("fixture-pass");
  await act(async () => late(reply(command, { token: "stale" }))); expect(next.result.current.pass.token).toBe("fixture-pass");
});
it.each(["userId", "orgId", "scope"])("keeps a delayed result in its original %s", async field => {
  let finish; const f = setup(vi.fn(command => new Promise(resolve => { finish = () => resolve(reply(command)); })));
  await act(async () => f.result.current.create([]));
  f.rerender({ ...scope, [field]: field === "scope" ? "planning-chat" : "other" });
  await act(async () => finish()); expect(f.result.current.attempt).toBeUndefined();
  f.rerender(scope); await f.flush(); expect(f.result.current.pass.token).toBe("fixture-pass"); expect(f.result.current.attempt.refresh).toBe("done");
});
it.each(["userId", "orgId", "requestId", "scope", "joinUrl"])("rejects a mismatched invitation %s", async field => {
  const send = vi.fn(async command => reply(command, { [field]: field === "requestId" ? "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb" : field === "scope" ? "planning-chat" : field === "joinUrl" ? "https://fixture.invalid/other" : "other" }));
  const f = setup(send); await act(async () => f.result.current.create([]));
  expect(f.result.current.attempt.kind).toBe("failed"); expect(f.result.current.pass).toBeNull();
});
it("retains a ready Planning link during notification failure and retries the original choices", async () => {
  let finish;
  const send = vi.fn().mockImplementationOnce(async command => reply(command, { targetCount: 1, notifications: { status: "pending", missing: 1 } }))
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const f = setup(send, { ...scope, scope: "planning-chat" });
  await act(async () => f.result.current.setFields({ targetUserIds: ["crew"], hours: 8 }));
  await act(async () => f.result.current.create(["crew"])); await f.flush();
  const original = f.result.current.pass; expect(original.notifications.status).toBe("pending");
  await act(async () => f.result.current.retry()); expect(f.result.current.pass).toEqual(original);
  expect(send.mock.calls[1][0]).toEqual(send.mock.calls[0][0]);
  await act(async () => finish({ ...original, notifications: { status: "saved", recipients: 1 } }));
  expect(f.result.current.pass.notifications.status).toBe("saved"); expect(f.result.current.pass.token).toBe(original.token);
});
it.each([[], ["missing"], Array.from({length: 51},(_, i) => `crew-${i}`)].map(ids => [ids]))("validates the whole Planning selection before sending (%j)", async ids => {
  const f = setup(undefined, { ...scope, scope: "planning-chat" });
  await act(async () => f.result.current.setFields({ targetUserIds: ids }));
  await act(async () => f.result.current.create(ids.filter(id => id !== "missing")));
  expect(f.send).not.toHaveBeenCalled(); expect(f.result.current.draft.error).toBeTruthy();
});
it("retains a ready link after closing and only makes another request after explicit reset", async () => {
  const f = setup(); await act(async () => f.result.current.create([])); await f.flush();
  const original = f.send.mock.calls[0][0]; f.unmount(); const next = f.mount();
  expect(next.result.current.pass.token).toBe("fixture-pass");
  await act(async () => next.result.current.create([])); expect(f.send).toHaveBeenCalledTimes(1);
  await act(async () => next.result.current.startNew()); await act(async () => { next.result.current.setFields({ hours: 8 }); next.result.current.create([]); });
  expect(f.send.mock.calls[1][0]).toMatchObject({ hours: 8 }); expect(f.send.mock.calls[1][0].requestId).not.toBe(original.requestId);
});
it("keeps link creation separate from a failed or cancelled share", async () => {
  const pass = reply({ ...scope, requestId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa" });
  const share = vi.fn().mockRejectedValueOnce(new Error("Sharing unavailable")).mockResolvedValueOnce("dismissed");
  const f = renderHook(() => useChatInviteSharing(pass, true, share));
  await act(async () => f.result.current.open()); expect(f.result.current.kind).toBe("failed");
  await act(async () => f.result.current.open()); expect(f.result.current.kind).toBe("dismissed");
  expect(share.mock.calls).toEqual([[pass.joinUrl],[pass.joinUrl]]);
});
it("bounds share completion and ignores a stale reply during a retry", async () => {
  const pass = reply({ ...scope, requestId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa" });
  let original, retry; const share = vi.fn().mockImplementationOnce(() => new Promise(resolve => { original = resolve; })).mockImplementationOnce(() => new Promise(resolve => { retry = resolve; }));
  const f = renderHook(() => useChatInviteSharing(pass, true, share));
  let pending; await act(async () => { pending = f.result.current.open(); });
  await act(async () => vi.advanceTimersByTimeAsync(15001)); await pending; expect(f.result.current.kind).toBe("failed");
  await act(async () => { pending = f.result.current.open(); });
  await act(async () => original("shared")); expect(f.result.current.kind).toBe("pending");
  await act(async () => retry("dismissed")); await pending; expect(f.result.current.kind).toBe("dismissed");
});
it("does not share expired links or let an old share update another link", async () => {
  const pass = reply({ ...scope, requestId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa" });
  let finish; const share = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  const f = renderHook(({ current }) => useChatInviteSharing(current, true, share), { initialProps: { current: { ...pass, expiresAt: Date.now() - 1 } } });
  await act(async () => f.result.current.open()); expect(share).not.toHaveBeenCalled();
  f.rerender({ current: pass }); let pending; await act(async () => { pending = f.result.current.open(); });
  f.rerender({ current: { ...pass, token: "other" } }); await act(async () => finish("shared")); await pending;
  expect(f.result.current.kind).toBe("idle");
});
