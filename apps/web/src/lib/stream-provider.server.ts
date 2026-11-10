import { env } from "cloudflare:workers";
import { z } from "zod";

export class StreamProviderError extends Error {
  constructor(
    message: string,
    readonly kind: "rejected" | "unconfirmed" | "not_found" = "unconfirmed",
  ) {
    super(message);
  }
}

/** Trusted callers pass path segments; no provider URL or raw error crosses this boundary. */
export async function streamProviderRequest(
  segments: readonly string[],
  method: "GET" | "POST" | "PUT" | "DELETE",
  body?: unknown,
): Promise<unknown> {
  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_STREAM_API_TOKEN)
    throw new StreamProviderError(
      "Streaming provider credentials are not configured.",
      "rejected",
    );
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}/stream/${segments.map(encodeURIComponent).join("/")}`,
          {
            method,
            headers: {
              Authorization: `Bearer ${env.CLOUDFLARE_STREAM_API_TOKEN}`,
              "Content-Type": "application/json",
            },
            signal: controller.signal,
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          },
        );
        if (response.status === 404) {
          await response.body?.cancel();
          if (method === "DELETE") return null;
          throw new StreamProviderError(
            "The provider could not find this live input.",
            "not_found",
          );
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new StreamProviderError(
            "The streaming provider did not confirm this request. Retry to check its result.",
            [400, 401, 403, 405, 422].includes(response.status)
              ? "rejected"
              : "unconfirmed",
          );
        }
        if (
          response.status === 204 &&
          (method === "DELETE" || method === "PUT")
        )
          return null;
        const value: unknown = await response.json();
        if (
          !z.object({ success: z.literal(true).optional() }).safeParse(value)
            .success
        )
          throw new StreamProviderError(
            "The streaming provider returned an unreadable result. Retry to reconcile it.",
          );
        return value;
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(
            new StreamProviderError(
              "The streaming provider did not respond within five seconds. Retry the same request.",
            ),
          );
        }, 5_000);
      }),
    ]);
  } catch (error) {
    if (error instanceof StreamProviderError) throw error;
    throw new StreamProviderError(
      "The streaming provider response could not be confirmed. Retry the same request.",
    );
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
