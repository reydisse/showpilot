import { useState, useEffect } from "react";
import { useRouter } from "@tanstack/react-router";
import {
  WORKSPACE_TYPES,
  WORKSPACE_DEFINITIONS,
  MODULE_IDS,
  CORE_MODULES,
  WORKSPACE_MODULES,
  isWorkspaceType,
  type WorkspaceType,
} from "@showpilot/shared";
import { useWorkspace } from "./WorkspaceProvider";
import {
  setWorkspaceType,
  setWorkspaceModules,
  setWorkspaceCustom,
} from "@/lib/workspace/profile";
export function WorkspaceSettings({
  orgId,
  canManage,
}: {
  orgId: string;
  canManage: boolean;
}) {
  const workspace = useWorkspace();
  const router = useRouter();
  const [type, setType] = useState<WorkspaceType>(workspace.type);
  const [reset, setReset] = useState(false);
  const [changing, setChanging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [label, setLabel] = useState(workspace.label ?? "");
  const [event, setEvent] = useState(workspace.terms.eventTitle);
  const [events, setEvents] = useState(workspace.terms.eventPlural);
  const [item, setItem] = useState(workspace.terms.item);
  const [items, setItems] = useState(workspace.terms.itemPlural);
  useEffect(() => {
    setLabel(workspace.label ?? "");
    setEvent(workspace.terms.eventTitle);
    setEvents(workspace.terms.eventPlural);
    setItem(workspace.terms.item);
    setItems(workspace.terms.itemPlural);
  }, [
    workspace.label,
    workspace.type,
    workspace.terms.eventTitle,
    workspace.terms.eventPlural,
    workspace.terms.item,
    workspace.terms.itemPlural,
  ]);
  async function save(work: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await work();
      await router.invalidate();
      setChanging(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save workspace");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="space-y-6 text-board-text">
      <header>
        <h1 className="text-2xl font-semibold">Workspace</h1>
        <p className="mt-2 text-sm text-board-muted">
          {workspace.label || WORKSPACE_DEFINITIONS[workspace.type].label} ·
          Names and features for your team.
        </p>
      </header>
      {error && (
        <p role="alert" className="text-red-400">
          {error}
        </p>
      )}
      {canManage && !changing && (
        <button
          className="rounded-lg border border-board-border px-4 py-3"
          onClick={() => {
            setType(workspace.type);
            setReset(false);
            setChanging(true);
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
              className="ml-3 rounded-lg bg-board-card p-3"
              value={type}
              onChange={(e) => {
                if (isWorkspaceType(e.target.value)) setType(e.target.value);
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
          <label className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={reset}
              onChange={(e) => setReset(e.target.checked)}
            />
            Also reset features to {WORKSPACE_DEFINITIONS[type].label} defaults
          </label>
          <div className="flex gap-3">
            <button
              disabled={busy}
              className="rounded-lg bg-fire-500 px-4 py-3 text-black"
              onClick={() =>
                void save(() =>
                  setWorkspaceType({
                    data: { orgId, type, resetModules: reset },
                  }),
                )
              }
            >
              Save type
            </button>
            <button disabled={busy} onClick={() => setChanging(false)}>
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
                onChange={(e) =>
                  void save(() =>
                    setWorkspaceModules({
                      data: {
                        orgId,
                        modules: e.target.checked
                          ? [...workspace.modules, id]
                          : workspace.modules.filter((value) => value !== id),
                      },
                    }),
                  )
                }
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
            void save(() =>
              setWorkspaceCustom({
                data: { orgId, label, terms: { event, events, item, items } },
              }),
            );
          }}
        >
          <h2 className="font-semibold">Your names</h2>
          {[
            { name: "Workspace label", value: label, set: setLabel, max: 80 },
            { name: "Event", value: event, set: setEvent, max: 24 },
            { name: "Events", value: events, set: setEvents, max: 24 },
            { name: "Item", value: item, set: setItem, max: 24 },
            { name: "Items", value: items, set: setItems, max: 24 },
          ].map((field) => (
            <label key={field.name} className="block text-sm">
              {field.name}
              <input
                disabled={!canManage || busy}
                maxLength={field.max}
                value={field.value}
                onChange={(e) => field.set(e.target.value)}
                className="mt-1 block w-full rounded-lg border border-board-border bg-board-card p-3"
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
