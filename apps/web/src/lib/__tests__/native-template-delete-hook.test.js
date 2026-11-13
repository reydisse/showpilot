import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useTemplateDelete } from "../../test/native-template-delete-hook.js";
const scope = { orgId: "org", userId: "operator", showId: "show" };
const template = { id: "template", name: "Sunday template" };
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
function setup(
  send = vi.fn(async (command) => ({ ...command, ok: true })),
  refresh = vi.fn(async () => {}),
) {
  const client = new QueryClient();
  const view = renderHook(
    ({ identity, active }) =>
      useTemplateDelete(identity, { active, send, refresh }),
    {
      initialProps: { identity: scope, active: true },
      wrapper: ({ children }) =>
        React.createElement(QueryClientProvider, { client }, children),
    },
  );
  return { ...view, client, send, refresh };
}
it("bounds a hung deletion, aborts its transport and retains the original command for retry", async () => {
  vi.useFakeTimers();
  const send = vi
    .fn()
    .mockImplementationOnce(() => new Promise(() => {}))
    .mockImplementation(async (command) => ({ ...command, ok: true }));
  const f = setup(send);
  await act(async () => f.result.current.confirm(template));
  const original = send.mock.calls[0][0],
    signal = send.mock.calls[0][1];
  await act(async () => vi.advanceTimersByTimeAsync(15001));
  expect(signal.aborted).toBe(true);
  expect(f.result.current.work.template.kind).toBe("failed");
  expect(f.result.current.work.template.message).toMatch(/may have completed/);
  await act(async () => f.result.current.retry("template"));
  expect(send.mock.calls[1][0]).toEqual(original);
  expect(f.result.current.work.template).toMatchObject({
    kind: "confirmed",
    refresh: "done",
  });
});
it("bounds a hung refresh and retries refresh without deleting again", async () => {
  vi.useFakeTimers();
  const refresh = vi
      .fn()
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValue(undefined),
    f = setup(undefined, refresh);
  await act(async () => f.result.current.confirm(template));
  await act(async () => vi.advanceTimersByTimeAsync(12001));
  expect(f.result.current.work.template).toMatchObject({
    kind: "confirmed",
    refresh: "failed",
  });
  await act(async () => f.result.current.refresh("template"));
  expect(f.send).toHaveBeenCalledTimes(1);
  expect(f.result.current.work.template.refresh).toBe("done");
});
it("rejects an acknowledgement for a different template", async () => {
  const f = setup(
    vi.fn(async (command) => ({ ...command, templateId: "other", ok: true })),
  );
  await act(async () => f.result.current.confirm(template));
  expect(f.result.current.work.template).toMatchObject({
    kind: "failed",
    message: expect.stringMatching(/another template/),
  });
  expect(f.refresh).not.toHaveBeenCalled();
});
it("a late reply stays with the original account and does not refresh another account", async () => {
  let resolve;
  const f = setup(
    vi.fn(
      (command) =>
        new Promise((done) => {
          resolve = () => done({ ...command, ok: true });
        }),
    ),
  );
  await act(async () => f.result.current.confirm(template));
  f.rerender({ identity: { ...scope, userId: "other" }, active: true });
  await act(async () => resolve());
  expect(f.result.current.work).toEqual({});
  expect(f.refresh).not.toHaveBeenCalled();
  const stored = f.client.getQueryData([
    "mobile-template-delete-request",
    scope.userId,
    scope.orgId,
    scope.showId,
  ]);
  expect(stored.template).toMatchObject({ kind: "confirmed", refresh: "idle" });
});
it("does not send twice or start work from an inactive screen", async () => {
  const f = setup(vi.fn(() => new Promise(() => {})));
  await act(async () => {
    f.result.current.confirm(template);
    f.result.current.confirm(template);
  });
  expect(f.send).toHaveBeenCalledTimes(1);
  f.rerender({ identity: scope, active: false });
  await act(async () =>
    f.result.current.confirm({ id: "other", name: "Other" }),
  );
  expect(f.send).toHaveBeenCalledTimes(1);
});
