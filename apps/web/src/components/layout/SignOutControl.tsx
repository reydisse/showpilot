import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";
import { lockLocalAccount } from "@/lib/local-account-exit";
import { reconcileSignOut } from "@/lib/sign-out-reconciliation";

export function exitAccountLocally(client: ReturnType<typeof useQueryClient>, userId: string) {
    lockLocalAccount();
    const session = authClient.$store.atoms.session;
    const expectedSessionId = session.get().data?.session.id ?? null;
    session.set({ ...session.get(), data: null, error: null, isPending: false });
    const activeOrganization = authClient.$store.atoms.activeOrganization;
    if (activeOrganization) activeOrganization.set({ ...activeOrganization.get(), data: null, error: null, isPending: false, isRefetching: false });
    const listOrganizations = authClient.$store.atoms.listOrganizations;
    if (listOrganizations) listOrganizations.set({ ...listOrganizations.get(), data: null, error: null, isPending: false, isRefetching: false });
    const activeMember = authClient.$store.atoms.activeMember;
    if (activeMember) activeMember.set({ ...activeMember.get(), data: null, error: null, isPending: false, isRefetching: false });
    const activeMemberRole = authClient.$store.atoms.activeMemberRole;
    if (activeMemberRole) activeMemberRole.set({ ...activeMemberRole.get(), data: null, error: null, isPending: false, isRefetching: false });
    void client.cancelQueries();
    client.clear();
    reconcileSignOut({ userId, expectedSessionId });
}

export function SignOutControl({ userId }: { userId: string }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const router = useRouter();
  useEffect(() => {
    // Warm the public form without running its authenticated beforeLoad hook.
    for (const id of ["/_auth", "/_auth/login"] as const) {
      const component = router.routesById[id]?.options.component;
      if (component && "preload" in component && typeof component.preload === "function")
        void Promise.resolve(component.preload()).catch(() => undefined);
    }
  }, [router]);
  const clicked = useRef(false);
  const submit = () => {
    if (clicked.current) return;
    clicked.current = true;
    exitAccountLocally(client, userId);
    void navigate({ to: "/login", replace: true, ignoreBlocker: true });
  };
  return <Button type="button" variant="ghost" className="h-auto min-h-11 whitespace-normal text-left text-red-400 hover:text-red-300" onClick={submit}>
    <LogOut data-icon="inline-start" />Sign Out
  </Button>;
}
