import { PageBreadcrumb } from "@/components/ui/PageBreadcrumb";
import {
  createFileRoute,
  Link,
  redirect,
  useNavigate,
} from "@tanstack/react-router";
import { useRundownPinVerification } from "@/hooks/useRundownPinVerification";
import { Lock, ShieldAlert } from "lucide-react";
import { BoardSkeleton } from "@/components/ui/Skeleton";
import { getRundownPinRequirement } from "@/lib/rbac";
import {
  hasEffectivePermission,
  roleRequiresRundownPin,
} from "@/lib/app-permissions";

export const Route = createFileRoute("/$slug/rundown-pin")({
  pendingComponent: () => <BoardSkeleton />,
  beforeLoad: async ({ context, params }) => {
    if (
      !hasEffectivePermission(
        context.role,
        context.grantedPermissions,
        "rundown:view",
      )
    ) {
      throw redirect({ to: "/$slug/board", params: { slug: params.slug } });
    }

    if (!roleRequiresRundownPin(context.role)) {
      throw redirect({ to: "/$slug/rundown", params: { slug: params.slug } });
    }

    const requirement = await getRundownPinRequirement({
      data: { orgId: context.orgId },
    });
    if (!requirement.enabled) {
      throw redirect({ to: "/$slug/rundown", params: { slug: params.slug } });
    }

    return { orgId: context.orgId, slug: params.slug };
  },
  component: RundownPinPage,
});

function RundownPinPage() {
  const { orgId, slug } = Route.useRouteContext();
  const navigate = useNavigate();
  return (
    <RundownPinForm
      orgId={orgId}
      slug={slug}
      onUnlocked={() => navigate({ to: "/$slug/rundown", params: { slug } })}
    />
  );
}

export function RundownPinForm({
  orgId,
  slug,
  onUnlocked,
}: {
  orgId: string;
  slug: string;
  onUnlocked: () => Promise<void>;
}) {
  const { pin, state, submitting, verify, changePin } =
    useRundownPinVerification(orgId, onUnlocked);

  return (
    <div className="min-h-[100dvh] bg-board-bg flex items-center justify-center px-4 py-6">
      <div className="w-full max-w-sm rounded-2xl border border-board-border bg-board-card p-6 shadow-2xl">
        <PageBreadcrumb current="Unlock changes">
          <Link
            activeOptions={{ exact: true }}
            to="/$slug/rundown"
            params={{ slug }}
            className="inline-flex min-h-11 items-center rounded underline outline-none focus-visible:ring-2 focus-visible:ring-fire-500"
          >
            Back to rundown
          </Link>
        </PageBreadcrumb>
        <div className="flex items-center gap-3 mb-4">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-amber-500/10 text-amber-400 border border-amber-500/20">
            <Lock className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-board-text">
              Unlock changes
            </h1>
            <p className="text-xs text-board-muted">
              Enter the organization PIN to edit the rundown and use live
              controls. You can view the rundown without it.
            </p>
          </div>
        </div>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            void verify();
          }}
          className="space-y-4"
        >
          <div>
            <label
              htmlFor="rundown-pin"
              className="block text-sm text-board-muted mb-2"
            >
              PIN
            </label>
            <input
              id="rundown-pin"
              type="password"
              inputMode="numeric"
              autoFocus
              value={pin}
              onChange={(event) => changePin(event.target.value)}
              className="w-full rounded-xl border border-board-border bg-board-bg px-4 py-3 text-board-text outline-none focus:border-fire-500/50"
              placeholder="Enter rundown PIN"
            />
          </div>

          {state.status === "error" && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-300"
            >
              <ShieldAlert className="w-4 h-4 mt-0.5 shrink-0" />
              <div>
                <p>{state.message}</p>
                <time
                  dateTime={new Date(state.occurredAt).toISOString()}
                  className="mt-1 block text-xs"
                >
                  Last attempt:{" "}
                  {new Date(state.occurredAt).toLocaleTimeString()}
                </time>
              </div>
            </div>
          )}

          <button
            type="submit"
            disabled={submitting || !pin.trim()}
            className="w-full rounded-xl bg-fire-500 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-fire-600 disabled:opacity-50"
          >
            {submitting
              ? "Verifying..."
              : state.status === "error"
                ? "Retry verification"
                : "Unlock changes"}
          </button>
        </form>
      </div>
    </div>
  );
}
