import { createFileRoute, redirect, Link } from "@tanstack/react-router";
import { useState } from "react";
import { Sparkles, Settings as SettingsIcon } from "lucide-react";
import { PageSkeleton } from "@/components/ui/Skeleton";
import { isAdminTier } from "@/lib/app-permissions";
import { setCloudEnabled } from "@/lib/settings";

// Explainer for when a role HAS lower-thirds permission but the org has cloud
// lower thirds turned off (organization.cloud_enabled = 0). The middleware
// returns feature_disabled and route-permissions redirects here instead of a
// silent /board bounce. See SHOWPILOT-FIXES-SPEC Task A3.
export const Route = createFileRoute("/$slug/streaming/lower-thirds-disabled")({
  pendingComponent: () => <PageSkeleton />,
  beforeLoad: ({ context, params }) => {
    // Already enabled → nothing to explain; go straight to the graphics studio.
    if (context.org.cloud_enabled) {
      throw redirect({
        to: "/$slug/streaming/graphics",
        params: { slug: params.slug },
      });
    }
    return { orgId: context.orgId, slug: params.slug, role: context.role };
  },
  component: LowerThirdsDisabledPage,
});

function LowerThirdsDisabledPage() {
  const { orgId, slug, role } = Route.useRouteContext();
  const canEnable = isAdminTier(role);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleEnable = async () => {
    if (!canEnable || saving) return;
    setSaving(true);
    setError(null);
    try {
      await setCloudEnabled({ data: { orgId, enabled: true } });
      // Hard navigate so the route context picks up the new flag and the
      // graphics loader's permission check passes.
      window.location.href = `/${slug}/streaming/graphics`;
    } catch {
      setError("Couldn't enable cloud lower thirds. Please try again.");
      setSaving(false);
    }
  };

  return (
    <div className="min-h-[100dvh] bg-board-bg flex items-center justify-center px-4">
      <div className="w-full max-w-md rounded-2xl border border-board-border bg-board-card p-6 shadow-2xl">
        <div className="flex items-center gap-3 mb-4">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-fire-500/10 text-fire-500 border border-fire-500/20">
            <Sparkles className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-board-text">
              Cloud lower thirds aren't enabled
            </h1>
            <p className="text-xs text-board-muted">
              This feature is turned off for this organization.
            </p>
          </div>
        </div>

        <p className="text-sm text-board-muted">
          Cloud lower thirds power browser-triggered graphics and the Template
          Studio. Turn it on to start triggering lower thirds from any device.
        </p>

        {error && (
          <p className="mt-3 text-xs text-red-400">{error}</p>
        )}

        <div className="mt-6 space-y-2">
          {canEnable ? (
            <button
              type="button"
              onClick={handleEnable}
              disabled={saving}
              className="w-full rounded-xl bg-fire-500 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-fire-600 disabled:opacity-50"
            >
              {saving ? "Enabling…" : "Enable cloud lower thirds"}
            </button>
          ) : (
            <p className="rounded-xl border border-board-border bg-board-bg px-4 py-3 text-xs text-board-muted">
              Ask an owner or admin to enable cloud lower thirds in settings.
            </p>
          )}

          <Link
            to="/$slug/settings"
            params={{ slug }}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-board-border px-4 py-3 text-sm text-board-muted transition-colors hover:text-board-text hover:bg-board-border/50"
          >
            <SettingsIcon className="w-4 h-4" />
            Open settings
          </Link>
        </div>
      </div>
    </div>
  );
}
