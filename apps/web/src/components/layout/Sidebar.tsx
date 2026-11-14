import {
  useWorkspace,
  useTerms,
} from "@/components/workspace/WorkspaceProvider";
import type { ModuleId } from "@showpilot/shared";
import { useEffect } from "react";
import {
  Link,
  useLocation,
  useParams,
  useRouteContext,
} from "@tanstack/react-router";
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
  MonitorPlay,
  MessageSquare,
  Timer,
  Clock4,
  CalendarDays,
  FileBarChart,
  LibraryBig,
} from "lucide-react";
import { useSidebar } from "./SidebarContext";
import { useTheme } from "./ThemeContext";
import {
  hasAnyEffectivePermission,
  type Permission,
} from "@/lib/app-permissions";
import { SidebarIdentity } from "./SidebarIdentity";
import { ROLE_COLOURS } from "./account-role";
import { useDesktopRuntime } from "@/hooks/useDesktopRuntime";

interface NavItem {
  module: ModuleId;
  icon: React.ElementType;
  label: string;
  path: string; // relative to /:slug/
  permission?: Permission | readonly Permission[];
}

const mainNav: NavItem[] = [
  {
    icon: ListMusic,
    label: "Show",
    path: "show",
    module: "show",
    permission: "show:view",
  },
  {
    icon: CalendarDays,
    label: "Schedule",
    path: "schedule",
    module: "schedule",
    permission: "schedule:view",
  },
  {
    icon: MonitorPlay,
    label: "Crew status",
    path: "board",
    module: "board",
    permission: "showboard:view",
  },
  {
    icon: Timer,
    label: "Rundown",
    path: "rundown",
    module: "rundown",
    permission: "rundown:view",
  },
  {
    icon: Clock4,
    label: "Timecode",
    path: "timecode",
    module: "timecode",
    permission: "timecode:access",
  },
  {
    icon: LibraryBig,
    label: "Songs",
    path: "songs",
    module: "songs",
    permission: "songs:access",
  },
  {
    icon: MessageSquare,
    label: "Chat",
    path: "chat",
    module: "chat",
    permission: "chat:access",
  },
  {
    icon: Users,
    label: "Team",
    path: "team",
    module: "team",
    permission: ["settings:members", "checkin:access"],
  },
];

const productionNav: NavItem[] = [
  {
    icon: Clapperboard,
    label: "Cue Sheets",
    path: "production/cue-sheets",
    module: "production",
    permission: ["cuesheet:view", "cuesheet:edit", "cuesheet:add_notes"],
  },
  {
    icon: ClipboardCheck,
    label: "Checklist",
    path: "production/checklist",
    module: "production",
    permission: ["checklist:view", "checklist:access"],
  },
  {
    icon: UserCheck,
    label: "Crew Check-in",
    path: "checkin",
    module: "board",
    permission: "checkin:access",
  },
  {
    icon: AlertTriangle,
    label: "Incidents",
    path: "production/incidents",
    module: "production",
    permission: ["incidents:report", "incidents:access"],
  },
  {
    icon: Package,
    label: "Assets",
    path: "production/assets",
    module: "production",
    permission: "assets:view",
  },
];

const streamingNav: NavItem[] = [
  {
    icon: Activity,
    label: "Stream",
    path: "streaming/health",
    module: "streaming",
    permission: "stream_health:view",
  },
  {
    icon: Radio,
    label: "Multi-Platform",
    path: "streaming/platforms",
    module: "streaming",
    permission: "streaming_suite:access",
  },
  {
    icon: Type,
    label: "Lower Thirds",
    path: "streaming/graphics",
    module: "lower_thirds",
    permission: "lowerthird:view",
  },
];

