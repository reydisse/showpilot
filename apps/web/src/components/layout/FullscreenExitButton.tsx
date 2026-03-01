import { Minimize } from "lucide-react";
import { useSidebar } from "./SidebarContext";

export function FullscreenExitButton() {
  const { fullscreen, toggleFullscreen } = useSidebar();

  if (!fullscreen) return null;

  return (
    <button
      onClick={toggleFullscreen}
      aria-label="Exit fullscreen"
      className="fixed top-4 left-4 z-50 flex items-center gap-2 px-3 py-2 rounded-xl bg-board-card/80 border border-board-border backdrop-blur-sm text-board-muted hover:text-board-text hover:bg-board-card transition-all opacity-0 hover:opacity-100 focus:opacity-100 cursor-pointer"
    >
      <Minimize className="w-4 h-4" />
      <span className="text-xs font-medium">Exit</span>
    </button>
  );
}
