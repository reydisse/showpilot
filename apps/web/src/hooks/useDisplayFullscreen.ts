import { useCallback, useEffect, useState } from "react";
import {
  getDesktopFullscreenState,
  isDesktopRuntime,
  toggleDesktopFullscreen,
} from "@/lib/desktop-runtime";

type FullscreenDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};

type FullscreenElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};

function browserFullscreenElement(): Element | null {
  const fullscreenDocument = document as FullscreenDocument;
  return document.fullscreenElement ?? fullscreenDocument.webkitFullscreenElement ?? null;
}

export function useDisplayFullscreen() {
  const desktop = isDesktopRuntime();
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    if (desktop) {
      let active = true;
      const syncNativeState = () => {
        void getDesktopFullscreenState()
          .then((fullscreen) => {
            if (active && fullscreen !== null) setIsFullscreen(fullscreen);
          })
          .catch((cause) => console.warn("[SP] Could not read display fullscreen state", cause));
      };
      syncNativeState();
      window.addEventListener("focus", syncNativeState);
      window.addEventListener("resize", syncNativeState);
      return () => {
        active = false;
        window.removeEventListener("focus", syncNativeState);
        window.removeEventListener("resize", syncNativeState);
      };
    }

    const syncBrowserState = () => setIsFullscreen(browserFullscreenElement() !== null);
    syncBrowserState();
    document.addEventListener("fullscreenchange", syncBrowserState);
    document.addEventListener("webkitfullscreenchange", syncBrowserState);
    return () => {
      document.removeEventListener("fullscreenchange", syncBrowserState);
      document.removeEventListener("webkitfullscreenchange", syncBrowserState);
    };
  }, [desktop]);

  const toggleFullscreen = useCallback(() => {
    if (desktop) {
      void toggleDesktopFullscreen()
        .then((fullscreen) => {
          if (fullscreen !== null) setIsFullscreen(fullscreen);
        })
        .catch((cause) => console.warn("[SP] Could not toggle display fullscreen", cause));
      return;
    }

    const fullscreenDocument = document as FullscreenDocument;
    const root = document.documentElement as FullscreenElement;
    const operation = browserFullscreenElement()
      ? document.exitFullscreen?.() ?? fullscreenDocument.webkitExitFullscreen?.()
      : root.requestFullscreen?.() ?? root.webkitRequestFullscreen?.();
    if (operation instanceof Promise) {
      void operation.catch((cause) => console.warn("[SP] Could not toggle fullscreen", cause));
    }
  }, [desktop]);

  return { isFullscreen, toggleFullscreen };
}
