import type { QueryClient } from "@tanstack/react-query";

export async function clearQueriesForIdentityTransition(
  queryClient: QueryClient,
  previousUserId: string | null,
  nextUserId: string | null,
): Promise<void> {
  if (previousUserId === nextUserId) return;
  await queryClient.cancelQueries();
  queryClient.clear();
}
