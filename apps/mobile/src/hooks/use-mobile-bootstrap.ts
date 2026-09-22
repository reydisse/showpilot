import { useQuery } from "@tanstack/react-query";
import { authClient } from "@/lib/auth-client";
import { getMobileBootstrap } from "@/lib/mobile-api";

type MobileBootstrapOptions = {
  enabled?: boolean;
  poll?: boolean;
};

export function useMobileBootstrap({ enabled = true, poll = false }: MobileBootstrapOptions = {}) {
  const { data: organization } = authClient.useActiveOrganization();
  const { data: session } = authClient.useSession();
  const query = useQuery({
    queryKey: ["mobile-bootstrap", session?.user.id, organization?.id],
    queryFn: () => getMobileBootstrap(organization!.id),
    enabled: enabled && Boolean(session?.user.id) && Boolean(organization?.id),
    // Push notifications carry urgent changes. A slower safety refresh keeps
    // badges and organization state current without a permanent 5-second
    // request loop on every authenticated screen.
    refetchInterval: poll ? 30_000 : false,
  });
  return { organization, ...query };
}
