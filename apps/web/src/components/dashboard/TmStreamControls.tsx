import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useTmStream } from "@/hooks/useTmStream";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ReadFailureNotice } from "@/components/layout/ReadFailureNotice";
import type { TmStreamReview } from "@/lib/tm-stream-contract";
const statusLabels = {
  enabled: "Output enabled",
  disabled: "Output disabled",
  missing: "Output missing",
  unconfirmed: "Not confirmed",
  unknown: "Status unavailable",
  none: "Not connected",
};
export function TmStreamControls(props: {
  orgId: string;
  userId: string;
  slug: string;
}) {
  return <StreamControls key={`${props.orgId}:${props.userId}`} {...props} />;
}
function StreamControls({
  orgId,
  userId,
  slug,
}: {
  orgId: string;
  userId: string;
  slug: string;
}) {
  const control = useTmStream(orgId, userId),
    { read } = control,
    state = read.data;
  const [review, setReview] = useState<TmStreamReview | null>(null),
    [selectedInput, setSelectedInput] = useState(""),
    [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  const input =
    state?.inputs.find((input) => input.id === selectedInput) ??
    (state?.inputs.length === 1 ? state.inputs[0] : undefined);
  const stale = !!read.dataUpdatedAt && now - read.dataUpdatedAt > 10_000,
    readFailure =
      read.isError ||
      (read.isFetching && read.errorUpdatedAt > read.dataUpdatedAt),
    unknown = state?.destinations.some(
      (destination) => destination.status === "unknown",
    ),
    liveDisabled =
      !state?.canControl ||
      readFailure ||
      stale ||
      unknown ||
      !!control.unfinished ||
      !input ||
      !state.destinations.some((destination) => destination.enabled),
    stopDisabled =
      state?.canControl === false ||
      control.unfinished?.command.action === "stream-stop" ||
      (!state?.destinations.some(
        (destination) => destination.enabled || destination.status !== "none",
      ) &&
        !control.unfinished);
  function request(action: "stream-live" | "stream-stop") {
    if (action === "stream-live" ? liveDisabled : stopDisabled) return;
    const targets = new Map(
      (state?.destinations ?? [])
        .filter((destination) =>
          action === "stream-live"
            ? destination.enabled
            : destination.enabled || destination.status !== "none",
        )
        .map((destination) => [
          destination.id,
          { id: destination.id, version: destination.version },
        ]),
    );
    const names = Object.fromEntries(
      (state?.destinations ?? []).map((destination) => [
        destination.id,
        destination.name,
      ]),
    );
    // Stop includes the original Go Live targets even if a new read no longer
    // lists them as enabled. Never silently drop an uncertain output.
    if (action === "stream-stop" && control.unfinished)
      for (const target of control.unfinished.command.targets) {
        targets.set(target.id, target);
        names[target.id] ??=
          control.unfinished.names[target.id] ?? "Destination";
      }
    const scope = {
      orgId,
      requestId: crypto.randomUUID(),
      targets: [...targets.values()],
    };
    if (action === "stream-live" && input)
      setReview({
        command: { ...scope, action, liveInputId: input.id },
        inputName: input.name,
        names,
      });
    if (action === "stream-stop")
      setReview({ command: { ...scope, action }, names });
  }
  const stopping = review?.command.action === "stream-stop",
    latest = control.latest;
  return (
    <section
      aria-label="Streaming controls"
      className="min-w-0 overflow-hidden rounded-xl border border-board-border bg-board-card"
    >
      <ConfirmDialog
        open={!!review}
        onOpenChange={(open) => {
          if (!open) setReview(null);
        }}
        title={
          stopping
            ? "Disconnect these destinations?"
            : "Go live to these destinations?"
        }
        description={
          review
            ? `${stopping ? "Disconnect" : `Send ${review.inputName} to`}: ${review.command.targets.map((target) => review.names[target.id]).join(", ")}. ${stopping ? "This also replaces unfinished Go Live requests for these destinations." : "Viewers on these destinations may see and hear this input."}`
            : ""
        }
        confirmLabel={stopping ? "Disconnect destinations" : "Go live now"}
        confirmDisabled={stopping ? stopDisabled : liveDisabled}
        onConfirm={() => {
          if (review && !(stopping ? stopDisabled : liveDisabled))
            control.send(review);
          setReview(null);
        }}
      />
      <header className="space-y-1 border-b border-board-border p-4">
        <h2 className="text-base font-semibold text-board-text">
          Streaming controls
        </h2>
        <p className="text-sm text-board-muted">
          Output enablement is checked with the provider. Confirm video and
          audio at each destination.
        </p>
        <p className="text-xs text-board-muted">
          {read.dataUpdatedAt
            ? `${readFailure || stale ? "Last confirmed check" : "Checked"} ${new Date(read.dataUpdatedAt).toLocaleTimeString()}`
            : "No confirmed check"}
        </p>
      </header>
      <ReadFailureNotice
        error={
          readFailure
            ? {
                message:
                  read.error?.message ?? "Streaming feedback is unavailable.",
                occurredAt: read.errorUpdatedAt,
              }
            : unknown
              ? {
                  message:
                    "Some output statuses could not be confirmed. Retry to check the provider.",
                  occurredAt: read.dataUpdatedAt,
                }
              : null
        }
        refreshing={read.isFetching}
        retry={() => void read.refetch()}
        label="Retry streaming feedback"
      />
      <div className="space-y-3 p-4">
        {!state && !readFailure ? (
          <p role="status" className="text-sm text-board-muted">
            Checking streaming outputs…
          </p>
        ) : null}
        {state ? (
          <>
            <label className="block space-y-1 text-sm text-board-text">
              <span>Live input</span>
              <select
                value={input?.id ?? ""}
                onChange={(event) => setSelectedInput(event.target.value)}
                disabled={!state.inputs.length || !!control.unfinished}
                className="block min-h-11 w-full min-w-0 rounded-lg border border-board-border bg-board-bg px-3"
              >
                <option value="">
                  {state.inputs.length
                    ? "Choose a live input"
                    : "No ready live input"}
                </option>
                {state.inputs.map((input) => (
                  <option key={input.id} value={input.id}>
                    {input.name}
                  </option>
                ))}
              </select>
            </label>
            {state.destinations.length ? (
              <ul className="divide-y divide-board-border">
                {state.destinations.map((destination) => (
                  <li
                    key={destination.id}
                    className="flex flex-wrap justify-between gap-2 py-2 text-sm"
                  >
                    <span className="min-w-0 break-words text-board-text">
                      {destination.name}
                      {!destination.enabled
                        ? " · Not selected for Go Live"
                        : ""}
                    </span>
                    <span
                      className={
                        destination.status === "enabled" &&
                        !readFailure &&
                        !stale
                          ? "text-green-300"
                          : "text-board-muted"
                      }
                    >
                      {readFailure || stale
                        ? `Last known: ${statusLabels[destination.status]}`
                        : statusLabels[destination.status]}
                    </span>
                    {destination.error ? (
                      <span className="basis-full text-amber-200">
                        {destination.error}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-board-muted">
                No destinations configured.
              </p>
            )}
            {!state.canControl ? (
              <p className="text-sm text-amber-200">
                Streaming management permission is required.
              </p>
            ) : null}
          </>
        ) : null}
        {stale && !readFailure && !unknown ? (
          <button
            type="button"
            disabled={read.isFetching}
            onClick={() => void read.refetch()}
            className="min-h-11 rounded-lg border px-3 text-sm text-amber-200"
          >
            {read.isFetching
              ? "Checking streaming feedback…"
              : "Refresh streaming feedback"}
          </button>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={liveDisabled}
            onClick={() => request("stream-live")}
            className="min-h-11 rounded-lg border border-board-border px-4 text-sm text-board-text focus-visible:outline-2 disabled:opacity-50"
          >
            Go live
          </button>
          <button
            type="button"
            disabled={stopDisabled}
            onClick={() => request("stream-stop")}
            className="min-h-11 rounded-lg border border-red-500/40 px-4 text-sm text-red-300 focus-visible:outline-2 disabled:opacity-50"
          >
            Disconnect destinations
          </button>
        </div>
        <div aria-live="polite" className="space-y-2 text-sm text-board-text">
          {control.pending ? (
            <p>
              Sending{" "}
              {latest?.review?.command.action === "stream-stop"
                ? "Disconnect"
                : "Go Live"}{" "}
              request…
            </p>
          ) : latest?.status === "error" ? (
            <p role="alert" className="text-amber-200">
              {latest.error instanceof Error
                ? latest.error.message
                : "Streaming command was not confirmed."}{" "}
              Checked {new Date(latest.at).toLocaleTimeString()}
            </p>
          ) : null}
          {!control.pending && latest?.result ? (
            <>
              <p>
                {latest.result.results.every((result) => result.success)
                  ? `${latest.review?.command.action === "stream-stop" ? "Disconnect" : "Go Live"} request confirmed. Check current output status above.`
                  : "Some destinations were not confirmed."}
              </p>
              {latest.result.results
                .filter((result) => !result.success)
                .map((result) => (
                  <p
                    key={result.id}
                    role="alert"
                    className="break-words text-amber-200"
                  >
                    {latest.review?.names[result.id] ?? "Destination"}:{" "}
                    {result.error ??
                      "Operation not confirmed. Retry the request."}
                  </p>
                ))}
            </>
          ) : null}
          {!control.pending && latest?.result?.notificationError ? (
            <p role="alert" className="text-amber-200">
              {latest.result.notificationError}
            </p>
          ) : null}
          {control.unfinished && !control.pending ? (
            <>
              <button
                type="button"
                onClick={control.retry}
                className="min-h-11 rounded-lg border px-3"
              >
                Retry streaming command
              </button>
              {control.unfinished.command.action === "stream-live" ? (
                <p className="text-board-muted">
                  Retry this request to recover its result, or disconnect these
                  destinations before reviewing a new Go Live request.
                </p>
              ) : null}
            </>
          ) : null}
        </div>
        <Link
          to="/$slug/streaming/platforms"
          params={{ slug }}
          className="inline-flex min-h-11 items-center text-sm text-fire-400 underline"
        >
          Manage destinations
        </Link>
      </div>
    </section>
  );
}
