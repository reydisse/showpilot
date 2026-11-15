import { plainFailure } from "@showpilot/shared/ui-feedback";
import { QuietActivity } from "@/components/ui/QuietActivity";
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
        <QuietActivity label="Checking saved profile…" />
      ) : null}
      {readFailed ? (
        <div
          role="alert"
          className="space-y-2 rounded-lg border border-red-500/25 bg-red-500/10 p-3 text-red-400"
        >
          <p>Your profile could not be loaded.</p>

          <Button
            variant="outline"
            className="min-h-11"
            disabled={profile.isFetching || pending}
            onClick={() => void profile.refetch()}
          >
            {profile.isFetching ? <QuietActivity label="Retrying…" /> : "Retry profile check"}
          </Button>
        </div>
      ) : null}
      {attempt?.kind === "pending" ? (
        <p role="status" className="text-board-muted">
          {attempt.command.kind === "photo-selection"
            ? <QuietActivity label="Preparing photo…" />
            : <QuietActivity label="Saving profile…" />}
        </p>
      ) : null}
      {attempt?.kind === "failed" ? (
        <div
          role="alert"
          className="space-y-2 rounded-lg border border-red-500/25 bg-red-500/10 p-3 text-red-400"
        >
          <p>{plainFailure((attempt.message) ?? "")}</p>

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
            Your profile was changed elsewhere.</p>
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
