import { createAuthEndpoint } from "better-auth/api";
import { deleteSessionCookie } from "better-auth/cookies";
import { z } from "zod";
import { idSchema } from "./validation";

/** ShowPilot uses database sessions and email/password authentication. */
export const confirmedSignOut = {
  id: "showpilot-confirmed-sign-out",
  endpoints: {
    signOut: createAuthEndpoint(
      "/sign-out",
      {
        method: "POST",
        requireHeaders: true,
        body: z
          .object({ expectedSessionId: idSchema.optional() })
          .strict()
          .optional(),
      },
      async (ctx) => {
        const token = await ctx.getSignedCookie(
          ctx.context.authCookies.sessionToken.name,
          ctx.context.secret,
        );
        if (token) {
          try {
            const current =
              await ctx.context.internalAdapter.findSession(token);
            if (
              current &&
              ctx.body?.expectedSessionId &&
              current.session.id !== ctx.body.expectedSessionId
            ) {
              ctx.setStatus(409);
              return ctx.json({
                code: "SIGN_IN_CHANGED",
                message:
                  "Your sign-in changed. Review the current account before signing out.",
              });
            }
            // Keep Better Auth's session-deletion hooks, including relay revocation.
            await ctx.context.internalAdapter.deleteSession(token);
            if (await ctx.context.internalAdapter.findSession(token)) {
              throw new Error("Session still exists after deletion");
            }
          } catch {
            ctx.context.logger.error(
              "Sign-out could not confirm session revocation",
            );
            ctx.setStatus(500);
            return ctx.json({
              code: "SIGN_OUT_UNCONFIRMED",
              message: "Sign-out could not be confirmed. Please retry.",
            });
          }
        }
        // A failed deletion must leave the cookie available for a safe retry.
        deleteSessionCookie(ctx);
        return ctx.json({ success: true });
      },
    ),
  },
};
