import { Menu } from "lucide-react";
import { useSidebar } from "./SidebarContext";
import { useRouteContext } from "@tanstack/react-router";

export function MobileHeader() {
  const { toggleMobile, isMobile } = useSidebar();

  let orgName: string | null = null;
  try {
    const ctx = useRouteContext({ from: "/$slug" });
    orgName = ctx.org?.name ?? null;
  } catch {
    // Not inside /$slug route
  }

  if (!isMobile) return null;

  return (
    <header className="shrink-0 flex items-center gap-3 px-4 py-3 border-b border-board-border bg-board-card md:hidden">
      <button
        onClick={toggleMobile}
        className="flex items-center justify-center w-11 h-11 rounded-xl bg-board-bg border border-board-border text-board-text active:bg-board-border transition-colors"
        aria-label="Open menu"
      >
        <Menu className="w-5 h-5" />
      </button>
      <div className="flex items-center gap-2 min-w-0">
        <img src="/showpilot-logo.svg" alt="" width={20} height={20} className="shrink-0" />
        <span className="text-sm font-semibold text-fire-500 truncate">
          {orgName ?? "ShowPilot"}
        </span>
      </div>
    </header>
  );
}
