import { Button } from "@/components/ui/button";
import type { useAccountProfile } from "@/hooks/useAccountProfile";

export function ProfileRecovery({
  controls,
}: {
  controls: ReturnType<typeof useAccountProfile>;
}) {
  const { profile, attempt, readFailed, pending } = controls;
  return (
    <div className="space-y-3 text-xs">
      {profile.isPending && !readFailed ? (
        <p role="status" className="text-board-muted">
          Checking saved profile…
        </p>
      ) : null}
      {readFailed ? (
        <div
          role="alert"
          className="space-y-2 rounded-lg border border-red-500/25 bg-red-500/10 p-3 text-red-400"
        >
          <p>Saved profile could not be checked. Your draft is still here.</p>
          <p>
            Last failed read{" "}
            <time dateTime={new Date(profile.errorUpdatedAt).toISOString()}>
              {new Date(profile.errorUpdatedAt).toLocaleTimeString()}
            </time>
          </p>
          <Button
            variant="outline"
            className="min-h-11"
            disabled={profile.isFetching || pending}
            onClick={() => void profile.refetch()}
          >
            {profile.isFetching ? "Retrying…" : "Retry profile check"}
          </Button>
        </div>
      ) : null}
      {attempt?.kind === "pending" ? (
        <p role="status" className="text-board-muted">
          {attempt.command.kind === "photo-selection"
            ? "Preparing photo…"
            : "Saving profile… Waiting for confirmation."}
        </p>
      ) : null}
      {attempt?.kind === "failed" ? (
        <div
          role="alert"
          className="space-y-2 rounded-lg border border-red-500/25 bg-red-500/10 p-3 text-red-400"
        >
          <p>{attempt.message}</p>
          <p>
            Last attempt{" "}
            <time dateTime={new Date(attempt.at).toISOString()}>
              {new Date(attempt.at).toLocaleTimeString()}
            </time>
          </p>
          <Button
            variant="outline"
            className="min-h-11"
            onClick={controls.retry}
          >
            {attempt.preparing
              ? "Retry photo preparation"
              : "Retry profile save"}
          </Button>
        </div>
      ) : null}
      {attempt?.kind === "resolved" && attempt.outcome !== "applied" ? (
        <div
          role="status"
          className="space-y-2 rounded-lg border border-amber-500/25 bg-amber-500/10 p-3 text-amber-700 dark:text-amber-300"
        >
          <p>
            Your profile changed elsewhere. The newer profile was kept. Review
            the saved details before applying your draft again.
          </p>
          {attempt.command.kind === "photo" ? (
            <Button
              className="min-h-11"
              variant="outline"
              disabled={controls.locked}
              onClick={controls.applySelectedPhoto}
            >
              Use selected photo
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
