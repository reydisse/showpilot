import { useQuery } from "@tanstack/react-query";
import { authClient } from "@/lib/auth-client";
import { getMobileBootstrap } from "@/lib/mobile-api";

export function useMobileBootstrap() {
  const { data: organization } = authClient.useActiveOrganization();
  const query = useQuery({
    queryKey: ["mobile-bootstrap", organization?.id],
    queryFn: () => getMobileBootstrap(organization!.id),
    enabled: Boolean(organization?.id),
    refetchInterval: 30_000,
  });
  return { organization, ...query };
}
