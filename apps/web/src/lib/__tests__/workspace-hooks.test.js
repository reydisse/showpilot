import * as React from "react";
import * as queries from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import * as editor from "@showpilot/shared/workspace-editor";
import { resolveWorkspaceProfile } from "@showpilot/shared";
import { useWorkspaceWork as useWeb } from "@/hooks/useWorkspaceWork";
const api = vi.hoisted(() => ({ read: vi.fn(), save: vi.fn(), review: vi.fn(), router: { invalidate: vi.fn(async () => {}) } }));
vi.mock("@/lib/workspace/change", () => ({ getWorkspaceChange: api.read, saveWorkspaceChange: api.save, reviewWorkspaceChange: api.review }));
vi.mock("@tanstack/react-router", () => ({ useRouter: () => api.router }));
const code = ts.transpileModule(readFileSync(resolve(process.cwd(), "../mobile/src/hooks/use-workspace-work.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const modules = {
  react: React, "@tanstack/react-query": queries, "@showpilot/shared/workspace-editor": editor,
  "@/lib/request-id": { createLocalRequestUuid: () => crypto.randomUUID() },
  "@/lib/mobile-api": { getMobileWorkspaceChange: (data, signal) => api.read({ data, signal }), sendMobileWorkspaceChange: (data, mode, signal) => (mode === "save" ? api.save : api.review)({ data, signal }) },
}, exported = {};
new Function("require", "exports", code)(name => { if (!(name in modules)) throw new Error(`Unmocked native import ${name}`); return modules[name]; }, exported);
const profile = resolveWorkspaceProfile({ "workspace-type": "custom" });
const scope = { orgId: "org", userId: "user", enabled: true };
const operation = { kind: "module", module: "chat", enabled: false };
beforeEach(() => {
  api.read.mockImplementation(async ({ data }) => ({ orgId: data.orgId, userId: data.userId, profile, revision: null }));
  api.save.mockImplementation(async ({ data }) => ({ orgId: data.orgId, userId: data.userId, requestId: data.requestId, outcome: "applied", snapshot: { orgId: data.orgId, userId: data.userId, profile, revision: "saved" } }));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });
describe.each([["web", useWeb], ["native", exported.useWorkspaceWork]])("%s workspace ownership", (_name, hook) => {
  async function fixture() {
    const client = new queries.QueryClient();
    const wrapper = ({ children }) => React.createElement(queries.QueryClientProvider, { client }, children);
    const mount = () => renderHook(value => hook({ orgId: value.orgId, userId: value.userId }, profile, value.enabled), { wrapper, initialProps: scope });
    const view = mount(); await waitFor(() => expect(view.result.current.locked).toBe(false));
    return { ...view, mount, client };
  }
  it.each(["orgId", "userId", "enabled"])("ignores old callbacks after %s changes", async field => {
    const f = await fixture(), old = f.result.current;
    f.rerender({ ...scope, [field]: field === "enabled" ? false : "other" });
    await act(async () => { old.edit({ ...old.draft, custom: { ...old.draft.custom, label: "Wrong scope" } }); old.submit(operation); });
    expect(api.save).not.toHaveBeenCalled();
    f.rerender(scope); expect(f.result.current.draft.custom.label).toBe("");
  });
  it("retains names after navigation and ignores callbacks from an unmounted view", async () => {
    const f = await fixture();
    act(() => f.result.current.edit({ ...f.result.current.draft, custom: { ...f.result.current.draft.custom, label: "Keep this" } }));
    const old = f.result.current; f.unmount();
    await act(async () => old.submit(operation)); expect(api.save).not.toHaveBeenCalled();
    const next = f.mount(); await waitFor(() => expect(next.result.current.locked).toBe(false));
    expect(next.result.current.draft.custom.label).toBe("Keep this");
  });
  it("refuses a stale submit after newer typing", async () => {
    const f = await fixture(), old = f.result.current;
    act(() => f.result.current.edit({ ...old.draft, custom: { ...old.draft.custom, label: "Newer" } }));
    await act(async () => old.submit(operation)); expect(api.save).not.toHaveBeenCalled();
  });
  it("retains an unknown save after unmount and retries its original ID", async () => {
    const f = await fixture(); api.save.mockRejectedValueOnce(new Error("Lost reply"));
    act(() => f.result.current.submit(operation));
    await waitFor(() => expect(f.result.current.attempt?.kind).toBe("unknown"));
    const command = f.result.current.attempt.command; f.unmount(); const next = f.mount();
    expect(next.result.current.attempt.command).toEqual(command);
    act(() => next.result.current.retry());
    await waitFor(() => expect(next.result.current.attempt).toBeNull());
    expect(api.save.mock.calls[1][0].data).toEqual(command);
  });
});
