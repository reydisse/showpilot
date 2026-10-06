import {
  createContext,
  useContext,
  useMemo,
  useCallback,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  resolveWorkspaceProfile,
  type WorkspaceProfile,
  type ModuleId,
} from "@showpilot/shared";
import { useMobileBootstrap } from "@/hooks/use-mobile-bootstrap";
import { authClient } from "@/lib/auth-client";
import type { MobileBootstrap } from "@/lib/mobile-api";
const Context = createContext({
  profile: resolveWorkspaceProfile({}),
  update: (_profile: WorkspaceProfile) => {},
});
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { data, organization } = useMobileBootstrap();
  const { data: session } = authClient.useSession();
  const queryClient = useQueryClient();
  const subscribe = useCallback(
    (onChange: () => void) => queryClient.getQueryCache().subscribe(onChange),
    [queryClient],
  );
  const legacySnapshot = useCallback(
    () =>
      queryClient
        .getQueriesData<{
          terminologyProfile?: string;
        }>({ queryKey: ["mobile-schedule", organization?.id] })
        .find(([, schedule]) => schedule?.terminologyProfile)?.[1]
        ?.terminologyProfile,
    [queryClient, organization?.id],
  );
  const legacy = useSyncExternalStore(
    subscribe,
    legacySnapshot,
    legacySnapshot,
  );
  const value = useMemo(() => {
    return {
      profile:
        data?.workspace ??
        resolveWorkspaceProfile({ "terminology-profile": legacy }),
      update: (profile: WorkspaceProfile) => {
        queryClient.setQueryData<MobileBootstrap>(
          ["mobile-bootstrap", session?.user.id, organization?.id],
          (current) => (current ? { ...current, workspace: profile } : current),
        );
      },
    };
  }, [
    data?.workspace,
    legacy,
    organization?.id,
    queryClient,
    session?.user.id,
  ]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useWorkspace() {
  return useContext(Context).profile;
}
export function useWorkspaceUpdate() {
  return useContext(Context).update;
}
export function useTerms() {
  return useWorkspace().terms;
}
export function useModuleEnabled(module: ModuleId) {
  return useWorkspace().modules.includes(module);
}
