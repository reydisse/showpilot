import { useEffect, useState } from "react";
import {
  useMutation,
  useMutationState,
  useQueryClient,
} from "@tanstack/react-query";
import { z } from "zod";
import { authClient } from "@/lib/auth-client";
import { runRouteLoad } from "@/lib/route-load-deadlines";
import { Button } from "@/components/ui/button";

export function ProfilePasswordReset({
  userId,
  email,
}: {
  userId: string;
  email: string;
}) {
  const client = useQueryClient(),
    mutationKey = ["profile-password-reset", userId, email];
  const [now, setNow] = useState(Date.now);
  const history = useMutationState({
    filters: { mutationKey, exact: true },
    select: (entry) => ({
      status: entry.state.status,
      at: entry.state.submittedAt,
    }),
  });
  const latest = history.at(-1),
    pending = latest?.status === "pending",
    failed = latest?.status === "error",
    sent = latest?.status === "success";
  const remaining = latest
    ? Math.max(0, Math.ceil((latest.at + 60_000 - now) / 1000))
    : 0;
  useEffect(() => {
    if (!latest) return;
    const expires = latest.at + 60_000;
    setNow(Date.now());
    if (Date.now() >= expires) return;
    const timer = setInterval(() => {
      setNow(Date.now());
      if (Date.now() >= expires) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [latest?.at]);
  const mutation = useMutation({
    mutationKey,
    retry: false,
    networkMode: "always",
    gcTime: Infinity,
    mutationFn: () =>
      runRouteLoad(
        async (controller) => {
          const result = await authClient.requestPasswordReset({
            email,
            redirectTo: "/reset-password",
            fetchOptions: { signal: controller.signal, retry: 0 },
          });
          controller.signal.throwIfAborted();
          if (result.error)
            throw new Error("Reset email could not be confirmed.");
          return z.object({ status: z.literal(true) }).parse(result.data);
        },
        undefined,
        8_000,
      ),
    onSettled: () => {
      const cache = client.getMutationCache(),
        entries = cache.findAll({ mutationKey, exact: true });
      for (const old of entries)
        if (old !== entries.at(-1) && old.state.status !== "pending")
          cache.remove(old);
    },
  });
  return (
    <div className="space-y-2">
      {failed && latest ? (
        <div role="alert" className="space-y-1 text-xs text-red-400">
          <p>
            Reset email was not confirmed. It may arrive. Retry requests another
            link.
          </p>
          <p>
            Last attempt{" "}
            <time dateTime={new Date(latest.at).toISOString()}>
              {new Date(latest.at).toLocaleTimeString()}
            </time>
          </p>
          {remaining ? <p>Retry available in {remaining}s.</p> : null}
        </div>
      ) : null}
      <Button
        type="button"
        variant="outline"
        className="h-auto min-h-11 whitespace-normal"
        disabled={pending || sent || (failed && remaining > 0)}
        onClick={() => {
          if (
            client
              .getMutationCache()
              .findAll({ mutationKey, exact: true })
              .some((entry) => entry.state.status === "pending")
          )
            return;
          setNow(Date.now());
          mutation.mutate();
        }}
      >
        {pending
          ? "Requesting reset link…"
          : sent
            ? "Reset link requested"
            : failed
              ? "Retry reset email"
              : "Reset password"}
      </Button>
    </div>
  );
}
