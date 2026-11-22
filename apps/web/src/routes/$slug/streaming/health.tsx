import { QuietActivity } from "@/components/ui/QuietActivity";
import { workspaceCopy } from "@showpilot/shared";
import { useTerms as useWorkspaceTerms } from "@/components/workspace/WorkspaceProvider";
import { createFileRoute, Link, useBlocker, useNavigate } from "@tanstack/react-router";
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { hasEffectivePermission } from "@/lib/app-permissions";
import { BookOpen, Check, ChevronLeft, CircleHelp, Cpu, Lightbulb, Monitor, MoreHorizontal, Network, Plus, Radio, RefreshCw, Trash2, TriangleAlert, Tv, Unplug } from "lucide-react";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { getLiveInputs, createLiveInput, deleteLiveInput, resumeLiveInput } from "@/lib/stream";
import { RouteError } from "@/components/ui/RouteRecovery";
import { useOperatorRead } from "@/hooks/useOperatorRead";
import { useConfirmedWrite } from "@/hooks/useConfirmedWrite";
import { useLiveInputHealth } from "@/hooks/useLiveInputHealth";
import { ConfirmedWriteNotice } from "@/components/layout/ConfirmedWriteNotice";
import { ReadFailureNotice } from "@/components/layout/ReadFailureNotice";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ModalA, modalCancel, modalPrimary } from "@/components/schedule/modal-a";
import { CopyField, SecretField, StatusMark, asStatus, needsAttention, relativeAge, statusDetail, statusRank, useSecondTick } from "@/components/stream/stream-a";

/** Stream — A (Doop canvas aneicgaHqk, "Stream" page). */

type Encoder = "atem" | "obs" | "hardware";
export const Route = createFileRoute("/$slug/streaming/health")({
  validateSearch: (search: Record<string, unknown>): { connect?: string; encoder?: Encoder } => ({
    connect: typeof search.connect === "string" ? search.connect : undefined,
    encoder: search.encoder === "atem" || search.encoder === "obs" || search.encoder === "hardware" ? search.encoder : undefined,
  }),
  pendingComponent: () => <StreamSkeleton />,
  errorComponent: RouteError,
  loader: async ({ context, abortController }) => {
    const { withPermission } = await import("@/lib/route-permissions");
    await withPermission(context.role, "stream_health:view", context.slug, context.orgId);
    const canManageStreamHealth = hasEffectivePermission(context.role, context.grantedPermissions, "stream_health:manage");
    const inputs = await getLiveInputs({ data: { orgId: context.orgId, includeCredentials: canManageStreamHealth }, signal: abortController.signal });
    return { inputs, orgId: context.orgId, role: context.role, grantedPermissions: context.grantedPermissions };
  },
  component: StreamHealthPage,
});

type Initial = Awaited<ReturnType<typeof getLiveInputs>>;
type Input = Initial[number];
function StreamHealthPage() {
  const initial = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const canManage = hasEffectivePermission(initial.role, initial.grantedPermissions, "stream_health:manage");
  return <StreamHealthWorkspace key={initial.orgId} orgId={initial.orgId} initialInputs={initial.inputs} canManageStreamHealth={canManage}
    connect={search.connect ? { inputId: search.connect, encoder: search.encoder ?? "atem" } : null}
    onConnect={(inputId, encoder) => void navigate({ search: { connect: inputId ?? undefined, encoder: inputId ? encoder : undefined } })} />;
}

const primary = "inline-flex h-9 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg bg-fire-500 px-3.5 text-[13px] font-semibold text-[#1a1300] hover:bg-fire-400 disabled:opacity-50 max-lg:h-11";
const secondary = "inline-flex h-9 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-[var(--sa-border-strong)] bg-[var(--sa-surface-2)] px-3 text-[13px] font-medium text-board-text hover:bg-[var(--sa-surface-3)] disabled:opacity-40 max-lg:h-11";
const iconButton = "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[var(--sa-ink-3)] hover:bg-[var(--sa-surface-2)] hover:text-board-text disabled:opacity-40 max-lg:h-11 max-lg:w-11";
const eyebrow = "text-xs font-medium uppercase tracking-[0.07em] text-[var(--sa-ink-3)]";

