import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import type { WorkspaceProfile } from "@showpilot/shared";
import { WorkspaceEditor, type WorkspaceDraft } from "@showpilot/shared/workspace-editor";
import type { WorkspaceOperation } from "@showpilot/shared/workspace-change";
import { getWorkspaceChange, saveWorkspaceChange, reviewWorkspaceChange } from "@/lib/workspace/change";
const editors = new WeakMap<QueryClient, Map<string, WorkspaceEditor>>();
export function useWorkspaceWork(scope: { orgId: string; userId: string }, profile: WorkspaceProfile, enabled: boolean) {
  const client = useQueryClient(), router = useRouter();
  const { orgId, userId } = scope;
  const editor = useMemo(() => {
    const scope = { orgId, userId };
    let map = editors.get(client);
    if (!map) { map = new Map(); editors.set(client, map); }
    const key = JSON.stringify([scope.userId, scope.orgId]);
    let editor = map.get(key);
    if (!editor) {
      editor = new WorkspaceEditor(scope, profile, {
        uuid: () => crypto.randomUUID(),
        read: signal => getWorkspaceChange({ data: scope, signal }),
        send: (data, mode, signal) => (mode === "save" ? saveWorkspaceChange : reviewWorkspaceChange)({ data, signal }),
        refresh: async (_snapshot, signal) => { signal.throwIfAborted(); await router.invalidate(); signal.throwIfAborted(); },
      });
      map.set(key, editor);
    }
    return editor;
  }, [client, orgId, userId, profile, router]);
  const owner = useMemo(() => ({ active: false }), [editor, enabled]);
  const current = useRef(owner); current.current = owner;
  const active = () => owner.active && current.current === owner;
  const state = useSyncExternalStore(editor.subscribe, editor.getSnapshot, editor.getSnapshot);
  useEffect(() => {
    owner.active = enabled;
    if (enabled) void editor.load();
    return () => { owner.active = false; };
  }, [editor, owner, enabled]);
  return {
    ...state,
    profile: enabled ? state.snapshot?.profile ?? profile : profile,
    locked: !enabled || state.loading || !state.snapshot || !!state.attempt,
    edit: (next: WorkspaceDraft) => { if (active() && editor.getSnapshot().draft === state.draft) editor.edit(next); },
    submit: (operation: WorkspaceOperation) => { if (active() && editor.getSnapshot() === state) editor.submit(operation); },
    load: () => { if (active()) void editor.load(); },
    retry: () => { if (active() && editor.getSnapshot().attempt === state.attempt) editor.retry(); },
    review: () => { if (active() && editor.getSnapshot().attempt === state.attempt) editor.review(); },
    refresh: () => { if (active()) void editor.refresh(); },
    useCurrent: () => { if (active() && editor.getSnapshot().attempt === state.attempt) editor.useCurrent(); },
  };
}
export type WorkspaceWork = ReturnType<typeof useWorkspaceWork>;
