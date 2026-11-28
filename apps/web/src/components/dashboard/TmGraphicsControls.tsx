import { QuietActivity } from "@/components/ui/QuietActivity";
import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useTmGraphics } from "@/hooks/useTmGraphics";
import { Layers, RefreshCw, TriangleAlert } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { ModalAContent, modalCancel, modalDanger } from "@/components/schedule/modal-a";
import { Callout, Spinner, TmPanel, tmDanger, tmLink, tmSecondary } from "./tm-a";
import type { GraphicsClearSnapshot } from "@/lib/graphics-clear-contract";
export function TmGraphicsControls(props: {
  orgId: string;
  userId: string;
  slug: string;
}) {
  return <GraphicsControls key={`${props.orgId}:${props.userId}`} {...props} />;
}
function GraphicsControls({
  orgId,
  userId,
  slug,
}: {
  orgId: string;
  userId: string;
  slug: string;
}) {
  const control = useTmGraphics(orgId, userId),
    { read } = control,
    state = read.data;
  const [review, setReview] = useState<GraphicsClearSnapshot | null>(null),
    [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  const stale = !!read.dataUpdatedAt && now - read.dataUpdatedAt > 8_000,
    readFailure =
      read.isError ||
      (read.isFetching && read.errorUpdatedAt > read.dataUpdatedAt),
    hasOutput =
      !!state &&
      (!!state.program.length ||
        state.programUnknown ||
        !!state.lowerThirds.length),
    disabled =
      !state?.canClear ||
      !hasOutput ||
      readFailure ||
      stale ||
      !!control.unfinished;
  const result = control.latest?.result,
    outcome = !result
      ? null
      : result.program === "conflict"
        ? "Graphics changed after confirmation. Review current output before clearing again."
        : result.program === "expired"
          ? "Clear expired before changing output. Review current graphics before trying again."
          : result.relay === "conflict"
            ? "Program cleared. A newer lower third was preserved. Review current output before clearing again."
            : result.relay === "expired"
              ? "Program cleared, but the lower-third clear expired. Review current output before trying again."
              : "";
  const reason = !state ? null : !hasOutput ? "Nothing on air" : !state.canClear ? "Needs lowerthird:trigger (owner/admin or Tech Manager)." : readFailure ? "Couldn't read graphics. Retry first." : stale ? "Graphics list is more than 8 seconds old." : control.unfinished ? "Wait for the current request to finish." : null;
  const confirmClear = () => {
    if (review && state && !disabled)
      control.send({
        orgId,
        requestId: crypto.randomUUID(),
        expectedProgramRevision: review.programRevision,
        expectedRelayRevision: review.relayRevision,
        expiresAt: Math.floor(state.serverTime + Math.max(0, Date.now() - read.dataUpdatedAt) + 5_000),
      });
    setReview(null);
  };
  return (
    <TmPanel
      icon={Layers}
      title="Graphics controls"
      label="Graphics controls"
      className="flex flex-col [&>div:nth-child(2)]:flex-1"
      footer={<>
        <button type="button" disabled={disabled} onClick={() => setReview(state ?? null)} className={tmDanger}>Clear all graphics</button>
        {control.pending ? <span className="inline-flex items-center gap-2 text-[13px] text-[var(--sa-ink-2)]"><Spinner />Clearing…</span> : reason ? <span className="text-[13px] text-[var(--sa-ink-2)]">{reason}</span> : null}
        <Link to="/$slug/streaming/graphics" params={{ slug }} className={`${tmLink} ml-auto`}>Open Graphics</Link>
      </>}
    >
      <Dialog open={!!review} onOpenChange={(open) => { if (!open) setReview(null); }}>
        {review ? (
          <ModalAContent title="Clear all graphics?" onClose={() => setReview(null)}
            description={`Program graphics and the lower third go off air now${[...review.program.map((graphic) => graphic.title), ...review.lowerThirds, ...(review.programUnknown ? ["unrecognized saved output"] : [])].length ? `: ${[...review.program.map((graphic) => graphic.title), ...review.lowerThirds, ...(review.programUnknown ? ["unrecognized saved output"] : [])].join(", ")}` : ""}. Saved graphics and scenes remain available.`}>
            <div className="-mx-5 -mb-5 flex flex-wrap items-center gap-2 border-t border-[var(--sa-border)] bg-board-bg px-5 py-3.5">
              <span className="mr-auto hidden items-center gap-1.5 text-xs text-[var(--sa-ink-3)] sm:inline-flex"><kbd className="rounded border border-[var(--sa-border-strong)] px-1.5 text-xs">Esc</kbd> to cancel</span>
              <button type="button" className={`${modalCancel} max-lg:h-11`} onClick={() => setReview(null)}>Cancel</button>
              <button type="button" disabled={disabled} className={`${modalDanger} max-lg:h-11`} onClick={confirmClear}>Clear all graphics</button>
            </div>
          </ModalAContent>
        ) : null}
      </Dialog>
      <div className="flex flex-col gap-3 text-[13px]">
        <p className="leading-[1.55] text-[var(--sa-ink-2)]">On-air graphics and lower thirds.</p>
        {readFailure ? (
          <Callout tone="warn" icon={TriangleAlert} role="alert" title="Couldn't read graphics"
            action={<button type="button" disabled={read.isFetching} onClick={() => void read.refetch()} className={tmSecondary} aria-label="Retry graphics feedback">
              <RefreshCw className={`h-3.5 w-3.5 ${read.isFetching ? "animate-spin motion-reduce:animate-none" : ""}`} />{read.isFetching ? "Retrying…" : "Retry graphics feedback"}
            </button>}>
            Showing what was last read.
          </Callout>
        ) : null}
        {!state && !readFailure ? <QuietActivity label="Checking graphics output…" /> : null}
        {state ? (
          <>
            <div>
              <h3 className="font-semibold text-board-text">Program graphics</h3>
              {state.program.map((graphic) => <p key={graphic.id} className="break-words text-[var(--sa-ink-2)]">{graphic.title}</p>)}
              {state.programUnknown ? (
                <p className="text-[var(--sa-warn)]">Saved output could not be fully read. Confirm Clear to remove it.</p>
              ) : !state.program.length ? (
                <p className="text-[var(--sa-ink-2)]">No Program graphics on air</p>
              ) : null}
            </div>
            <div>
              <h3 className="font-semibold text-board-text">Lower thirds</h3>
              {state.lowerThirds.length
                ? state.lowerThirds.map((title) => <p key={title} className="break-words text-[var(--sa-ink-2)]">{title}</p>)
                : <p className="text-[var(--sa-ink-2)]">No lower third on air</p>}
            </div>
            {!state.canClear ? <p className="text-[var(--sa-warn)]">Graphics control permission is required.</p> : null}
          </>
        ) : null}
        {stale && !readFailure ? (
          <button type="button" disabled={read.isFetching} onClick={() => void read.refetch()} className={`${tmSecondary} self-start`}
            aria-label={read.isFetching ? "Checking graphics feedback…" : "Refresh graphics feedback"}>
            {read.isFetching ? <QuietActivity label="Checking graphics feedback…" /> : "Refresh graphics feedback"}
          </button>
        ) : null}
        <div aria-live="polite" className="empty:hidden">
          {control.pending ? null : control.latest?.status === "error" ? (
            <Callout tone="danger" icon={TriangleAlert} role="alert" title="This graphics change needs attention."
              action={<button type="button" onClick={control.retry} className={tmSecondary}><RefreshCw className="h-3.5 w-3.5" />Retry graphics clear</button>} />
          ) : outcome ? (
            <p role="status">{outcome}</p>
          ) : null}
        </div>
      </div>
    </TmPanel>
  );
}
