import { useEffect, useState } from "react";
import { ChevronDown, Monitor } from "lucide-react";
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
      <div className="flex shrink-0 items-center rounded-md border border-board-border">
        <button type="button" disabled={output.busy}
          aria-pressed={output.enabled}
          title={output.error || output.status.message}
          onClick={() => {
            if (failed || (!output.enabled && !output.target)) setOpen(true);
            else void output.toggle();
          }}
          className={`flex min-h-8 items-center gap-1.5 rounded-l-md px-2 py-1 disabled:opacity-50 ${failed ? "text-red-400" : output.enabled ? "bg-green-500/10 text-green-400" : "text-board-muted hover:text-board-text"}`}>
          <Monitor className="size-3.5" />
          Confidence {output.busy ? "Updating…" : output.status.state === "starting" ? "Starting…" : failed ? "Error" : output.enabled ? "On" : "Off"}
        </button>
        <button type="button" aria-label="Confidence output and appearance" aria-expanded={open}
          onClick={() => setOpen(true)} className="min-h-8 rounded-r-md border-l border-board-border px-2 hover:text-board-text">
          <ChevronDown className="size-3.5" />
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
