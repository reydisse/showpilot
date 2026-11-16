import { useQuery } from "@tanstack/react-query";
import { authClient } from "@/lib/auth-client";
import { getMobileBootstrap } from "@/lib/mobile-api";

type MobileBootstrapOptions = {
  enabled?: boolean;
  poll?: boolean;
  retry?: boolean;
};

export function useMobileBootstrap({ enabled = true, poll = false, retry }: MobileBootstrapOptions = {}) {
  const { data: organization, isPending: organizationPending } = authClient.useActiveOrganization();
  const { data: session } = authClient.useSession();
  const query = useQuery({
    queryKey: ["mobile-bootstrap", session?.user.id, organization?.id],
    queryFn: () => getMobileBootstrap(organization!.id),
    retry,
    enabled: enabled && Boolean(session?.user.id) && Boolean(organization?.id),
    // Push notifications carry urgent changes. A slower safety refresh keeps
    // badges and organization state current without a permanent 5-second
    // request loop on every authenticated screen.
    refetchInterval: poll ? 30_000 : false,
  });
  // React Query retains data for this identity while refreshing. Background
  // failures must not replace settled lists or introduce an operator alert.
  return { organization, organizationPending, ...query,
    error: query.data === undefined ? query.error : null,
  };
}
