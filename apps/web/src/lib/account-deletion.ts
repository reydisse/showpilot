import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";

export const getAccountDeletionStatus = createServerFn({ method: "GET" }).handler(async () => {
  const { getAuth } = await import("@/lib/auth");
  const { getAccountDeletionOwnershipStatus } = await import("@/lib/account-deletion.server");
  let session: Awaited<ReturnType<ReturnType<typeof getAuth>["api"]["getSession"]>> | null = null;
  try {
    session = await getAuth().api.getSession({ headers: getRequestHeaders() });
  } catch {
    // Keep the public account-deletion resource reachable even when a local
    // environment is missing auth secrets. Sign-in will surface the config.
  }
  if (!session) return { signedIn: false as const, blockers: [] };
  const { blockers } = await getAccountDeletionOwnershipStatus(session.user.id);
  return {
    signedIn: true as const,
    email: session.user.email,
    blockers,
  };
});
