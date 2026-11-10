import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSetupChoices } from "../useSetupChoices";
import { setupChoiceConfirmed, type SetupChoicesSnapshot, type SetupChoiceCommand } from "@/lib/setup-choices-contract";
const api = vi.hoisted(() => ({ get: vi.fn(), workspace: vi.fn(), role: vi.fn() }));
vi.mock("@/lib/setup-choices", () => ({ getSetupChoices: api.get, saveSetupRole: api.role, saveSetupWorkspace: api.workspace }));
const empty: SetupChoicesSnapshot = { settings: {}, workspaceRevision: null, roleValue: null };
function applied(command: SetupChoiceCommand): SetupChoicesSnapshot {
  return command.kind === "workspace" ? { ...empty, settings: { "workspace-type": command.selection.type }, workspaceRevision: JSON.stringify({ requestId: command.requestId, fingerprint: "fixture", nonce: crypto.randomUUID() }) }
    : { ...empty, roleValue: JSON.stringify({ archetype: command.archetype, requestId: command.requestId, nonce: crypto.randomUUID() }) };
}
async function mount() { const f = renderHook(() => useSetupChoices("org")); await act(async () => {}); return f; }
beforeEach(() => { api.get.mockResolvedValue(empty); });
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.useRealTimers(); });
it("waits for confirmation and retries exactly the captured workspace request", async () => {
  api.workspace.mockRejectedValueOnce(new Error("Unavailable")); const f = await mount(); let result: boolean | undefined;
  const selection = { type: "custom" as const, custom: { label: " Tour ", terms: { event: " Gig " } }, modules: ["chat" as const] };
  await act(async () => { result = await f.result.current.workspace(selection); }); expect(result).toBe(false);
  expect(f.result.current.snapshot).toEqual(empty); expect(f.result.current.failure?.message).toContain("not confirmed");
  const command = api.workspace.mock.calls[0][0].data; selection.custom.label = "Changed draft";
  api.workspace.mockResolvedValue(applied(command)); await act(async () => { result = await f.result.current.retry(); });
  expect(result).toBe(true); expect(api.workspace.mock.calls[1][0].data).toEqual(command);
  expect(command.selection.custom.label).toBe("Tour"); expect(f.result.current.snapshot?.settings["workspace-type"]).toBe("custom");
});
it("bounds failed reads and refuses writes without confirmed revisions", async () => {
  vi.useFakeTimers(); api.get.mockImplementationOnce(() => new Promise(() => {})); const f = await mount();
  await act(async () => vi.advanceTimersByTimeAsync(10_000)); expect(f.result.current.busy).toBe(false); expect(f.result.current.failure?.occurredAt).toEqual(expect.any(Number));
  await act(async () => { expect(await f.result.current.role("td")).toBe(false); }); expect(api.role).not.toHaveBeenCalled();
  await act(async () => f.result.current.check()); expect(f.result.current.snapshot).toEqual(empty); expect(f.result.current.failure).toBeNull();
});
it("recovers a lost role acknowledgement with a read and ignores the late reply", async () => {
  vi.useFakeTimers(); let release: (value: SetupChoicesSnapshot) => void = () => {};
  api.role.mockImplementation(() => new Promise<SetupChoicesSnapshot>(yes => { release = yes; })); const f = await mount();
  act(() => { void f.result.current.role("pm"); }); const command = api.role.mock.calls[0][0].data;
  await act(async () => vi.advanceTimersByTimeAsync(10_000)); expect(f.result.current.failure?.message).toContain("may have saved");
  const saved = applied(command); api.get.mockResolvedValue(saved); await act(async () => f.result.current.check());
  expect(setupChoiceConfirmed(f.result.current.snapshot!, command)).toBe(true); expect(api.role).toHaveBeenCalledTimes(1);
  await act(async () => release(empty)); expect(f.result.current.snapshot).toEqual(saved); expect(f.result.current.failure).toBeNull();
});
it("requires review after conflict, then bases an explicit replacement on the new revision", async () => {
  const newer = { ...empty, settings: { "workspace-type": "school" }, workspaceRevision: "newer-settings-revision" };
  api.workspace.mockResolvedValue(newer); const f = await mount();
  await act(async () => { expect(await f.result.current.workspace({ type: "theatre" })).toBe(false); });
  expect(f.result.current.failure?.message).toContain("changed while this request"); expect(f.result.current.snapshot).toEqual(newer);
  const first = api.workspace.mock.calls[0][0].data;
  api.workspace.mockImplementation(({ data }: { data: SetupChoiceCommand }) => Promise.resolve(applied(data)));
  await act(async () => { expect(await f.result.current.workspace({ type: "theatre" })).toBe(true); });
  expect(api.workspace.mock.calls[1][0].data.expectedRevision).toBe(newer.workspaceRevision);
  expect(api.workspace.mock.calls[1][0].data.requestId).not.toBe(first.requestId);
});
it("suppresses duplicate clicks and aborts with no pending timer on unmount", async () => {
  vi.useFakeTimers(); api.role.mockImplementation(() => new Promise(() => {})); const f = await mount();
  act(() => { void f.result.current.role("td"); void f.result.current.role("sm"); }); expect(api.role).toHaveBeenCalledTimes(1);
  f.unmount(); expect(api.role.mock.calls[0][0].signal.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
});
it("does not expose or apply an earlier organization's result after switching scope", async () => {
  let release: (value: SetupChoicesSnapshot) => void = () => {};
  api.workspace.mockImplementation(() => new Promise<SetupChoicesSnapshot>(yes => { release = yes; }));
  const f = renderHook(({ orgId }) => useSetupChoices(orgId), { initialProps: { orgId: "first" } }); await act(async () => {});
  act(() => { void f.result.current.workspace({ type: "school" }); }); const command = api.workspace.mock.calls[0][0].data;
  f.rerender({ orgId: "second" }); await act(async () => {}); await act(async () => release(applied(command)));
  expect(f.result.current.snapshot).toEqual(empty); expect(f.result.current.pending).toBeNull(); expect(api.workspace.mock.calls[0][0].signal.aborted).toBe(true);
});
it("validates custom names without discarding or sending the invalid draft", async () => {
  const f = await mount(); await act(async () => { expect(await f.result.current.workspace({ type: "custom", custom: { label: "<bad>", terms: {} } })).toBe(false); });
  expect(api.workspace).not.toHaveBeenCalled(); expect(f.result.current.failure?.message).toBe("Use plain text");
});
it("rejects missing, malformed and unchanged write acknowledgements", async () => {
  const f = await mount(); for (const reply of [null, {}, empty]) {
    api.role.mockResolvedValue(reply); await act(async () => { expect(await f.result.current.role("td")).toBe(false); });
    expect(f.result.current.failure?.message).toContain("not confirmed");
  }
});
