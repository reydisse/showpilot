import { Minimize } from "lucide-react";
import { useSidebar } from "./SidebarContext";

export function FullscreenExitButton() {
  const { fullscreen, toggleFullscreen } = useSidebar();

  if (!fullscreen) return null;

  return (
    <button
      onClick={toggleFullscreen}
      aria-label="Exit fullscreen"
      className="fixed left-4 top-4 z-50 flex cursor-pointer items-center gap-2 rounded-xl border border-board-border bg-board-card/80 px-3 py-2 text-board-muted opacity-100 backdrop-blur-sm transition-all hover:bg-board-card hover:text-board-text focus:opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:hover:opacity-100 [@media(hover:hover)]:focus:opacity-100"
    >
      <Minimize className="w-4 h-4" />
      <span className="text-xs font-medium">Exit</span>
    </button>
  );
}
