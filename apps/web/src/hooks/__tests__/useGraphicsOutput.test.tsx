import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useGraphicsOutput } from "../useGraphicsOutput";
const mocks = vi.hoisted(() => ({ read: vi.fn(), show: vi.fn(), hide: vi.fn(), clear: vi.fn(), publish: vi.fn() }));
vi.mock("@/lib/graphics", () => ({ getActiveGraphics: mocks.read, addActiveGraphic: mocks.show, removeActiveGraphic: mocks.hide, clearActiveGraphics: mocks.clear, publishGraphicComposition: mocks.publish }));
const rows = (...ids: string[]) => ids.map(id => ({ id }));
beforeEach(() => { vi.useFakeTimers(); vi.resetAllMocks(); vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible"); mocks.read.mockResolvedValue(rows("old")); mocks.show.mockResolvedValue(["old", "new"]); mocks.hide.mockResolvedValue([]); mocks.clear.mockResolvedValue([]); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });
const tick = async (ms = 0) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

it("aborts an older read when writing and never lets its late reply overwrite the acknowledged output", async () => {
  let oldRead!: (value: { id: string }[]) => void;
  let write!: (value: string[]) => void;
  mocks.read.mockImplementationOnce(() => new Promise(resolve => { oldRead = resolve; })).mockResolvedValue(rows("new"));
  mocks.show.mockImplementationOnce(() => new Promise(resolve => { write = resolve; }));
  const { result } = renderHook(() => useGraphicsOutput("org", ["old"], true));
  await tick();
  act(() => { void result.current.run({ kind: "show", graphicId: "new" }); void result.current.run({ kind: "clear" }); });
  expect(mocks.read.mock.calls[0][0].signal.aborted).toBe(true);
  expect(mocks.show).toHaveBeenCalledOnce(); expect(mocks.clear).not.toHaveBeenCalled();
  expect(result.current.activeIds).toEqual(["old"]); expect(result.current.fresh).toBe(false);
  await act(async () => write(["new"]));
  expect(result.current.activeIds).toEqual(["new"]);
  await act(async () => oldRead(rows("old")));
  expect(result.current.activeIds).toEqual(["new"]); expect(result.current.fresh).toBe(true);
});

it("reconciles a lost write response through reads without repeating the action", async () => {
  const { result } = renderHook(() => useGraphicsOutput("org", ["old"], true));
  await tick();
  mocks.hide.mockRejectedValueOnce(new TypeError("lost response after commit"));
  mocks.read.mockResolvedValue([]);
  await act(async () => { expect(await result.current.run({ kind: "hide", graphicId: "old" })).toBe(false); });
  expect(result.current.failure?.occurredAt).toBe(Date.now());
  expect(result.current.failure?.message).toContain("not confirmed");
  expect(result.current.activeIds).toEqual([]); expect(result.current.fresh).toBe(true);
  await tick(10_000);
  expect(mocks.hide).toHaveBeenCalledOnce(); expect(result.current.failure).not.toBeNull();
});

it("bounds stalled writes and keeps controls unconfirmed until a fresh read arrives", async () => {
  let finishWrite!: (value: string[]) => void;
  let finishRead!: (value: { id: string }[]) => void;
  mocks.show.mockImplementationOnce(() => new Promise(resolve => { finishWrite = resolve; }));
  const { result } = renderHook(() => useGraphicsOutput("org", ["old"], true));
  await tick();
  mocks.read.mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve; }));
  act(() => { void result.current.run({ kind: "show", graphicId: "new" }); });
  await tick(10_000);
  expect(mocks.show.mock.calls[0][0].signal.aborted).toBe(true);
  expect(result.current.pending).toBeNull(); expect(result.current.fresh).toBe(false);
  expect(result.current.activeIds).toEqual(["old"]);
  await act(async () => { expect(await result.current.run({ kind: "hide", graphicId: "old" })).toBe(false); finishWrite(["late"]); });
  expect(result.current.activeIds).toEqual(["old"]);
  await act(async () => finishRead(rows("confirmed")));
  expect(result.current.activeIds).toEqual(["confirmed"]); expect(result.current.fresh).toBe(true);
  expect(mocks.hide).not.toHaveBeenCalled();
});

it("retains failed reads, blocks uncertain per-graphic changes, and keeps explicit Clear available", async () => {
  mocks.read.mockRejectedValueOnce(new Error("offline"));
  const { result } = renderHook(() => useGraphicsOutput("org", ["old"], true));
  await tick();
  expect(result.current.readFailure?.occurredAt).toBe(Date.now());
  expect(result.current.activeIds).toEqual(["old"]); expect(result.current.fresh).toBe(false);
  await act(async () => result.current.run({ kind: "hide", graphicId: "old" }));
  expect(mocks.hide).not.toHaveBeenCalled();
  mocks.clear.mockResolvedValue(["another-operator"]); mocks.read.mockResolvedValue(rows("another-operator"));
  await act(async () => { expect(await result.current.run({ kind: "clear" })).toBe(true); });
  expect(result.current.activeIds, "Clear uses observed server state instead of inventing an empty output").toEqual(["another-operator"]);
  expect(result.current.fresh).toBe(true);
});

