import { Link, useLocation, useParams } from "@tanstack/react-router";
import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import {
  ListMusic,
  UserCheck,
  Users,
  Clapperboard,
  ClipboardCheck,
  AlertTriangle,
  Package,
  Activity,
  Radio,
  Type,
  Mic,
  LayoutDashboard,
  Wrench,
  Monitor,
  ChevronsLeft,
  ChevronsRight,
  Maximize,
  Minimize,
  Sun,
  Moon,
  Settings,
  MonitorPlay,
  MessageSquare,
  Timer,
} from "lucide-react";
import { useSidebar } from "./SidebarContext";
import { useTheme } from "./ThemeContext";

interface NavItem {
  icon: React.ElementType;
  label: string;
  path: string; // relative to /:slug/
}

const mainNav: NavItem[] = [
  { icon: ListMusic, label: "Show", path: "show" },
  { icon: MonitorPlay, label: "Show Board", path: "show/board" },
  { icon: Timer, label: "Rundown", path: "rundown" },
  { icon: MessageSquare, label: "Chat", path: "chat" },
  { icon: UserCheck, label: "Check-in", path: "checkin" },
  { icon: Users, label: "Team", path: "admin" },
];

const productionNav: NavItem[] = [
  { icon: Clapperboard, label: "Cue Sheets", path: "production/cue-sheets" },
  { icon: ClipboardCheck, label: "Checklist", path: "production/checklist" },
  { icon: AlertTriangle, label: "Incidents", path: "production/incidents" },
  { icon: Package, label: "Assets", path: "production/assets" },
];

const streamingNav: NavItem[] = [
  { icon: Activity, label: "Stream Health", path: "streaming/health" },
  { icon: Radio, label: "Multi-Platform", path: "streaming/platforms" },
  { icon: Type, label: "Lower Thirds", path: "streaming/graphics" },
];

const dashboardNav: NavItem[] = [
  { icon: LayoutDashboard, label: "Prod Manager", path: "dashboard/prod-manager" },
  { icon: Wrench, label: "Tech Manager", path: "dashboard/tech-manager" },
  { icon: Mic, label: "Audio", path: "dashboard/audio" },
  { icon: Monitor, label: "Devices", path: "dashboard/devices" },
];

function NavLink({
  item,
  slug,
  collapsed,
  active,
}: {
  item: NavItem;
  slug: string;
  collapsed: boolean;
  active: boolean;
}) {
  const Icon = item.icon;
  return (
    <Link
      to={`/${slug}/${item.path}`}
      title={item.label}
      className={`flex items-center rounded-lg transition-colors relative ${
        collapsed ? "justify-center p-2.5" : "gap-3 px-3 py-2.5"
      } ${
        active
          ? "bg-fire-500/10 text-fire-500"
          : "text-board-muted hover:bg-board-border/50 hover:text-board-text"
      }`}
    >
      {active && (
        <div className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-5 rounded-r-full bg-fire-500" />
      )}
      <Icon className="w-[18px] h-[18px] shrink-0" />
      {!collapsed && (
        <span className="text-sm font-medium whitespace-nowrap">
          {item.label}
        </span>
      )}
    </Link>
  );
}

function GearMenu({ collapsed }: { collapsed: boolean }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });
  const { toggle, fullscreen, toggleFullscreen } = useSidebar();
  const { theme, toggleTheme } = useTheme();

  // Position the menu relative to the button using fixed coords
  useEffect(() => {
    if (!open || !btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    setMenuPos({
      top: rect.bottom + 6,
      left: Math.max(8, rect.left),
    });
  }, [open, collapsed]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        menuRef.current && !menuRef.current.contains(e.target as Node) &&
        btnRef.current && !btnRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open]);

  return (
    <div>
      <button
        ref={btnRef}
        onClick={() => setOpen((v) => !v)}
        type="button"
        aria-label="Settings"
        className={`p-1.5 rounded-lg text-board-muted hover:bg-board-border/50 hover:text-board-text transition-colors cursor-pointer ${
          open ? "bg-board-border/50 text-board-text" : ""
        }`}
      >
        <Settings className="w-4 h-4" />
      </button>

      {open && createPortal(
        <div
          ref={menuRef}
          className="fixed z-50 bg-board-card border border-board-border rounded-xl shadow-lg py-1"
          style={{ top: menuPos.top, left: menuPos.left, minWidth: 180 }}
        >
          {/* Theme toggle */}
          <button
            onClick={() => {
              toggleTheme();
              setOpen(false);
            }}
            type="button"
            className="flex items-center gap-3 px-3 py-2.5 w-full text-board-muted hover:bg-board-border/50 hover:text-board-text transition-colors cursor-pointer"
          >
            {theme === "dark" ? (
              <Sun className="w-[18px] h-[18px] shrink-0" />
            ) : (
              <Moon className="w-[18px] h-[18px] shrink-0" />
            )}
            <span className="text-sm font-medium whitespace-nowrap">
              {theme === "dark" ? "Light Mode" : "Dark Mode"}
            </span>
          </button>

          {/* Fullscreen toggle */}
          <button
            onClick={() => {
              toggleFullscreen();
              setOpen(false);
            }}
            type="button"
            className="flex items-center gap-3 px-3 py-2.5 w-full text-board-muted hover:bg-board-border/50 hover:text-board-text transition-colors cursor-pointer"
          >
            {fullscreen ? (
              <Minimize className="w-[18px] h-[18px] shrink-0" />
            ) : (
              <Maximize className="w-[18px] h-[18px] shrink-0" />
            )}
            <span className="text-sm font-medium whitespace-nowrap">
              {fullscreen ? "Exit Fullscreen" : "Fullscreen"}
            </span>
          </button>

          {/* Collapse sidebar toggle */}
          <button
            onClick={() => {
              toggle();
              setOpen(false);
            }}
            type="button"
            className="flex items-center gap-3 px-3 py-2.5 w-full text-board-muted hover:bg-board-border/50 hover:text-board-text transition-colors cursor-pointer"
          >
            {collapsed ? (
              <ChevronsRight className="w-[18px] h-[18px] shrink-0" />
            ) : (
              <ChevronsLeft className="w-[18px] h-[18px] shrink-0" />
            )}
            <span className="text-sm font-medium whitespace-nowrap">
              {collapsed ? "Expand Sidebar" : "Collapse Sidebar"}
            </span>
          </button>
        </div>,
        document.body
      )}
    </div>
  );
}

