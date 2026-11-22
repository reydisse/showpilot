import { Link, useRouteContext } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import { Maximize, Minimize, Moon, MoreHorizontal, PanelLeft, Sun, UserCheck, Users } from "lucide-react";
import { Popover } from "radix-ui";
import { ConfidenceToolbar } from "@/components/confidence/ConfidenceToolbar";
import { useSidebar } from "@/components/layout/SidebarContext";
import { useTheme } from "@/components/layout/ThemeContext";
import { useDesktopRuntime } from "@/hooks/useDesktopRuntime";
import { hasEffectivePermission } from "@/lib/app-permissions";

/** Real output and workspace controls, shared by the cue sheet's compact header. */
export function CueSheetHeaderActions({ orgId, slug, controls, menuOnly = false }: { orgId: string; slug: string; controls?: ReactNode; menuOnly?: boolean }) {
  const { role, grantedPermissions } = useRouteContext({ from: "/$slug" });
  const { collapsed, toggle, fullscreen, toggleFullscreen } = useSidebar();
  const { theme, toggleTheme } = useTheme();
  const desktop = useDesktopRuntime();
  const [wide, setWide] = useState(false);
  useEffect(() => { const media = window.matchMedia("(min-width: 1101px)"); const update = () => setWide(media.matches); update(); media.addEventListener("change", update); return () => media.removeEventListener("change", update); }, []);
  return <div className="cue-header-actions">
    {!menuOnly && <ConfidenceToolbar orgId={orgId} slug={slug} />}
    {!menuOnly && hasEffectivePermission(role, grantedPermissions, "showboard:view") && <Link to="/$slug/board" params={{ slug }}><Users />Crew status</Link>}
    {!menuOnly && hasEffectivePermission(role, grantedPermissions, "checkin:access") && <Link to="/$slug/checkin" params={{ slug }}><UserCheck />Check-in</Link>}
    <Popover.Root><Popover.Trigger asChild><button type="button" className="cue-icon" aria-label="Workspace actions"><MoreHorizontal /></button></Popover.Trigger>
      <Popover.Portal><Popover.Content align="end" sideOffset={8} className="cue-portal cue-header-menu z-50 rounded-lg border border-board-border bg-board-card p-2 shadow-xl" aria-label="Workspace actions">
        {controls && <div className="mb-2 border-b border-board-border pb-2">{controls}</div>}
        <button type="button" onClick={toggleTheme}>{theme === "dark" ? <Sun /> : <Moon />}{theme === "dark" ? "Light appearance" : "Dark appearance"}</button>
        {!desktop && <button type="button" onClick={toggleFullscreen}>{fullscreen ? <Minimize /> : <Maximize />}{fullscreen ? "Exit fullscreen" : "Fullscreen"}</button>}
        {wide && <button type="button" onClick={toggle}><PanelLeft />{collapsed ? "Expand sidebar" : "Collapse sidebar"}</button>}
      </Popover.Content></Popover.Portal>
    </Popover.Root>
  </div>;
}
