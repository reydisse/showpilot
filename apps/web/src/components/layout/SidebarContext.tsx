import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";

interface SidebarContextValue {
  collapsed: boolean;
  setCollapsed: (value: boolean) => void;
  toggle: () => void;
  fullscreen: boolean;
  toggleFullscreen: () => void;
  exitFullscreen: () => void;
}

const SidebarContext = createContext<SidebarContextValue>({
  collapsed: false,
  setCollapsed: () => {},
  toggle: () => {},
  fullscreen: false,
  toggleFullscreen: () => {},
  exitFullscreen: () => {},
});

function getInitialCollapsed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return localStorage.getItem("showpilot-sidebar-collapsed") === "true";
  } catch {
    return false;
  }
}

export function SidebarProvider({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsedState] = useState(getInitialCollapsed);
  const [fullscreen, setFullscreen] = useState(false);

  // Sync with browser fullscreen API changes (e.g. user presses Esc)
  useEffect(() => {
    const handleChange = () => {
      if (!document.fullscreenElement) {
        setFullscreen(false);
      }
    };
    document.addEventListener("fullscreenchange", handleChange);
    return () => document.removeEventListener("fullscreenchange", handleChange);
  }, []);

  const setCollapsed = (value: boolean) => {
    setCollapsedState(value);
    localStorage.setItem("showpilot-sidebar-collapsed", String(value));
  };

  const toggle = () => {
    setCollapsedState((prev) => {
      const next = !prev;
      localStorage.setItem("showpilot-sidebar-collapsed", String(next));
      return next;
    });
  };

  const toggleFullscreen = useCallback(() => {
    setFullscreen((prev) => {
      const next = !prev;
      if (next) {
        document.documentElement.requestFullscreen?.().catch(() => {});
      } else {
        document.exitFullscreen?.().catch(() => {});
      }
      return next;
    });
  }, []);

  const exitFullscreen = useCallback(() => {
    setFullscreen(false);
    document.exitFullscreen?.().catch(() => {});
  }, []);

  return (
    <SidebarContext.Provider
      value={{ collapsed, setCollapsed, toggle, fullscreen, toggleFullscreen, exitFullscreen }}
    >
      {children}
    </SidebarContext.Provider>
  );
}

export function useSidebar() {
  return useContext(SidebarContext);
}
