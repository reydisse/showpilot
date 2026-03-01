import { SidebarProvider } from "./SidebarContext";
import { Sidebar } from "./Sidebar";
import { FullscreenExitButton } from "./FullscreenExitButton";

interface AppShellProps {
  children: React.ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  return (
    <SidebarProvider>
      <div className="flex h-screen bg-board-bg">
        <Sidebar />
        <main className="flex-1 min-w-0 overflow-auto modern-scrollbar">
          {children}
        </main>
        <FullscreenExitButton />
      </div>
    </SidebarProvider>
  );
}
