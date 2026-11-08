import { z } from "zod";
import { authClient } from "./auth-client";
import { runRouteLoad } from "./route-load-deadlines";

const sessionSchema = z
  .object({
    user: z.object({ id: z.string().min(1) }),
    session: z.object({ id: z.string().min(1) }),
  })
  .nullable();
const successSchema = z.object({ success: z.literal(true) });
export type SignOutCommand = {
  userId: string;
  expectedSessionId: string | null;
};
export class SignOutFailure extends Error {
  constructor(
    readonly kind: "unconfirmed" | "changed",
    readonly command: SignOutCommand,
  ) {
    super(
      kind === "changed"
        ? "Your sign-in changed. Review the current account before signing out."
        : "Sign-out was not confirmed. You may still be signed in. Retry checks your session before trying again.",
    );
  }
}

export async function confirmAccountSignOut(original: SignOutCommand) {
  let command = original;
  try {
    return await runRouteLoad(
      async (controller) => {
        const fetchOptions = { signal: controller.signal, retry: 0 };
        const read = await authClient.getSession({
          query: { disableCookieCache: true },
          fetchOptions,
        });
        controller.signal.throwIfAborted();
        if (read.error) throw new Error("Session could not be checked");
        const current = sessionSchema.parse(read.data);
        if (!current) return { success: true };
        if (
          current.user.id !== command.userId ||
          (command.expectedSessionId &&
            current.session.id !== command.expectedSessionId)
        )
          throw new SignOutFailure("changed", command);
        command = {
          userId: command.userId,
          expectedSessionId: current.session.id,
        };
        // fetchOptions.body extends the built-in endpoint body while retaining
        // Better Auth's normal cross-tab session notifications on acknowledgement.
        const result = await authClient.signOut({
          fetchOptions: {
            ...fetchOptions,
            body: { expectedSessionId: command.expectedSessionId },
          },
        });
        controller.signal.throwIfAborted();
        if (result.error?.status === 409)
          throw new SignOutFailure("changed", command);
        if (result.error) throw new Error("Sign-out could not be confirmed");
        return successSchema.parse(result.data);
      },
      undefined,
      8_000,
    );
  } catch (error) {
    if (error instanceof SignOutFailure) throw error;
    throw new SignOutFailure("unconfirmed", command);
  }
}