export function StreamHealthWorkspace({ orgId, initialInputs, canManageStreamHealth, connect = null, onConnect = () => {} }: {
  orgId: string;
  initialInputs: Initial;
  canManageStreamHealth: boolean;
  connect?: { inputId: string; encoder: Encoder } | null;
  onConnect?: (inputId: string | null, encoder: Encoder) => void;
}) {
  const workspaceTerms = useWorkspaceTerms();
  const readInputs = useCallback((signal: AbortSignal) => getLiveInputs({ data: { orgId, includeCredentials: canManageStreamHealth }, signal }), [orgId, canManageStreamHealth]);
  const read = useOperatorRead({ key: JSON.stringify([orgId, initialInputs, canManageStreamHealth]), initialValue: initialInputs, read: readInputs, errorMessage: "Inputs could not be refreshed. Previously confirmed configuration is shown. Retry before making changes." });
  const inputs = read.value;
  const healthRead = useLiveInputHealth(orgId, inputs);
  const statuses = healthRead.value;
  const polling = healthRead.refreshing;
  const now = useSecondTick();
  const [showAddForm, setShowAddForm] = useState(false);
  const [newName, setNewName] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<"attention" | "name">("attention");
  const [deleteAsk, setDeleteAsk] = useState<Input | null>(null);
  const writes = useConfirmedWrite(orgId);
  const busy = writes.state.status === "saving", locked = writes.state.status !== "idle";
  const controlsDisabled = locked || read.refreshing || !!read.error;
  const dirty = locked || newName.length > 0;
  const blocker = useBlocker({ shouldBlockFn: () => dirty, enableBeforeUnload: dirty, withResolver: true });
  useEffect(() => { if (!dirty && blocker.status === "blocked") blocker.proceed(); }, [dirty, blocker]);
  const { confirm, ConfirmDialogEl } = useConfirmDialog();
  const finish = async (_result: unknown, signal: AbortSignal) => {
    const refreshed = await read.refresh(); signal.throwIfAborted();
    if (!refreshed) throw new Error("The input change completed, but the list could not be refreshed. Retry refresh without repeating the change.");
  };
  const duplicate = !!newName.trim() && inputs.some(input => input.name.trim().toLowerCase() === newName.trim().toLowerCase());
  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim() || duplicate || controlsDisabled) return;
    const name = newName.trim();
    let createdId: string | null = null;
    void writes.start({ label: "Create live input", write: (requestId, signal) => createLiveInput({ data: { orgId, name, requestId }, signal }),
      apply: (created) => { createdId = (created as { id?: string } | null)?.id ?? null; read.invalidate(); },
      finish: async (result, signal) => {
        await finish(result, signal); setNewName(""); setShowAddForm(false);
        // A new input lands on its Connect an encoder steps.
        if (createdId) onConnect(createdId, "atem");
      },
    });
  };
  const runDelete = (input: Input) => {
    setDeleteAsk(null);
    void writes.start({ label: `Delete ${input.name}`, write: (requestId, signal) => deleteLiveInput({ data: { orgId, inputId: input.id, requestId }, signal }), apply: () => read.invalidate(), finish });
  };
  const handleDelete = (input: Input) => { if (!controlsDisabled) setDeleteAsk(input); };
  const handleResume = (input: Input) => {
    if (controlsDisabled) return;
    void writes.start({ label: `Resume ${input.name}`, write: (_requestId, signal) => resumeLiveInput({ data: { orgId, inputId: input.id }, signal }), apply: () => read.invalidate(), finish });
  };
  const closeEditor = async () => {
    if (busy) return;
    if (locked) { setShowAddForm(false); return; }
    if (newName && !await confirm({ title: "Discard input draft?", description: "The unsaved input name will be discarded.", confirmLabel: "Discard draft" })) return;
    setNewName(""); setShowAddForm(false);
  };
  const reviewStored = async () => {
    if (reviewing || writes.state.status !== "failed") return;
    if (!await confirm({ title: "Review stored inputs?", description: "The previous request may still complete. Resume any pending input instead of creating another. Your draft will be kept; submitting it again starts a new creation.", confirmLabel: "Review inputs", variant: "warning" })) return;
    setReviewing(true); if (await read.refresh()) writes.discard(); setReviewing(false);
  };
  const notice = <ConfirmedWriteNotice collectionLabel="inputs" state={writes.state} retry={() => void writes.retry()} review={() => void reviewStored()} reviewing={reviewing} />;
  const statusOf = (input: Input) => healthRead.error ? "unknown" : statuses[input.id]?.status ?? "unknown";
  const liveCount = healthRead.error ? 0 : inputs.filter(i => statusOf(i) === "streaming").length;
  const connectedCount = healthRead.error ? 0 : inputs.filter(i => ["streaming", "connecting"].includes(statusOf(i))).length;
  const attention = inputs.filter(input => needsAttention(statusOf(input)));
  const sorted = useMemo(() => [...inputs].sort((a, b) => sortBy === "name" ? a.name.localeCompare(b.name) : statusRank(statusOf(a)) - statusRank(statusOf(b)) || a.name.localeCompare(b.name)), [inputs, statuses, sortBy, healthRead.error]); // eslint-disable-line react-hooks/exhaustive-deps
  const selected = inputs.find(input => input.id === selectedId) ?? sorted[0] ?? null;
  const healthState = healthRead.error ? "failed" : inputs.length && liveCount === inputs.length ? "live" : attention.length ? "attention" : "quiet";
  const openAdd = () => { setShowAddForm(true); };

  if (connect) {
    const input = inputs.find(item => item.id === connect.inputId);
    return <div className="schedule-a h-full overflow-auto bg-board-bg">
      {input ? <ConnectEncoder input={input} status={statusOf(input)} encoder={connect.encoder} checkedAt={healthRead.confirmedAt} now={now} polling={polling}
        onEncoder={encoder => onConnect(input.id, encoder)} onBack={() => onConnect(null, "atem")} workspaceTerms={workspaceTerms} /> : (
        <div className="mx-auto flex max-w-[1180px] flex-col items-start gap-3 px-4 pt-8 md:px-8">
          <h1 className="text-xl font-semibold text-board-text">This input is no longer here</h1>
          <p className="text-[13px] text-[var(--sa-ink-2)]">It may have been deleted. Your other inputs are unchanged.</p>
          <button type="button" className={secondary} onClick={() => onConnect(null, "atem")}>Back to Stream</button>
        </div>
      )}
    </div>;
  }

  return (
    <div className="schedule-a h-full overflow-auto bg-board-bg">
      <div className="mx-auto flex max-w-[1180px] flex-col gap-5 px-4 pb-12 pt-6 md:px-8">
        <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <div className="flex min-w-0 flex-col gap-1.5">
            <h1 className="text-[26px] font-semibold leading-[1.15] tracking-[-0.02em] text-board-text">Stream</h1>
            <p className="text-[13px] text-[var(--sa-ink-2)]">Live inputs, encoder setup, and health monitoring</p>
          </div>
          {canManageStreamHealth && inputs.length > 0 ? <button type="button" onClick={openAdd} disabled={controlsDisabled} className={primary}><Plus className="h-3.5 w-3.5" strokeWidth={2.25} />Add Input</button> : null}
        </header>

        <ReadFailureNotice variant="panel" error={read.error} refreshing={read.refreshing} retry={read.retry} label="Retry inputs" title="We couldn't refresh your inputs." description="Previously confirmed configuration is shown. Retry before making changes." />
        {!showAddForm && notice}
        {!showAddForm && newName ? <button type="button" className={`${secondary} self-start`} onClick={() => setShowAddForm(true)}>Review input draft</button> : null}

        {inputs.length === 0 && (read.refreshing || read.error) ? <p role="status" className="text-[13px] text-[var(--sa-ink-2)]">{read.refreshing ? <QuietActivity label="Loading inputs…" /> : "Input list unavailable. Retry above."}</p> : inputs.length === 0 ? (
          <>
            <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-[var(--sa-border-strong)] px-6 py-14 text-center">
              <span aria-hidden="true" className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-[var(--sa-surface-2)] text-[var(--sa-ink-2)]"><Radio className="h-4 w-4" /></span>
              <h2 className="text-[15px] font-semibold text-board-text">No live inputs yet</h2>
              <p className="max-w-[420px] text-[13px] leading-[1.6] text-[var(--sa-ink-2)]">Create an input to get a server URL and stream key for your ATEM, OBS, or hardware encoder.</p>
              {canManageStreamHealth ? <button type="button" onClick={openAdd} className={`${primary} mt-1`}><Plus className="h-3.5 w-3.5" />Add Input</button> : null}
            </div>
            <section aria-labelledby="stream-how" className="flex flex-col gap-3">
              <h2 id="stream-how" className={eyebrow}>How it works</h2>
              <ol className="grid gap-3 sm:grid-cols-2">
                {[
                  ["Create a live input", "This provisions an ingest point on Cloudflare Stream with RTMPS and SRT URLs."],
                  ["Configure your encoder", "Point your ATEM, OBS, or hardware encoder at the RTMPS URL + stream key."],
                  ["Go live", "Start your encoder. Status updates automatically every 10 seconds."],
                  ["Simulcast", "Go to Multi-Platform to push your stream to YouTube, Facebook, Twitch, and more simultaneously."],
                ].map(([title, body], index) => <li key={title} className="flex gap-3 rounded-xl border border-[var(--sa-border)] bg-[var(--sa-surface)] p-4">
                  <span aria-hidden="true" className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-[var(--sa-border-strong)] text-xs tabular-nums text-[var(--sa-ink-2)]">{index + 1}</span>
                  <span className="flex flex-col gap-1"><span className="text-[13px] font-semibold text-board-text">{title}</span><span className="text-[13px] leading-[1.5] text-[var(--sa-ink-2)]">{body}</span></span>
                </li>)}
              </ol>
            </section>
          </>
        ) : <>
          <section aria-label="Stream health" className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-[var(--sa-border)] bg-[var(--sa-surface)] px-4 py-3">
            <span className={`inline-flex items-center gap-2 text-[13px] font-semibold ${healthState === "live" ? "text-[var(--sa-ok)]" : healthState === "failed" ? "text-[var(--sa-warn)]" : healthState === "attention" ? (attention.some(input => asStatus(statusOf(input)) === "error") ? "text-[var(--sa-danger)]" : "text-[var(--sa-warn)]") : "text-board-text"}`}>
              {healthState === "live" ? <><Radio aria-hidden="true" className="h-4 w-4" />All inputs live</>
                : healthState === "failed" ? <><CircleHelp aria-hidden="true" className="h-4 w-4" />Couldn't check health</>
                : healthState === "attention" ? <>{attention.some(input => asStatus(statusOf(input)) === "error") ? <Unplug aria-hidden="true" className="h-4 w-4" /> : <CircleHelp aria-hidden="true" className="h-4 w-4" />}{inputs.length === 1 ? "Health check failed" : `${attention.length} ${attention.length === 1 ? "input needs" : "inputs need"} attention`}</>
                : <><Radio aria-hidden="true" className="h-4 w-4 text-[var(--sa-ink-3)]" />Not live</>}
            </span>
            <span aria-hidden="true" className="hidden h-5 w-px bg-[var(--sa-border)] sm:block" />
            <span className="text-[13px] text-[var(--sa-ink-2)]"><span className="tabular-nums font-semibold text-board-text">{connectedCount}</span> / <span className="tabular-nums">{inputs.length}</span> connected</span>
            <span aria-hidden="true" className="hidden h-5 w-px bg-[var(--sa-border)] sm:block" />
            <span className="text-[13px] text-[var(--sa-ink-3)]">{healthRead.error ? `Showing the last known status. We'll keep trying every 10s.` : relativeAge(healthRead.confirmedAt, now)}</span>
            <span className="ml-auto flex items-center gap-3">
              <span className="inline-flex items-center gap-2 text-[13px] text-[var(--sa-ink-3)]"><RefreshCw aria-hidden="true" className={`h-3.5 w-3.5 ${polling ? "animate-spin motion-reduce:animate-none" : ""}`} />Auto-refresh every 10s</span>
              {healthRead.failure ? <button type="button" disabled={polling} onClick={healthRead.retry} aria-label="Retry input health" className={secondary}><RefreshCw className="h-3.5 w-3.5" />{polling ? "Checking…" : healthRead.error ? "Try again" : "Retry failed check"}</button> : null}
            </span>
          </section>

          {inputs.length === 1 ? (
            <InputDetail input={inputs[0]} status={statusOf(inputs[0])} statusError={statuses[inputs[0].id]?.error ?? null} providerStatus={statuses[inputs[0].id]?.providerStatus ?? null}
              canManage={canManageStreamHealth} disabled={controlsDisabled} polling={polling} onRetry={healthRead.retry} onDelete={handleDelete} onResume={handleResume}
              onConnect={encoder => onConnect(inputs[0].id, encoder)} />
          ) : (
            <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              <section aria-label="Inputs" className="overflow-hidden rounded-xl border border-[var(--sa-border)] bg-[var(--sa-surface)]">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--sa-border)] px-4 py-3">
                  <h2 className="text-[13px] font-semibold text-board-text">Inputs <span className="ml-1 font-normal tabular-nums text-[var(--sa-ink-3)]">{inputs.length}</span></h2>
                  <span className="flex items-center gap-2 text-[13px] text-[var(--sa-ink-3)]">Sort
                    <span role="radiogroup" aria-label="Sort inputs" className="flex rounded-lg border border-[var(--sa-border-strong)] p-0.5">
                      {(["attention", "name"] as const).map(option => <button key={option} type="button" role="radio" aria-checked={sortBy === option} onClick={() => setSortBy(option)}
                        className={`h-7 rounded-md px-2.5 text-[13px] max-lg:h-10 ${sortBy === option ? "bg-[var(--sa-surface-3)] font-medium text-board-text" : "text-[var(--sa-ink-2)] hover:text-board-text"}`}>{option === "attention" ? "Attention first" : "Name"}</button>)}
                    </span>
                  </span>
                </div>
                <ul>
                  {sorted.map(input => {
                    const status = statusOf(input), active = selected?.id === input.id;
                    return <li key={input.id} className={`group grid grid-cols-[120px_minmax(0,1fr)_auto] items-center gap-3 border-b border-[var(--sa-border)] py-1 pl-4 pr-2 last:border-b-0 max-sm:grid-cols-[minmax(0,1fr)_auto] ${active ? "bg-[var(--sa-surface-2)] shadow-[inset_2px_0_0_var(--color-fire-500)]" : "hover:bg-[var(--sa-surface-2)]"}`}>
                      <span className="max-sm:hidden"><StatusMark status={status} /></span>
                      <button type="button" onClick={() => setSelectedId(input.id)} aria-current={active ? "true" : undefined} className="flex min-h-12 min-w-0 flex-col justify-center gap-0.5 py-1.5 text-left">
                        <span className="truncate text-[13px] font-semibold text-board-text">{input.name}</span>
                        <span className="truncate text-xs text-[var(--sa-ink-3)]"><span className="sm:hidden"><StatusMark status={status} /> · </span>{input.setupState !== "ready" ? "Setup needs attention." : statuses[input.id]?.error ?? statusDetail(status)}</span>
                      </button>
                      <span className="flex items-center gap-1">
                        {asStatus(status) === "idle" && canManageStreamHealth ? <button type="button" onClick={() => onConnect(input.id, "atem")} className={secondary}>Connect</button> : null}
                        {asStatus(status) === "unknown" ? <button type="button" onClick={healthRead.retry} disabled={polling} aria-label={`Retry check for ${input.name}`} className={iconButton}><RefreshCw className="h-3.5 w-3.5" /></button> : null}
                        <InputMenu input={input} canManage={canManageStreamHealth} disabled={controlsDisabled} polling={polling} onRetry={healthRead.retry} onDelete={handleDelete} onConnect={() => onConnect(input.id, "atem")} />
                      </span>
                    </li>;
                  })}
                </ul>
              </section>
              {selected ? <InputDetail input={selected} status={statusOf(selected)} statusError={statuses[selected.id]?.error ?? null} providerStatus={statuses[selected.id]?.providerStatus ?? null}
                canManage={canManageStreamHealth} disabled={controlsDisabled} polling={polling} onRetry={healthRead.retry} onDelete={handleDelete} onResume={handleResume}
                onConnect={encoder => onConnect(selected.id, encoder)} compact /> : null}
            </div>
          )}
        </>}

        {showAddForm ? <ModalA title="New Live Input" description="Create an ingest point for your encoder. Destination forwarding is controlled separately." closeLabel="Close live input editor" onClose={() => void closeEditor()}>
          <form onSubmit={handleCreate} className="flex flex-col gap-4">
            <div>
              <label htmlFor="live-input-name" className="mb-1.5 block text-[13px] font-medium text-board-text">Input Name</label>
              <input id="live-input-name" autoFocus value={newName} onChange={e => setNewName(e.target.value)} maxLength={200} disabled={locked} placeholder="e.g. ATEM Program, Main Camera"
                aria-invalid={duplicate} aria-describedby={duplicate ? "live-input-name-error" : "live-input-name-hint"} className={`w-full ${duplicate ? "!border-[var(--sa-danger)]" : ""}`} />
              {duplicate ? <p id="live-input-name-error" className="mt-1.5 flex items-start gap-1.5 text-xs text-[var(--sa-danger)]"><CircleHelp aria-hidden="true" className="mt-px h-3.5 w-3.5 shrink-0" />You already have an input called {newName.trim()}. Pick a different name.</p>
                : <p id="live-input-name-hint" className="mt-1.5 text-xs text-[var(--sa-ink-3)]">Name it after the source or encoder so your team recognises it.</p>}
            </div>
            {notice}
            {read.error && <ReadFailureNotice error={read.error} refreshing={read.refreshing} retry={read.retry} label="Retry inputs" />}
            <div className="-mx-5 -mb-5 flex items-center gap-2 border-t border-[var(--sa-border)] bg-board-bg px-5 py-3.5">
              <span className="mr-auto hidden items-center gap-1.5 text-xs text-[var(--sa-ink-3)] sm:inline-flex"><kbd className="rounded border border-[var(--sa-border-strong)] px-1.5 text-xs">Esc</kbd> to cancel</span>
              <button type="button" className={`${modalCancel} max-lg:h-11`} disabled={busy} onClick={() => void closeEditor()}>Cancel</button>
              <button type="submit" className={`${modalPrimary} min-w-[76px] max-lg:h-11`} disabled={controlsDisabled || !newName.trim() || duplicate} aria-label={busy ? "Creating…" : "Create"}>{busy ? "Creating…" : "Create"}</button>
            </div>
          </form>
        </ModalA> : null}

        <Dialog open={!!deleteAsk} onOpenChange={open => { if (!open) setDeleteAsk(null); }}>
          <DialogContent showCloseButton={false} className="schedule-a max-w-[480px] gap-0 overflow-hidden rounded-[14px] border-[var(--sa-border-strong)] bg-[var(--sa-surface)] p-0 text-board-text">
            {deleteAsk ? <>
              <div className="flex flex-col gap-3 px-5 pb-4 pt-5">
                <DialogTitle className="text-base font-semibold">Delete {deleteAsk.name}?</DialogTitle>
                <DialogDescription className="text-[13px] leading-[1.55] text-[var(--sa-ink-2)]">This removes the ingest point and its stream key. Encoders pointed at it can't connect again. This can't be undone.</DialogDescription>
                {asStatus(statusOf(deleteAsk)) === "streaming" ? <p className="flex items-center gap-2.5 rounded-lg border border-[var(--sa-danger)]/30 bg-[var(--sa-danger)]/[0.07] px-3 py-2.5 text-[13px] text-board-text"><Unplug aria-hidden="true" className="h-4 w-4 shrink-0 text-[var(--sa-danger)]" />{deleteAsk.name} is live. Deleting it ends the stream right away.</p> : null}
              </div>
              <div className="flex items-center justify-end gap-2 border-t border-[var(--sa-border)] bg-board-bg px-5 py-3.5">
                <span className="mr-auto hidden items-center gap-1.5 text-xs text-[var(--sa-ink-3)] sm:inline-flex"><kbd className="rounded border border-[var(--sa-border-strong)] px-1.5 text-xs">Esc</kbd> to cancel</span>
                <button type="button" autoFocus onClick={() => setDeleteAsk(null)} className={secondary}>Cancel</button>
                <button type="button" onClick={() => runDelete(deleteAsk)} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[var(--sa-danger)]/30 bg-[var(--sa-danger)]/10 px-3 text-[13px] font-semibold text-[var(--sa-danger)] max-lg:h-11"><Trash2 className="h-3.5 w-3.5" />Delete input</button>
              </div>
            </> : null}
          </DialogContent>
        </Dialog>
        <Dialog open={blocker.status === "blocked"} onOpenChange={open => { if (!open && blocker.status === "blocked") blocker.reset(); }}>
          <DialogContent aria-modal="true" showCloseButton={false} className="schedule-a border-[var(--sa-border-strong)] bg-[var(--sa-surface)] text-board-text"><DialogTitle>Leave Stream?</DialogTitle><DialogDescription>Your draft and retry controls will be discarded. An unconfirmed request may still complete. Review pending inputs when you return.</DialogDescription>
            <div className="flex flex-wrap justify-end gap-2"><button type="button" className={secondary} onClick={() => blocker.status === "blocked" && blocker.reset()}>Stay</button><button type="button" className={secondary} onClick={() => blocker.status === "blocked" && blocker.proceed()}>Leave Stream</button></div></DialogContent>
        </Dialog>
      </div>
      {ConfirmDialogEl}
    </div>
  );
}

