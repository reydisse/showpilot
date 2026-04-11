import { useState } from "react";
import {
  Play,
  Square,
  ToggleLeft,
  ToggleRight,
  Volume2,
  Sliders,
} from "lucide-react";
import type {
  DeviceModule,
  DeviceConnectionStatus,
  ModuleDefinition,
  ModuleAction,
} from "@/lib/device-modules/types";

interface GenericControlPanelProps {
  module: DeviceModule | null;
  status: DeviceConnectionStatus;
  feedbacks: Map<string, unknown>;
  definition: ModuleDefinition;
}

export function GenericControlPanel({
  module,
  status,
  feedbacks,
  definition,
}: GenericControlPanelProps) {
  const actions = module?.getActions() ?? definition.createInstance({}).getActions();
  const isConnected = status === "connected";

  // Group actions by category
  const grouped = new Map<string, ModuleAction[]>();
  for (const action of actions) {
    const cat = action.category ?? "general";
    const list = grouped.get(cat) ?? [];
    list.push(action);
    grouped.set(cat, list);
  }

  // Feedback values
  const feedbackList = module?.getFeedbacks() ?? definition.createInstance({}).getFeedbacks();

  return (
    <div className="space-y-6">
      {/* Feedbacks */}
      {feedbackList.length > 0 && (
        <div className="rounded-xl border border-board-border bg-board-card p-4">
          <h3 className="text-xs font-medium text-board-muted uppercase tracking-wider mb-3">
            Status
          </h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {feedbackList.map((fb) => {
              const liveValue = feedbacks.get(fb.id) ?? fb.value;
              return (
                <div
                  key={fb.id}
                  className="rounded-lg border border-board-border bg-board-bg p-3"
                >
                  <p className="text-[10px] text-board-muted uppercase tracking-wider mb-1">
                    {fb.label}
                  </p>
                  <p className="text-sm font-medium text-board-text truncate">
                    {fb.type === "boolean" ? (
                      <span
                        className={
                          liveValue
                            ? "text-green-400"
                            : "text-board-muted/50"
                        }
                      >
                        {liveValue ? "ON" : "OFF"}
                      </span>
                    ) : (
                      String(liveValue || "—")
                    )}
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Actions by category */}
      {[...grouped.entries()].map(([category, categoryActions]) => (
        <div
          key={category}
          className="rounded-xl border border-board-border bg-board-card p-4"
        >
          <h3 className="text-xs font-medium text-board-muted uppercase tracking-wider mb-3">
            {category}
          </h3>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
            {categoryActions.map((action) => (
              <ActionButton
                key={action.id}
                action={action}
                module={module}
                disabled={!isConnected}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function ActionButton({
  action,
  module,
  disabled,
}: {
  action: ModuleAction;
  module: DeviceModule | null;
  disabled: boolean;
}) {
  const [executing, setExecuting] = useState(false);
  const [paramValues, setParamValues] = useState<Record<string, unknown>>({});

  const hasParams = action.params.length > 0;
  const [expanded, setExpanded] = useState(false);

  async function execute() {
    if (!module || disabled) return;
    setExecuting(true);
    try {
      await module.executeAction(action.id, paramValues);
    } catch (err) {
      console.error(`Action ${action.id} failed:`, err);
    } finally {
      setExecuting(false);
    }
  }

  // Simple action (no params) — single button
  if (!hasParams) {
    return (
      <button
        onClick={execute}
        disabled={disabled || executing}
        className="rounded-lg border border-board-border bg-board-bg px-3 py-2.5 text-left text-sm font-medium text-board-text hover:border-fire-500/30 hover:bg-fire-500/5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed active:scale-[0.98]"
      >
        {executing ? "..." : action.label}
      </button>
    );
  }

  // Parameterized action — expandable
  return (
    <div className="col-span-2 rounded-lg border border-board-border bg-board-bg p-3">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full text-left text-sm font-medium text-board-text flex items-center justify-between"
      >
        {action.label}
        <Sliders className="w-3 h-3 text-board-muted" />
      </button>
      {expanded && (
        <div className="mt-3 space-y-2">
          {action.params.map((p) => (
            <div key={p.id}>
              <label className="text-[10px] text-board-muted uppercase tracking-wider">
                {p.label}
              </label>
              {p.type === "number" ? (
                <input
                  type="range"
                  min={p.min ?? 0}
                  max={p.max ?? 1}
                  step={p.step ?? 0.01}
                  value={Number(paramValues[p.id] ?? p.default ?? p.min ?? 0)}
                  onChange={(e) =>
                    setParamValues((prev) => ({
                      ...prev,
                      [p.id]: parseFloat(e.target.value),
                    }))
                  }
                  className="w-full mt-1 accent-fire-500"
                />
              ) : p.type === "boolean" ? (
                <button
                  onClick={() =>
                    setParamValues((prev) => ({
                      ...prev,
                      [p.id]: !prev[p.id],
                    }))
                  }
                  className="mt-1 text-board-muted"
                >
                  {paramValues[p.id] ? (
                    <ToggleRight className="w-6 h-6 text-fire-500" />
                  ) : (
                    <ToggleLeft className="w-6 h-6" />
                  )}
                </button>
              ) : p.type === "select" ? (
                <select
                  value={String(paramValues[p.id] ?? "")}
                  onChange={(e) =>
                    setParamValues((prev) => ({
                      ...prev,
                      [p.id]: e.target.value,
                    }))
                  }
                  className="w-full mt-1 rounded-lg border border-board-border bg-board-card px-2 py-1.5 text-sm text-board-text"
                >
                  <option value="">Select...</option>
                  {p.options?.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  value={String(paramValues[p.id] ?? "")}
                  onChange={(e) =>
                    setParamValues((prev) => ({
                      ...prev,
                      [p.id]: e.target.value,
                    }))
                  }
                  className="w-full mt-1 rounded-lg border border-board-border bg-board-card px-2 py-1.5 text-sm text-board-text outline-none focus:border-fire-500/50"
                />
              )}
            </div>
          ))}
          <button
            onClick={execute}
            disabled={disabled || executing}
            className="w-full rounded-lg bg-fire-500/10 border border-fire-500/20 px-3 py-1.5 text-xs font-medium text-fire-500 hover:bg-fire-500/20 transition-colors disabled:opacity-40"
          >
            {executing ? "Executing..." : "Execute"}
          </button>
        </div>
      )}
    </div>
  );
}
