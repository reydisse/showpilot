import { useEffect } from "react";
import { Link, useLocation, useParams, useRouteContext } from "@tanstack/react-router";
import { OrgSwitcher } from "./OrgSwitcher";
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
  Clock4,
} from "lucide-react";
import { useSidebar } from "./SidebarContext";
import { useTheme } from "./ThemeContext";
import { hasAnyPermission, hasPermission } from "@/lib/app-permissions";
import { SidebarIdentity } from "./SidebarIdentity";
import { ROLE_COLOURS } from "./ProfileModal";

interface NavItem {
  icon: React.ElementType;
  label: string;
  path: string; // relative to /:slug/
}

const mainNav: NavItem[] = [
  { icon: ListMusic, label: "Show", path: "show" },
  { icon: MonitorPlay, label: "Show Board", path: "board" },
  { icon: Timer, label: "Rundown", path: "rundown" },
  { icon: Clock4, label: "Timecode", path: "timecode" },
  { icon: MessageSquare, label: "Chat", path: "chat" },
  { icon: UserCheck, label: "Check-in", path: "checkin" },
  { icon: Users, label: "Team", path: "team" },
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
  const resolvedTo = `/${slug}/${item.path}` as unknown as Parameters<typeof Link>[0]["to"];
  return (
    <Link
      to={resolvedTo}
      title={item.label}
      className={`flex items-center rounded-lg transition-colors relative min-h-[44px] ${
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

function QuickActions({ collapsed }: { collapsed: boolean }) {
  const { toggle, fullscreen, toggleFullscreen } = useSidebar();
  const { theme, toggleTheme } = useTheme();

  return (
    <div className={`flex items-center ${collapsed ? "flex-col gap-1" : "gap-1"}`}>
      <button
        onClick={toggleTheme}
        type="button"
        title={theme === "dark" ? "Light Mode" : "Dark Mode"}
        className="p-1.5 rounded-lg text-board-muted hover:bg-board-border/50 hover:text-board-text transition-colors cursor-pointer"
      >
        {theme === "dark" ? (
          <Sun className="w-3.5 h-3.5" />
        ) : (
          <Moon className="w-3.5 h-3.5" />
        )}
      </button>
      <button
        onClick={toggleFullscreen}
        type="button"
        title={fullscreen ? "Exit Fullscreen" : "Fullscreen"}
        className="p-1.5 rounded-lg text-board-muted hover:bg-board-border/50 hover:text-board-text transition-colors cursor-pointer"
      >
        {fullscreen ? (
          <Minimize className="w-3.5 h-3.5" />
        ) : (
          <Maximize className="w-3.5 h-3.5" />
        )}
      </button>
      <button
        onClick={toggle}
        type="button"
        title={collapsed ? "Expand Sidebar" : "Collapse Sidebar"}
        className="p-1.5 rounded-lg text-board-muted hover:bg-board-border/50 hover:text-board-text transition-colors cursor-pointer"
      >
        {collapsed ? (
          <ChevronsRight className="w-3.5 h-3.5" />
        ) : (
          <ChevronsLeft className="w-3.5 h-3.5" />
        )}
      </button>
    </div>
  );
}


export function Sidebar() {
  const { collapsed, fullscreen, mobileOpen, setMobileOpen, isMobile } = useSidebar();
  const { pathname } = useLocation();
  const { slug } = useParams({ strict: false });
  let org: { id: string; name: string; slug: string; logo: string | null } | null = null;
  let role: string | null = null;
  let user: { id: string; name: string; email: string; image?: string | null } | null = null;
  try {
    const ctx = useRouteContext({ from: "/$slug" });
    org = ctx.org;
    role = ctx.role ?? null;
    user = ctx.user ?? null;
  } catch {
    // Not inside /$slug route
  }

  // Close drawer on navigation
  useEffect(() => {
    if (mobileOpen) setMobileOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  const isSettings = pathname === `/${slug}/settings`;

  const isActive = (path: string) => {
    const fullPath = `/${slug}/${path}`;
    if (path === "show") return pathname === `/${slug}/show` || pathname === `/${slug}`;
    return pathname.startsWith(fullPath);
  };

  const hidden = fullscreen || isSettings;
  const w = hidden ? 0 : collapsed ? 68 : 240;

  if (hidden && !isMobile) {
    return null;
  }

  // Mobile: overlay drawer
  if (isMobile) {
    return (
      <>
        {/* Backdrop */}
        {mobileOpen && (
          <div
            className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
            onClick={() => setMobileOpen(false)}
          />
        )}
        {/* Slide-in drawer */}
          <aside
            className={`fixed top-0 left-0 h-[100dvh] w-[280px] z-50 bg-board-card border-r border-board-border flex flex-col overflow-hidden transition-transform duration-200 ease-in-out ${
              mobileOpen ? "translate-x-0" : "-translate-x-full"
            }`}
          >
          {/* Drawer uses expanded layout (collapsed=false) */}
           {renderSidebarContent({ collapsed: false, org, slug: slug!, isActive, role, user })}
        </aside>
      </>
    );
  }

  // Desktop: fixed sidebar + spacer
  return (
    <>
      <aside
        style={{ width: w, transition: "width 200ms ease-in-out" }}
        className={`fixed top-0 left-0 h-[100dvh] z-30 bg-board-card border-r border-board-border flex flex-col overflow-hidden ${
          hidden ? "pointer-events-none opacity-0" : "opacity-100"
        }`}
      >
        {renderSidebarContent({ collapsed, org, slug: slug!, isActive, role, user })}
      </aside>

      {/* Spacer div to push main content right */}
      <div
        className="shrink-0 hidden lg:block"
        style={{
          width: w,
          minWidth: w,
          transition: "width 200ms ease-in-out, min-width 200ms ease-in-out",
        }}
      />
    </>
  );
}

/** Shared sidebar content — used by both desktop sidebar and mobile drawer */
function renderSidebarContent({
  collapsed,
  org,
  slug,
  isActive,
  role,
  user,
}: {
  collapsed: boolean;
  org: { id: string; name: string; slug: string; logo: string | null } | null;
  slug: string;
  isActive: (path: string) => boolean;
  role: string | null;
  user: { id: string; name: string; email: string; image?: string | null } | null;
}) {
  const visibleMainNav = mainNav.filter((item) => {
    if (item.path === "show") return hasPermission(role, "show:view");
    if (item.path === "board") return hasPermission(role, "showboard:view");
    if (item.path === "rundown") return hasPermission(role, "rundown:view");
    if (item.path === "timecode") return hasPermission(role, "timecode:access");
    if (item.path === "chat") return hasPermission(role, "chat:access");
    if (item.path === "checkin") return hasPermission(role, "checkin:access");
    if (item.path === "team") return hasAnyPermission(role, ["settings:members", "checkin:access"]);
    return true;
  });

  const visibleProductionNav = productionNav.filter((item) => {
    if (item.path === "production/checklist") return hasAnyPermission(role, ["checklist:view", "checklist:access"]);
    if (item.path === "production/incidents") {
      return hasAnyPermission(role, ["incidents:report", "incidents:access"]);
    }
    if (item.path === "production/cue-sheets") {
      return hasAnyPermission(role, ["cuesheet:view", "cuesheet:edit", "cuesheet:add_notes"]);
    }
    if (item.path === "production/assets") return hasPermission(role, "assets:view");
    return true;
  });

  const visibleStreamingNav = streamingNav.filter((item) => {
    if (item.path === "streaming/health") return hasPermission(role, "stream_health:view");
    if (item.path === "streaming/platforms") return hasPermission(role, "streaming_suite:access");
    if (item.path === "streaming/graphics") return hasPermission(role, "lowerthird:view");
    return true;
  });

  const visibleDashboardNav = dashboardNav.filter((item) => {
    if (item.path === "dashboard/devices") return hasPermission(role, "devices:access");
    if (item.path === "dashboard/prod-manager") return hasPermission(role, "dashboard:pm");
    return hasPermission(role, "dashboard:tm");
  });

  const roleColour = ROLE_COLOURS[role ?? ""] ?? ROLE_COLOURS.member;

  return (
    <>
      {/* Logo + Gear — role-accent left border */}
      <div
        className={`py-5 flex items-center overflow-hidden ${
          collapsed ? "flex-col gap-2 px-2" : "gap-3 px-4"
        }`}
        style={{ borderLeft: `3px solid ${roleColour}` }}
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
        <div className={collapsed ? "mt-1" : "ml-auto"}>
          <QuickActions collapsed={collapsed} />
        </div>
      </div>

      {/* Org Switcher */}
      {org && (
        <div className={`border-b border-board-border ${collapsed ? "px-1.5 py-2" : "px-2.5 py-2"}`}>
          <OrgSwitcher currentOrg={org} collapsed={collapsed} />
        </div>
      )}

      {/* Scrollable nav area */}
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden hide-scrollbar pb-4">
        {/* Main nav */}
        <div className="px-2.5 space-y-0.5">
          {visibleMainNav.map((item) => (
            <NavLink
              key={item.path}
              item={item}
              slug={slug}
              collapsed={collapsed}
              active={isActive(item.path)}
            />
          ))}
        </div>

        {/* Divider + Production section */}
        {visibleProductionNav.length > 0 && (
          <>
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
              {visibleProductionNav.map((item) => (
                <NavLink
                  key={item.path}
                  item={item}
                  slug={slug}
                  collapsed={collapsed}
                  active={isActive(item.path)}
                />
              ))}
            </div>
          </>
        )}

        {/* Divider + Streaming section */}
        {visibleStreamingNav.length > 0 && (
          <>
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
              {visibleStreamingNav.map((item) => (
                <NavLink
                  key={item.path}
                  item={item}
                  slug={slug}
                  collapsed={collapsed}
                  active={isActive(item.path)}
                />
              ))}
            </div>
          </>
        )}

        {/* Divider + Dashboards section */}
        {visibleDashboardNav.length > 0 && (
          <>
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
              {visibleDashboardNav.map((item) => (
                <NavLink
                  key={item.path}
                  item={item}
                  slug={slug}
                  collapsed={collapsed}
                  active={isActive(item.path)}
                />
              ))}
            </div>
          </>
        )}
      </div>

      {/* Settings + Identity pinned to bottom */}
      <div className="shrink-0 border-t border-board-border px-2.5 py-3 space-y-0.5">
        {hasAnyPermission(role, [
          "settings:organization",
          "settings:members",
          "settings:billing",
          "settings:integrations",
          "settings:production_defaults",
          "settings:lowerthird_config",
          "settings:notifications",
          "settings:api_keys",
          "settings:webhooks",
          "settings:danger_zone",
          "org:delete",
        ]) && (
          <NavLink
            item={{ icon: Settings, label: "Settings", path: "settings" }}
            slug={slug}
            collapsed={collapsed}
            active={isActive("settings")}
          />
        )}
        {user && (
          <SidebarIdentity
            collapsed={collapsed}
            user={user}
            role={role ?? "member"}
            orgName={org?.name ?? ""}
          />
        )}
      </div>
    </>
  );
}