function InputMenu({ input, canManage, disabled, polling, onRetry, onDelete, onConnect }: { input: Input; canManage: boolean; disabled: boolean; polling: boolean; onRetry: () => void; onDelete: (input: Input) => void; onConnect: () => void }) {
  return <DropdownMenu>
    <DropdownMenuTrigger asChild><button type="button" className={iconButton} aria-label={`Actions for ${input.name}`}><MoreHorizontal className="h-4 w-4" /></button></DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="schedule-a min-w-[220px]">
      <DropdownMenuItem onSelect={onConnect}><BookOpen className="h-3.5 w-3.5" />Connect an encoder</DropdownMenuItem>
      <DropdownMenuItem disabled={polling} onSelect={onRetry}><RefreshCw className="h-3.5 w-3.5" />Retry health check</DropdownMenuItem>
      {canManage ? <>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" disabled={disabled} onSelect={() => onDelete(input)} aria-label={`Delete ${input.name} stream input`}><Trash2 className="h-3.5 w-3.5" />Delete input…</DropdownMenuItem>
      </> : null}
    </DropdownMenuContent>
  </DropdownMenu>;
}

const ENCODERS: { id: Encoder; title: string; subtitle: string; icon: React.ElementType }[] = [
  { id: "atem", title: "Blackmagic ATEM Mini Pro / ISO", subtitle: "Direct RTMP streaming from the switcher — no computer needed", icon: Tv },
  { id: "obs", title: "OBS Studio", subtitle: "Software encoder — capture HDMI/SDI via capture card or screen", icon: Monitor },
  { id: "hardware", title: "Hardware Encoder", subtitle: "Teradek, Kiloview, LiveU, or similar — SDI/HDMI to RTMP", icon: Cpu },
];

