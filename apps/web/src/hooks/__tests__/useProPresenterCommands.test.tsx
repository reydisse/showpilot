import { createElement, type PropsWithChildren } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useProPresenterCommands } from "../useProPresenterCommands";
import type {
  ProPresenterCommand,
  ProPresenterReply,
} from "@showpilot/shared/propresenter-command";
const mocks = vi.hoisted(() => ({ slide: vi.fn(), output: vi.fn() }));
vi.mock("@/lib/rundown", () => ({
  sendProPresenterCommand: mocks.slide,
  setProPresenterStageDisplay: mocks.output,
}));
const options = {
  orgId: "org",
  userId: "user",
  showId: "show",
  scope: "org:show:target",
  canControlSlides: true,
  canCheckSlides: true,
  canChangeOutput: true,
};
function reply(
  data: ProPresenterCommand & { mode?: string },
  status: ProPresenterReply["status"],
): ProPresenterReply {
  const { mode: _mode, ...command } = data;
  return { ...command, status, message: status };
}
function setup(client = new QueryClient()) {
  return {
    client,
    ...renderHook((props) => useProPresenterCommands(props), {
      initialProps: options,
      wrapper: ({ children }: PropsWithChildren) =>
        createElement(QueryClientProvider, { client }, children),
    }),
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.slide.mockImplementation(async ({ data }) =>
    reply(data, data.mode === "prepare" ? "prepared" : "confirmed"),
  );
  mocks.output.mockResolvedValue({ ok: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
it("prepares then executes the same request and prevents overlapping actions", async () => {
  let finish!: (value: ProPresenterReply) => void;
  mocks.slide.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const f = setup();
  let first!: Promise<void>;
  act(() => {
    first = f.result.current.run({ kind: "slide", command: "next" });
    void f.result.current.run({ kind: "slide", command: "next" });
    void f.result.current.run({ kind: "output", enabled: true });
  });
  await act(async () => {});
  expect(mocks.slide).toHaveBeenCalledOnce();
  expect(mocks.output).not.toHaveBeenCalled();
  expect(f.result.current.pending).toEqual({ kind: "slide", command: "next" });
  const original = mocks.slide.mock.calls[0][0].data;
  expect(original).toMatchObject({
    orgId: "org",
    userId: "user",
    showId: "show",
    command: "next",
    mode: "prepare",
  });
  await act(async () => {
    finish(reply(original, "prepared"));
    await first;
  });
  expect(mocks.slide.mock.calls[1][0].data).toEqual({
    ...original,
    mode: "execute",
  });
  expect(f.result.current.notice).toBe("Next slide confirmed.");
});
it("retains an unconfirmed command through navigation and checks it without another mutation", async () => {
  mocks.slide.mockImplementation(async ({ data }) => {
    if (data.mode === "execute") throw new Error("Lost reply");
    return reply(data, data.mode === "prepare" ? "prepared" : "confirmed");
  });
  const first = setup();
  await act(async () =>
    first.result.current.run({ kind: "slide", command: "next" }),
  );
  expect(first.result.current.failure?.message).toContain(
    "Next slide was not confirmed",
  );
  const original = mocks.slide.mock.calls[0][0].data;
  first.unmount();
  const returned = setup(first.client);
  expect(returned.result.current.failure).not.toBeNull();
  expect(returned.result.current.canAcknowledge).toBe(false);
  await act(async () =>
    returned.result.current.run({ kind: "slide", command: "next" }),
  );
  await act(async () => returned.result.current.checkStatus());
  expect(mocks.slide.mock.calls.map((call) => call[0].data.mode)).toEqual([
    "prepare",
    "execute",
    "check",
  ]);
  expect(mocks.slide.mock.calls[2][0].data).toEqual({
    ...original,
    mode: "check",
  });
  expect(returned.result.current.notice).toBe("Next slide confirmed.");
});
it.each([{}, undefined, { ok: false }, { status: "confirmed" }])(
  "rejects a missing or malformed acknowledgement: %j",
  async (result) => {
    mocks.slide.mockResolvedValueOnce(result);
    const f = setup();
    await act(async () =>
      f.result.current.run({ kind: "slide", command: "clear" }),
    );
    expect(f.result.current.notice).toBeNull();
    expect(f.result.current.failure?.message).toContain(
      "Clear slide was not confirmed",
    );
    expect(f.result.current.failure?.occurredAt).toBe(Date.now());
    expect(mocks.slide).toHaveBeenCalledOnce();
  },
);
it("requires an explicit output review after an uncertain device result", async () => {
  mocks.slide.mockImplementation(async ({ data }) =>
    reply(data, data.mode === "prepare" ? "prepared" : "uncertain"),
  );
  const f = setup();
  await act(async () =>
    f.result.current.run({ kind: "slide", command: "clear" }),
  );
  expect(f.result.current.blocked).toBe(true);
  expect(f.result.current.canAcknowledge).toBe(true);
  await act(async () => f.result.current.checkStatus());
  expect(mocks.slide.mock.calls.map((call) => call[0].data.mode)).toEqual([
    "prepare",
    "execute",
    "check",
  ]);
  act(() => f.result.current.acknowledgeReview());
  expect(f.result.current.blocked).toBe(false);
  expect(mocks.slide).toHaveBeenCalledTimes(3);
});
it("times out a stalled preparation and never executes its late reply", async () => {
  let finish!: (value: ProPresenterReply) => void;
  mocks.slide.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const f = setup();
  let work!: Promise<void>;
  act(() => {
    work = f.result.current.run({ kind: "slide", command: "next" });
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20_001);
    await work;
  });
  expect(mocks.slide.mock.calls[0][0].signal.aborted).toBe(true);
  expect(f.result.current.failure).not.toBeNull();
  const failure = f.result.current.failure;
  await act(async () => {
    finish(reply(mocks.slide.mock.calls[0][0].data, "prepared"));
  });
  expect(mocks.slide).toHaveBeenCalledOnce();
  expect(f.result.current.failure).toEqual(failure);
});
it("bounds failed status checks without erasing the original request", async () => {
  mocks.slide.mockImplementation(async ({ data }) => {
    if (data.mode === "execute") throw new Error("lost");
    if (data.mode === "check") return new Promise(() => {});
    return reply(data, "prepared");
  });
  const f = setup();
  await act(async () =>
    f.result.current.run({ kind: "slide", command: "next" }),
  );
  let work!: Promise<void>;
  act(() => {
    work = f.result.current.checkStatus();
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(12_001);
    await work;
  });
  expect(f.result.current.failure?.message).toContain("Retry the status check");
  expect(f.result.current.blocked).toBe(true);
  expect(mocks.slide.mock.calls[2][0].signal.aborted).toBe(true);
  mocks.slide.mockImplementation(async ({ data }) => reply(data, "confirmed"));
  await act(async () => f.result.current.checkStatus());
  expect(mocks.slide.mock.calls[3][0].data.requestId).toBe(
    mocks.slide.mock.calls[0][0].data.requestId,
  );
});
it.each(["show", "target", "access", "unmount"])(
  "does not execute a late preparation after %s changes",
  async (change) => {
    let finish!: (value: ProPresenterReply) => void;
    mocks.slide.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const f = setup();
    let work!: Promise<void>;
    act(() => {
      work = f.result.current.run({ kind: "slide", command: "next" });
    });
    await act(async () => {});
    if (change === "unmount") f.unmount();
    else
      f.rerender(
        change === "access"
          ? { ...options, canControlSlides: false }
          : {
              ...options,
              showId: change === "show" ? "other" : options.showId,
              scope: "changed",
            },
      );
    await act(async () => {
      finish(reply(mocks.slide.mock.calls[0][0].data, "prepared"));
      await work;
    });
    expect(mocks.slide).toHaveBeenCalledOnce();
  },
);
it.each(["orgId", "userId"])(
  "isolates retained requests when %s changes",
  async (field) => {
    mocks.slide.mockRejectedValueOnce(new Error("Lost"));
    const f = setup();
    await act(async () =>
      f.result.current.run({ kind: "slide", command: "next" }),
    );
    f.rerender({ ...options, [field]: "other" });
    expect(f.result.current.failure).toBeNull();
    f.rerender(options);
    expect(f.result.current.failure).not.toBeNull();
  },
);
it("preserves a lost kiosk response through navigation without toggling again", async () => {
  mocks.output.mockRejectedValueOnce(new TypeError("Private transport detail"));
  const f = setup();
  await act(async () =>
    f.result.current.run({ kind: "output", enabled: true }),
  );
  expect(f.result.current.failure?.message).toContain(
    "Kiosk output change was not confirmed",
  );
  expect(f.result.current.failure?.message).not.toContain("Private transport");
  f.unmount();
  const g = setup(f.client);
  expect(g.result.current.blocked).toBe(true);
  act(() => g.result.current.acknowledgeReview());
  expect(mocks.output).toHaveBeenCalledOnce();
  await act(async () =>
    g.result.current.run({ kind: "output", enabled: false }),
  );
  expect(g.result.current.notice).toBe("Kiosk output change confirmed.");
});
it("does not send when live access is unavailable", async () => {
  const f = setup();
  f.rerender({ ...options, canControlSlides: false, canChangeOutput: false });
  await act(async () => {
    await f.result.current.run({ kind: "slide", command: "next" });
    await f.result.current.run({ kind: "output", enabled: true });
  });
  expect(mocks.slide).not.toHaveBeenCalled();
  expect(mocks.output).not.toHaveBeenCalled();
});
