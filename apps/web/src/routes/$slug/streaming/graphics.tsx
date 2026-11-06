import { useGraphicLibraryMutation } from "@/hooks/useGraphicLibraryMutation";
import { useOperatorRead } from "@/hooks/useOperatorRead";
import { LibraryMutationNotice } from "@/components/graphics/LibraryMutationNotice";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useGraphicsOutput } from "@/hooks/useGraphicsOutput";
import { ReadFailureNotice } from "@/components/layout/ReadFailureNotice";
import { workspaceCopy } from "@showpilot/shared";
import { useTerms as useWorkspaceTerms } from "@/components/workspace/WorkspaceProvider";
import { createFileRoute, Link } from "@tanstack/react-router";
import { PageSkeleton } from "@/components/ui/Skeleton";
import { useCallback, useRef, useState } from "react";
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
  Sparkles,
  X,
} from "lucide-react";
import { EmptyState, EmptyStateButton } from "@/components/ui/empty-state";
import { hasEffectivePermission } from "@/lib/app-permissions";
import {
  getGraphicTemplates,
  getActiveGraphics,
} from "@/lib/graphics";
import {
  DEFAULT_CONTROLS,
  POSITION_PRESETS,
  ACCENT_PRESETS,
  TEMPLATES,
} from "@/lib/lt-templates";
import { getProPresenterConfiguration } from "@/lib/settings";
import { useProPresenter } from "@/hooks/useProPresenter";
import { useDisplayLink } from "@/hooks/useDisplayLink";

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
    return JSON.parse(json) as {
      type?: GraphicType;
      styleName?: string;
      scratch?: boolean;
    };
  } catch {
    return {};
  }
}

export const Route = createFileRoute("/$slug/streaming/graphics")({
  pendingComponent: () => <PageSkeleton />,
  loader: async ({ context }) => {
    const { withPermission } = await import("@/lib/route-permissions");
    await withPermission(context.role, "lowerthird:view", context.slug, context.orgId);
    const canTrigger = hasEffectivePermission(
      context.role,
      context.grantedPermissions,
      "lowerthird:trigger",
    );
    const [templates, active, settings] = await Promise.all([
      getGraphicTemplates({ data: { orgId: context.orgId } }),
      getActiveGraphics({ data: { orgId: context.orgId } }),
      canTrigger
        ? getProPresenterConfiguration({ data: { orgId: context.orgId } })
        : Promise.resolve<Record<string, string>>({}),
    ]);
    return {
      templates,
      activeIds: active.map((g) => g.id),
      orgId: context.orgId,
      slug: context.slug,
      role: context.role,
      grantedPermissions: context.grantedPermissions,
      proPresenter: {
        host: settings["propresenter-host"] ?? "",
        stagePort: Number.parseInt(settings["propresenter-port"] ?? "50001", 10) || 50001,
        apiPort: Number.parseInt(settings["propresenter-api-port"] ?? "1025", 10) || 1025,
      },
    };
  },
  component: GraphicsRoute,
});

function GraphicsRoute() {
  return <GraphicsPage key={Route.useLoaderData().orgId} />;
}

