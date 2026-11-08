import { getAuth } from "./auth";
import { markDatabaseWrite } from "./request-database.server";
import { rundownRelayKey } from "./rundown-relay-key";
import {
  showDetailsInputSchema,
  showDetailsResultSchema,
  type ShowDetailsInput,
} from "./show-details-contract";

type Environment = {
  BETTER_AUTH_SECRET?: string;
  RUNDOWN_RELAY?: {
    getByName(name: string): { fetch(request: Request): Promise<Response> };
  };
};
/** Bind retained browser requests to the currently authenticated account. The
 * relay checks session/permission again when its serialized mutation executes. */
export async function saveShowDetailsRequest(
  headers: Headers,
  input: ShowDetailsInput,
  env: Environment,
  mode: "save" | "review" = "save",
) {
  const data = showDetailsInputSchema.parse(input);
  const session = await getAuth().api.getSession({
    headers,
    query: { disableCookieCache: true },
  });
  if (!session || (data.userId && data.userId !== session.user.id))
    throw new Error(
      "Your account changed. Reopen this form before saving show details.",
    );
  if (mode === "review" && !data.requestId)
    throw new Error("Choose the original save request before reviewing it.");
  if (!env.RUNDOWN_RELAY || !env.BETTER_AUTH_SECRET)
    throw new Error("Live show editing is temporarily unavailable.");
  const command = {
    ...data,
    requestId: data.requestId ?? crypto.randomUUID(),
    userId: session.user.id,
  };
  const relay = env.RUNDOWN_RELAY.getByName(
    rundownRelayKey(
      data.orgId,
      data.serviceDate,
      data.serviceDate,
      data.showId,
    ),
  );
  const url = new URL("https://rundown.internal/internal/show-details");
  url.searchParams.set("orgId", data.orgId);
  markDatabaseWrite();
  const response = await relay.fetch(
    new Request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-showpilot-internal-secret": env.BETTER_AUTH_SECRET,
      },
      body: JSON.stringify({ command, sessionId: session.session.id, mode }),
    }),
  );
  const result: unknown = await response.json();
  if (!response.ok) {
    const message =
      typeof result === "object" &&
      result !== null &&
      "error" in result &&
      typeof result.error === "string"
        ? result.error
        : "Could not confirm the show details save.";
    throw new Error(message);
  }
  const saved = showDetailsResultSchema.parse(result);
  if (saved.requestId !== command.requestId || saved.showId !== command.showId)
    throw new Error(
      "The save returned a different show. Refresh before trying again.",
    );
  // Older clients have no retained request/result state and expect rejection.
  if (!data.requestId && saved.outcome !== "applied")
    throw new Error(
      "This show changed on another device. Refresh and try again.",
    );
  return saved;
}