function InputDetail({ input, status, statusError, providerStatus, canManage, disabled, polling, onRetry, onDelete, onResume, onConnect, compact = false }: {
  input: Input; status: string; statusError: string | null; providerStatus: string | null; canManage: boolean; disabled: boolean; polling: boolean;
  onRetry: () => void; onDelete: (input: Input) => void; onResume: (input: Input) => void; onConnect: (encoder: Encoder) => void; compact?: boolean;
}) {
  const [transport, setTransport] = useState<"rtmps" | "srt">("rtmps");
  const live = asStatus(status) === "streaming";
  const hasCredentials = !!(input.rtmpUrl || input.rtmpKey || input.srtUrl);
  return <section aria-label={input.name} className="overflow-hidden rounded-xl border border-[var(--sa-border)] bg-[var(--sa-surface)]">
    <header className="flex items-start justify-between gap-3 px-5 pb-4 pt-4">
      <div className="flex min-w-0 flex-col gap-1">
        <h2 className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[17px] font-semibold text-board-text"><span className="break-words">{input.name}</span><StatusMark status={status} /></h2>
        <p className="text-xs text-[var(--sa-ink-3)]">Provider: {(providerStatus ?? "unconfirmed").replaceAll("_", " ")}</p>
      </div>
      <InputMenu input={input} canManage={canManage} disabled={disabled} polling={polling} onRetry={onRetry} onDelete={onDelete} onConnect={() => onConnect("atem")} />
    </header>
    {input.setupState !== "ready" ? <div role="alert" className="mx-5 mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-[var(--sa-warn)]/30 bg-[var(--sa-warn)]/[0.07] px-3 py-2.5 text-[13px] text-board-text">
      <TriangleAlert aria-hidden="true" className="h-4 w-4 shrink-0 text-[var(--sa-warn)]" />
      <span className="min-w-0 flex-1">{input.setupState === "deleting" ? "This removal needs attention." : "This setup needs attention."}</span>
      {canManage ? <button type="button" className={secondary} disabled={disabled} onClick={() => input.setupState === "deleting" ? onDelete(input) : onResume(input)}>{input.setupState === "deleting" ? "Retry removal" : "Resume setup"}</button> : null}
    </div> : needsAttention(status) ? <div className="mx-5 mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-[var(--sa-warn)]/30 bg-[var(--sa-warn)]/[0.07] px-3 py-2.5 text-[13px] text-board-text">
      <CircleHelp aria-hidden="true" className="h-4 w-4 shrink-0 text-[var(--sa-warn)]" />
      <span className="min-w-0 flex-1">{asStatus(status) === "error" ? "The encoder stopped sending video. Check its network, then restart it." : "We couldn't confirm this input's status — the provider sent a status we don't recognise. Your encoder may still be sending video."}{statusError ? <span className="mt-0.5 block text-xs text-[var(--sa-ink-2)]">{statusError}</span> : null}</span>
      <button type="button" className={secondary} disabled={polling} onClick={onRetry}><RefreshCw className={`h-3.5 w-3.5 ${polling ? "animate-spin motion-reduce:animate-none" : ""}`} />{polling ? "Checking…" : "Retry check"}</button>
    </div> : null}
    <div className={`grid border-t border-[var(--sa-border)] ${compact ? "" : "lg:grid-cols-2 lg:divide-x lg:divide-[var(--sa-border)]"}`}>
      <div className="flex min-w-0 flex-col gap-4 px-5 py-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className={eyebrow}>Connection</h3>
          {input.srtUrl ? <span className="flex items-center gap-2 text-[13px] text-[var(--sa-ink-3)]">Connection type
            <span role="radiogroup" aria-label="Connection type" className="flex rounded-lg border border-[var(--sa-border-strong)] p-0.5">
              {(["rtmps", "srt"] as const).map(option => <button key={option} type="button" role="radio" aria-checked={transport === option} onClick={() => setTransport(option)}
                className={`h-7 rounded-md px-2.5 text-[13px] max-lg:h-10 ${transport === option ? "bg-[var(--sa-surface-3)] font-medium text-board-text" : "text-[var(--sa-ink-2)] hover:text-board-text"}`}>{option.toUpperCase()}</button>)}
            </span>
          </span> : null}
        </div>
        {!hasCredentials ? <p className="text-[13px] text-[var(--sa-ink-2)]">{canManage ? "Connection details appear once setup finishes." : "Only stream managers can see the server URL and stream key."}</p>
          : transport === "srt" && input.srtUrl ? <CopyField label="SRT URL" value={input.srtUrl} id={`srt-${input.id}`} />
          : <>
            {input.rtmpUrl ? <CopyField label="RTMPS URL" value={input.rtmpUrl} id={`rtmp-${input.id}`} /> : null}
            {input.rtmpKey ? <SecretField label="Stream Key" value={input.rtmpKey} id={`key-${input.id}`} /> : null}
          </>}
        {hasCredentials ? <p className="text-xs leading-[1.5] text-[var(--sa-ink-3)]">Use these in your ATEM, OBS, or hardware encoder. The key is secret — anyone with it can stream to this input.</p> : null}
      </div>
      <div className={`flex min-w-0 flex-col gap-3 px-5 py-5 ${compact ? "border-t border-[var(--sa-border)]" : "max-lg:border-t max-lg:border-[var(--sa-border)]"}`}>
        {live ? <>
          <h3 className={eyebrow}>Signal</h3>
          <p className="flex items-center gap-2 text-[13px] text-board-text"><Radio aria-hidden="true" className="h-4 w-4 text-[var(--sa-ok)]" />Receiving video from your encoder.</p>
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-dashed border-[var(--sa-border-strong)] px-4 py-3">
            <Radio aria-hidden="true" className="h-4 w-4 shrink-0 text-[var(--sa-ink-3)]" />
            <p className="min-w-0 flex-1 text-[13px] leading-[1.5] text-[var(--sa-ink-2)]">Push this stream to YouTube, Facebook, Twitch, and more at the same time.</p>
            <Link to="/$slug/streaming/platforms" from="/$slug/streaming/health" className={secondary}>Multi-Platform</Link>
          </div>
        </> : <>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className={eyebrow}>Connect an encoder</h3>
            <span className="text-xs text-[var(--sa-ink-3)]">Step-by-step, with your connection details filled in</span>
          </div>
          {ENCODERS.map(encoder => { const Icon = encoder.icon; return <button key={encoder.id} type="button" onClick={() => onConnect(encoder.id)}
            className="flex items-start gap-3 rounded-xl border border-[var(--sa-border)] px-3.5 py-3 text-left hover:border-[var(--sa-border-strong)] hover:bg-[var(--sa-surface-2)]">
            <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[var(--sa-border)] bg-[var(--sa-surface-2)] text-[var(--sa-ink-2)]"><Icon className="h-3.5 w-3.5" /></span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5"><span className="text-[13px] font-semibold text-board-text">{encoder.title}</span><span className="text-xs text-[var(--sa-ink-2)]">{encoder.subtitle}</span></span>
          </button>; })}
        </>}
      </div>
    </div>
  </section>;
}

