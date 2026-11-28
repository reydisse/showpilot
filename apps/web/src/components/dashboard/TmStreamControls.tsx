import { plainFailure } from "@showpilot/shared/ui-feedback";
import { QuietActivity } from "@/components/ui/QuietActivity";
import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useTmStream } from "@/hooks/useTmStream";
import { CircleCheck, CircleHelp, CircleMinus, Ban, Radio, RefreshCw, TriangleAlert } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { ModalAContent, modalCancel, modalDanger, modalPrimary } from "@/components/schedule/modal-a";
import { Callout, Spinner, StatusWord, TmPanel, tmDanger, tmLink, tmSecondary, type Tone } from "./tm-a";
import type { TmStreamReview } from "@/lib/tm-stream-contract";
const statusMeta: Record<keyof typeof statusLabels, { tone: Tone; icon: React.ElementType }> = {
  enabled: { tone: "ok", icon: CircleCheck },
  disabled: { tone: "muted", icon: CircleMinus },
  missing: { tone: "warn", icon: CircleHelp },
  unconfirmed: { tone: "warn", icon: TriangleAlert },
  unknown: { tone: "muted", icon: CircleHelp },
  none: { tone: "muted", icon: Ban },
};
const statusLabels = {
  enabled: "Output enabled",
  disabled: "Output disabled",
  missing: "Output missing",
  unconfirmed: "Needs attention",
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
  const failures = !control.pending && latest?.result ? latest.result.results.filter((result) => !result.success) : [];
  const liveReason = !state ? null : !state.canControl ? "Needs stream_health:manage (owner/admin or Tech Manager)." : readFailure ? "Couldn't read stream status. Retry first." : stale ? "Status is more than 10 seconds old. Waiting for a fresh read." : unknown ? "One destination's status is unknown." : control.unfinished ? "Wait for the current request to finish." : !input ? "Choose a live input." : !state.destinations.some((destination) => destination.enabled) ? "Turn on a destination in Manage destinations." : null;
  return (
    <TmPanel
      icon={Radio}
      title="Streaming controls"
      label="Streaming controls"
      className="flex flex-col [&>div:nth-child(2)]:flex-1"
      footer={<>
        {control.pending ? (
          <p role="status" className="inline-flex basis-full items-center gap-2 text-[13px] text-[var(--sa-ink-2)]"><Spinner />
            Sending {latest?.review?.command.action === "stream-stop" ? "Disconnect" : "Go Live"} request…
          </p>
        ) : null}
        <button type="button" disabled={liveDisabled} title={liveReason ?? undefined} onClick={() => request("stream-live")} className={tmSecondary}><Radio className="h-3.5 w-3.5" />Go live</button>
        <button type="button" disabled={stopDisabled} onClick={() => request("stream-stop")} className={tmDanger}>Disconnect destinations</button>
        <Link to="/$slug/streaming/platforms" params={{ slug }} className={`${tmLink} ml-auto`}>Manage destinations</Link>
      </>}
    >
      <Dialog open={!!review} onOpenChange={(open) => { if (!open) setReview(null); }}>
        {review ? (
          <ModalAContent
            title={stopping ? "Disconnect these destinations?" : "Go live to these destinations?"}
            description={<span className="sr-only">{stopping ? "Disconnect" : `Send ${review.inputName} to`}: {review.command.targets.map((target) => review.names[target.id]).join(", ")}.</span>}
            onClose={() => setReview(null)}
          >
            <ul className="flex flex-col gap-1.5">
              {review.command.targets.map((target) => (
                <li key={target.id} className="flex items-center gap-2.5 rounded-lg border border-[var(--sa-border)] bg-board-bg/40 px-3 py-2.5 text-[13px]">
                  <Radio aria-hidden="true" className="h-3.5 w-3.5 text-[var(--sa-ink-3)]" />
                  <span className="min-w-0 flex-1 truncate font-semibold">{review.names[target.id]}</span>
                  <span className="text-xs text-[var(--sa-ink-3)]">Selected destination</span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-[13px] leading-[1.55] text-[var(--sa-ink-2)]">
              {stopping
                ? "Each destination stops receiving the stream. This also replaces unfinished Go Live requests for these destinations."
                : `Each destination starts receiving ${review.inputName}. Confirm video and audio at each destination.`}
            </p>
            <div className="-mx-5 -mb-5 mt-5 flex flex-wrap items-center gap-2 border-t border-[var(--sa-border)] bg-board-bg px-5 py-3.5">
              <span className="mr-auto hidden items-center gap-1.5 text-xs text-[var(--sa-ink-3)] sm:inline-flex"><kbd className="rounded border border-[var(--sa-border-strong)] px-1.5 text-xs">Esc</kbd> to cancel</span>
              <button type="button" className={`${modalCancel} max-lg:h-11`} onClick={() => setReview(null)}>Cancel</button>
              <button
                type="button"
                disabled={stopping ? stopDisabled : liveDisabled}
                className={`${stopping ? modalDanger : modalPrimary} max-lg:h-11`}
                onClick={() => {
                  if (review && !(stopping ? stopDisabled : liveDisabled)) control.send(review);
                  setReview(null);
                }}
              >
                {stopping ? "Disconnect destinations" : <><Radio className="h-3.5 w-3.5" />Go live</>}
              </button>
            </div>
          </ModalAContent>
        ) : null}
      </Dialog>
      <div className="flex flex-col gap-3">
        <p className="text-[13px] leading-[1.55] text-[var(--sa-ink-2)]">
          Output enablement is checked with the provider. Confirm video and audio at each destination.
        </p>
        {readFailure || unknown ? (
          <Callout tone="warn" icon={TriangleAlert} role="alert" title={readFailure ? "Couldn't read streaming status" : "Some destinations could not be reached."}
            action={<button type="button" disabled={read.isFetching} onClick={() => void read.refetch()} className={tmSecondary} aria-label="Retry streaming feedback">
              <RefreshCw className={`h-3.5 w-3.5 ${read.isFetching ? "animate-spin motion-reduce:animate-none" : ""}`} />{read.isFetching ? "Retrying…" : "Retry streaming feedback"}
            </button>}>
            {readFailure ? "Showing the last known status." : null}
          </Callout>
        ) : null}
        {!state && !readFailure ? <QuietActivity label="Checking streaming outputs…" /> : null}
        {state ? (
          <>
            <label className="flex flex-col gap-1.5 text-[13px] font-medium text-board-text">
              <span>Live input</span>
              <select
                value={input?.id ?? ""}
                onChange={(event) => setSelectedInput(event.target.value)}
                disabled={!state.inputs.length || !!control.unfinished}
                className="h-10 w-full min-w-0 rounded-lg border border-[var(--sa-border-strong)] bg-board-bg px-3 text-[13px] font-normal text-board-text disabled:opacity-50 max-lg:h-11"
              >
                <option value="">{state.inputs.length ? "Choose a live input" : "No ready live input"}</option>
                {state.inputs.map((input) => <option key={input.id} value={input.id}>{input.name}</option>)}
              </select>
            </label>
            {state.destinations.length ? (
              <ul className="flex flex-col gap-1.5">
                {state.destinations.map((destination) => {
                  const lastKnown = readFailure || stale, meta = statusMeta[destination.status];
                  return (
                    <li key={destination.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-lg bg-[var(--sa-surface-2)] px-3 py-2.5 text-[13px]">
                      <span className="min-w-0 break-words text-board-text">{destination.name}{!destination.enabled ? <span className="text-[var(--sa-ink-3)]"> · Not selected for Go Live</span> : ""}</span>
                      <StatusWord tone={lastKnown ? "muted" : meta.tone} icon={meta.icon} className={lastKnown ? "italic" : ""}>
                        {lastKnown ? `Last known: ${statusLabels[destination.status]}` : statusLabels[destination.status]}
                      </StatusWord>
                      {destination.error ? <span className="basis-full text-xs text-[var(--sa-warn)]">{destination.error}</span> : null}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-[13px] text-[var(--sa-ink-2)]">No destinations configured.</p>
            )}
            {!state.canControl ? <p className="text-[13px] text-[var(--sa-warn)]">Streaming management permission is required.</p> : null}
          </>
        ) : null}
        {stale && !readFailure && !unknown ? (
          <button type="button" disabled={read.isFetching} onClick={() => void read.refetch()} className={`${tmSecondary} self-start`}
            aria-label={read.isFetching ? "Checking streaming feedback…" : "Refresh streaming feedback"}>
            {read.isFetching ? <QuietActivity label="Checking streaming feedback…" /> : "Refresh streaming feedback"}
          </button>
        ) : null}
        {liveDisabled && liveReason && !control.pending && state?.canControl ? <p className="text-xs text-[var(--sa-ink-3)]">{liveReason}</p> : null}
        <div aria-live="polite" className="flex flex-col gap-2 empty:hidden">
          {!control.pending && (latest?.status === "error" || failures.length) ? (
            <Callout tone="danger" icon={TriangleAlert} role="alert"
              title={latest?.status === "error" ? "This stream change needs attention." : "Some destinations could not be reached."}
              action={control.unfinished ? <button type="button" onClick={control.retry} className={tmSecondary}><RefreshCw className="h-3.5 w-3.5" />Retry streaming command</button> : null}>
              {failures.map((result) => (
                <p key={result.id} className="break-words">
                  {latest?.review?.names[result.id] ?? "Destination"}: {plainFailure((result.error ?? "This action needs attention.") ?? "")}
                </p>
              ))}
              {control.unfinished?.command.action === "stream-live" ? <p>Retry this request to recover its result, or disconnect these destinations before reviewing a new Go Live request.</p> : null}
            </Callout>
          ) : !control.pending && control.unfinished ? (
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={control.retry} className={tmSecondary}><RefreshCw className="h-3.5 w-3.5" />Retry streaming command</button>
              {control.unfinished.command.action === "stream-live" ? <p className="text-xs text-[var(--sa-ink-2)]">Retry this request to recover its result, or disconnect these destinations before reviewing a new Go Live request.</p> : null}
            </div>
          ) : null}
          {!control.pending && latest?.result?.notificationError ? (
            <p role="alert" className="text-[13px] text-[var(--sa-warn)]">{latest.result.notificationError}</p>
          ) : null}
        </div>
      </div>
    </TmPanel>
  );
}
