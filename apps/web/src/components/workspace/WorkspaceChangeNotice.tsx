import { plainFailure } from "@showpilot/shared/ui-feedback";
import { QuietActivity } from "@/components/ui/QuietActivity";
import { workspaceChangeMessage } from "@showpilot/shared/workspace-change";
import type { WorkspaceWork } from "@/hooks/useWorkspaceWork";
export function WorkspaceChangeNotice({ work }: { work: WorkspaceWork }) {
  const a = work.attempt;
  const button = "min-h-11 rounded-lg border border-board-border px-4 py-2";
  return <div className="space-y-2 text-sm" aria-live="polite">
    {work.loading && <QuietActivity label="Loading current workspace settings…" />}
    {work.error && <div role="alert"><p>{plainFailure((work.error) ?? "")}</p><button className={button} onClick={work.load}>Reload workspace</button></div>}
    {a?.kind === "pending" && <QuietActivity label="Saving workspace change…" />}
    {a?.kind === "unknown" && <div role="alert" className="space-y-2">
      <p>This change needs attention.</p>
      <div className="flex flex-wrap gap-2"><button className={button} onClick={work.retry}>Retry original change</button><button className={button} onClick={work.review}>Check current settings</button></div>
    </div>}
    {a?.kind === "confirmed" && <div className="space-y-2">
      {a.result.outcome !== "applied" && <p>{workspaceChangeMessage(a.result)}</p>}
      {a.refresh === "pending" ? <QuietActivity label="Refreshing workspace…" /> : a.refresh === "failed" ? <div role="alert"><p>The workspace could not be updated.</p><button className={button} onClick={work.refresh}>Retry refresh</button></div>
        : <button className={button} onClick={work.useCurrent}>Use current settings</button>}
    </div>}
  </div>;
}
