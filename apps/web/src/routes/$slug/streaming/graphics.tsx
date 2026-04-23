import { createFileRoute, useRouter } from "@tanstack/react-router";
import { PageSkeleton } from "@/components/ui/Skeleton";
import { useState } from "react";
import {
  Play,
  Square,
  Plus,
  Pencil,
  Trash2,
  Type,
  BookOpen,
  Megaphone,
  Heading,
  Eye,
  Copy,
  Check,
} from "lucide-react";
import {
  getGraphicTemplates,
  addGraphicTemplate,
  updateGraphicTemplate,
  deleteGraphicTemplate,
  setActiveGraphic,
  getActiveGraphic,
} from "@/lib/graphics";

type GraphicType = "lower-third" | "scripture" | "announcement" | "title";

const TYPE_CONFIG: Record<
  GraphicType,
  { label: string; icon: React.ElementType; color: string }
> = {
  "lower-third": {
    label: "Lower Third",
    icon: Type,
    color: "bg-blue-500/15 text-blue-400 border-blue-500/25",
  },
  scripture: {
    label: "Scripture",
    icon: BookOpen,
    color: "bg-purple-500/15 text-purple-400 border-purple-500/25",
  },
  announcement: {
    label: "Announcement",
    icon: Megaphone,
    color: "bg-yellow-500/15 text-yellow-400 border-yellow-500/25",
  },
  title: {
    label: "Title",
    icon: Heading,
    color: "bg-green-500/15 text-green-400 border-green-500/25",
  },
};

function parseStyle(json: string) {
  try {
    return JSON.parse(json) as { type?: GraphicType; styleName?: string };
  } catch {
    return {};
  }
}

export const Route = createFileRoute("/$slug/streaming/graphics")({
  pendingComponent: () => <PageSkeleton />,
  loader: async ({ context }) => {
    const { withPermission } = await import("@/lib/route-permissions");
    await withPermission(context.role, "lowerthird:view", context.slug, context.orgId);
    const [templates, active] = await Promise.all([
      getGraphicTemplates({ data: { orgId: context.orgId } }),
      getActiveGraphic({ data: { orgId: context.orgId } }),
    ]);
    return { templates, activeId: active?.id ?? null, orgId: context.orgId, slug: context.slug };
  },
  component: GraphicsPage,
});

