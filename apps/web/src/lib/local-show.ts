import { createServerFn } from "@tanstack/react-start";
import { localShowPreparationInput } from "./local-show-protocol";
import { parseOrThrow } from "./validation";

export const prepareLocalShow = createServerFn({ method: "POST" })
  .inputValidator((value: unknown) =>
    parseOrThrow(localShowPreparationInput, value),
  )
  .handler(async ({ data }) => {
    const [
      { getAuth },
      { getRequestHeaders },
      { getPresentedRundownPin },
      { env },
    ] = await Promise.all([
      import("./auth"),
      import("@tanstack/react-start/server"),
      import("./rundown-pin.server"),
      import("cloudflare:workers"),
    ]);
    const headers = getRequestHeaders();
    const session = await getAuth().api.getSession({ headers });
    if (!session) throw new Error("Sign in before preparing a local show.");
    const rundownPin = getPresentedRundownPin(
      new Request("https://showpilot.local/local-preparation", { headers }),
      data.orgId,
    );
    const result = await env.BRIDGE_RELAY.getByName(
      data.orgId,
    ).prepareLocalShow(data, {
      orgId: data.orgId,
      userId: session.user.id,
      sessionId: session.session.id,
      rundownPin,
    });
    // RPC results carry a disposal method. Only the public scalar receipt crosses
    // the server-function serialization boundary.
    try {
      return {
        sessionId: result.sessionId,
        baseRevision: result.baseRevision,
        preparedAt: result.preparedAt,
        expiresAt: result.expiresAt,
        actionCount: result.actionCount,
      };
    } finally {
      result[Symbol.dispose]();
    }
  });