it("does not accept a missing output acknowledgement as empty output", async () => {
  const { result } = renderHook(() => useGraphicsOutput("org", ["old"], true));
  await tick(); mocks.clear.mockResolvedValueOnce(undefined);
  await act(async () => result.current.run({ kind: "clear" }));
  expect(result.current.failure?.message).toContain("not confirmed");
  expect(result.current.activeIds).toEqual(["old"]);
});

it("drops old workspace state and ignores its pending mutation", async () => {
  let finish!: (value: string[]) => void;
  mocks.show.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const { result, rerender } = renderHook(({ orgId, ids }) => useGraphicsOutput(orgId, ids, true), { initialProps: { orgId: "old-org", ids: ["old"] } });
  await tick(); act(() => { void result.current.run({ kind: "show", graphicId: "new" }); });
  mocks.read.mockResolvedValue(rows("other"));
  rerender({ orgId: "other-org", ids: ["other"] });
  expect(result.current.activeIds).toEqual(["other"]);
  expect(mocks.show.mock.calls[0][0].signal.aborted).toBe(true);
  await act(async () => finish(["old-org-result"]));
  expect(result.current.activeIds).toEqual(["other"]); expect(result.current.failure).toBeNull();
});

it("permits read recovery but no writes for a viewer", async () => {
  const { result } = renderHook(() => useGraphicsOutput("org", ["old"], false));
  await tick();
  await act(async () => { await result.current.run({ kind: "show", graphicId: "new" }); await result.current.run({ kind: "clear" }); });
  expect(mocks.read).toHaveBeenCalledOnce(); expect(mocks.show).not.toHaveBeenCalled(); expect(mocks.clear).not.toHaveBeenCalled();
});

const publish = { kind: "publish" as const, requestId: "revision", items: [{ key: "one", name: "Name", title: "Name", subtitle: "", style: "{}" }] };
it("reconciles a lost publication response without replaying or inventing that the prior output stayed live", async () => {
  const { result } = renderHook(() => useGraphicsOutput("org", ["old"], true));
  await tick();
  mocks.publish.mockRejectedValueOnce(new Error("lost successful reply"));
  mocks.read.mockResolvedValue(rows("new"));
  await act(async () => { expect(await result.current.run(publish)).toBe(false); });
  expect(result.current.activeIds).toEqual(["new"]);
  expect(result.current.failure?.occurredAt).toBe(Date.now());
  expect(result.current.failure?.message).toContain("not confirmed");
  await tick(10_000); expect(mocks.publish).toHaveBeenCalledOnce();
});
it("reports a superseded publication and retains the actually observed Program", async () => {
  const { result } = renderHook(() => useGraphicsOutput("org", ["old"], true));
  await tick();
  mocks.publish.mockResolvedValueOnce({ revision: "revision", activeIds: ["newer"], publishedIds: ["mine"], isActive: false });
  mocks.read.mockResolvedValue(rows("newer"));
  await act(async () => { expect(await result.current.run(publish)).toBe(false); });
  expect(result.current.activeIds).toEqual(["newer"]); expect(result.current.fresh).toBe(true);
  expect(result.current.failure?.message).toContain("newer Program");
});
it("requires a matching publication acknowledgement", async () => {
  const { result } = renderHook(() => useGraphicsOutput("org", ["old"], true)); await tick();
  mocks.publish.mockResolvedValueOnce({ revision: "wrong", activeIds: ["wrong"], isActive: true });
  await act(async () => { expect(await result.current.run(publish)).toBe(false); });
  expect(result.current.activeIds).toEqual(["old"]); expect(result.current.failure).not.toBeNull();
});
it("bounds a stalled publication and prevents overlapping Clear until it settles", async () => {
  mocks.publish.mockImplementationOnce(() => new Promise(() => {}));
  const { result } = renderHook(() => useGraphicsOutput("org", ["old"], true)); await tick();
  act(() => { void result.current.run(publish); void result.current.run({kind:"clear"}); });
  expect(mocks.clear).not.toHaveBeenCalled();
  await tick(10_000);
  expect(mocks.publish.mock.calls[0][0].signal.aborted).toBe(true);
  expect(result.current.pending).toBeNull(); expect(result.current.failure).not.toBeNull();
  await act(async () => { expect(await result.current.run({kind:"clear"})).toBe(true); });
  expect(mocks.clear).toHaveBeenCalledOnce();
});
