import { workspaceChangeMessage } from "@showpilot/shared/workspace-change";
import type { WorkspaceWork } from "@/hooks/useWorkspaceWork";
export function WorkspaceChangeNotice({ work }: { work: WorkspaceWork }) {
  const a = work.attempt;
  const button = "min-h-11 rounded-lg border border-board-border px-4 py-2";
  return <div className="space-y-2 text-sm" aria-live="polite">
    {work.loading && <p>Loading current workspace settings…</p>}
    {work.error && <div role="alert"><p>{work.error}</p><button className={button} onClick={work.load}>Reload workspace</button></div>}
    {work.notice && <p role="status">{work.notice}</p>}
    {a?.kind === "pending" && <p>Confirming workspace change…</p>}
    {a?.kind === "unknown" && <div role="alert" className="space-y-2">
      <p>Workspace change is not confirmed. It may have saved. Your original change is kept.</p>
      <div className="flex flex-wrap gap-2"><button className={button} onClick={work.retry}>Retry original change</button><button className={button} onClick={work.review}>Check current settings</button></div>
    </div>}
    {a?.kind === "confirmed" && <div className="space-y-2">
      <p>{workspaceChangeMessage(a.result)}</p>
      {a.refresh === "pending" ? <p>Refreshing workspace…</p> : a.refresh === "failed" ? <div role="alert"><p>The change is confirmed, but the workspace could not refresh.</p><button className={button} onClick={work.refresh}>Retry refresh</button></div>
        : <button className={button} onClick={work.useCurrent}>Use current settings</button>}
    </div>}
  </div>;
}
