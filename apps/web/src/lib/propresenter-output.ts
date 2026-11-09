import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { env } from "cloudflare:workers";
import { z } from "zod";
import {
  proPresenterOutputScopeSchema,
  proPresenterOutputCommandSchema,
} from "@showpilot/shared/propresenter-output";
import { getAuth } from "./auth";
import { parseOrThrow } from "./validation";
import { getPresentedRundownPin } from "./rundown-pin.server";
import {
  readMemberProPresenterOutput,
  writeProPresenterOutput,
} from "./propresenter-output.server";
import { notifyProPresenterOutput } from "./propresenter-output-notify.server";

const surface = z.enum(["rundown", "settings"]);
async function actor(scope: { orgId: string; userId: string }) {
  const headers = getRequestHeaders();
  const session = await getAuth().api.getSession({
    headers,
    query: { disableCookieCache: true },
  });
  if (!session || session.user.id !== scope.userId)
    throw new Error("Sign in to the account that started this output change.");
  return {
    ...scope,
    sessionId: session.session.id,
    rundownPin: getPresentedRundownPin(
      new Request("https://showpilot.local/output", { headers }),
      scope.orgId,
    ),
  };
}
export const getProPresenterOutput = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) =>
    parseOrThrow(proPresenterOutputScopeSchema.extend({ surface }), data),
  )
  .handler(async ({ data }) =>
    readMemberProPresenterOutput(env.DB, await actor(data), data.surface),
  );

export const changeProPresenterOutput = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(proPresenterOutputCommandSchema.extend({ surface }), data),
  )
  .handler(async ({ data }) => {
    const claim = await actor(data);
    const { surface: source, ...command } = data;
    const result = await writeProPresenterOutput(
      env.DB,
      command,
      claim,
      source,
    );
    if (result.outcome === "applied" || result.outcome === "superseded")
      await notifyProPresenterOutput(env, data.orgId);
    return result;
  });
