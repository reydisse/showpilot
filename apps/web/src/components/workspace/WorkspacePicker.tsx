import { useState } from "react";
import {
  Church,
  RadioTower,
  GraduationCap,
  Drama,
  SlidersHorizontal,
} from "lucide-react";
import {
  WORKSPACE_TYPES,
  WORKSPACE_DEFINITIONS,
  MODULE_IDS,
  WORKSPACE_MODULES,
  CORE_MODULES,
  type WorkspaceType,
  type ModuleId,
  type WorkspaceCustom,
} from "@showpilot/shared";
const icons = { Church, RadioTower, GraduationCap, Drama, SlidersHorizontal };
export function WorkspacePicker({
  onSelect,
  busy = false,
}: {
  onSelect: (
    type: WorkspaceType,
    custom?: WorkspaceCustom,
    modules?: ModuleId[],
  ) => void;
  busy?: boolean;
}) {
  const [customType, setCustomType] = useState<WorkspaceType | null>(null);
  const [label, setLabel] = useState("");
  const [event, setEvent] = useState("");
  const [item, setItem] = useState("");
  const [modules, setModules] = useState<ModuleId[]>([...MODULE_IDS]);
  return (
    <div className="space-y-5">
      <h1 className="text-3xl font-bold">What are you running?</h1>
      <div className="grid gap-3 sm:grid-cols-2">
        {WORKSPACE_TYPES.map((type) => {
          const definition = WORKSPACE_DEFINITIONS[type];
          const Icon =
            Object.entries(icons).find(
              ([name]) => name === definition.icon,
            )?.[1] ?? SlidersHorizontal;
          return (
            <button
              type="button"
              key={type}
              disabled={busy}
              onClick={() =>
                definition.customizable ? setCustomType(type) : onSelect(type)
              }
              className="min-h-24 rounded-xl border border-white/15 bg-white/[0.03] p-5 text-left transition-colors hover:border-amber-400/50 focus-visible:outline-amber-400 disabled:opacity-50"
            >
              <Icon className="mb-3 size-5 text-amber-400" />
              <span className="block font-semibold">{definition.label}</span>
              <span className="mt-1 block text-sm opacity-60">
                {definition.description}
              </span>
            </button>
          );
        })}
      </div>
      {customType && (
        <form
          className="space-y-4 rounded-xl border border-white/15 p-5"
          onSubmit={(e) => {
            e.preventDefault();
            onSelect(
              customType,
              {
                label,
                terms: {
                  ...(event.trim() ? { event } : {}),
                  ...(item.trim() ? { item } : {}),
                },
              },
              modules,
            );
          }}
        >
          <label className="block text-sm">
            What do you call your productions?
            <input
              className="mt-2 block w-full rounded-lg border border-white/20 bg-transparent p-3"
              maxLength={80}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Northside Productions"
            />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label>
              Event noun
              <input
                className="mt-2 block w-full rounded-lg border border-white/20 bg-transparent p-3"
                maxLength={24}
                value={event}
                onChange={(e) => setEvent(e.target.value)}
                placeholder="Show"
              />
            </label>
            <label>
              Item noun
              <input
                className="mt-2 block w-full rounded-lg border border-white/20 bg-transparent p-3"
                maxLength={24}
                value={item}
                onChange={(e) => setItem(e.target.value)}
                placeholder="Segment"
              />
            </label>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {MODULE_IDS.map((id) => (
              <label key={id} className="flex min-h-11 items-center gap-3">
                <input
                  type="checkbox"
                  checked={modules.includes(id)}
                  disabled={CORE_MODULES.includes(id)}
                  onChange={(e) =>
                    setModules((current) =>
                      e.target.checked
                        ? [...current, id]
                        : current.filter((value) => value !== id),
                    )
                  }
                />
                {WORKSPACE_MODULES[id]}
                {CORE_MODULES.includes(id) && (
                  <span className="text-xs opacity-50">Required</span>
                )}
              </label>
            ))}
          </div>
          <button
            disabled={busy}
            className="min-h-11 rounded-lg bg-amber-400 px-5 py-3 font-semibold text-black"
          >
            Continue
          </button>
        </form>
      )}
      <button
        type="button"
        disabled={busy}
        className="min-h-11 text-sm opacity-60 hover:opacity-100"
        onClick={() =>
          onSelect("custom", { label: "", terms: {} }, [...MODULE_IDS])
        }
      >
        Set up later
      </button>
      <p className="text-sm opacity-60">
        You can change this anytime in Settings.
      </p>
    </div>
  );
}
