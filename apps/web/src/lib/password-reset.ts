import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { getAuth } from "./auth";
import { createD1RateLimitStorage } from "./auth-rate-limit.server";
import { parseOrThrow } from "./validation";

// Anonymous, read-only check. Better Auth owns token storage, expiry and use.
// Send the token in a POST body and return only validity, never account data.
export const checkPasswordResetLink = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ token: z.string().min(1).max(256) }), data))
  .handler(async ({ data }) => {
    const ip = getRequestHeaders().get("cf-connecting-ip") ?? "unknown";
    const limit = await createD1RateLimitStorage(env.DB).consume(`reset-link-check:${ip}`, { window: 60, max: 10 });
    if (!limit.allowed) throw new Error("Too many link checks. Wait a minute and try again.");
    const context = await getAuth().$context;
    // Same lookup as Better Auth's reset callback, without following its
    // redirect or consuming the one-use token. The reset endpoint validates
    // again at write time; this read never grants permission to change it.
    const verification = await context.internalAdapter.findVerificationValue(`reset-password:${data.token}`);
    return { valid: verification !== null && verification.expiresAt.getTime() > Date.now() };
  });