function ConnectEncoder({ input, status, encoder, checkedAt, now, polling, onEncoder, onBack, workspaceTerms }: {
  input: Input; status: string; encoder: Encoder; checkedAt: number | null; now: number; polling: boolean;
  onEncoder: (encoder: Encoder) => void; onBack: () => void; workspaceTerms: ReturnType<typeof useWorkspaceTerms>;
}) {
  const [done, setDone] = useState<Set<number>>(new Set());
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { setDone(new Set()); heading.current?.focus(); }, [encoder]);
  const credentials = <>
    {input.rtmpUrl ? <CopyField label="RTMPS URL" value={input.rtmpUrl} id={`guide-rtmp-${input.id}`} /> : null}
    {input.rtmpKey ? <SecretField label="Stream Key" value={input.rtmpKey} id={`guide-key-${input.id}`} /> : null}
  </>;
  const B = ({ children }: { children: React.ReactNode }) => <strong className="font-semibold text-board-text">{children}</strong>;
  const steps: { text: React.ReactNode; extra?: React.ReactNode }[] = encoder === "atem" ? [
    { text: <>Open <B>ATEM Software Control</B> and connect to your ATEM.</> },
    { text: <>Go to the <B>Output</B> tab at the top of the window.</> },
    { text: <>In the <B>Live Stream</B> section, select <B>Service: Custom</B> from the dropdown.</> },
    { text: <><B>Server:</B> paste the RTMPS URL.</>, extra: input.rtmpUrl ? <CopyField label="Server" value={input.rtmpUrl} id={`atem-server-${input.id}`} /> : null },
    { text: <><B>Key:</B> paste the stream key.</>, extra: input.rtmpKey ? <SecretField label="Key" value={input.rtmpKey} id={`atem-key-${input.id}`} /> : null },
    { text: <>Set your preferred <B>Quality</B>.</>, extra: <div className="overflow-hidden rounded-lg border border-[var(--sa-border)] text-[13px]">
      {[["Streaming High", "1080p · 6Mbps", "Recommended"], ["Streaming Medium", "720p · 4.5Mbps", ""], ["Streaming Low", "540p · 3Mbps", "slow internet"]].map(([name, spec, note]) =>
        <div key={name} className="grid grid-cols-[minmax(0,1fr)_120px_120px] items-center gap-3 border-b border-[var(--sa-border)] px-3 py-2 last:border-b-0 max-sm:grid-cols-[minmax(0,1fr)_auto]"><span className="text-board-text">{name}</span><span className="tabular-nums text-[var(--sa-ink-2)]">{spec}</span>{note ? <span className={`text-xs text-[var(--sa-ink-3)] max-sm:hidden ${note === "Recommended" ? "justify-self-start rounded border border-[var(--sa-border-strong)] px-1.5" : ""}`}>{note}</span> : <span className="max-sm:hidden" />}</div>)}
    </div> },
    { text: <>Press the <B>ON AIR</B> button on the ATEM, or click the stream button in ATEM Software Control.</> },
  ] : encoder === "obs" ? [
    { text: <>Open OBS and go to <B>Settings → Stream</B>.</> },
    { text: <>Set <B>Service</B> to <B>Custom…</B></> },
    { text: <><B>Server:</B> paste the RTMPS URL.</>, extra: input.rtmpUrl ? <CopyField label="Server" value={input.rtmpUrl} id={`obs-server-${input.id}`} /> : null },
    { text: <><B>Stream Key:</B> paste the stream key.</>, extra: input.rtmpKey ? <SecretField label="Stream Key" value={input.rtmpKey} id={`obs-key-${input.id}`} /> : null },
    { text: <>Click <B>Apply</B>, then close settings.</> },
    { text: <>Click <B>Start Streaming</B> in the main OBS window.</> },
  ] : [
    { text: <>Connect your video source (ATEM, camera, etc.) to the encoder via SDI or HDMI.</> },
    { text: <>Connect the encoder to your network via Ethernet.</> },
    { text: <>Open the encoder's web interface (check your encoder's manual for the IP/URL).</> },
    { text: <>Set the streaming destination to <B>Custom RTMP</B>, or <B>SRT</B> if your encoder supports it.</> },
    { text: <>Paste the server address and stream key.</>, extra: <div className="flex flex-col gap-3">{credentials}{input.srtUrl ? <CopyField label="SRT URL" value={input.srtUrl} id={`hw-srt-${input.id}`} /> : null}</div> },
    { text: <>Start the stream from the encoder's interface or hardware button.</> },
  ];
  const total = steps.length + 1;
  const aside: { icon: React.ElementType; title: string; body: React.ReactNode }[] = encoder === "atem" ? [
    { icon: Check, title: "Requirements", body: <ul className="list-disc space-y-1.5 pl-4"><li>ATEM Mini Pro, Pro ISO, or Extreme (original Mini does not have streaming)</li><li>Ethernet connection to your network (USB-C Ethernet on ATEM Mini Pro)</li><li>ATEM Software Control installed on any computer on the same network</li></ul> },
    { icon: Lightbulb, title: "Tip", body: "Once configured, the ATEM remembers these settings. Next time, just press ON AIR — no computer needed to start streaming. The ATEM's built-in encoder handles everything." },
    { icon: Network, title: "Network", body: <>The ATEM must have internet access via its Ethernet port. If your ATEM is on a local-only network, connect it to a port with internet access or use a USB-C Ethernet adapter with an internet-connected port. Minimum recommended: <span className="tabular-nums text-board-text">10 Mbps</span> upload.</> },
  ] : encoder === "obs" ? [
    { icon: Check, title: "Recommended output settings", body: <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1"><dt>Encoder</dt><dd className="text-board-text">x264 (or NVENC/QSV)</dd><dt>Rate control</dt><dd className="text-board-text">CBR</dd><dt>Bitrate</dt><dd className="tabular-nums text-board-text">4500–6000 Kbps (1080p)</dd><dt>Keyframes</dt><dd className="text-board-text">2 seconds</dd><dt>Profile</dt><dd className="text-board-text">High</dd></dl> },
    { icon: Lightbulb, title: "With ATEM + capture card", body: "Connect ATEM HDMI Out → Capture Card → Computer USB. In OBS, add a Video Capture Device source and select your capture card. This gives you OBS's full encoding options while using the ATEM for switching." },
  ] : [
    { icon: Network, title: "SRT (if supported)", body: "If your encoder supports SRT, use the SRT URL instead of RTMP for lower latency and better reliability over unstable networks. SRT is supported by Kiloview, Teradek, and most modern encoders." },
    { icon: Lightbulb, title: "Best for", body: workspaceCopy("Permanent installations where reliability matters. Hardware encoders are always-on, don't need a computer, and handle encoding without any lag. Ideal for churches with a fixed production setup.", workspaceTerms) },
  ];
  const live = asStatus(status) === "streaming", connecting = asStatus(status) === "connecting";
  const current = steps.findIndex((_, index) => !done.has(index));
  return <div className="mx-auto flex max-w-[1180px] flex-col gap-5 px-4 pb-12 pt-6 md:px-8">
    <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1.5 text-[13px] text-[var(--sa-ink-3)]">
      <button type="button" onClick={onBack} className="inline-flex min-h-9 items-center gap-1 hover:text-board-text max-lg:min-h-11"><ChevronLeft className="h-3.5 w-3.5" />Stream</button>
      <span aria-hidden="true">/</span><span className="text-[var(--sa-ink-2)]">{input.name}</span><span aria-hidden="true">/</span><span>Connect an encoder</span>
    </nav>
    <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="flex min-w-0 flex-col gap-1.5">
        <h1 ref={heading} tabIndex={-1} className="text-[26px] font-semibold leading-[1.15] tracking-[-0.02em] text-board-text outline-none">Connect an encoder</h1>
        <p className="text-[13px] text-[var(--sa-ink-2)]">For {input.name}. Your server URL and stream key are filled into the steps below.</p>
      </div>
      <button type="button" onClick={onBack} className={secondary}>Back to Stream</button>
    </header>
    <div role="radiogroup" aria-label="Encoder" className="grid gap-3 md:grid-cols-3">
      {ENCODERS.map(option => { const Icon = option.icon, active = option.id === encoder; return <button key={option.id} type="button" role="radio" aria-checked={active} onClick={() => onEncoder(option.id)}
        className={`flex items-start gap-3 rounded-xl border px-4 py-3.5 text-left ${active ? "border-fire-500 bg-fire-500/[0.06]" : "border-[var(--sa-border)] bg-[var(--sa-surface)] hover:border-[var(--sa-border-strong)]"}`}>
        <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[var(--sa-border)] bg-[var(--sa-surface-2)] text-[var(--sa-ink-2)]"><Icon className="h-3.5 w-3.5" /></span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5"><span className="text-[13px] font-semibold text-board-text">{option.title}</span><span className="text-xs leading-[1.45] text-[var(--sa-ink-2)]">{option.subtitle}</span></span>
        <span aria-hidden="true" className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full ${active ? "bg-fire-500" : "shadow-[inset_0_0_0_1.5px_var(--sa-border-strong)]"}`}>{active ? <span className="h-1.5 w-1.5 rounded-full bg-[#1a1300]" /> : null}</span>
      </button>; })}
    </div>
    <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
      <section aria-labelledby="encoder-steps" className="rounded-xl border border-[var(--sa-border)] bg-[var(--sa-surface)] p-5">
        <div className="mb-4 flex items-baseline justify-between gap-2">
          <h2 id="encoder-steps" className={eyebrow}>Steps · {ENCODERS.find(option => option.id === encoder)?.title.replace("Blackmagic ", "")}</h2>
          <span className="text-xs tabular-nums text-[var(--sa-ink-3)]">{done.size + (live ? 1 : 0)} of {total} done</span>
        </div>
        <ol className="flex flex-col">
          {steps.map((step, index) => {
            const isDone = done.has(index), isCurrent = index === current;
            return <li key={index} className="grid grid-cols-[28px_minmax(0,1fr)] gap-x-3">
              <span className="flex flex-col items-center">
                <button type="button" role="checkbox" aria-checked={isDone} aria-label={`Step ${index + 1} done`} onClick={() => setDone(previous => { const next = new Set(previous); if (next.has(index)) next.delete(index); else next.add(index); return next; })}
                  className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs tabular-nums max-lg:h-11 max-lg:w-11 ${isDone ? "bg-[var(--sa-surface-3)] text-board-text" : isCurrent ? "bg-board-text font-semibold text-board-bg" : "shadow-[inset_0_0_0_1px_var(--sa-border-strong)] text-[var(--sa-ink-2)]"}`}>
                  {isDone ? <Check className="h-3.5 w-3.5" strokeWidth={2.5} /> : index + 1}
                </button>
                <span aria-hidden="true" className="w-px flex-1 bg-[var(--sa-border)]" />
              </span>
              <div className="flex min-w-0 flex-col gap-2.5 pb-5 pt-0.5">
                <p className={`text-[13px] leading-[1.55] ${isDone ? "text-[var(--sa-ink-2)]" : "text-board-text"}`}>{step.text}</p>
                {step.extra}
              </div>
            </li>;
          })}
          <li className="grid grid-cols-[28px_minmax(0,1fr)] gap-x-3">
            <span aria-hidden="true" className={`flex h-6 w-6 items-center justify-center rounded-full text-xs tabular-nums ${live ? "bg-[var(--sa-surface-3)] text-board-text" : "shadow-[inset_0_0_0_1px_var(--sa-border-strong)] text-[var(--sa-ink-2)]"}`}>{live ? <Check className="h-3.5 w-3.5" strokeWidth={2.5} /> : total}</span>
            <div className="flex min-w-0 flex-col gap-2.5 pt-0.5">
              <p className="text-[13px] text-board-text">Watch the status here.</p>
              <div role="status" className={`flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border px-4 py-3 ${live ? "border-[var(--sa-ok)]/35 bg-[var(--sa-ok)]/[0.06]" : connecting ? "border-[var(--sa-warn)]/35 bg-[var(--sa-warn)]/[0.06]" : "border-[var(--sa-border)] bg-board-bg"}`}>
                <StatusMark status={status} size="md" />
                <span className="min-w-0 flex-1 text-[13px] leading-[1.5] text-[var(--sa-ink-2)]">{live ? <>You're live. Push this stream to other platforms from <Link to="/$slug/streaming/platforms" from="/$slug/streaming/health" className="text-board-text underline underline-offset-2">Multi-Platform</Link>.</> : <>Waiting for video from your encoder. This changes to <B>Connecting</B>, then <B>LIVE</B>, within a few seconds.</>}</span>
                <span className="inline-flex items-center gap-1.5 text-xs text-[var(--sa-ink-3)]"><RefreshCw aria-hidden="true" className={`h-3 w-3 ${polling ? "animate-spin motion-reduce:animate-none" : ""}`} />{relativeAge(checkedAt, now)}</span>
              </div>
            </div>
          </li>
        </ol>
      </section>
      <aside className="flex flex-col gap-3">
        {aside.map(card => { const Icon = card.icon; return <section key={card.title} className="rounded-xl border border-[var(--sa-border)] bg-[var(--sa-surface)] p-4">
          <h3 className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-board-text"><Icon aria-hidden="true" className="h-3.5 w-3.5 text-[var(--sa-ink-3)]" />{card.title}</h3>
          <div className="text-[13px] leading-[1.55] text-[var(--sa-ink-2)]">{card.body}</div>
        </section>; })}
      </aside>
    </div>
  </div>;
}

