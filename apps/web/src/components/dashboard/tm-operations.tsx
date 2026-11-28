import { Link } from "@tanstack/react-router";
import { Activity, CircleCheck, CircleHelp, ExternalLink, RefreshCw } from "lucide-react";
import { useLiveInputHealth } from "@/hooks/useLiveInputHealth";
import { KioskDisplayControl } from "@/components/settings/KioskDisplayControl";
import { StatusMark, asStatus } from "@/components/stream/stream-a";
import type { ServicePhase } from "@/lib/service-phase";
import { TmGraphicsControls } from "./TmGraphicsControls";
import { TmStreamControls } from "./TmStreamControls";
import { TmRundownControls } from "./TmRundownControls";
import { StatusWord, TmPanel, tmEyebrow, tmLink, tmSecondary } from "./tm-a";

type Input = { id: string; name: string; status: string };
type Destination = { id: string; name: string; platform: string; enabled: boolean; connected: boolean };

/**
 * Live operations — A. During a live show the rundown leads; otherwise the
 * stream comes first, since that is what a tech checks before call.
 */
export function TmOperations(props: { orgId: string; userId: string; slug: string; inputs: Input[]; destinations: Destination[]; phase?: ServicePhase }) {
  const stream = <StreamHealthPanel key="stream" {...props} />;
  const rundown = <TmRundownControls key={`${props.orgId}:${props.userId}`} orgId={props.orgId} userId={props.userId} slug={props.slug} />;
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {props.phase === "live" ? [rundown, stream] : [stream, rundown]}
      <div className="grid min-w-0 grid-cols-1 items-stretch gap-4 lg:grid-cols-2">
        <TmStreamControls orgId={props.orgId} userId={props.userId} slug={props.slug} />
        <TmGraphicsControls orgId={props.orgId} userId={props.userId} slug={props.slug} />
      </div>
      <KioskDisplayControl orgId={props.orgId} userId={props.userId} surface="technical" />
    </div>
  );
}

export function StreamHealthPanel({ orgId, slug, inputs, destinations }: { orgId: string; slug: string; inputs: Input[]; destinations: Destination[] }) {
  const health = useLiveInputHealth(orgId, inputs);
  const status = (id: string) => health.error ? "unknown" : health.value[id]?.status ?? "unknown";
  const live = health.error ? 0 : inputs.filter((input) => status(input.id) === "streaming").length;
  const enabled = destinations.filter((destination) => destination.enabled);
  const connected = enabled.filter((destination) => destination.connected).length;
  const hasRows = inputs.length > 0 || enabled.length > 0;
  return (
    <TmPanel icon={Activity} title="Live stream" label="Live stream"
      subtitle={hasRows ? "Input health and saved destination configuration" : "No inputs or destinations configured"}
      action={<Link to={`/${slug}/streaming/health` as never} className={tmLink}>Diagnostics <ExternalLink aria-hidden="true" className="h-3.5 w-3.5" /></Link>}>
      <div className="flex flex-col gap-3">
        {health.failure ? (
          <div role="alert" className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-[var(--sa-border)] bg-board-bg/40 px-3.5 py-2.5">
            <span className="inline-flex items-center gap-2 text-[13px] font-semibold text-[var(--sa-warn)]"><CircleHelp aria-hidden="true" className="h-4 w-4" />Couldn't check input health</span>
            <span aria-hidden="true" className="hidden h-5 w-px bg-[var(--sa-border)] sm:block" />
            <span className="min-w-0 flex-1 text-[13px] text-[var(--sa-ink-2)]">Showing the last known status. We'll keep trying every 10s.</span>
            <button type="button" disabled={health.refreshing} onClick={health.retry} aria-label="Retry input health" className={tmSecondary}>
              <RefreshCw className={`h-3.5 w-3.5 ${health.refreshing ? "animate-spin motion-reduce:animate-none" : ""}`} />{health.refreshing ? "Checking…" : "Retry input health"}
            </button>
          </div>
        ) : null}
        <div className="grid grid-cols-2 overflow-hidden rounded-lg border border-[var(--sa-border)]">
          <Metric label="Inputs live" value={`${live}/${inputs.length}`} good={live > 0} />
          <Metric label="Configured outputs" value={`${connected}/${enabled.length}`} good={enabled.length > 0 && connected === enabled.length} />
        </div>
        {hasRows ? (
          <ul className="flex flex-col">
            {inputs.map((input) => (
              <li key={input.id} className="flex min-h-11 items-center gap-3 px-1 py-1">
                <span className="flex min-w-0 flex-1 flex-col"><span className="truncate text-[13px] font-semibold text-board-text">{input.name}</span><span className="text-xs text-[var(--sa-ink-3)]">Live input</span></span>
                {health.error || (health.failure && asStatus(status(input.id)) === "unknown")
                  ? <StatusWord tone="warn" icon={CircleHelp}>Last known: Check failed</StatusWord>
                  : <StatusMark status={status(input.id)} />}
              </li>
            ))}
            {enabled.map((destination) => (
              <li key={destination.id} className="flex min-h-11 items-center gap-3 px-1 py-1">
                <span className="flex min-w-0 flex-1 flex-col"><span className="truncate text-[13px] font-semibold text-board-text">{destination.name}</span><span className="text-xs capitalize text-[var(--sa-ink-3)]">{destination.platform}</span></span>
                {destination.connected ? <StatusWord tone="ok" icon={CircleCheck}>Configured</StatusWord> : <StatusWord tone="warn" icon={CircleHelp}>Not configured</StatusWord>}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </TmPanel>
  );
}

function Metric({ label, value, good }: { label: string; value: string; good: boolean }) {
  return (
    <div className="border-r border-[var(--sa-border)] px-3.5 py-2.5 last:border-r-0">
      <p className={tmEyebrow}>{label}</p>
      <p className={`mt-0.5 text-[17px] font-semibold tabular-nums ${good ? "text-[var(--sa-ok)]" : "text-board-text"}`}>{value}</p>
    </div>
  );
}
