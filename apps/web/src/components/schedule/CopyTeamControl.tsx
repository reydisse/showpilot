import {
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { copyScheduleTeam } from "@/lib/schedule-copy";
import {
  copyTeamBlockedMessage,
  copyTeamResultSchema,
  type CopyTeamCommand,
  type CopyTeamResult,
  type CopyTeamSelection,
} from "@/lib/schedule-copy-contract";
import { runRouteLoad } from "@/lib/route-load-deadlines";
import { reminderMessage } from "@/lib/schedule-reminder-contract";

type Attempt = {
  command: CopyTeamCommand;
  result: CopyTeamResult | null;
  phase: "pending" | "failed" | "confirmed";
  refresh: "pending" | "failed" | "done";
};
type Scope = Pick<CopyTeamCommand, "orgId" | "userId" | "showId">;
const keyFor = (scope: Scope) => [
  "schedule-copy",
  scope.userId,
  scope.orgId,
  scope.showId,
];
async function refreshResult(
  client: QueryClient,
  attempt: Attempt,
  refresh: () => Promise<void>,
  requireIdle = false,
) {
  const key = keyFor(attempt.command);
  if (requireIdle) {
    const live = client.getQueryData<Attempt | null>(key);
    if (
      !live ||
      live.command.requestId !== attempt.command.requestId ||
      live.phase === "pending" ||
      live.refresh === "pending"
    )
      return false;
    attempt = live;
  }
  client.setQueryData(key, { ...attempt, refresh: "pending" });
  try {
    await runRouteLoad(() => refresh(), undefined, 12_000);
    client.setQueryData(key, { ...attempt, refresh: "done" });
    return true;
  } catch {
    client.setQueryData(key, { ...attempt, refresh: "failed" });
    return false;
  }
}
async function execute(
  client: QueryClient,
  command: CopyTeamCommand,
  refresh: () => Promise<void>,
) {
  const key = keyFor(command),
    old = client.getQueryData<Attempt | null>(key);
  if (old?.phase === "pending" || old?.refresh === "pending") return;
  const attempt: Attempt = {
    command,
    result: old?.result ?? null,
    phase: "pending",
    refresh: "done",
  };
  client.setQueryData(key, attempt);
  try {
    const result = await runRouteLoad(
      async (controller) => {
        const result = copyTeamResultSchema.parse(
          await copyScheduleTeam({ data: command, signal: controller.signal }),
        );
        controller.signal.throwIfAborted();
        if (
          result.orgId !== command.orgId ||
          result.userId !== command.userId ||
          result.requestId !== command.requestId
        )
          throw new Error("Copy acknowledgement does not match this request.");
        return result;
      },
      undefined,
      15_000,
    );
    await refreshResult(
      client,
      { ...attempt, result, phase: "confirmed" },
      refresh,
    );
  } catch {
    client.setQueryData(key, { ...attempt, phase: "failed" });
  }
}
const button =
  "min-h-11 rounded-lg border border-board-border px-3 py-2 text-xs text-board-text focus-visible:outline-2 focus-visible:outline-fire-500 disabled:opacity-50";
export function CopyTeamControl({
  orgId,
  userId,
  showId,
  selection,
  canCopy,
  onChanged,
}: Scope & {
  selection: CopyTeamSelection | null;
  canCopy: boolean;
  onChanged: () => Promise<void>;
}) {
  const client = useQueryClient(),
    key = keyFor({ orgId, userId, showId });
  const { data: attempt = null } = useQuery<Attempt | null>({
    queryKey: key,
    queryFn: () => null,
    initialData: null,
    enabled: false,
    gcTime: Infinity,
  });
  const pending =
    attempt?.phase === "pending" || attempt?.refresh === "pending";
  const result = attempt?.result;
  const retryable =
    attempt?.phase === "failed" ||
    result?.items.some(
      (item) =>
        item.invitation &&
        ["uncertain", "failed", "sending", "unavailable"].includes(
          item.invitation.email,
        ),
    );
  const start = () => {
    if (!selection || !canCopy || client.getQueryData(key)) return;
    void execute(
      client,
      { orgId, userId, ...selection, requestId: crypto.randomUUID() },
      onChanged,
    );
  };
  return (
    <div className="min-w-0 max-w-full space-y-2 text-xs sm:max-w-md">
      {!attempt && (
        <>
          <button
            type="button"
            className={button}
            disabled={!selection || !canCopy}
            onClick={start}
          >
            Copy team
          </button>
          {!selection && (
            <p className="text-board-muted">
              Choose a show with an earlier crew list to copy.
            </p>
          )}
        </>
      )}
      {pending && (
        <p role="status">
          {attempt?.phase === "pending"
            ? "Checking team copy…"
            : "Copy result received. Refreshing Schedule…"}
        </p>
      )}
      {attempt?.phase === "failed" && (
        <p role="alert" className="text-amber-300">
          Team copy was not confirmed. Positions or invitations may already
          exist. Retry checks the original request.
        </p>
      )}
      {result && (
        <div role="status" className="space-y-2 break-words">
          <p>
            {result.reason
              ? copyTeamBlockedMessage(result.reason)
              : `${result.copied} position${result.copied === 1 ? "" : "s"} copied from ${attempt.command.copyFrom}.`}
          </p>
          {result.items.map((item) => (
            <p
              key={item.id}
              className={
                item.changed ||
                (item.invitation && item.invitation.email !== "accepted")
                  ? "text-amber-300"
                  : "text-board-muted"
              }
            >
              <span className="font-medium">{item.label}: </span>
              {item.changed
                ? "Changed or removed since this copy. The newer state was kept."
                : item.invitation
                  ? reminderMessage(item.invitation)
                  : "Open position. No invitation needed."}
            </p>
          ))}
        </div>
      )}
      {!pending && attempt && retryable && (
        <button
          type="button"
          className={button}
          onClick={() => void execute(client, attempt.command, onChanged)}
        >
          Retry team copy
        </button>
      )}
      {attempt?.refresh === "failed" && (
        <div role="alert" className="space-y-2">
          <p>The copy result is known, but Schedule could not refresh.</p>
          <button
            type="button"
            className={button}
            onClick={() => void refreshResult(client, attempt, onChanged, true)}
          >
            Retry refresh
          </button>
        </div>
      )}
      {attempt?.phase === "confirmed" &&
        !pending &&
        !retryable &&
        attempt.refresh === "done" &&
        canCopy &&
        selection && (
          <button
            type="button"
            className={button}
            onClick={async () => {
              // Refresh first; the next explicit Copy uses the current source selection.
              if (await refreshResult(client, attempt, onChanged, true))
                client.setQueryData(key, null);
            }}
          >
            Review another copy
          </button>
        )}
    </div>
  );
}
