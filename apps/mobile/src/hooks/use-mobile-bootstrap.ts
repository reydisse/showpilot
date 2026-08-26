import { useQuery } from "@tanstack/react-query";
import { authClient } from "@/lib/auth-client";
import { getMobileBootstrap } from "@/lib/mobile-api";

type MobileBootstrapOptions = {
  enabled?: boolean;
  poll?: boolean;
};

export function useMobileBootstrap({ enabled = true, poll = false }: MobileBootstrapOptions = {}) {
  const { data: organization } = authClient.useActiveOrganization();
  const query = useQuery({
    queryKey: ["mobile-bootstrap", organization?.id],
    queryFn: () => getMobileBootstrap(organization!.id),
    enabled: enabled && Boolean(organization?.id),
    refetchInterval: poll ? 30_000 : false,
  });
  return { organization, ...query };
}