const dashboardNav: NavItem[] = [
  {
    icon: LayoutDashboard,
    label: "Prod Manager",
    path: "dashboard/prod-manager",
    module: "dashboards",
    permission: "dashboard:pm",
  },
  {
    icon: FileBarChart,
    label: "Reports & Notes",
    path: "reports",
    module: "dashboards",
    permission: "show:view",
  },
  {
    icon: Wrench,
    label: "Tech Manager",
    path: "dashboard/tech-manager",
    module: "dashboards",
    permission: "dashboard:tm",
  },
  {
    icon: Mic,
    label: "Audio",
    path: "dashboard/audio",
    module: "dashboards",
    permission: "dashboard:tm",
  },
  {
    icon: Monitor,
    label: "Devices",
    path: "dashboard/devices",
    module: "dashboards",
    permission: "devices:access",
  },
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
  const terms = useTerms();
  const label = item.path === "show" ? terms.eventTitle : item.label;
  const Icon = item.icon;
  const resolvedTo = `/${slug}/${item.path}` as unknown as Parameters<
    typeof Link
  >[0]["to"];
  return (
    <Link
      to={resolvedTo}
      title={label}
      aria-current={active ? "page" : undefined}
      className={`flex items-center rounded-lg transition-colors relative min-h-[44px] outline-none focus-visible:ring-2 focus-visible:ring-fire-500 ${
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
        <span className="text-sm font-medium whitespace-nowrap">{label}</span>
      )}
    </Link>
  );
}

function QuickActions({ collapsed }: { collapsed: boolean }) {
  const { toggle, fullscreen, toggleFullscreen } = useSidebar();
  const { theme, toggleTheme } = useTheme();
  const desktop = useDesktopRuntime();

  const buttonClass =
    "flex min-h-11 min-w-11 items-center justify-center rounded-lg text-board-muted outline-none hover:bg-board-border/50 hover:text-board-text focus-visible:ring-2 focus-visible:ring-fire-500";
  return (
    <div
      className={`flex items-center justify-start gap-1 ${collapsed ? "flex-col" : "-ml-2.5"}`}
    >
      <button
        onClick={toggleTheme}
        title={theme === "dark" ? "Light" : "Dark"}
        className={buttonClass}
      >
        {theme === "dark" ? (
          <Sun className="size-4" />
        ) : (
          <Moon className="size-4" />
        )}
      </button>
      {!desktop && (
        <button
          onClick={toggleFullscreen}
          title={fullscreen ? "Exit Fullscreen" : "Fullscreen"}
          className={buttonClass}
        >
          {fullscreen ? (
            <Minimize className="size-4" />
          ) : (
            <Maximize className="size-4" />
          )}
        </button>
      )}
      <button
        onClick={toggle}
        title={collapsed ? "Expand" : "Collapse"}
        className={buttonClass}
      >
        {collapsed ? (
          <ChevronsRight className="size-4" />
        ) : (
          <ChevronsLeft className="size-4" />
        )}
      </button>
    </div>
  );
}

export function Sidebar() {
  const workspace = useWorkspace();
  const { collapsed, fullscreen, mobileOpen, setMobileOpen, isMobile } =
    useSidebar();
  const { pathname } = useLocation();
  const { slug } = useParams({ strict: false });
  let org: {
    id: string;
    name: string;
    slug: string;
    logo: string | null;
  } | null = null;
  let role: string | null = null;
  let grantedPermissions: Permission[] = [];
  let canManageAccess = false;
  let user: {
    id: string;
    name: string;
    email: string;
    emailVerified: boolean;
    image?: string | null;
  } | null = null;
  try {
    const ctx = useRouteContext({ from: "/$slug" });
    org = ctx.org;
    role = ctx.role ?? null;
    grantedPermissions = ctx.grantedPermissions ?? [];
    canManageAccess = ctx.accessAuthority?.canManage ?? false;
    user = ctx.user ?? null;
  } catch {
    // Not inside /$slug route
  }

  // Close drawer on navigation
  useEffect(() => {
    if (mobileOpen) setMobileOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  const isActive = (path: string) => {
    const fullPath = `/${slug}/${path}`;
    if (path === "show")
      return pathname === fullPath || pathname === `/${slug}`;
    if (
      path === "streaming/graphics" &&
      ["streaming/lt-preview", "streaming/lower-thirds-disabled"].some(
        (alias) => pathname === `/${slug}/${alias}`,
      )
    )
      return true;
    return pathname.startsWith(fullPath);
  };

  const hidden = fullscreen;
  const w = collapsed ? 68 : 240;

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
        {/* Backdrop */}
        <aside
          key="workspace-sidebar"
          aria-hidden={!mobileOpen}
          inert={!mobileOpen}
          className={`fixed top-0 left-0 h-[100dvh] w-[280px] z-50 bg-board-card border-r border-board-border flex flex-col overflow-hidden transition-transform duration-200 ease-in-out ${
            mobileOpen ? "translate-x-0" : "-translate-x-full"
          }`}
        >
          {/* Backdrop */}
          <SidebarContent
            modules={workspace.modules}
            collapsed={false}
            org={org}
            slug={slug!}
            isActive={isActive}
            role={role}
            grantedPermissions={grantedPermissions}
            canManageAccess={canManageAccess}
            user={user}
          />
        </aside>
      </>
    );
  }

  // Desktop: fixed sidebar + spacer
  return (
    <>
      <aside
        key="workspace-sidebar"
        style={{ width: w, transition: "width 200ms ease-in-out" }}
        className="fixed top-0 left-0 z-30 flex h-[100dvh] flex-col overflow-hidden border-r border-board-border bg-board-card"
      >
        <SidebarContent
          modules={workspace.modules}
          collapsed={collapsed}
          org={org}
          slug={slug!}
          isActive={isActive}
          role={role}
          grantedPermissions={grantedPermissions}
          canManageAccess={canManageAccess}
          user={user}
        />
      </aside>

      {/* Backdrop */}
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
function SidebarContent({
  modules,
  collapsed,
  org,
  slug,
  isActive,
  role,
  grantedPermissions,
  canManageAccess,
  user,
}: {
  modules: readonly ModuleId[];
  collapsed: boolean;
  org: { id: string; name: string; slug: string; logo: string | null } | null;
  slug: string;
  isActive: (path: string) => boolean;
  role: string | null;
  grantedPermissions: Permission[];
  canManageAccess: boolean;
  user: {
    id: string;
    name: string;
    email: string;
    emailVerified: boolean;
    image?: string | null;
  } | null;
}) {
  const canOpen = (item: NavItem) =>
    (item.path === "team" && canManageAccess) ||
    (modules.includes(item.module) &&
      (!item.permission ||
        hasAnyEffectivePermission(
          role,
          grantedPermissions,
          typeof item.permission === "string"
            ? [item.permission]
            : item.permission,
        )));
  const sections = [
    { label: "", items: mainNav },
    { label: "Production", items: productionNav },
    { label: "Streaming", items: streamingNav },
    { label: "Dashboards", items: dashboardNav },
  ];
  const terms = useTerms();
  const unavailable = sections
    .flatMap((section) => section.items)
    .filter((item) => !canOpen(item));
  const { toggle } = useSidebar();

  const roleColour = ROLE_COLOURS[role ?? ""] ?? ROLE_COLOURS.member;

  return (
    <>
      {/* Backdrop */}
      <div
        className={`py-5 flex items-center overflow-hidden ${
          collapsed ? "flex-col gap-2 px-2" : "flex-wrap gap-3 px-4"
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
        <div className={collapsed ? "mt-1" : "w-full"}>
          <QuickActions collapsed={collapsed} />
        </div>
      </div>

      {/* Org Switcher */}
      {org && (
        <div
          className={`border-b border-board-border ${collapsed ? "px-1.5 py-2" : "px-2.5 py-2"}`}
        >
          <OrgSwitcher currentOrg={org} collapsed={collapsed} />
        </div>
      )}

      <nav
        aria-label="Workspace navigation"
        tabIndex={0}
        className="modern-scrollbar flex-1 min-h-0 overflow-y-scroll overflow-x-hidden pb-4 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-fire-500 [scrollbar-color:var(--board-muted)_transparent]"
      >
        {sections.map((section) => {
          const items = section.items.filter(canOpen);
          if (!items.length) return null;
          return (
            <div key={section.label}>
              {section.label && (
                <div className={`pt-5 pb-2 ${collapsed ? "px-3" : "px-4"}`}>
                  {collapsed ? (
                    <div className="h-px bg-board-border" />
                  ) : (
                    <p className="text-[10px] font-medium text-board-muted uppercase tracking-widest">
                      {section.label}
                    </p>
                  )}
                </div>
              )}
              <div className="px-2.5 space-y-0.5">
                {items.map((item) => (
                  <NavLink
                    key={item.path}
                    item={item}
                    slug={slug}
                    collapsed={collapsed}
                    active={isActive(item.path)}
                  />
                ))}
              </div>
            </div>
          );
        })}
        {unavailable.length > 0 && (
          <details
            className="mx-2.5 mt-4 border-t border-board-border"
            onToggle={(event) => {
              if (event.currentTarget.open && collapsed) toggle();
            }}
          >
            <summary
              aria-label="Unavailable pages"
              title="Unavailable pages"
              className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-lg px-2 text-xs text-board-muted outline-none hover:text-board-text focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-fire-500"
            >
              <LayoutDashboard className="size-4 shrink-0" />
              {!collapsed && "Unavailable pages"}
            </summary>
            <div className="space-y-3 px-2 pb-3 text-xs text-board-muted">
              <p>Ask an owner or admin for access.</p>
              <ul className="space-y-3">
                {unavailable.map((item) => (
                  <li key={item.path}>
                    <span className="block text-board-text">
                      {item.path === "show" ? terms.eventTitle : item.label}
                    </span>
                    {modules.includes(item.module)
                      ? "Requires additional access"
                      : "Turned off in this workspace"}
                  </li>
                ))}
              </ul>
              {(role === "owner" || role === "admin") && (
                <Link
                  to="/$slug/settings"
                  params={{ slug }}
                  search={{ section: "organization" }}
                  className="inline-flex min-h-11 items-center underline outline-none focus-visible:ring-2 focus-visible:ring-fire-500"
                >
                  Manage workspace features
                </Link>
              )}
            </div>
          </details>
        )}
      </nav>

      {/* Backdrop */}
      <div className="shrink-0 border-t border-board-border px-2.5 py-3">
        {user && org && (
          <SidebarIdentity
            collapsed={collapsed}
            user={user}
            role={role ?? "member"}
            orgName={org.name}
            orgId={org.id}
            slug={slug}
            canAccessSettings={true}
          />
        )}
      </div>
    </>
  );
}
