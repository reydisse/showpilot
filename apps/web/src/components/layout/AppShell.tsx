import { SidebarProvider } from "./SidebarContext";
import { Sidebar } from "./Sidebar";
import { FullscreenExitButton } from "./FullscreenExitButton";
import { MobileHeader } from "./MobileHeader";

interface AppShellProps {
  children: React.ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  return (
    <SidebarProvider>
      <div className="flex h-[100dvh] min-h-[100dvh] overflow-hidden bg-board-bg">
        <Sidebar />
        <div className="flex-1 min-w-0 flex flex-col">
          <MobileHeader />
          <main className="flex-1 min-h-0 overflow-auto modern-scrollbar">
            {children}
          </main>
        </div>
        <FullscreenExitButton />
      </div>
    </SidebarProvider>
  );
}
