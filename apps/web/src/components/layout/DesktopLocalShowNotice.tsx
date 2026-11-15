import { useDesktopLocalShow } from "@/hooks/useDesktopLocalShow";
export function DesktopLocalShowNotice({ orgId }: { orgId?: string; slug?: string }) {
  const { status, error } = useDesktopLocalShow();
  if (error || !orgId || status?.mode !== "active" || status.orgId !== orgId || !["local", "local-held"].includes(status.commandSource)) return null;
  return <span aria-label="Running on this computer" className="inline-flex items-center gap-1.5 text-xs text-board-muted"><span aria-hidden="true" className="size-1.5 rounded-full bg-green-500" />On this computer</span>;
}
