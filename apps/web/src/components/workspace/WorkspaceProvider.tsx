import { createContext, useContext, useState, type ReactNode } from "react";
import { Link, useLocation, useRouter } from "@tanstack/react-router";
import {
  resolveWorkspaceProfile,
  moduleForSurface,
  WORKSPACE_MODULES,
  type ModuleId,
  type WorkspaceProfile,
} from "@showpilot/shared";
import { setWorkspaceModules } from "@/lib/workspace/profile";
const Context = createContext<WorkspaceProfile>(resolveWorkspaceProfile({}));
export function WorkspaceProvider({
  profile,
  children,
}: {
  profile: WorkspaceProfile;
  children: ReactNode;
}) {
  return <Context.Provider value={profile}>{children}</Context.Provider>;
}
export function useWorkspace() {
  return useContext(Context);
}
export function useTerms() {
  return useWorkspace().terms;
}
export function useModuleEnabled(module: ModuleId) {
  return useWorkspace().modules.includes(module);
}
export function WorkspaceRouteGate({
  orgId,
  slug,
  canManage,
  children,
}: {
  orgId: string;
  slug: string;
  canManage: boolean;
  children: ReactNode;
}) {
  const profile = useWorkspace();
  const { pathname } = useLocation();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const module = moduleForSurface("web", pathname.slice(slug.length + 2));
  if (!module || profile.modules.includes(module)) return children;
  return (
    <section className="mx-auto max-w-xl p-8 text-board-text">
      <h1 className="text-xl font-semibold">
        {WORKSPACE_MODULES[module]} is turned off for this workspace.
      </h1>
      <p className="mt-3 text-sm text-board-muted">
        {canManage
          ? "Your content is still here. Enable this feature to open it."
          : "Ask an admin to turn it on."}
      </p>
      <Link
        to="/$slug/show"
        params={{ slug }}
        className="mt-5 inline-flex rounded-lg border border-board-border px-5 py-3"
      >
        Back to {profile.terms.event}
      </Link>
      {error && (
        <p role="alert" className="mt-3 text-red-400">
          {error}
        </p>
      )}
      {canManage && (
        <button
          disabled={busy}
          className="mt-5 rounded-lg bg-fire-500 px-5 py-3 text-black disabled:opacity-50"
          onClick={async () => {
            setBusy(true);
            try {
              await setWorkspaceModules({
                data: { orgId, modules: [...profile.modules, module] },
              });
              await router.invalidate();
            } catch (e) {
              setError(
                e instanceof Error
                  ? e.message
                  : "Could not enable this feature",
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          Enable {WORKSPACE_MODULES[module]}
        </button>
      )}
    </section>
  );
}
