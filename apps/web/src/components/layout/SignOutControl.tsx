import { useEffect, useState } from "react";
import {
  useMutation,
  useMutationState,
  useQueryClient,
} from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { confirmAccountSignOut, SignOutFailure } from "@/lib/account-sign-out";

/** Account menu and profile share an unfinished attempt, even after unmount. */
export function SignOutControl({ userId }: { userId: string }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [armedUntil, setArmedUntil] = useState(0);
  const mutationKey = ["account-sign-out", userId];
  const history = useMutationState({
    filters: { mutationKey, exact: true },
    select: (entry) => ({
      status: entry.state.status,
      at: entry.state.submittedAt,
      failure:
        entry.state.error instanceof SignOutFailure ? entry.state.error : null,
    }),
  });
  const latest = history.at(-1);
  const pending = latest?.status === "pending";
  const failure = latest?.status === "error" ? latest.failure : null;
  const mutation = useMutation({
    mutationKey,
    mutationFn: confirmAccountSignOut,
    retry: false,
    networkMode: "always",
    gcTime: Infinity,
    onSuccess: () => {
      client.clear();
      // Full document navigation also discards private route/query state.
      void navigate({ to: "/login", reloadDocument: true, replace: true });
    },
    onSettled: () => {
      const cache = client.getMutationCache(),
        entries = cache.findAll({ mutationKey, exact: true });
      for (const old of entries)
        if (old !== entries.at(-1) && old.state.status !== "pending")
          cache.remove(old);
    },
  });
  useEffect(() => {
    if (!armedUntil) return;
    const timer = setTimeout(
      () => setArmedUntil(0),
      Math.max(0, armedUntil - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [armedUntil]);
  const submit = () => {
    if (
      client
        .getMutationCache()
        .findAll({ mutationKey, exact: true })
        .some((entry) => entry.state.status === "pending")
    )
      return;
    if (!failure && armedUntil <= Date.now()) {
      setArmedUntil(Date.now() + 4_000);
      return;
    }
    setArmedUntil(0);
    mutation.mutate(failure?.command ?? { userId, expectedSessionId: null });
  };
  return (
    <div className="min-w-0 space-y-2">
      {failure && latest ? (
        <div
          role="alert"
          aria-label="Sign-out recovery"
          className="space-y-1 rounded-lg border border-red-500/25 bg-red-500/10 p-3 text-xs text-red-400"
        >
          <p>{failure.message}</p>
          <p>
            Last attempt{" "}
            <time dateTime={new Date(latest.at).toISOString()}>
              {new Date(latest.at).toLocaleTimeString()}
            </time>
          </p>
        </div>
      ) : null}
      {failure?.kind === "changed" ? (
        <a
          href={window.location.pathname + window.location.search}
          className="flex min-h-11 items-center rounded-lg border border-board-border px-3 text-sm text-board-text"
        >
          Review current sign-in
        </a>
      ) : (
        <Button
          type="button"
          variant="ghost"
          className="h-auto min-h-11 whitespace-normal text-left text-red-400 hover:text-red-300"
          disabled={pending}
          onClick={submit}
        >
          <LogOut data-icon="inline-start" />
          {pending
            ? "Signing out…"
            : failure
              ? "Retry sign-out"
              : armedUntil
                ? "Tap again to sign out"
                : "Sign Out"}
        </Button>
      )}
      {pending ? (
        <p role="status" className="text-xs text-board-muted">
          Waiting for sign-out confirmation…
        </p>
      ) : null}
    </div>
  );
}
