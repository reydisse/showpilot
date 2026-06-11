import { createFileRoute, useRouter } from "@tanstack/react-router";
import { PageSkeleton } from "@/components/ui/Skeleton";
import { useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  RotateCcw,
  Sliders,
  Play,
  Square,
  Save,
  Plus,
  X,
  Layers,
} from "lucide-react";
import {
  addGraphicTemplate,
  updateGraphicTemplate,
  setActiveGraphics,
  clearActiveGraphics,
  getActiveGraphics,
} from "@/lib/graphics";
import { hasPermission } from "@/lib/app-permissions";
import {
  type Controls,
  DEFAULT_CONTROLS,
  ACCENT_PRESETS,
  POSITION_PRESETS,
  PRIMARY_SIZE_RANGE,
  SECONDARY_SIZE_RANGE,
  TEMPLATES,
  LtStage,
  getTemplate,
} from "@/lib/lt-templates";

export const Route = createFileRoute("/$slug/streaming/lt-preview")({
  pendingComponent: () => <PageSkeleton />,
  loader: async ({ context }) => {
    const { withPermission } = await import("@/lib/route-permissions");
    await withPermission(context.role, "lowerthird:view", context.slug, context.orgId);
    const active = await getActiveGraphics({ data: { orgId: context.orgId } });
    return { orgId: context.orgId, activeIds: active.map((g) => g.id), role: context.role };
  },
  component: TemplatePreviewPage,
});

// ─── Sample Data ─────────────────────────────────────────────

const SAMPLES = {
  person: { primary: "Pastor James Mensah", secondary: "Lead Pastor" },
  person2: { primary: "Akua Boateng", secondary: "Worship Leader" },
  scripture: {
    primary:
      "For I know the plans I have for you, declares the Lord, plans to prosper you and not to harm you, plans to give you hope and a future.",
    secondary: "Jeremiah 29:11 — NIV",
  },
  announcement: {
    primary: "Youth Conference 2026",
    secondary: "Register at the Welcome Desk",
  },
  song: { primary: "Way Maker", secondary: "Sinach" },
};

// ─── Scene composition ───────────────────────────────────────
// A "scene" is a set of lower thirds composed together and pushed at once,
// so you can place two panelists side by side before going live.

interface SceneItem {
  key: string;
  templateId: string;
  primary: string;
  secondary: string;
  controls: Controls;
}

// Corners to drop successive LTs into so they don't stack on top of each other.
const CORNERS = [
  { x: 5, y: 82 },
  { x: 95, y: 82 },
  { x: 5, y: 8 },
  { x: 95, y: 8 },
];

const uid = () => Math.random().toString(36).slice(2, 9);

function posLabel(c: Controls) {
  const m = POSITION_PRESETS.find(
    (p) => Math.abs(p.x - c.posX) < 6 && Math.abs(p.y - c.posY) < 8
  );
  return m?.label ?? `${Math.round(c.posX)},${Math.round(c.posY)}`;
}

// ─── Control Panel Component ─────────────────────────────────