/** One calm skeleton in the real layout. No status words until there is a real answer. */
function StreamSkeleton() {
  const bar = (className: string) => <span className={`block rounded bg-[var(--sa-surface-3)] ${className}`} />;
  return <div className="schedule-a h-full bg-board-bg">
    <p role="status" className="sr-only">Loading inputs…</p>
    <div aria-hidden="true" className="schedule-skeleton mx-auto flex max-w-[1180px] flex-col gap-5 px-4 pt-6 md:px-8">
      <div className="flex flex-col gap-2">{bar("h-7 w-32")}{bar("h-3 w-72")}</div>
      <div className="flex h-12 items-center gap-6 rounded-xl border border-[var(--sa-border)] bg-[var(--sa-surface)] px-4">{bar("h-2.5 w-32")}{bar("h-2.5 w-24")}{bar("h-2.5 w-28")}</div>
      <div className="grid gap-5 rounded-xl border border-[var(--sa-border)] bg-[var(--sa-surface)] p-5 lg:grid-cols-2">
        <div className="flex flex-col gap-3">{bar("h-3 w-40")}{bar("h-10 w-full rounded-lg")}{bar("h-10 w-full rounded-lg")}</div>
        <div className="flex flex-col gap-3">{bar("h-14 w-full rounded-xl")}{bar("h-14 w-full rounded-xl")}</div>
      </div>
    </div>
  </div>;
}