function GraphicsPage() {
  const { templates: initialTemplates, activeIds: initialActiveIds, orgId, slug, role, grantedPermissions, proPresenter: proPresenterConfig } = Route.useLoaderData();
  const [libraryRevision, setLibraryRevision] = useState(0);
  const retainedTemplates = useRef(initialTemplates);
  const refreshLibrary = () => setLibraryRevision(revision => revision + 1);
  const library = useOperatorRead({ key: JSON.stringify([orgId, libraryRevision]), initialValue: retainedTemplates.current,
    read: useCallback((signal: AbortSignal) => getGraphicTemplates({ data: { orgId }, signal }), [orgId]),
    errorMessage: "Graphics library could not refresh. Showing the last confirmed library.",
  });
  const templates = library.value;
  retainedTemplates.current = templates;
  const mutation = useGraphicLibraryMutation(orgId);
  const { confirm, ConfirmDialogEl } = useConfirmDialog();
  const currentScope = useRef(orgId);
  currentScope.current = orgId;
  const canTriggerGraphics = hasEffectivePermission(role, grantedPermissions, "lowerthird:trigger");
  const canConfigureGraphics = hasEffectivePermission(role, grantedPermissions, "lowerthird:configure");
  const output = useGraphicsOutput(orgId, initialActiveIds, canTriggerGraphics);
  const activeIds = output.activeIds;
  const [filterType, setFilterType] = useState<GraphicType | "all">("all");
  const [showForm, setShowForm] = useState(false);
  const [editTemplate, setEditTemplate] = useState<
    (typeof templates)[0] | null
  >(null);
  const [copiedOverlay, setCopiedOverlay] = useState(false);
  const [proPresenterEnabled, setProPresenterEnabled] = useState(false);
  const [proPresenterMessage, setProPresenterMessage] = useState<string | null>(null);

  const proPresenter = useProPresenter({
    orgId,
    host: proPresenterConfig.host,
    port: proPresenterConfig.stagePort,
    enabled: proPresenterEnabled,
  });

  const currentProPresenterSlide = proPresenter.currentSlide;
  const proPresenterConnected = proPresenter.status === "connected";
  const proPresenterConnecting = proPresenter.status === "connecting";
  const bridgeOnline = proPresenter.debugInfo?.wsConnected ?? false;

  // Hide the designer's live-preview "scratch" entries from the library.
  const visibleTemplates = templates.filter((t) => !parseStyle(t.style).scratch);
  const filtered =
    filterType === "all"
      ? visibleTemplates
      : visibleTemplates.filter((t) => parseStyle(t.style).type === filterType);

  const handleToggle = async (id: string) => {
    const operation = { kind: activeIds.includes(id) ? "hide" as const : "show" as const, graphicId: id };
    const title = templates.find(template => template.id === id)?.title ?? "this graphic";
    if (!await confirm({ title: operation.kind === "show" ? "Show this graphic?" : "Hide this graphic?", description: `This changes live output for “${title}”.`, confirmLabel: operation.kind === "show" ? "Show graphic" : "Hide graphic", variant: "warning" })) return;
    if (currentScope.current === orgId) await output.run(operation);
  };
  const handleClearAll = async () => {
    if (!await confirm({ title: "Clear all graphics?", description: "This removes every graphic currently on air. The library is kept.", confirmLabel: "Clear all graphics" })) return;
    if (currentScope.current === orgId) await output.run({ kind: "clear" });
  };
  const handleDelete = async (id: string) => {
    if (!await confirm({ title: "Delete graphic?", description: "This permanently deletes the graphic from the library and removes it from live output if it is on air.", confirmLabel: "Delete graphic" })) return;
    if (currentScope.current !== orgId) return;
    if (activeIds.includes(id) && !await output.run({ kind: "hide", graphicId: id })) return;
    if (await mutation.run({ kind: "delete", id })) { refreshLibrary(); output.retry(); }
  };

  const overlayLink = useDisplayLink(slug, "overlay");

  const generateFromProPresenter = async (kind: "scripture" | "lower-third" | "title") => {
    const slide = currentProPresenterSlide;
    if (!slide?.text.trim() || !canConfigureGraphics) return;

    const isScripture = kind === "scripture";
    const secondary = (slide.notes || slide.presentationName || "").trim();
    const title = slide.text.trim();
    const name = (isScripture ? secondary || "ProPresenter Scripture" : slide.presentationName || title)
      .replace(/\s+/g, " ")
      .slice(0, 120);

    const saved = await mutation.run({ kind: "create", content: {
        name,
        title,
        subtitle: secondary,
        style: JSON.stringify({
          type: kind,
          templateId: isScripture ? "scripture-card" : kind === "title" ? "kicker" : "classic",
          controls: {
            ...DEFAULT_CONTROLS,
            ...(isScripture ? { posX: 50, posY: 72, accentColor: "#8b5cf6" } : {}),
          },
          source: "propresenter",
          sourceSlideId: slide.slideId,
        }),
      },
    });
    if (!saved) return;
    setProPresenterMessage(`${isScripture ? "Scripture" : "Graphic"} saved to the library`);
    setTimeout(() => setProPresenterMessage(null), 2500);
    refreshLibrary();
  };

  const types: (GraphicType | "all")[] = [
    "all",
    "lower-third",
    "scripture",
    "announcement",
    "title",
  ];

  return (
    <div className="h-full overflow-auto">
      {ConfirmDialogEl}
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
          <div className="flex items-center gap-2">
            {canConfigureGraphics && (
              <Link
                to="/$slug/streaming/lt-preview"
                params={{ slug }}
                className="min-h-11 flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-board-border text-board-muted text-xs font-medium hover:text-board-text hover:bg-board-border/50 transition-colors"
              >
                <Sparkles className="w-3 h-3" />
                Template Studio
              </Link>
            )}
            {canConfigureGraphics && visibleTemplates.length > 0 && (
              <button
                onClick={() => {
                  setEditTemplate(null);
                  setShowForm(true);
                }}
                className="min-h-11 flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-fire-500 text-white text-xs font-medium hover:bg-fire-600 transition-colors"
              >
                <Plus className="w-3 h-3" />
                New Graphic
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="p-4 md:p-6 max-w-3xl mx-auto space-y-5">
        <ReadFailureNotice error={library.error} refreshing={library.refreshing} retry={library.retry} label="Refresh graphics library" />
        <LibraryMutationNotice mutation={mutation} onConfirmed={() => { refreshLibrary(); output.retry(); }} />
        <ReadFailureNotice error={output.readFailure} refreshing={output.refreshing} retry={output.retry} label="Refresh graphics output" />
        {output.failure && <div role="alert" aria-label="Graphics change confirmation" className="rounded-xl border border-amber-400/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">{output.failure.message} <time dateTime={new Date(output.failure.occurredAt).toISOString()}>{new Date(output.failure.occurredAt).toLocaleTimeString()}</time></div>}
        {!output.fresh && <p role="status" aria-live="polite" className="text-sm text-amber-200">{output.pending ? "Waiting for graphics output confirmation…" : "Refreshing graphics output. Showing the last confirmed state."}</p>}
        {/* ProPresenter slide import */}
        {canConfigureGraphics && (
          <section className="rounded-xl border border-board-border bg-board-card/60 p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`w-2 h-2 rounded-full ${proPresenterConnected ? "bg-green-400" : proPresenterConnecting ? "bg-yellow-400 animate-pulse" : "bg-board-muted/40"}`} />
                  <h2 className="text-sm font-semibold text-board-text">ProPresenter import</h2>
                  <span className="text-xs uppercase tracking-wider text-board-muted/60">
                    {proPresenter.status === "connected"
                      ? "Connected through venue Bridge"
                      : proPresenter.error
                        ? "Reconnecting, showing last confirmed slide"
                        : proPresenterEnabled && bridgeOnline
                          ? "Bridge online · waiting for slide"
                          : proPresenterEnabled
                            ? "Waiting for connection"
                            : "Not connected"}
                  </span>
                </div>
                <p className="text-xs text-board-muted mt-1">
                  Turn the current ProPresenter slide into a reusable scripture, title, or lower-third graphic.
                </p>
              </div>
              <button
                onClick={() => setProPresenterEnabled((enabled) => !enabled)}
                className={`min-h-11 shrink-0 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${proPresenterEnabled ? "border-red-500/25 text-red-400 hover:bg-red-500/10" : "border-fire-500/30 text-fire-500 hover:bg-fire-500/10"}`}
              >
                {proPresenterEnabled ? "Disconnect" : "Connect ProPresenter"}
              </button>
            </div>

            {!proPresenterConfig.host && !bridgeOnline && (
              <p className="mt-3 text-xs text-amber-400/80">
                Add the ProPresenter host and ports in Settings → Integrations before connecting.
              </p>
            )}
            <ReadFailureNotice error={proPresenter.error && proPresenter.errorAt !== null ? { message: proPresenter.error, occurredAt: proPresenter.errorAt } : null} refreshing={proPresenter.refreshing} retry={proPresenter.connect} label="Reconnect ProPresenter feed" />
            {currentProPresenterSlide && (
              <div className="mt-3 rounded-lg border border-board-border bg-board-bg p-3">
                <div className="flex flex-col items-start justify-between gap-3 sm:flex-row">
                  <div className="min-w-0 w-full sm:flex-1">
                    <p className="text-xs uppercase tracking-widest text-board-muted/60">{proPresenterConnected ? "Current slide" : "Last confirmed slide"}</p>
                    <p aria-label="ProPresenter slide text" className="mt-1 break-words text-sm text-board-text whitespace-pre-wrap line-clamp-4">{currentProPresenterSlide.text}</p>
                    {(currentProPresenterSlide.notes || currentProPresenterSlide.presentationName) && (
                      <p className="mt-1 text-xs text-board-muted truncate">
                        {currentProPresenterSlide.notes || currentProPresenterSlide.presentationName}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
                    <button disabled={mutation.locked} onClick={() => void generateFromProPresenter("scripture")} className="min-h-11 px-2.5 py-1.5 rounded-lg bg-purple-500/15 text-purple-300 border border-purple-500/25 text-xs font-medium hover:bg-purple-500/25">Scripture</button>
                    <button disabled={mutation.locked} onClick={() => void generateFromProPresenter("lower-third")} className="min-h-11 px-2.5 py-1.5 rounded-lg bg-blue-500/15 text-blue-300 border border-blue-500/25 text-xs font-medium hover:bg-blue-500/25">Lower third</button>
                    <button disabled={mutation.locked} onClick={() => void generateFromProPresenter("title")} className="min-h-11 px-2.5 py-1.5 rounded-lg bg-green-500/15 text-green-300 border border-green-500/25 text-xs font-medium hover:bg-green-500/25">Title</button>
                  </div>
                </div>
              </div>
            )}
            {proPresenterMessage && (
              <p className="mt-2 text-xs font-medium text-green-400">{proPresenterMessage}</p>
            )}
          </section>
        )}

        {/* ProPresenter slide import */}
        {(activeIds.length > 0 || canTriggerGraphics || !output.fresh) && (
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 rounded-xl bg-fire-500/10 border border-fire-500/20">
              <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-fire-500 animate-pulse" />
              <span className="text-sm font-medium text-fire-500">
                {output.fresh ? (activeIds.length === 0 ? "No graphics on air" : activeIds.length === 1 ? "1 graphic on air" : `${activeIds.length} graphics on air`) : (activeIds.length === 0 ? "Last confirmed: no graphics on air" : `${activeIds.length} last confirmed on air`)}
              </span>
            </div>
              {canTriggerGraphics && (
                <button
                  onClick={handleClearAll}
                  disabled={output.pending !== null}
                  className="min-h-11 flex items-center gap-1.5 px-3 py-1 rounded-lg bg-red-500/20 text-red-400 text-xs font-medium hover:bg-red-500/30 transition-colors"
                >
                  <Square className="w-3 h-3" />
                  Clear all
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
              className={`min-h-11 px-2.5 py-1 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
                filterType === t
                  ? "bg-fire-500/15 text-fire-500 border border-fire-500/25"
                  : "text-board-muted hover:text-board-text hover:bg-board-border/50 border border-transparent"
              }`}
            >
              {t === "all" ? "All" : TYPE_CONFIG[t].label}
            </button>
          ))}
        </div>

        {/* ProPresenter slide import */}
        <div className="space-y-2">
          {filtered.length === 0 ? (
            filterType !== "all" ? (
              <div className="text-center py-12">
                <Type className="w-10 h-10 text-board-muted/30 mx-auto mb-3" />
                <p className="text-sm text-board-muted">No {TYPE_CONFIG[filterType].label.toLowerCase()} graphics</p>
                <p className="text-xs text-board-muted/50 mt-1">Switch to All or create one</p>
              </div>
            ) : (
              <EmptyState
                icon={Type}
                title="No graphics yet"
                description="Lower thirds, bugs and full-screen graphics you create here can be triggered live during the show."
                action={
                  canConfigureGraphics ? (
                    <EmptyStateButton onClick={() => { setEditTemplate(null); setShowForm(true); }}>
                      Create first graphic
                    </EmptyStateButton>
                  ) : undefined
                }
              />
            )
          ) : (
            filtered.map((template) => {
              const style = parseStyle(template.style);
              const graphicType = (style.type ?? "lower-third") as GraphicType;
              const config = TYPE_CONFIG[graphicType] ?? TYPE_CONFIG["lower-third"];
              const isActive = activeIds.includes(template.id);

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
                        onClick={() => handleToggle(template.id)}
                        disabled={!output.fresh}
                        className={`min-w-11 min-h-11 w-11 h-11 disabled:opacity-45 rounded-lg flex items-center justify-center shrink-0 transition-colors ${
                          isActive
                            ? "bg-red-500/20 text-red-400 hover:bg-red-500/30"
                            : "bg-fire-500/15 text-fire-500 hover:bg-fire-500/25"
                        }`}
                        title={isActive ? "Hide graphic" : "Show graphic"}
                        aria-label={`${isActive ? "Hide" : "Show"} ${template.title}`}
                      >
                        {isActive ? (
                          <Square className="w-4 h-4" />
                        ) : (
                          <Play className="w-4 h-4" />
                        )}
                      </button>
                    )}

                    <div className="flex-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-2 mb-1">
                        <span
                          className={`text-[10px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded border ${config.color}`}
                        >
                          {config.label}
                        </span>
                        {isActive && (
                          <span className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider text-fire-500">
                            <Eye className="w-2.5 h-2.5" /> {output.fresh ? "On Air" : "Last confirmed on air"}
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
                          className="min-w-11 min-h-11 flex items-center justify-center rounded-lg text-board-muted hover:text-board-text hover:bg-board-border/50 transition-colors"
                          aria-label={`Edit ${template.title}`}
                        >
                          <Pencil className="w-3 h-3" />
                        </button>
                        <button
                          onClick={() => handleDelete(template.id)}
                          disabled={mutation.locked || (isActive && !canTriggerGraphics)}
                          className="min-w-11 min-h-11 flex items-center justify-center rounded-lg text-board-muted hover:text-red-400 hover:bg-red-500/10 transition-colors"
                          aria-label={`Delete ${template.title}`}
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

        {/* ProPresenter slide import */}
        <div className="rounded-xl border border-board-border bg-board-card/50 p-4">
          <p className="text-[10px] font-medium uppercase tracking-widest text-board-muted/50 mb-3">
            OBS Browser Source
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-xs text-board-muted bg-board-bg px-3 py-2 rounded-lg truncate">
              {overlayLink.url || (overlayLink.pending ? "Creating display link…" : "Display link unavailable")}
            </code>
            <button
              disabled={!overlayLink.url}
              onClick={() => {
                void overlayLink.copy().then((copied) => {
                  if (copied) { setCopiedOverlay(true); setTimeout(() => setCopiedOverlay(false), 2000); }
                });
              }}
              className="min-h-11 min-w-11 p-2 rounded-lg text-board-muted hover:text-board-text hover:bg-board-border/50 transition-colors"
              aria-label="Copy OBS browser source URL"
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
            graphics on your stream. This link expires in 8 hours.
          </p>
          {overlayLink.error && <p role="alert" className="mt-2 text-sm text-red-300">{overlayLink.error}</p>}
          <button type="button" disabled={overlayLink.pending} onClick={overlayLink.refresh} className="mt-2 min-h-11 text-xs text-board-muted">Create a fresh link</button>
          {overlayLink.errorAt !== null && <p className="text-xs text-board-muted">Last error <time dateTime={new Date(overlayLink.errorAt).toISOString()}>{new Date(overlayLink.errorAt).toLocaleTimeString()}</time></p>}
          {overlayLink.monitorUrl && <a href={overlayLink.monitorUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center px-3 text-sm text-fire-500 underline outline-none focus-visible:ring-2 focus-visible:ring-fire-500">Open overlay monitor</a>}
        </div>

        {/* ProPresenter slide import */}
        {canConfigureGraphics && showForm && (
          <GraphicFormModal
            key={`${orgId}:${editTemplate?.id ?? "new"}`}
            existing={editTemplate}
            orgId={orgId}
            onClose={() => {
              setShowForm(false);
              setEditTemplate(null);
              refreshLibrary();
            }}
            onSaved={() => {
              setShowForm(false);
              setEditTemplate(null);
              refreshLibrary();
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
  existing: {
    id: string;
    name: string;
    title: string;
    subtitle: string;
    style: string;
  } | null;
  orgId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const workspaceTerms = useWorkspaceTerms();
  const existingStyle = existing ? parseStyle(existing.style) : {};
  // Read the full raw style so we keep any designer-authored template + controls.
  const existingRaw = (() => {
    try {
      return existing
        ? (JSON.parse(existing.style) as {
            templateId?: string;
            controls?: Partial<typeof DEFAULT_CONTROLS>;
          })
        : {};
    } catch {
      return {};
    }
  })();
  const existingControls = existingRaw.controls ?? {};
  const existingTemplateId = existingRaw.templateId ?? "classic";

  const defaultTemplateForType = (graphicType: GraphicType) => {
    switch (graphicType) {
      case "scripture": return "scripture-card";
      case "title": return "kicker";
      case "announcement": return "lower-bar";
      default: return "classic";
    }
  };

  const [type, setType] = useState<GraphicType>(
    (existingStyle.type as GraphicType) ?? "lower-third"
  );
  const [templateId, setTemplateId] = useState(
    existing ? existingTemplateId : defaultTemplateForType((existingStyle.type as GraphicType) ?? "lower-third"),
  );
  const [name, setName] = useState(existing?.name ?? "");
  const [title, setTitle] = useState(existing?.title ?? "");
  const [subtitle, setSubtitle] = useState(existing?.subtitle ?? "");
  const [posX, setPosX] = useState<number>(existingControls.posX ?? DEFAULT_CONTROLS.posX);
  const [posY, setPosY] = useState<number>(existingControls.posY ?? DEFAULT_CONTROLS.posY);
  const [accentColor, setAccentColor] = useState<string>(
    existingControls.accentColor ?? DEFAULT_CONTROLS.accentColor
  );
  const mutation = useGraphicLibraryMutation(orgId);
  const { confirm, ConfirmDialogEl } = useConfirmDialog();
  const saving = mutation.pending;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    if (mutation.locked) return;
    const controls = { ...DEFAULT_CONTROLS, ...existingControls, posX, posY, accentColor };
    const content = { name: (name.trim() || title.trim()).slice(0, 200), title: title.trim(), subtitle: subtitle.trim(), style: JSON.stringify({ type, templateId, controls }) };
    if (existing && !await confirm({ title: "Update graphic?", description: "If this graphic is on air, its content changes immediately on every output.", confirmLabel: "Update graphic", variant: "warning" })) return;
    if (await mutation.run(existing ? { kind: "update", id: existing.id, content } : { kind: "create", content })) onSaved();
  };

  const requestClose = async () => {
    if (saving) return;
    if (mutation.locked && !await confirm({ title: "Close an unconfirmed save?", description: "The change may already be saved. Check the library before creating another graphic. You can also keep this editor open and retry the original change.", confirmLabel: "Close and review library", variant: "warning" })) return;
    onClose();
  };
  return (
    <Dialog open onOpenChange={open => { if (!open) void requestClose(); }}>
      <DialogContent showCloseButton={false} className="bg-board-card border-board-border max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md">
        {ConfirmDialogEl}
        <div className="flex items-center justify-between mb-5">
          <DialogTitle className="text-lg font-semibold text-board-text">
            {existing ? "Edit Graphic" : "New Graphic"}
          </DialogTitle>
          <button
            type="button"
            onClick={() => void requestClose()}
            disabled={saving}
            className="min-w-11 min-h-11 flex items-center justify-center rounded-lg hover:bg-board-border transition-colors text-board-muted"
            aria-label="Close graphic editor"
          >
            <X className="size-4" />
          </button>
        </div>

        <DialogDescription>Save a reusable graphic to the library. Showing it on air is a separate action.</DialogDescription>
        <LibraryMutationNotice mutation={mutation} onConfirmed={onSaved} />
        <form onSubmit={handleSubmit} className="space-y-4">
          <fieldset disabled={mutation.locked} className="space-y-4">
          {/* ProPresenter slide import */}
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
                    onClick={() => {
                      setType(t);
                      if (!existing) setTemplateId(defaultTemplateForType(t));
                    }}
                    aria-pressed={type === t}
                    className={`min-h-11 flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium border transition-colors ${
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
            <label htmlFor="graphic-name" className="block text-sm text-board-muted mb-1.5">
              Label (internal reference)
            </label>
            <input
              id="graphic-name"
              maxLength={200}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={workspaceCopy("e.g. Pastor Name", workspaceTerms)}
              className="w-full px-4 py-2.5 rounded-xl bg-board-bg border border-board-border text-board-text placeholder:text-board-muted/50 focus:outline-none focus:border-fire-500 transition-colors text-sm"
            />
          </div>

          {/* Title */}
          <div>
            <label htmlFor="graphic-title" className="block text-sm text-board-muted mb-1.5">
              {type === "scripture" ? "Verse Text" : "Primary Text"}
            </label>
            <input
              id="graphic-title"
              maxLength={500}
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={
                type === "scripture"
                  ? "For God so loved the world..."
                  : type === "lower-third"
                    ? "Name"
                    : "Main text"
              }
              className="w-full px-4 py-2.5 rounded-xl bg-board-bg border border-board-border text-board-text placeholder:text-board-muted/50 focus:outline-none focus:border-fire-500 transition-colors text-sm"
            />
          </div>

          {/* Subtitle */}
          <div>
            <label htmlFor="graphic-subtitle" className="block text-sm text-board-muted mb-1.5">
              {type === "scripture" ? "Reference" : "Secondary Text"}
            </label>
            <input
              id="graphic-subtitle"
              maxLength={500}
              type="text"
              value={subtitle}
              onChange={(e) => setSubtitle(e.target.value)}
              placeholder={
                type === "scripture"
                  ? "John 3:16 (NIV)"
                  : type === "lower-third"
                    ? "Title / Role"
                    : "Subtitle"
              }
              className="w-full px-4 py-2.5 rounded-xl bg-board-bg border border-board-border text-board-text placeholder:text-board-muted/50 focus:outline-none focus:border-fire-500 transition-colors text-sm"
            />
          </div>

          {/* ProPresenter slide import */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="block text-sm text-board-muted">Template</label>
              <span className="text-[10px] text-board-muted/60">{TEMPLATES.length} broadcast-ready styles</span>
            </div>
            <div className="grid grid-cols-2 gap-1.5 max-h-36 overflow-y-auto pr-1">
              {TEMPLATES.map((template) => (
                <button
                  key={template.id}
                  type="button"
                  onClick={() => setTemplateId(template.id)}
                  aria-pressed={templateId === template.id}
                  className={`min-h-11 text-left px-2.5 py-2 rounded-lg border transition-colors ${templateId === template.id ? "border-fire-500/35 bg-fire-500/10" : "border-board-border text-board-muted hover:border-board-muted/50"}`}
                >
                  <span className={`block text-[11px] font-medium ${templateId === template.id ? "text-fire-400" : "text-board-text"}`}>{template.name}</span>
                  <span className="block text-[9px] text-board-muted/60 mt-0.5">{template.category}</span>
                </button>
              ))}
            </div>
          </div>

          {/* ProPresenter slide import */}
          <div>
            <label className="block text-sm text-board-muted mb-1.5">
              Screen Position
            </label>
            <div className="grid grid-cols-3 gap-1 p-2 rounded-lg bg-board-bg border border-board-border">
              {POSITION_PRESETS.map((preset) => {
                const isActive =
                  Math.abs(posX - preset.x) < 5 && Math.abs(posY - preset.y) < 6;
                return (
                  <button
                    key={preset.label}
                    type="button"
                    onClick={() => {
                      setPosX(preset.x);
                      setPosY(preset.y);
                    }}
                    title={preset.label}
                    aria-label={`Position: ${preset.label}`}
                    aria-pressed={isActive}
                    className={`min-h-11 aspect-video rounded transition-all flex items-center justify-center ${
                      isActive
                        ? "bg-fire-500/25 border border-fire-500/40"
                        : "bg-board-border/30 border border-transparent hover:bg-board-border/60"
                    }`}
                  >
                    <div
                      className={`w-1.5 h-1.5 rounded-full ${
                        isActive ? "bg-fire-500" : "bg-board-muted/40"
                      }`}
                    />
                  </button>
                );
              })}
            </div>
            <p className="text-[10px] text-board-muted/50 mt-1.5">
              Place panelists in different corners so they don't overlap.
            </p>
          </div>

          {/* Accent color */}
          <div>
            <label className="block text-sm text-board-muted mb-1.5">
              Accent Color
            </label>
            <div className="flex flex-wrap gap-2">
              {ACCENT_PRESETS.map((p) => (
                <button
                  key={p.value}
                  type="button"
                  onClick={() => setAccentColor(p.value)}
                  title={p.label}
                  aria-label={`Accent: ${p.label}`}
                  aria-pressed={accentColor === p.value}
                  className="w-11 h-11 rounded-full border-2 transition-all"
                  style={{
                    background: p.value,
                    borderColor: accentColor === p.value ? "white" : "transparent",
                  }}
                />
              ))}
            </div>
          </div>

          </fieldset>
          {/* Buttons */}
          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={() => void requestClose()}
              disabled={saving}
              className="min-h-11 flex-1 px-4 py-2.5 rounded-xl border border-board-border text-board-muted hover:bg-board-border transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={mutation.locked || !title.trim()}
              className="min-h-11 flex-1 px-4 py-2.5 rounded-xl bg-fire-500 text-white font-semibold hover:bg-fire-600 disabled:opacity-50 transition-colors"
            >
              {saving ? "Saving..." : existing ? "Update" : "Create"}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
