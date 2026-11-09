import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useProPresenterCommand } from "../../test/native-propresenter-command-hook.js";
const scope = { orgId: "org", userId: "user", showId: "show" };
const reply = (c, status) => ({ ...c, status, message: status });
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
function setup(
  call = vi.fn(async (c, mode) =>
    reply(c, mode === "prepare" ? "prepared" : "confirmed"),
  ),
  client = new QueryClient(),
) {
  const view = renderHook(
    ({ identity, ready }) =>
      useProPresenterCommand(identity, { enabled: true, ready, call }),
    {
      initialProps: { identity: scope, ready: true },
      wrapper: ({ children }) =>
        React.createElement(QueryClientProvider, { client }, children),
    },
  );
  return { ...view, client, call };
}
it("prepares then executes one command and allows the next deliberate tap after success", async () => {
  const f = setup();
  await act(async () => f.result.current.start("next"));
  expect(f.call.mock.calls.map((c) => c[1])).toEqual(["prepare", "execute"]);
  expect(f.call.mock.calls[1][0]).toEqual(f.call.mock.calls[0][0]);
  expect(f.result.current.attempt.result.status).toBe("confirmed");
  await act(async () => f.result.current.start("previous"));
  expect(f.call).toHaveBeenCalledTimes(4);
  expect(f.call.mock.calls[2][0].requestId).not.toBe(
    f.call.mock.calls[0][0].requestId,
  );
});
it("checks a lost execute reply without sending the command again, including after navigation", async () => {
  const call = vi.fn(async (c, mode) => {
    if (mode === "execute") throw new Error("Lost reply");
    return reply(c, mode === "prepare" ? "prepared" : "confirmed");
  });
  const f = setup(call);
  await act(async () => f.result.current.start("next"));
  expect(f.result.current.attempt.kind).toBe("failed");
  f.unmount();
  const g = setup(call, f.client);
  expect(g.result.current.canStart).toBe(false);
  await act(async () => g.result.current.start("next"));
  expect(call).toHaveBeenCalledTimes(2);
  await act(async () => g.result.current.check());
  expect(call.mock.calls.map((c) => c[1])).toEqual([
    "prepare",
    "execute",
    "check",
  ]);
  expect(g.result.current.attempt.result.status).toBe("confirmed");
});
it.each(["orgId", "userId", "showId"])(
  "does not execute a late preparation after %s changes",
  async (field) => {
    let release;
    const call = vi.fn(
      (c) =>
        new Promise((done) => {
          release = () => done(reply(c, "prepared"));
        }),
    );
    const f = setup(call);
    await act(async () => f.result.current.start("next"));
    f.rerender({ identity: { ...scope, [field]: "other" }, ready: true });
    await act(async () => release());
    expect(call).toHaveBeenCalledTimes(1);
    expect(f.result.current.attempt).toBeUndefined();
  },
);
it("does not execute after live sync is lost during preparation", async () => {
  let release;
  const call = vi.fn(
    (c) =>
      new Promise((done) => {
        release = () => done(reply(c, "prepared"));
      }),
  );
  const f = setup(call);
  await act(async () => f.result.current.start("next"));
  f.rerender({ identity: scope, ready: false });
  await act(async () => release());
  expect(call).toHaveBeenCalledTimes(1);
  expect(f.result.current.canStart).toBe(false);
});
it("requires an output check before another command after an uncertain outcome", async () => {
  const f = setup(
    vi.fn(async (c, mode) =>
      reply(c, mode === "prepare" ? "prepared" : "uncertain"),
    ),
  );
  await act(async () => f.result.current.start("clear"));
  expect(f.result.current.canStart).toBe(false);
  await act(async () => f.result.current.check());
  expect(f.call.mock.calls.map((c) => c[1])).toEqual([
    "prepare",
    "execute",
    "check",
  ]);
  expect(f.result.current.canStart).toBe(false);
  await act(async () => f.result.current.acknowledge());
  expect(f.result.current.canStart).toBe(true);
});
it("bounds a stuck request, preserves its identity, and checks rather than re-executing", async () => {
  vi.useFakeTimers();
  const call = vi.fn(async (c, mode) =>
    mode === "check" ? reply(c, "rejected") : new Promise(() => {}),
  );
  const f = setup(call);
  await act(async () => f.result.current.start("next"));
  await act(async () => vi.advanceTimersByTimeAsync(15001));
  expect(f.result.current.attempt.kind).toBe("failed");
  await act(async () => f.result.current.check());
  expect(call.mock.calls.map((c) => c[1])).toEqual(["prepare", "check"]);
  expect(call.mock.calls[0][0]).toEqual(call.mock.calls[1][0]);
});
it("rejects a mismatched command reply", async () => {
  const f = setup(
    vi.fn(async (c) => ({ ...reply(c, "prepared"), command: "clear" })),
  );
  await act(async () => f.result.current.start("next"));
  expect(f.result.current.attempt.kind).toBe("failed");
  expect(f.call).toHaveBeenCalledTimes(1);
});
