import { useEffect, useState } from "react";
import { Monitor, Power } from "lucide-react";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { ConfidenceOutputControls } from "@/components/settings/ConfidenceOutputs";
import { ConfidenceSection } from "@/components/settings/ConfidenceSection";
import { useConfidenceOutput } from "@/lib/use-confidence-output";
import { getManageableOrgSettings } from "@/lib/settings";
import { CONFIDENCE_LAYOUT_KEY } from "@/lib/confidence-layout";

export function ConfidenceToolbar({ slug, orgId }: { slug: string; orgId?: string }) {
  const output = useConfidenceOutput(slug);
  const [open, setOpen] = useState(false);
  const [layout, setLayout] = useState<string | null>(null);
  const [layoutError, setLayoutError] = useState("");
  useEffect(() => {
    if (!open || !orgId) return;
    let active = true;
    setLayout(null);
    setLayoutError("");
    void getManageableOrgSettings({ data: { orgId } }).then((settings) => {
      if (active) setLayout(settings[CONFIDENCE_LAYOUT_KEY] ?? "");
    }).catch(() => {
      if (active) setLayoutError("Could not load the screen style. Close and reopen to retry.");
    });
    return () => { active = false; };
  }, [open, orgId]);
  const failed = Boolean(output.error) || output.status.state === "error";
  return (
    <>
      <div className="flex shrink-0 items-center gap-1 rounded-xl border border-board-border bg-board-card/70 p-1 shadow-sm">
        <button
          type="button"
          aria-label="Confidence output and appearance"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen(true)}
          className="sp-button flex h-8 items-center gap-2 rounded-lg px-2 text-sm font-medium text-board-text hover:bg-board-text/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fire-500"
        >
          <Monitor aria-hidden="true" className="size-4 text-board-muted" />
          <span>Confidence</span>
          <span className={`inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs font-medium ${failed ? "bg-red-500/10 text-red-400" : output.enabled ? "bg-green-500/10 text-green-400" : "bg-board-text/5 text-board-muted"}`}>
            <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
            {output.busy ? "Updating…" : output.status.state === "starting" ? "Starting…" : failed ? "Error" : output.enabled ? "Live" : "Off"}
          </span>
        </button>
        <button
          type="button"
          disabled={output.busy}
          aria-label={`Confidence ${output.busy ? "Updating…" : output.status.state === "starting" ? "Starting…" : failed ? "Error" : output.enabled ? "On" : "Off"}`}
          aria-pressed={output.enabled}
          title={failed ? output.error || output.status.message : output.enabled ? "Turn confidence output off" : "Turn confidence output on"}
          onClick={() => {
            if (failed || (!output.enabled && !output.target)) setOpen(true);
            else void output.toggle();
          }}
          className={`sp-button flex size-8 items-center justify-center rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fire-500 disabled:opacity-50 ${failed ? "text-red-400 hover:bg-red-500/10" : output.enabled ? "bg-green-500/10 text-green-400 hover:bg-green-500/20" : "text-board-muted hover:bg-board-text/5 hover:text-board-text"}`}
        >
          <Power aria-hidden="true" className="size-4" />
        </button>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto bg-board-bg text-board-text sm:max-w-3xl">
          <DialogTitle>Confidence display</DialogTitle>
          <DialogDescription>Choose an output and adjust what your team sees.</DialogDescription>
          <ConfidenceOutputControls slug={slug} output={output} />
          {layoutError && <p role="alert" className="text-sm text-red-400">{layoutError}</p>}
          {orgId && layout !== null && (
            <ConfidenceSection orgId={orgId} slug={slug} initialValue={layout} onApplied={setLayout} showOutputs={false} />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
