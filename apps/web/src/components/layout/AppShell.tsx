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
        <Sidebar />
        <div className="flex-1 min-w-0 flex flex-col">
          <DesktopStatusBar />
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