function GraphicsPage() {
  const { templates, activeId: initialActiveId, orgId, slug } = Route.useLoaderData();
  const router = useRouter();
  const [activeId, setActiveId] = useState<string | null>(initialActiveId);
  const [filterType, setFilterType] = useState<GraphicType | "all">("all");
  const [showForm, setShowForm] = useState(false);
  const [editTemplate, setEditTemplate] = useState<typeof templates[0] | null>(null);
  const [copiedOverlay, setCopiedOverlay] = useState(false);

  const filtered =
    filterType === "all"
      ? templates
      : templates.filter((t) => {
          const style = parseStyle(t.style);
          return style.type === filterType;
        });

  const handleTrigger = async (id: string) => {
    setActiveId(id);
    await setActiveGraphic({ data: { orgId, graphicId: id } });
  };

  const handleStop = async () => {
    setActiveId(null);
    await setActiveGraphic({ data: { orgId, graphicId: null } });
  };

  const handleDelete = async (id: string) => {
    if (activeId === id) {
      setActiveId(null);
      await setActiveGraphic({ data: { orgId, graphicId: null } });
    }
    await deleteGraphicTemplate({ data: { orgId, id } });
    router.invalidate();
  };

  const overlayUrl = `/overlay/${slug}`;

  const types: (GraphicType | "all")[] = [
    "all",
    "lower-third",
    "scripture",
    "announcement",
    "title",
  ];

  return (
    <div className="h-full overflow-auto">
      <div className="sticky top-0 z-10 bg-board-bg/80 backdrop-blur-xl border-b border-board-border px-4 md:px-6 py-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-lg font-semibold text-board-text font-[family-name:var(--font-display)]">
              Lower Thirds
            </h1>
            <p className="text-xs text-board-muted mt-0.5">
              Create and control on-screen graphics
            </p>
          </div>
          <button
            onClick={() => {
              setEditTemplate(null);
              setShowForm(true);
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-fire-500 text-white text-xs font-medium hover:bg-fire-600 transition-colors"
          >
            <Plus className="w-3 h-3" />
            New Graphic
          </button>
        </div>
      </div>

      <div className="p-4 md:p-6 max-w-3xl mx-auto space-y-5">
        {/* Active indicator */}
        {activeId && (
            <div className="flex items-center justify-between px-4 py-3 rounded-xl bg-fire-500/10 border border-fire-500/20">
              <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-fire-500 animate-pulse" />
              <span className="text-sm font-medium text-fire-500">
                Graphic on air
              </span>
            </div>
              {canTriggerGraphics && (
                <button
                  onClick={handleStop}
                  className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-red-500/20 text-red-400 text-xs font-medium hover:bg-red-500/30 transition-colors"
                >
                  <Square className="w-3 h-3" />
                  Clear
                </button>
              )}
          </div>
        )}

        {/* Filter tabs */}
        <div className="flex items-center gap-1.5 overflow-x-auto">
          {types.map((t) => (
            <button
              key={t}
              onClick={() => setFilterType(t)}
              className={`px-2.5 py-1 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
                filterType === t
                  ? "bg-fire-500/15 text-fire-500 border border-fire-500/25"
                  : "text-board-muted hover:text-board-text hover:bg-board-border/50 border border-transparent"
              }`}
            >
              {t === "all" ? "All" : TYPE_CONFIG[t].label}
            </button>
          ))}
        </div>

        {/* Graphics list */}
        <div className="space-y-2">
          {filtered.length === 0 ? (
            <div className="text-center py-12">
              <Type className="w-10 h-10 text-board-muted/30 mx-auto mb-3" />
              <p className="text-sm text-board-muted">No graphics found</p>
              <p className="text-xs text-board-muted/50 mt-1">
                Create a graphic to get started
              </p>
            </div>
          ) : (
            filtered.map((template) => {
              const style = parseStyle(template.style);
              const graphicType = (style.type ?? "lower-third") as GraphicType;
              const config = TYPE_CONFIG[graphicType] ?? TYPE_CONFIG["lower-third"];
              const isActive = activeId === template.id;

              return (
                <div
                  key={template.id}
                  className={`rounded-xl border p-4 transition-all ${
                    isActive
                      ? "bg-fire-500/5 border-fire-500/25 ring-1 ring-fire-500/20"
                      : "bg-board-card border-board-border hover:border-board-muted/30"
                  }`}
                >
                  <div className="flex items-start gap-3">
                    {canTriggerGraphics && (
                      <button
                        onClick={() =>
                          isActive ? handleStop() : handleTrigger(template.id)
                        }
                        className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 transition-colors ${
                          isActive
                            ? "bg-red-500/20 text-red-400 hover:bg-red-500/30"
                            : "bg-fire-500/15 text-fire-500 hover:bg-fire-500/25"
                        }`}
                        title={isActive ? "Stop graphic" : "Show graphic"}
                      >
                        {isActive ? (
                          <Square className="w-4 h-4" />
                        ) : (
                          <Play className="w-4 h-4" />
                        )}
                      </button>
                    )}

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span
                          className={`text-[10px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded border ${config.color}`}
                        >
                          {config.label}
                        </span>
                        {isActive && (
                          <span className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider text-fire-500">
                            <Eye className="w-2.5 h-2.5" /> On Air
                          </span>
                        )}
                      </div>
                      <p className="text-sm font-medium text-board-text truncate">
                        {template.title}
                      </p>
                      {template.subtitle && (
                        <p className="text-xs text-board-muted truncate mt-0.5">
                          {template.subtitle}
                        </p>
                      )}
                    </div>

                    {canConfigureGraphics && (
                      <div className="flex items-center gap-0.5 shrink-0">
                        <button
                          onClick={() => {
                            setEditTemplate(template);
                            setShowForm(true);
                          }}
                          className="p-1.5 rounded-lg text-board-muted hover:text-board-text hover:bg-board-border/50 transition-colors"
                        >
                          <Pencil className="w-3 h-3" />
                        </button>
                        <button
                          onClick={() => handleDelete(template.id)}
                          className="p-1.5 rounded-lg text-board-muted hover:text-red-400 hover:bg-red-500/10 transition-colors"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    )}
                  </div>

                  {isActive && (
                    <div className="mt-3 rounded-lg bg-board-bg p-3 border border-board-border/50">
                      <div className="flex items-center gap-2">
                        <div className="w-1 h-6 rounded-full bg-fire-500" />
                        <div>
                          <p className="text-xs font-semibold text-board-text">
                            {template.title}
                          </p>
                          <p className="text-[10px] text-board-muted">
                            {template.subtitle}
                          </p>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* OBS Overlay URL */}
        <div className="rounded-xl border border-board-border bg-board-card/50 p-4">
          <p className="text-[10px] font-medium uppercase tracking-widest text-board-muted/50 mb-3">
            OBS Browser Source
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-xs text-board-muted bg-board-bg px-3 py-2 rounded-lg truncate">
              {typeof window !== "undefined"
                ? `${window.location.origin}${overlayUrl}`
                : overlayUrl}
            </code>
            <button
              onClick={() => {
                const url = `${window.location.origin}${overlayUrl}`;
                navigator.clipboard.writeText(url);
                setCopiedOverlay(true);
                setTimeout(() => setCopiedOverlay(false), 2000);
              }}
              className="p-2 rounded-lg text-board-muted hover:text-board-text hover:bg-board-border/50 transition-colors"
            >
              {copiedOverlay ? (
                <Check className="w-4 h-4 text-green-400" />
              ) : (
                <Copy className="w-4 h-4" />
              )}
            </button>
          </div>
          <p className="text-[10px] text-board-muted/50 mt-2">
            Add this URL as a Browser Source in OBS/vMix to display live
            graphics on your stream.
          </p>
        </div>

        {/* Add/Edit Form Modal */}
        {canConfigureGraphics && showForm && (
          <GraphicFormModal
            existing={editTemplate}
            orgId={orgId}
            activeId={activeId}
            onClose={() => {
              setShowForm(false);
              setEditTemplate(null);
            }}
            onSaved={() => {
              setShowForm(false);
              setEditTemplate(null);
              router.invalidate();
            }}
          />
        )}
      </div>
    </div>
  );
}

function GraphicFormModal({
  existing,
  orgId,
  onClose,
  onSaved,
}: {
  existing: { id: string; name: string; title: string; subtitle: string; style: string } | null;
  orgId: string;
  activeId: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const existingStyle = existing ? parseStyle(existing.style) : {};
  const [type, setType] = useState<GraphicType>(
    (existingStyle.type as GraphicType) ?? "lower-third"
  );
  const [name, setName] = useState(existing?.name ?? "");
  const [title, setTitle] = useState(existing?.title ?? "");
  const [subtitle, setSubtitle] = useState(existing?.subtitle ?? "");
  const [styleName, setStyleName] = useState<string>(
    existingStyle.styleName ?? "default"
  );
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setSaving(true);

    const styleJson = JSON.stringify({ type, styleName });

    if (existing) {
      await updateGraphicTemplate({
        data: {
          orgId,
          id: existing.id,
          updates: {
            name: name.trim() || title.trim(),
            title: title.trim(),
            subtitle: subtitle.trim(),
            style: styleJson,
          },
        },
      });
      // Re-trigger if this graphic is currently on air so overlay picks up changes
      if (activeId === existing.id) {
        await setActiveGraphic({ data: { orgId, graphicId: null } });
        await setActiveGraphic({ data: { orgId, graphicId: existing.id } });
      }
    } else {
      await addGraphicTemplate({
        data: {
          orgId,
          name: name.trim() || title.trim(),
          title: title.trim(),
          subtitle: subtitle.trim(),
          style: styleJson,
        },
      });
    }

    setSaving(false);
    onSaved();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-board-card border border-board-border rounded-2xl p-6 w-full max-w-md mx-4 shadow-2xl">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-semibold text-board-text">
            {existing ? "Edit Graphic" : "New Graphic"}
          </h2>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-board-border transition-colors text-board-muted"
          >
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Type selector */}
          <div>
            <label className="block text-sm text-board-muted mb-1.5">
              Type
            </label>
            <div className="grid grid-cols-2 gap-2">
              {(Object.keys(TYPE_CONFIG) as GraphicType[]).map((t) => {
                const config = TYPE_CONFIG[t];
                const Icon = config.icon;
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setType(t)}
                    className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium border transition-colors ${
                      type === t
                        ? "bg-fire-500/15 text-fire-500 border-fire-500/25"
                        : "text-board-muted border-board-border hover:border-board-muted/50"
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    {config.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Name */}
          <div>
            <label className="block text-sm text-board-muted mb-1.5">
              Label (internal reference)
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Pastor Name"
              className="w-full px-4 py-2.5 rounded-xl bg-board-bg border border-board-border text-board-text placeholder:text-board-muted/50 focus:outline-none focus:border-fire-500 transition-colors text-sm"
            />
          </div>

          {/* Title */}
          <div>
            <label className="block text-sm text-board-muted mb-1.5">
              {type === "scripture" ? "Reference" : "Primary Text"}
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={
                type === "scripture"
                  ? "Romans 8:28 (NIV)"
                  : type === "lower-third"
                    ? "Name"
                    : "Main text"
              }
              className="w-full px-4 py-2.5 rounded-xl bg-board-bg border border-board-border text-board-text placeholder:text-board-muted/50 focus:outline-none focus:border-fire-500 transition-colors text-sm"
            />
          </div>

          {/* Subtitle */}
          <div>
            <label className="block text-sm text-board-muted mb-1.5">
              {type === "scripture" ? "Verse Text" : "Secondary Text"}
            </label>
            <input
              type="text"
              value={subtitle}
              onChange={(e) => setSubtitle(e.target.value)}
              placeholder={
                type === "scripture"
                  ? "Verse content..."
                  : type === "lower-third"
                    ? "Title / Role"
                    : "Subtitle"
              }
              className="w-full px-4 py-2.5 rounded-xl bg-board-bg border border-board-border text-board-text placeholder:text-board-muted/50 focus:outline-none focus:border-fire-500 transition-colors text-sm"
            />
          </div>

          {/* Style */}
          <div>
            <label className="block text-sm text-board-muted mb-1.5">
              Style
            </label>
            <div className="flex gap-2">
              {["default", "accent", "minimal"].map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setStyleName(s)}
                  className={`flex-1 px-3 py-2 rounded-lg text-xs font-medium capitalize border transition-colors ${
                    styleName === s
                      ? "bg-fire-500/15 text-fire-500 border-fire-500/25"
                      : "text-board-muted border-board-border hover:border-board-muted/50"
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          {/* Buttons */}
          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2.5 rounded-xl border border-board-border text-board-muted hover:bg-board-border transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || !title.trim()}
              className="flex-1 px-4 py-2.5 rounded-xl bg-fire-500 text-white font-semibold hover:bg-fire-600 disabled:opacity-50 transition-colors"
            >
              {saving ? "Saving..." : existing ? "Update" : "Create"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
