import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { Lock, ShieldAlert } from "lucide-react";
import { BoardSkeleton } from "@/components/ui/Skeleton";
import { getRundownPinCookieName } from "@/middleware/withPermission";
import { validateRundownPin } from "@/lib/rbac";
import { hasPermission, roleRequiresRundownPin } from "@/lib/app-permissions";

export const Route = createFileRoute("/$slug/rundown-pin")({
  pendingComponent: () => <BoardSkeleton />,
  beforeLoad: ({ context, params }) => {
    if (!hasPermission(context.role, "rundown:view")) {
      throw redirect({ to: "/$slug/board", params: { slug: params.slug } });
    }

    if (!roleRequiresRundownPin(context.role)) {
      throw redirect({ to: "/$slug/rundown", params: { slug: params.slug } });
    }

    return { orgId: context.orgId, slug: params.slug };
  },
  component: RundownPinPage,
});

function RundownPinPage() {
  const { orgId, slug } = Route.useRouteContext();
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!pin.trim()) return;

    setSubmitting(true);
    setError(null);
    try {
      const result = await validateRundownPin({ data: { orgId, pin } });
      if (!result.ok) {
        setError("Incorrect PIN. Please try again.");
        return;
      }

      const secure = window.location.protocol === "https:" ? "; Secure" : "";
      document.cookie = `${getRundownPinCookieName(orgId)}=${encodeURIComponent(pin.trim())}; Path=/; Max-Age=14400; SameSite=Lax${secure}`;
      window.location.href = `/${slug}/rundown`;
    } catch {
      setError("Could not verify the PIN right now.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-[100dvh] bg-board-bg flex items-center justify-center px-4">
      <div className="w-full max-w-sm rounded-2xl border border-board-border bg-board-card p-6 shadow-2xl">
        <div className="flex items-center gap-3 mb-4">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-amber-500/10 text-amber-400 border border-amber-500/20">
            <Lock className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-board-text">Rundown PIN Required</h1>
            <p className="text-xs text-board-muted">Technical Manager access requires the organization PIN.</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="rundown-pin" className="block text-sm text-board-muted mb-2">PIN</label>
            <input
              id="rundown-pin"
              type="password"
              inputMode="numeric"
              autoFocus
              value={pin}
              onChange={(event) => setPin(event.target.value)}
              className="w-full rounded-xl border border-board-border bg-board-bg px-4 py-3 text-board-text outline-none focus:border-fire-500/50"
              placeholder="Enter rundown PIN"
            />
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-300">
              <ShieldAlert className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={submitting || !pin.trim()}
            className="w-full rounded-xl bg-fire-500 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-fire-600 disabled:opacity-50"
          >
            {submitting ? "Verifying..." : "Unlock Rundown"}
          </button>
        </form>
      </div>
    </div>
  );
}
