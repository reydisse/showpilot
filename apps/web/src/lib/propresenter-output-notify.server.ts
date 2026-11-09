import { getActiveRundownRelayTarget } from "./active-rundown-relay";
import { rundownInternalRequest } from "./rundown-internal-request.server";
import { withOperationTimeout } from "./operation-timeout";

/** Reconcile the saved setting, never repeat a toggle. Receipt recovery can
 * safely retry this after the database commit or a lost relay acknowledgement. */
export async function notifyProPresenterOutput(
  environment: {
    DB: Parameters<typeof getActiveRundownRelayTarget>[0];
    BETTER_AUTH_SECRET?: string;
    RUNDOWN_RELAY?: {
      getByName(name: string): { fetch(request: Request): Promise<Response> };
    };
  },
  orgId: string,
) {
  if (!environment.RUNDOWN_RELAY || !environment.BETTER_AUTH_SECRET)
    throw new Error("Live output delivery is unavailable.");
  const target = await getActiveRundownRelayTarget(environment.DB, orgId);
  const response = await withOperationTimeout(
    environment.RUNDOWN_RELAY.getByName(target.key).fetch(
      rundownInternalRequest(
        `https://rundown.local/refresh-output?orgId=${encodeURIComponent(orgId)}`,
        environment.BETTER_AUTH_SECRET,
        { method: "POST" },
      ),
    ),
    8_000,
    "The output setting was saved, but live delivery could not be confirmed. Recover the original request.",
  );
  await response.arrayBuffer();
  if (!response.ok)
    throw new Error(
      "Live output delivery could not be confirmed. Recover the original request.",
    );
}
