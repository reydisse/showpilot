import { ResumeSetup } from "@/components/onboarding/ResumeSetup";
import {
  WORKSPACE_TYPES,
  WORKSPACE_DEFINITIONS,
  MODULE_IDS,
  CORE_MODULES,
  WORKSPACE_MODULES,
  isWorkspaceType,
} from "@showpilot/shared";
import { useWorkspace } from "./WorkspaceProvider";
import { useWorkspaceWork } from "@/hooks/useWorkspaceWork";
import { WorkspaceChangeNotice } from "./WorkspaceChangeNotice";
export function WorkspaceSettings({
  orgId,
  userId,
  canManage,
  canResumeSetup = false,
}: {
  orgId: string;
  userId: string;
  canManage: boolean;
  canResumeSetup?: boolean;
}) {
  const work = useWorkspaceWork({ orgId, userId }, useWorkspace(), canManage);
  const workspace = work.profile;
  const { type, reset, changing, custom } = work.draft;
  const busy = work.locked;
  const edit = (next: Partial<typeof work.draft>) => work.edit({ ...work.draft, ...next });
  return (
    <section className="space-y-6 text-board-text">
      <header>
        <h1 className="text-2xl font-semibold">Workspace</h1>
        <p className="mt-2 text-sm text-board-muted">
          {workspace.label || WORKSPACE_DEFINITIONS[workspace.type].label} ·
          Names and features for your team.
        </p>
      </header>
      {canResumeSetup && <ResumeSetup orgId={orgId} />}
      {canManage && <WorkspaceChangeNotice work={work} />}
      {canManage && !changing && (
        <button
          disabled={busy}
          className="rounded-lg border border-board-border px-4 py-3"
          onClick={() => {
            edit({ type: workspace.type, reset: false, changing: true });
          }}
        >
          Change type
        </button>
      )}
      {changing && (
        <div className="space-y-4 rounded-xl border border-board-border p-5">
          <label className="block">
            Workspace type
            <select
              className="mt-2 block w-full rounded-lg bg-board-card p-3"
              disabled={busy}
              value={type}
              onChange={(e) => {
                if (isWorkspaceType(e.target.value)) edit({ type: e.target.value });
              }}
            >
              {WORKSPACE_TYPES.map((id) => (
                <option key={id} value={id}>
                  {WORKSPACE_DEFINITIONS[id].label}
                </option>
              ))}
            </select>
          </label>
          <p>Names change. Nothing is deleted.</p>
          <label className="flex min-h-11 items-center gap-3">
            <input
              type="checkbox"
              disabled={busy}
              checked={reset}
              onChange={(e) => edit({ reset: e.target.checked })}
            />
            Also reset features to {WORKSPACE_DEFINITIONS[type].label} defaults
          </label>
          <div className="flex gap-3">
            <button
              disabled={busy}
              className="rounded-lg bg-fire-500 px-4 py-3 text-black"
              onClick={() => work.submit({ kind: "type", type, resetModules: reset })}
            >
              Save type
            </button>
            <button className="min-h-11 px-4" disabled={busy} onClick={() => edit({ changing: false })}>
              Cancel
            </button>
          </div>
        </div>
      )}
      <div>
        <h2 className="font-semibold">Features</h2>
        <p className="mb-3 text-sm text-board-muted">
          Show, Rundown, and Team are always available. Turning a feature off
          hides it without deleting its content.
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          {MODULE_IDS.map((id) => (
            <label
              key={id}
              className="flex min-h-12 items-center gap-3 rounded-lg border border-board-border px-3"
            >
              <input
                type="checkbox"
                disabled={!canManage || busy || CORE_MODULES.includes(id)}
                checked={workspace.modules.includes(id)}
                onChange={(e) => work.submit({ kind: "module", module: id, enabled: e.target.checked })}
              />
              {WORKSPACE_MODULES[id]}
              {CORE_MODULES.includes(id) && (
                <span className="text-xs text-board-muted">Required</span>
              )}
            </label>
          ))}
        </div>
      </div>
      {WORKSPACE_DEFINITIONS[workspace.type].customizable && (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            work.submit({ kind: "custom", custom });
          }}
        >
          <h2 className="font-semibold">Your names</h2>
          {(["label", "event", "events", "item", "items"] as const).map((key) => (
            <label key={key} className="block text-sm">
              {{ label: "Workspace label", event: "Event", events: "Events", item: "Item", items: "Items" }[key]}
              <input
                disabled={busy}
                maxLength={key === "label" ? 80 : 24}
                value={key === "label" ? custom.label : custom.terms[key]}
                onChange={(e) => edit({ custom: key === "label" ? { ...custom, label: e.target.value } : { ...custom, terms: { ...custom.terms, [key]: e.target.value } } })}
                className="mt-1 block min-h-11 w-full rounded-lg border border-board-border bg-board-card p-3"
              />
            </label>
          ))}
          {canManage && (
            <button
              disabled={busy}
              className="rounded-lg bg-fire-500 px-4 py-3 text-black"
            >
              Save names
            </button>
          )}
        </form>
      )}
    </section>
  );
}