export function Sidebar() {
  const { collapsed, fullscreen } = useSidebar();
  const { pathname } = useLocation();
  const { slug } = useParams({ strict: false });

  const isActive = (path: string) => {
    const fullPath = `/${slug}/${path}`;
    if (path === "show") return pathname === `/${slug}/show` || pathname === `/${slug}`;
    return pathname.startsWith(fullPath);
  };

  const w = fullscreen ? 0 : collapsed ? 68 : 240;

  return (
    <>
      {/* Fixed sidebar */}
      <aside
        style={{ width: w, transition: "width 200ms ease-in-out" }}
        className={`fixed top-0 left-0 h-screen z-30 bg-board-card border-r border-board-border flex flex-col overflow-hidden ${
          fullscreen ? "pointer-events-none opacity-0" : "opacity-100"
        }`}
      >
        {/* Logo + Gear */}
        <div
          className={`py-5 flex items-center overflow-hidden ${
            collapsed ? "flex-col gap-2 px-2" : "gap-3 px-4"
          }`}
        >
          <img
            src="/showpilot-logo.svg"
            alt="ShowPilot"
            width={24}
            height={24}
            className="shrink-0"
          />
          {!collapsed && (
            <span className="text-base font-semibold text-fire-500 whitespace-nowrap tracking-tight">
              ShowPilot
            </span>
          )}
          <div className={collapsed ? "" : "ml-auto"}>
            <GearMenu collapsed={collapsed} />
          </div>
        </div>

        {/* Scrollable nav area */}
        <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden hide-scrollbar pb-4">
          {/* Main nav */}
          <div className="px-2.5 space-y-0.5">
            {mainNav.map((item) => (
              <NavLink
                key={item.path}
                item={item}
                slug={slug!}
                collapsed={collapsed}
                active={isActive(item.path)}
              />
            ))}
          </div>

          {/* Divider + Production section */}
          <div className={`pt-5 pb-2 ${collapsed ? "px-3" : "px-4"}`}>
            {!collapsed ? (
              <p className="text-[10px] font-medium text-board-muted/50 uppercase tracking-widest whitespace-nowrap">
                Production
              </p>
            ) : (
              <div className="h-px bg-board-border" />
            )}
          </div>

          <div className="px-2.5 space-y-0.5">
            {productionNav.map((item) => (
              <NavLink
                key={item.path}
                item={item}
                slug={slug!}
                collapsed={collapsed}
                active={isActive(item.path)}
              />
            ))}
          </div>

          {/* Divider + Streaming section */}
          <div className={`pt-5 pb-2 ${collapsed ? "px-3" : "px-4"}`}>
            {!collapsed ? (
              <p className="text-[10px] font-medium text-board-muted/50 uppercase tracking-widest whitespace-nowrap">
                Streaming
              </p>
            ) : (
              <div className="h-px bg-board-border" />
            )}
          </div>

          <div className="px-2.5 space-y-0.5">
            {streamingNav.map((item) => (
              <NavLink
                key={item.path}
                item={item}
                slug={slug!}
                collapsed={collapsed}
                active={isActive(item.path)}
              />
            ))}
          </div>

          {/* Divider + Dashboards section */}
          <div className={`pt-5 pb-2 ${collapsed ? "px-3" : "px-4"}`}>
            {!collapsed ? (
              <p className="text-[10px] font-medium text-board-muted/50 uppercase tracking-widest whitespace-nowrap">
                Dashboards
              </p>
            ) : (
              <div className="h-px bg-board-border" />
            )}
          </div>

          <div className="px-2.5 space-y-0.5">
            {dashboardNav.map((item) => (
              <NavLink
                key={item.path}
                item={item}
                slug={slug!}
                collapsed={collapsed}
                active={isActive(item.path)}
              />
            ))}
          </div>
        </div>

        {/* Settings link pinned to bottom */}
        <div className="shrink-0 border-t border-board-border px-2.5 py-3">
          <NavLink
            item={{ icon: Settings, label: "Settings", path: "settings" }}
            slug={slug!}
            collapsed={collapsed}
            active={isActive("settings")}
          />
        </div>
      </aside>

      {/* Spacer div to push main content right */}
      <div
        className="shrink-0"
        style={{
          width: w,
          minWidth: w,
          transition: "width 200ms ease-in-out, min-width 200ms ease-in-out",
        }}
      />
    </>
  );
}
