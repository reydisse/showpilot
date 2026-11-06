import { useEffect, useRef, useState } from "react";
import { workspaceCopy } from "@showpilot/shared";
import { useTerms } from "@/components/workspace/WorkspaceProvider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { createBrowserId } from "@/lib/browser-id";
import { saveRundownTemplate } from "@/lib/rundown";
import { withOperationTimeout } from "@/lib/operation-timeout";
import type { RundownItem } from "@/types/rundown";

type SaveInput = { id: string; orgId: string; name: string; serviceName: string; scheduledStartTime: string; items: RundownItem[] };
type SaveState = { kind: "editing" } | { kind: "saving"; input: SaveInput } | { kind: "error"; input: SaveInput; occurredAt: number; reason: "unconfirmed" | "conflict" | "removed" };
interface Props {
  orgId: string;
  items: RundownItem[];
  initialServiceName: string;
  initialStartTime: string;
  onClose: () => void;
}
export function SaveRundownModal(props: Props) {
  return <SaveRundownSession key={props.orgId} {...props} />;
}
function SaveRundownSession({ orgId, items, initialServiceName, initialStartTime, onClose }: Props) {
  const terms = useTerms();
  const [name, setName] = useState("");
  const [serviceName, setServiceName] = useState(initialServiceName);
  const [scheduledStartTime, setScheduledStartTime] = useState(initialStartTime);
  const [state, setState] = useState<SaveState>({ kind: "editing" });
  const current = useRef(0);
  const alive = useRef(false);
  const pending = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; current.current++; }; }, []);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim() || pending.current || state.kind === "error" && state.reason !== "unconfirmed") return;
    // Freeze the reviewed fields and items for this attempt. A retry checks this
    // same save, even when another operator changes the live rundown meanwhile.
    const input = state.kind === "editing" ? {
      id: createBrowserId(), orgId, name: name.trim(), serviceName: serviceName.trim(), scheduledStartTime, items: structuredClone(items),
    } : state.input;
    const request = ++current.current;
    pending.current = true;
    setState({ kind: "saving", input });
    try {
      const result = await withOperationTimeout(saveRundownTemplate({ data: input }), 10_000, "Template save was not confirmed");
      if (!alive.current || request !== current.current) return;
      if (result.ok) onClose();
      else setState({ kind: "error", input, occurredAt: Date.now(), reason: result.reason });
    } catch {
      if (alive.current && request === current.current) setState({ kind: "error", input, occurredAt: Date.now(), reason: "unconfirmed" });
    } finally {
      if (request === current.current) pending.current = false;
    }
  }
  const frozen = state.kind !== "editing";
  const inputClass = "w-full rounded-xl border border-board-border bg-board-bg px-4 py-2.5 text-sm text-board-text placeholder:text-board-muted focus:border-fire-500 focus:outline-none disabled:opacity-60";
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent aria-describedby={undefined} showCloseButton={false} className="rundown-modal block max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] overflow-y-auto rounded-2xl border-board-border bg-board-card p-4 sm:max-w-sm sm:p-6">
      <DialogTitle className="mb-4 text-lg font-semibold text-board-text">Save Rundown Template</DialogTitle>
      <form onSubmit={save} className="space-y-4">
        <div>
          <label htmlFor="template-name" className="mb-1.5 block text-sm text-board-muted">Template Name</label>
          <input id="template-name" type="text" value={name} maxLength={200} disabled={frozen} required autoFocus
            onChange={event => setName(event.target.value)} placeholder={workspaceCopy("e.g. Sunday Morning Service", terms)} className={inputClass} />
        </div>
        <div>
          <label htmlFor="template-service-name" className="mb-1.5 block text-sm text-board-muted">{workspaceCopy("Service title", terms)}</label>
          <input id="template-service-name" type="text" value={serviceName} maxLength={120} disabled={frozen}
            onChange={event => setServiceName(event.target.value)} className={inputClass} />
        </div>
        <div>
          <label htmlFor="template-start-time" className="mb-1.5 block text-sm text-board-muted">{workspaceCopy("Service start time", terms)}</label>
          <input id="template-start-time" type="time" value={scheduledStartTime} disabled={frozen}
            onChange={event => setScheduledStartTime(event.target.value)} className={inputClass} />
        </div>
        <p className="text-xs text-board-muted">Saves {state.kind === "editing" ? items.length : state.input.items.length} rundown items as a reusable template. Saved items start as upcoming.</p>
        {state.kind === "saving" && <p role="status" className="text-sm text-board-muted">Saving template…</p>}
        {state.kind === "error" && <div role="alert" className="space-y-2 rounded-xl border border-red-400/40 p-3 text-sm text-red-300">
          <p>{state.reason === "unconfirmed" ? "Template save could not be confirmed. Check your connection and retry the same save. Retrying will not create a duplicate." : state.reason === "removed" ? "This template was saved and then removed. Close this dialog before creating another copy." : "This save conflicts with an existing template. Close this dialog and review Saved Templates before starting a new save."}</p>
          <time dateTime={new Date(state.occurredAt).toISOString()}>{new Date(state.occurredAt).toLocaleTimeString()}</time>
          <p>If you close this dialog, check Saved Templates before creating another copy.</p>
        </div>}
        <div className="flex gap-3 pt-1">
          <Button type="button" variant="outline" onClick={onClose} className="flex-1">{state.kind === "error" ? "Close" : "Cancel"}</Button>
          {(state.kind !== "error" || state.reason === "unconfirmed") && <Button type="submit" disabled={!name.trim() || state.kind === "saving"} className="flex-1 bg-fire-500 text-black">
            {state.kind === "saving" ? "Saving…" : state.kind === "error" ? "Retry save" : "Save"}
          </Button>}
        </div>
      </form>
    </DialogContent>
  </Dialog>;
}
