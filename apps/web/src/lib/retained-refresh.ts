import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { runRouteLoad } from "./route-load-deadlines";

/** Claim a retained result before the first await. Only that exact pending
 * cache entry may finish, including after navigation, sign-out or a new save. */
export async function refreshRetainedResult<T>(options: {
  client: QueryClient;
  key: QueryKey;
  begin: (current: T | null | undefined) => {
    pending: T;
    done: T;
    failed: () => T;
  } | null;
  refresh: () => Promise<void>;
}): Promise<boolean> {
  const { client, key, begin, refresh } = options;
  const transition = begin(client.getQueryData<T | null>(key));
  if (!transition) return false;
  // setQueryData may structurally share an older value; capture the actual
  // stored object rather than comparing against the proposed object.
  const owner = client.setQueryData<T>(key, () => transition.pending);
  try {
    await runRouteLoad(() => refresh(), undefined, 12_000);
    if (client.getQueryData<T>(key) !== owner) return false;
    client.setQueryData<T>(key, () => transition.done);
    return true;
  } catch {
    if (client.getQueryData<T>(key) === owner)
      client.setQueryData<T>(key, transition.failed);
    return false;
  }
}