function ControlPanel({
  controls,
  onChange,
  onReset,
}: {
  controls: Controls;
  onChange: (c: Controls) => void;
  onReset: () => void;
}) {
  const update = (patch: Partial<Controls>) => onChange({ ...controls, ...patch });

  return (
    <div className="space-y-5">
      {/* Accent Color */}
      <div>
        <label className="block text-[10px] font-semibold uppercase tracking-widest text-board-muted mb-2">
          Accent Color
        </label>
        <div className="flex flex-wrap gap-2">
          {ACCENT_PRESETS.map((p) => (
            <button
              key={p.value}
              onClick={() => update({ accentColor: p.value })}
              className="group relative"
              title={p.label}
            >
              <div
                className="w-7 h-7 rounded-full border-2 transition-all"
                style={{
                  background: p.value,
                  borderColor: controls.accentColor === p.value ? "white" : "transparent",
                  boxShadow: controls.accentColor === p.value ? `0 0 12px ${p.value}60` : "none",
                }}
              />
            </button>
          ))}
          <label className="relative w-7 h-7 rounded-full border-2 border-dashed border-board-muted/30 cursor-pointer overflow-hidden hover:border-board-muted/60 transition-colors">
            <input
              type="color"
              value={controls.accentColor}
              onChange={(e) => update({ accentColor: e.target.value })}
              className="absolute inset-0 opacity-0 cursor-pointer"
            />
            <span className="absolute inset-0 flex items-center justify-center text-board-muted text-[10px]">+</span>
          </label>
        </div>
      </div>

      {/* Background Opacity */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-[10px] font-semibold uppercase tracking-widest text-board-muted">
            Background Opacity
          </label>
          <span className="text-[10px] text-board-muted font-mono">{controls.bgOpacity}%</span>
        </div>
        <input
          type="range" min={30} max={100} value={controls.bgOpacity}
          onChange={(e) => update({ bgOpacity: Number(e.target.value) })}
          className="w-full h-1.5 rounded-full appearance-none bg-board-border [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:cursor-pointer"
        />
      </div>

      {/* Primary Text Size */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-[10px] font-semibold uppercase tracking-widest text-board-muted">
            Primary Text
          </label>
          <span className="text-[10px] text-board-muted font-mono">{controls.primarySize}px</span>
        </div>
        <input
          type="range" min={PRIMARY_SIZE_RANGE.min} max={PRIMARY_SIZE_RANGE.max} value={controls.primarySize}
          onChange={(e) => update({ primarySize: Number(e.target.value) })}
          className="w-full h-1.5 rounded-full appearance-none bg-board-border [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:cursor-pointer"
        />
      </div>

      {/* Secondary Text Size */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-[10px] font-semibold uppercase tracking-widest text-board-muted">
            Secondary Text
          </label>
          <span className="text-[10px] text-board-muted font-mono">{controls.secondarySize}px</span>
        </div>
        <input
          type="range" min={SECONDARY_SIZE_RANGE.min} max={SECONDARY_SIZE_RANGE.max} value={controls.secondarySize}
          onChange={(e) => update({ secondarySize: Number(e.target.value) })}
          className="w-full h-1.5 rounded-full appearance-none bg-board-border [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:cursor-pointer"
        />
      </div>

      {/* Position — 3x3 Grid + Coordinates */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-[10px] font-semibold uppercase tracking-widest text-board-muted">
            Position
          </label>
          <span className="text-[10px] text-board-muted font-mono">
            {Math.round(controls.posX)},{Math.round(controls.posY)}
          </span>
        </div>

        {/* 3x3 visual grid */}
        <div className="grid grid-cols-3 gap-1 p-2 rounded-lg bg-board-bg border border-board-border mb-2.5">
          {POSITION_PRESETS.map((preset) => {
            const isActive = Math.abs(controls.posX - preset.x) < 5 && Math.abs(controls.posY - preset.y) < 6;
            return (
              <button
                key={preset.label}
                onClick={() => update({ posX: preset.x, posY: preset.y })}
                className={`aspect-video rounded transition-all flex items-center justify-center ${
                  isActive
                    ? "bg-fire-500/25 border border-fire-500/40"
                    : "bg-board-border/30 border border-transparent hover:bg-board-border/60"
                }`}
              >
                <div className={`w-1.5 h-1.5 rounded-full ${isActive ? "bg-fire-500" : "bg-board-muted/40"}`} />
              </button>
            );
          })}
        </div>

        {/* Fine-tune sliders */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-[9px] text-board-muted w-4 shrink-0">X</span>
            <input
              type="range" min={0} max={100} value={controls.posX}
              onChange={(e) => update({ posX: Number(e.target.value) })}
              className="flex-1 h-1 rounded-full appearance-none bg-board-border [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:cursor-pointer"
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[9px] text-board-muted w-4 shrink-0">Y</span>
            <input
              type="range" min={0} max={100} value={controls.posY}
              onChange={(e) => update({ posY: Number(e.target.value) })}
              className="flex-1 h-1 rounded-full appearance-none bg-board-border [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:cursor-pointer"
            />
          </div>
        </div>

        <p className="text-[9px] text-board-muted/50 mt-1.5">
          Use the grid or coordinate fields to set position.
        </p>
      </div>

      {/* Animation Speed */}
      <div>
        <label className="block text-[10px] font-semibold uppercase tracking-widest text-board-muted mb-2">
          Animation Speed
        </label>
        <div className="grid grid-cols-3 gap-1.5">
          {(["fast", "normal", "slow"] as const).map((s) => (
            <button
              key={s}
              onClick={() => update({ animSpeed: s })}
              className={`px-2 py-1.5 rounded-lg text-[10px] font-medium capitalize transition-colors ${
                controls.animSpeed === s
                  ? "bg-fire-500/15 text-fire-500 border border-fire-500/25"
                  : "text-board-muted border border-board-border hover:border-board-muted/50"
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {/* Reset */}
      <button
        onClick={onReset}
        className="flex items-center gap-1.5 text-[10px] font-medium text-board-muted hover:text-board-text transition-colors"
      >
        <RotateCcw className="w-3 h-3" />
        Reset to defaults
      </button>
    </div>
  );
}

// ─── Preview Page ────────────────────────────────────────────

function TemplatePreviewPage() {
  const { orgId, activeIds: initialActiveIds, role } = Route.useLoaderData();
  const router = useRouter();
  const canConfigureGraphics = hasPermission(role, "lowerthird:configure");
  const canTriggerGraphics = hasPermission(role, "lowerthird:trigger");
  const [currentIndex, setCurrentIndex] = useState(0);
  const [visible, setVisible] = useState(true);
  const [sampleKey, setSampleKey] = useState<keyof typeof SAMPLES | "custom">("person");
  const [controls, setControls] = useState<Controls>(DEFAULT_CONTROLS);
  const [showControls, setShowControls] = useState(true);
  const [customPrimary, setCustomPrimary] = useState("");
  const [customSecondary, setCustomSecondary] = useState("");
  const [activeIds, setActiveIds] = useState<string[]>(initialActiveIds);
  // The current scene — additional LTs composed alongside the one being edited.
  const [scene, setScene] = useState<SceneItem[]>([]);
  // Reusable scratch records (one per scene item + the draft) so re-pushing
  // updates in place instead of littering the library.
  const [scratchId, setScratchId] = useState<string | null>(null);
  const sceneRecordsRef = useRef<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [savedMsg, setSavedMsg] = useState("");

  const template = TEMPLATES[currentIndex];

  const next = () => {
    setVisible(false);
    setTimeout(() => {
      setCurrentIndex((i) => (i + 1) % TEMPLATES.length);
      setVisible(true);
    }, 400);
  };

  const prev = () => {
    setVisible(false);
    setTimeout(() => {
      setCurrentIndex((i) => (i - 1 + TEMPLATES.length) % TEMPLATES.length);
      setVisible(true);
    }, 400);
  };

  const toggle = () => {
    setVisible((v) => !v);
  };

  const getCurrentText = () => {
    if (sampleKey === "custom") {
      return { primary: customPrimary || "Preview Text", secondary: customSecondary };
    }
    return SAMPLES[sampleKey];
  };

  const handleSave = async () => {
    if (!canConfigureGraphics) return;
    const text = getCurrentText();
    if (!text.primary.trim()) return;
    setSaving(true);
    await addGraphicTemplate({
      data: {
        orgId,
        name: text.primary.trim(),
        title: text.primary.trim(),
        subtitle: text.secondary?.trim() ?? "",
        style: JSON.stringify({
          type: "lower-third",
          templateId: template.id,
          controls,
        }),
      },
    });
    setSaving(false);
    setSavedMsg("Saved to library");
    setTimeout(() => setSavedMsg(""), 2000);
    router.invalidate();
  };

  // Does the in-progress draft carry real text (vs. an empty custom field)?
  const draftHasText =
    sampleKey === "custom" ? customPrimary.trim().length > 0 : true;

  // Add the current design to the scene, then nudge the draft to a free corner.
  const addToScene = () => {
    if (!draftHasText) return;
    const text = getCurrentText();
    setScene((prev) => [
      ...prev,
      {
        key: uid(),
        templateId: template.id,
        primary: text.primary.trim(),
        secondary: text.secondary?.trim() ?? "",
        controls,
      },
    ]);
    const corner = CORNERS[(scene.length + 1) % CORNERS.length];
    setControls((c) => ({ ...c, posX: corner.x, posY: corner.y }));
    if (sampleKey === "custom") {
      setCustomPrimary("");
      setCustomSecondary("");
    }
  };

  const removeFromScene = (key: string) => {
    setScene((prev) => prev.filter((s) => s.key !== key));
  };

  // Pull a scene item back into the editor to tweak it.
  const editSceneItem = (item: SceneItem) => {
    const idx = TEMPLATES.findIndex((t) => t.id === item.templateId);
    if (idx >= 0) setCurrentIndex(idx);
    setControls(item.controls);
    setSampleKey("custom");
    setCustomPrimary(item.primary);
    setCustomSecondary(item.secondary);
    setVisible(true);
    setScene((prev) => prev.filter((s) => s.key !== item.key));
  };

  // Everything currently shown in the preview: scene items + the draft.
  const composed = (): SceneItem[] => {
    const items = [...scene];
    if (draftHasText) {
      const text = getCurrentText();
      items.push({
        key: "__draft__",
        templateId: template.id,
        primary: text.primary.trim(),
        secondary: text.secondary?.trim() ?? "",
        controls,
      });
    }
    return items;
  };

  // Push the whole composition live at once — the output matches the preview.
  const handlePushLive = async () => {
    if (!canTriggerGraphics) return;
    const items = composed();
    if (items.length === 0) return;
    setPushing(true);

    const ids: string[] = [];
    for (const item of items) {
      const style = JSON.stringify({
        type: "lower-third",
        templateId: item.templateId,
        controls: item.controls,
        scratch: true, // hidden from the library — these are live-preview records
      });
      const fields = { name: item.primary, title: item.primary, subtitle: item.secondary };
      const mapped =
        item.key === "__draft__" ? scratchId : sceneRecordsRef.current[item.key];
      if (mapped) {
        await updateGraphicTemplate({ data: { orgId, id: mapped, updates: { ...fields, style } } });
        ids.push(mapped);
      } else {
        const created = await addGraphicTemplate({ data: { orgId, ...fields, style } });
        if (item.key === "__draft__") setScratchId(created.id);
        else sceneRecordsRef.current[item.key] = created.id;
        ids.push(created.id);
      }
    }

    // Absolute write: the live set becomes exactly the composed scene.
    await setActiveGraphics({ data: { orgId, graphicIds: ids } });
    setActiveIds(ids);
    setPushing(false);
    router.invalidate();
  };

  const handleClearLive = async () => {
    if (!canTriggerGraphics) return;
    await clearActiveGraphics({ data: { orgId } });
    setActiveIds([]);
  };

  const sample = getCurrentText();
  const composedCount = scene.length + (draftHasText ? 1 : 0);

  return (
    <div className="h-full overflow-auto bg-board-bg">
      {/* Header */}
      <div className="sticky top-0 z-20 bg-board-bg/90 backdrop-blur-xl border-b border-board-border px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-board-text font-display">
              Lower Third Templates
            </h1>
            <p className="text-xs text-board-muted mt-0.5">
              Design, add multiple LTs to a scene, then push them together — what you see is what airs.
            </p>
          </div>
          <button
            onClick={() => setShowControls((v) => !v)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              showControls
                ? "bg-fire-500/15 text-fire-500 border border-fire-500/25"
                : "text-board-muted hover:text-board-text border border-board-border"
            }`}
          >
            <Sliders className="w-3.5 h-3.5" />
            Controls
          </button>
        </div>
      </div>

      <div className="p-6 max-w-6xl mx-auto">
        <div className="flex gap-6">
          {/* Main content */}
          <div className="flex-1 min-w-0 space-y-5">
            {/* Top controls */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 overflow-x-auto">
                <button
                  onClick={() => setSampleKey("custom")}
                  className={`px-2.5 py-1 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
                    sampleKey === "custom"
                      ? "bg-fire-500/15 text-fire-500 border border-fire-500/25"
                      : "text-board-muted hover:text-board-text border border-transparent"
                  }`}
                >
                  Custom
                </button>
                {(Object.keys(SAMPLES) as (keyof typeof SAMPLES)[]).map((key) => (
                  <button
                    key={key}
                    onClick={() => setSampleKey(key)}
                    className={`px-2.5 py-1 rounded-lg text-xs font-medium capitalize whitespace-nowrap transition-colors ${
                      sampleKey === key
                        ? "bg-fire-500/15 text-fire-500 border border-fire-500/25"
                        : "text-board-muted hover:text-board-text border border-transparent"
                    }`}
                  >
                    {key.replace("2", " 2")}
                  </button>
                ))}
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={toggle}
                  className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
                    visible
                      ? "bg-green-500/15 text-green-400 border border-green-500/25"
                      : "bg-board-bg text-board-muted border border-board-border hover:text-board-text"
                  }`}
                >
                  {visible ? "On Air" : "Off Air"}
                </button>
                <span className="text-xs text-board-muted font-mono">
                  {currentIndex + 1}/{TEMPLATES.length}
                </span>
                <button
                  onClick={prev}
                  className="p-1.5 rounded-lg text-board-muted hover:text-board-text hover:bg-board-border/50 transition-colors"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <button
                  onClick={next}
                  className="p-1.5 rounded-lg text-board-muted hover:text-board-text hover:bg-board-border/50 transition-colors"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Custom text inputs */}
            {sampleKey === "custom" && (
              <div className="flex gap-3">
                <input
                  type="text"
                  value={customPrimary}
                  onChange={(e) => setCustomPrimary(e.target.value)}
                  placeholder="Primary text (name, title, verse...)"
                  className="flex-1 px-3 py-2 rounded-lg bg-board-bg border border-board-border text-board-text placeholder:text-board-muted/50 focus:outline-none focus:border-fire-500 transition-colors text-sm"
                />
                <input
                  type="text"
                  value={customSecondary}
                  onChange={(e) => setCustomSecondary(e.target.value)}
                  placeholder="Secondary text (optional)"
                  className="flex-1 px-3 py-2 rounded-lg bg-board-bg border border-board-border text-board-text placeholder:text-board-muted/50 focus:outline-none focus:border-fire-500 transition-colors text-sm"
                />
              </div>
            )}

            {/* Action buttons */}
            <div className="flex items-center gap-2">
              <button
                onClick={addToScene}
                disabled={!draftHasText}
                title="Add this lower third to the scene, then design the next one"
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-fire-500/30 text-fire-500 text-xs font-medium hover:bg-fire-500/10 disabled:opacity-40 transition-colors"
              >
                <Plus className="w-3.5 h-3.5" />
                Add LT
              </button>
              {canTriggerGraphics && (
                <button
                  onClick={handlePushLive}
                  disabled={pushing || composedCount === 0}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-fire-500 text-white text-xs font-medium hover:bg-fire-600 disabled:opacity-50 transition-colors"
                >
                  <Play className="w-3.5 h-3.5" />
                  {pushing
                    ? "Pushing..."
                    : composedCount > 1
                      ? `Push Scene (${composedCount})`
                      : "Push Live"}
                </button>
              )}
              {canTriggerGraphics && activeIds.length > 0 && (
                <button
                  onClick={handleClearLive}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-red-500/20 text-red-400 text-xs font-medium hover:bg-red-500/30 transition-colors"
                >
                  <Square className="w-3.5 h-3.5" />
                  Clear All
                </button>
              )}
              {canConfigureGraphics && (
                <button
                  onClick={handleSave}
                  disabled={saving || (sampleKey === "custom" && !customPrimary.trim())}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-lg border border-board-border text-board-muted text-xs font-medium hover:text-board-text hover:bg-board-border/50 disabled:opacity-50 transition-colors"
                >
                  <Save className="w-3.5 h-3.5" />
                  {saving ? "Saving..." : "Save to Library"}
                </button>
              )}
              {savedMsg && (
                <span className="text-xs text-green-400 font-medium">{savedMsg}</span>
              )}
              {activeIds.length > 0 && (
                <div className="flex items-center gap-1.5 ml-auto">
                  <div className="w-2 h-2 rounded-full bg-fire-500 animate-pulse" />
                  <span className="text-xs font-medium text-fire-500">
                    {activeIds.length === 1 ? "On Air" : `${activeIds.length} On Air`}
                  </span>
                </div>
              )}
            </div>

            {/* Scene tray — LTs composed alongside the one being edited */}
            {scene.length > 0 && (
              <div className="rounded-lg border border-board-border bg-board-card/50 p-2.5">
                <div className="flex items-center gap-1.5 mb-2 px-0.5">
                  <Layers className="w-3 h-3 text-board-muted" />
                  <span className="text-[10px] font-semibold uppercase tracking-widest text-board-muted">
                    Scene · {scene.length + (draftHasText ? 1 : 0)} LTs
                  </span>
                  <span className="text-[10px] text-board-muted/50">
                    (these push together)
                  </span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {scene.map((item) => (
                    <div
                      key={item.key}
                      className="flex items-center gap-1.5 pl-2 pr-1 py-1 rounded-lg bg-board-bg border border-board-border"
                    >
                      <button
                        onClick={() => editSceneItem(item)}
                        title="Edit this lower third"
                        className="flex items-center gap-1.5 max-w-[180px]"
                      >
                        <span className="text-[9px] font-mono text-fire-500 shrink-0">
                          {posLabel(item.controls)}
                        </span>
                        <span className="text-xs text-board-text truncate">
                          {item.primary}
                        </span>
                      </button>
                      <button
                        onClick={() => removeFromScene(item.key)}
                        title="Remove from scene"
                        className="p-0.5 rounded text-board-muted hover:text-red-400 hover:bg-red-500/10 transition-colors"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                  {draftHasText && (
                    <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-fire-500/10 border border-dashed border-fire-500/30">
                      <span className="text-[9px] font-mono text-fire-500 shrink-0">
                        {posLabel(controls)}
                      </span>
                      <span className="text-xs text-fire-500 truncate max-w-[180px]">
                        {getCurrentText().primary} <span className="opacity-60">· editing</span>
                      </span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Preview viewport — 16:9 OBS canvas, scaled 1:1 with the stream */}
            <div
              className="relative w-full rounded-xl overflow-hidden border border-board-border select-none"
              style={{ aspectRatio: "16 / 9", background: "#111" }}
            >
              {/* Grid overlay */}
              <div
                className="absolute inset-0 opacity-[0.03] pointer-events-none z-10"
                style={{
                  backgroundImage:
                    "linear-gradient(rgba(255,255,255,0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.1) 1px, transparent 1px)",
                  backgroundSize: "80px 80px",
                }}
              />
              {/* Center cross */}
              <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-8 h-8 pointer-events-none z-10">
                <div className="absolute top-1/2 left-0 right-0 h-px bg-white/10" />
                <div className="absolute left-1/2 top-0 bottom-0 w-px bg-white/10" />
              </div>
              {/* Safe area */}
              <div className="absolute inset-[5%] border border-white/3 rounded pointer-events-none z-10" />

              {/* Crosshair at current position */}
              <div
                className="absolute w-4 h-4 pointer-events-none transition-all duration-75 z-10"
                style={{
                  left: `${controls.posX}%`,
                  top: `${controls.posY}%`,
                  transform: "translate(-50%, -50%)",
                  opacity: 0.15,
                }}
              >
                <div className="absolute top-1/2 left-0 right-0 h-px bg-fire-500" />
                <div className="absolute left-1/2 top-0 bottom-0 w-px bg-fire-500" />
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-1.5 h-1.5 rounded-full bg-fire-500" />
              </div>

              {/* Template render — the full scene on the scaled broadcast stage */}
              <LtStage>
                {scene.map((item) => (
                  <div key={item.key}>
                    {getTemplate(item.templateId).render(
                      item.primary,
                      item.secondary,
                      true,
                      item.controls,
                    )}
                  </div>
                ))}
                {draftHasText && (
                  <div>{template.render(sample.primary, sample.secondary, visible, controls)}</div>
                )}
              </LtStage>

              {/* Status */}
              <div className="absolute top-4 right-4 flex items-center gap-2 pointer-events-none z-20">
                {visible ? (
                  <div className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-red-500/20">
                    <div className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
                    <span className="text-[10px] text-red-400 font-mono uppercase tracking-widest">on air</span>
                  </div>
                ) : (
                  <span className="text-[10px] text-white/20 font-mono uppercase tracking-widest">off air</span>
                )}
              </div>
            </div>

            {/* Template info */}
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-semibold text-board-text">{template.name}</h2>
                <span className="text-[10px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded border border-board-border text-board-muted">
                  {template.category}
                </span>
              </div>
              <p className="text-sm text-board-muted mt-0.5">{template.description}</p>
              {template.fullWidth && (
                <p className="text-[10px] text-board-muted/50 mt-1 italic">
                  Full-width template — horizontal position adjusts gradient direction, vertical position moves the strip.
                </p>
              )}
            </div>

            {/* Dot navigation */}
            <div className="flex justify-center gap-2 flex-wrap">
              {TEMPLATES.map((t, i) => (
                <button
                  key={t.id}
                  onClick={() => {
                    setVisible(false);
                    setTimeout(() => {
                      setCurrentIndex(i);
                      setVisible(true);
                    }, 300);
                  }}
                  className={`h-2 rounded-full transition-all ${
                    i === currentIndex ? "bg-fire-500 w-6" : "bg-board-border hover:bg-board-muted w-2"
                  }`}
                />
              ))}
            </div>

            {/* Gallery grid */}
            <div className="pt-4 border-t border-board-border">
              <h3 className="text-sm font-semibold text-board-muted uppercase tracking-widest mb-4">
                All Templates
              </h3>
              <div className="grid grid-cols-2 gap-4">
                {TEMPLATES.map((t, i) => (
                  <button
                    key={t.id}
                    onClick={() => {
                      setCurrentIndex(i);
                      setVisible(true);
                      window.scrollTo({ top: 0, behavior: "smooth" });
                    }}
                    className={`text-left rounded-xl border p-3 transition-all ${
                      i === currentIndex
                        ? "border-fire-500/30 bg-fire-500/5"
                        : "border-board-border bg-board-card hover:border-board-muted/30"
                    }`}
                  >
                    <div
                      className="relative w-full rounded-lg overflow-hidden mb-2.5"
                      style={{ aspectRatio: "16 / 9", background: "#111" }}
                    >
                      <LtStage>
                        {t.render(SAMPLES.person.primary, SAMPLES.person.secondary, true, controls)}
                      </LtStage>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <p className="text-xs font-semibold text-board-text">{t.name}</p>
                      <span className="text-[9px] text-board-muted/60 uppercase tracking-wider">{t.category}</span>
                    </div>
                    <p className="text-[10px] text-board-muted mt-0.5 line-clamp-1">{t.description}</p>
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Controls sidebar */}
          {showControls && (
            <div className="w-64 shrink-0">
              <div className="sticky top-[73px] rounded-xl border border-board-border bg-board-card p-4">
                <h3 className="text-xs font-semibold text-board-text uppercase tracking-widest mb-4">
                  Customize
                </h3>
                <ControlPanel
                  controls={controls}
                  onChange={setControls}
                  onReset={() => setControls(DEFAULT_CONTROLS)}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
