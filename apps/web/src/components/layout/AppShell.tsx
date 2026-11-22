import { RundownHandoffNotice } from "./RundownHandoffNotice";
import { RuntimeErrorNotice } from "./RuntimeErrorNotice";
import { Link, useRouterState } from "@tanstack/react-router";
import { createContext, lazy, Suspense, useContext, useEffect, useState } from "react";
import { useDesktopRuntime } from "@/hooks/useDesktopRuntime";
import { SidebarProvider } from "./SidebarContext";
import { Sidebar } from "./Sidebar";
import { FullscreenExitButton } from "./FullscreenExitButton";
import { MobileHeader } from "./MobileHeader";
import { LiveRundownBar } from "./LiveRundownBar";

const CueSheetHeaderActions = lazy(() => import("@/components/cue-sheet/header-actions").then(module => ({ default: module.CueSheetHeaderActions })));
const DesktopStatusBar = lazy(() => import("./DesktopStatusBar").then(module => ({ default: module.DesktopStatusBar })));

const SettingsReturnContext = createContext<string | null>(null);

export function useSettingsReturnTo() {
  return useContext(SettingsReturnContext);
}

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
  const desktop = useDesktopRuntime();
  const location = useRouterState({ select: state => state.resolvedLocation });
  const cueSheet = location?.pathname.endsWith("/production/cue-sheets") ?? false;
  const [previousPage, setPreviousPage] = useState<{ slug: string; href: string } | null>(null);
  useEffect(() => {
    if (slug && location && location.pathname.startsWith(`/${slug}/`) && location.pathname !== `/${slug}/settings`) {
      setPreviousPage({ slug, href: location.href });
    }
  }, [slug, location?.pathname, location?.href]);
  // Section changes stay inside Settings. Keep the preceding workspace page,
  // including its filters/hash, and never carry it across organizations.
  const settingsReturnTo = previousPage && previousPage.slug === slug ? previousPage.href : null;

  return (
    <SettingsReturnContext.Provider value={settingsReturnTo}>
      <SidebarProvider>
        <div className={`flex h-[100dvh] overflow-hidden bg-board-bg ${cueSheet ? "cue-workspace" : ""}`}>
          {orgId && slug && <Link to="/$slug/rundown" params={{ slug }} hash="rundown-runsheet"
            onClick={event => {
              const runsheet = document.getElementById("rundown-runsheet");
              if (runsheet) { event.preventDefault(); runsheet.focus(); runsheet.scrollIntoView({ block: "start" }); }
            }}
            className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[100] focus:rounded-lg focus:border focus:border-fire-500 focus:bg-board-card focus:px-4 focus:py-3 focus:text-sm focus:font-semibold focus:text-board-text focus:outline-2 focus:outline-fire-500">Skip to rundown</Link>}

          <Sidebar />
          <div className="flex-1 min-w-0 flex flex-col">
            {desktop && <Suspense fallback={null}><DesktopStatusBar orgId={orgId} liveRundown={cueSheet && showLiveRundown && orgId && slug ? <LiveRundownBar orgId={orgId} slug={slug} canControl={canControlRundown} compact toolbar={controls => <Suspense fallback={null}><CueSheetHeaderActions orgId={orgId} slug={slug} controls={controls} menuOnly /></Suspense>} /> : undefined} /></Suspense>}
            <MobileHeader />
            {orgId && <RuntimeErrorNotice orgId={orgId} />}
            {orgId && slug && <RundownHandoffNotice orgId={orgId} slug={slug} />}
            {showLiveRundown && orgId && slug && !(desktop && cueSheet) ? (
              <LiveRundownBar orgId={orgId} slug={slug} canControl={canControlRundown} compact={cueSheet} toolbar={cueSheet ? controls => <Suspense fallback={null}><CueSheetHeaderActions orgId={orgId} slug={slug} controls={controls} /></Suspense> : undefined} />
            ) : null}
            <main className="flex-1 min-h-0 overflow-auto modern-scrollbar">
              {children}
            </main>
          </div>
          <FullscreenExitButton />
        </div>
      </SidebarProvider>
    </SettingsReturnContext.Provider>
  );
}
