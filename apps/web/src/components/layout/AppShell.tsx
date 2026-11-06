import { Link } from "@tanstack/react-router";
import { SidebarProvider } from "./SidebarContext";
import { Sidebar } from "./Sidebar";
import { FullscreenExitButton } from "./FullscreenExitButton";
import { MobileHeader } from "./MobileHeader";
import { DesktopStatusBar } from "./DesktopStatusBar";
import { LiveRundownBar } from "./LiveRundownBar";

interface AppShellProps {
  children: React.ReactNode;
  orgId?: string;
  slug?: string;
  canControlRundown?: boolean;
  showLiveRundown?: boolean;
}

export function AppShell({
  children,
  orgId,
  slug,
  canControlRundown = false,
  showLiveRundown = true,
}: AppShellProps) {
  return (
    <SidebarProvider>
      <div className="flex h-[100dvh] overflow-hidden bg-board-bg">
        {orgId && slug && <Link to="/$slug/rundown" params={{ slug }} hash="rundown-runsheet"
          onClick={event => {
            const runsheet = document.getElementById("rundown-runsheet");
            if (runsheet) { event.preventDefault(); runsheet.focus(); runsheet.scrollIntoView({ block: "start" }); }
          }}
          className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[100] focus:rounded-lg focus:border focus:border-fire-500 focus:bg-board-card focus:px-4 focus:py-3 focus:text-sm focus:font-semibold focus:text-board-text focus:outline-2 focus:outline-fire-500">Skip to rundown</Link>}

        <Sidebar />
        <div className="flex-1 min-w-0 flex flex-col">
          <DesktopStatusBar orgId={orgId} />
          <MobileHeader />
          {showLiveRundown && orgId && slug ? (
            <LiveRundownBar orgId={orgId} slug={slug} canControl={canControlRundown} />
          ) : null}
          <main className="flex-1 min-h-0 overflow-auto modern-scrollbar">
            {children}
          </main>
        </div>
        <FullscreenExitButton />
      </div>
    </SidebarProvider>
  );
}
