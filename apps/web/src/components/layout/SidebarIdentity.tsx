import { lazy, Suspense, useCallback, useMemo, useState } from "react";
import { Bell, CalendarDays, ChevronLeft, ChevronRight, Settings, UserRound } from "lucide-react";
import { CatchBoundary, Link, useRouter } from "@tanstack/react-router";
import { ROLE_COLOURS, getAccountInitials } from "./account-role";
import { useAccountNotificationCount } from "@/hooks/useAccountNotificationCount";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getPortableAvatarUrl } from "@/lib/avatar-image";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { runRouteLoad } from "@/lib/route-load-deadlines";

function AccountPanelFailure({ retry }: { retry: () => void }) {
  const [failedAt] = useState(Date.now);
  return <div role="alert" aria-label="Account view unavailable" className="min-h-0 overflow-y-auto p-5 text-sm text-board-text">
    <p>Could not load this account view.</p>
    <time className="mt-2 block text-xs text-board-muted" dateTime={new Date(failedAt).toISOString()}>Last attempt: {new Date(failedAt).toLocaleTimeString()}</time>
    <Button type="button" variant="outline" onClick={retry} className="mt-4 min-h-11">Retry account view</Button>
  </div>;
}


const ROLE_LABELS: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  pm: "Prod Mgr",
  tm: "Tech Mgr",
  sm: "Stage Mgr",
  member: "Member",
};

type AccountView = "menu" | "profile" | "notifications";

interface SidebarIdentityProps {
  collapsed: boolean;
  user: { id: string; name: string; email: string; emailVerified: boolean; image?: string | null };
  role: string;
  orgName: string;
  orgId: string;
  slug: string;
  canAccessSettings: boolean;
}

export function SidebarIdentity({ collapsed, user, role, orgName, orgId, slug, canAccessSettings }: SidebarIdentityProps) {
  const router = useRouter();
  const [accountOpen, setAccountOpen] = useState(false);
  const [accountView, setAccountView] = useState<AccountView>("menu");
  const [panelAttempt, setPanelAttempt] = useState(0);
  const AccountPanels = useMemo(() => lazy(() => runRouteLoad(() => import("./AccountPanels").then(module => ({ default: module.createAccountPanels() })))), [panelAttempt]);
  const DeviceNotifications = useMemo(() => lazy(() => runRouteLoad(() => import("./DeviceNotificationsControl").then(module => ({ default: module.DeviceNotificationsControl })))), [panelAttempt]);
  const PanelError = useCallback(() => <AccountPanelFailure retry={() => setPanelAttempt(attempt => attempt + 1)} />, []);
  const reviewTimeZone = useCallback(() => { setAccountView("menu"); setAccountOpen(true); }, []);
  const TimeZoneFailure = useCallback(() => <button type="button" aria-label="Alert timezone needs attention" title="Alert timezone needs attention" className="size-11 shrink-0 text-amber-500" onClick={reviewTimeZone}>!</button>, [reviewTimeZone]);

  const [localUser, setLocalUser] = useState(user);
  const [failedAvatarUrl, setFailedAvatarUrl] = useState<string | null>(null);
  const notificationCount = useAccountNotificationCount(orgId, user.id);
  const countState = notificationCount.state;
  const unread = countState.snapshot?.unread ?? null;
  const unreadBadge = countState.kind === "failed" ? "!" : unread === null ? "…" : unread > 99 ? "99+" : unread || null;

  const roleColour = ROLE_COLOURS[role] ?? ROLE_COLOURS.member;
  const initials = getAccountInitials(localUser.name);
  const roleLabel = ROLE_LABELS[role] ?? role;
  const portableAvatarUrl = getPortableAvatarUrl(localUser.image);
  const avatarUrl = portableAvatarUrl && portableAvatarUrl !== failedAvatarUrl
    ? portableAvatarUrl
    : null;

  const handleUserUpdated = (updates: { name?: string; image?: string }) => {
    if (updates.image !== undefined) setFailedAvatarUrl(null);
    setLocalUser((current) => ({
      ...current,
      ...(updates.name !== undefined ? { name: updates.name } : {}),
      ...(updates.image !== undefined ? { image: updates.image } : {}),
    }));
    // Names and photos also appear in route-owned crew, duty, schedule, and
    // assignment data. Refresh those loaders after the optimistic account UI
    // update so the open workspace never shows two identities for one user.
    void router.invalidate();
  };

  const avatar = (
    <div className="relative shrink-0">
      <div
        className="flex size-7 items-center justify-center overflow-hidden rounded-full text-[9px] font-bold text-white ring-2 ring-board-card"
        style={{ backgroundColor: roleColour }}
      >
        {avatarUrl ? (
          <img
            src={avatarUrl}
            alt={localUser.name}
            className="size-full object-cover"
            onError={() => setFailedAvatarUrl(avatarUrl)}
          />
        ) : initials}
      </div>
    </div>
  );

  const closeAccount = (open: boolean) => {
    setAccountOpen(open);
    if (!open) {
      setAccountView("menu");
    }
  };

  const viewTitle = accountView === "profile" ? "Profile" : accountView === "notifications" ? "Notifications" : localUser.name;
  const viewDescription = accountView === "profile"
    ? "Manage your personal ShowPilot account"
    : accountView === "notifications"
      ? "Assignments and operational updates"
      : localUser.email;

  return (
    <>
      <div className={cn("flex min-w-0 items-center gap-1", collapsed && "flex-col")}>
      <button
        type="button"
        onClick={() => setAccountOpen(true)}
        title="Account menu"
        className={cn(
          "relative flex min-h-11 min-w-0 flex-1 items-center rounded-lg text-board-muted transition-colors hover:bg-board-border/50 hover:text-board-text",
          collapsed ? "justify-center p-2.5" : "gap-2.5 px-3 py-2.5",
        )}
      >
        {avatar}
        {!collapsed ? (
          <>
            <div className="min-w-0 flex-1 text-left">
              <p className="truncate text-xs font-medium leading-tight text-board-text">{localUser.name}</p>
              <p className="truncate text-[10px] leading-tight text-board-text" style={{ color: role === "owner" ? undefined : roleColour }}>{roleLabel}</p>
            </div>
            <ChevronRight className="size-3.5 shrink-0 opacity-35" />
          </>
        ) : null}
      </button>
      <button
        type="button"
        onClick={() => { setAccountView("notifications"); setAccountOpen(true); }}
        aria-label={countState.kind === "failed" ? "Notifications, unread count unavailable" : unread === null ? "Notifications, checking unread count" : unread === 0 ? "Notifications" : `Notifications, ${unread} unread`}
        title="Notifications"
        className="relative flex size-11 shrink-0 items-center justify-center rounded-lg text-board-muted transition-colors hover:bg-board-border/50 hover:text-board-text"
      >
        <Bell className="size-4" />
        {unreadBadge !== null ? <span className="absolute right-0 top-0 flex min-w-4 items-center justify-center rounded-full bg-fire-500 px-1 text-[9px] font-semibold leading-4 text-black">{unreadBadge}</span> : null}
      </button>
      <CatchBoundary key={`${orgId}:${user.id}`} getResetKey={() => panelAttempt} errorComponent={TimeZoneFailure}>
        <Suspense fallback={null}><AccountPanels view="timezone" panelProps={{ orgId, userId: user.id, mode: "background", onReview: reviewTimeZone }} /></Suspense>
      </CatchBoundary>
      </div>

      <Dialog open={accountOpen} onOpenChange={closeAccount}>
        <DialogContent
          className={cn(
            "[&>[data-slot=dialog-close]]:size-11 [&>[data-slot=dialog-close]]:top-1 [&>[data-slot=dialog-close]]:right-1 [&>[data-slot=dialog-close]]:flex [&>[data-slot=dialog-close]]:items-center [&>[data-slot=dialog-close]]:justify-center flex max-h-[min(760px,calc(100dvh-2rem))] min-h-0 flex-col gap-0 overflow-hidden border-board-border bg-board-card p-0 text-board-text shadow-[0_24px_80px_rgba(0,0,0,0.5)]",
            "max-sm:inset-0 max-sm:h-[100dvh] max-sm:max-h-none max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none max-sm:border-0",
            accountView === "menu" ? "sm:max-w-[430px]" : "sm:max-w-[680px]",
          )}
        >
          <DialogHeader className="shrink-0 border-b border-board-border px-5 py-4 pr-12 text-left sm:px-6">
            <div className="flex min-w-0 items-center gap-3">
              {accountView === "menu" ? (
                <div
                  className="flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-full text-xs font-bold text-white"
                  style={{ backgroundColor: roleColour }}
                >
                  {avatarUrl ? (
                    <img
                      src={avatarUrl}
                      alt=""
                      className="size-full object-cover"
                      onError={() => setFailedAvatarUrl(avatarUrl)}
                    />
                  ) : initials}
                </div>
              ) : (
                <button type="button" onClick={() => setAccountView("menu")} className="flex size-11 shrink-0 items-center justify-center rounded-lg text-board-muted transition-colors hover:bg-board-border/50 hover:text-board-text" aria-label="Back to account">
                  <ChevronLeft className="size-5" />
                </button>
              )}
              <div className="min-w-0">
                <DialogTitle className="truncate text-base">{viewTitle}</DialogTitle>
                <DialogDescription className="mt-1 truncate text-xs text-board-muted">{viewDescription}</DialogDescription>
              </div>
            </div>
          </DialogHeader>

          {accountOpen && accountView === "menu" ? (
            <div className="modern-scrollbar min-h-0 flex-1 overflow-y-auto px-3 py-3">
              <div className="mb-2 flex items-center justify-between rounded-lg border border-board-border bg-board-bg/35 px-3 py-2.5 text-xs text-board-muted">
                <span className="truncate">{orgName}</span>
                <span className="ml-3 shrink-0 font-medium text-board-text" style={{ color: role === "owner" ? undefined : roleColour }}>{roleLabel}</span>
              </div>

              <button type="button" onClick={() => setAccountView("notifications")} className="flex min-h-12 w-full items-center gap-3 rounded-lg px-3 py-3 text-board-muted transition-colors hover:bg-board-border/50 hover:text-board-text">
                <Bell className="size-[18px]" />
                <span className="text-sm font-medium">Notifications</span>
                {unreadBadge !== null ? <span className="ml-auto flex h-5 min-w-5 items-center justify-center rounded-full bg-fire-500 px-1 text-[10px] font-semibold text-black">{unreadBadge}</span> : <ChevronRight className="ml-auto size-3.5 opacity-40" />}
              </button>

              <Link to="/$slug/assignments" params={{ slug }} search={{ date: undefined, assignment: undefined }} onClick={() => setAccountOpen(false)} className="flex min-h-12 w-full items-center gap-3 rounded-lg px-3 py-3 text-board-muted outline-none transition-colors hover:bg-board-border/50 hover:text-board-text focus-visible:ring-2 focus-visible:ring-fire-500">
                <CalendarDays className="size-[18px]" />
                <span className="text-sm font-medium">My assignments</span>
                <ChevronRight className="ml-auto size-3.5 opacity-40" />
              </Link>

              <CatchBoundary getResetKey={() => panelAttempt} errorComponent={PanelError}>
                <Suspense fallback={<p role="status" className="p-3 text-xs text-board-muted">Checking device notifications…</p>}>
                  <DeviceNotifications orgId={orgId} />
                </Suspense>
              </CatchBoundary>

              {canAccessSettings ? (
                <Link to="/$slug/settings" params={{ slug }} onClick={() => setAccountOpen(false)} className="flex min-h-12 w-full items-center gap-3 rounded-lg px-3 py-3 text-board-muted transition-colors hover:bg-board-border/50 hover:text-board-text">
                  <Settings className="size-[18px]" />
                  <span className="text-sm font-medium">Settings</span>
                  <ChevronRight className="ml-auto size-3.5 opacity-40" />
                </Link>
              ) : null}

              <button type="button" onClick={() => setAccountView("profile")} className="flex min-h-12 w-full items-center gap-3 rounded-lg px-3 py-3 text-board-muted transition-colors hover:bg-board-border/50 hover:text-board-text">
                <UserRound className="size-[18px]" />
                <span className="text-sm font-medium">Profile and account</span>
                <ChevronRight className="ml-auto size-3.5 opacity-40" />
              </button>

              <div className="my-2 h-px bg-board-border" />

              <CatchBoundary getResetKey={() => panelAttempt} errorComponent={PanelError}>
                <Suspense fallback={<p role="status" className="p-3 text-xs text-board-muted">Loading sign-out…</p>}>
                  <AccountPanels view="signout" panelProps={{ userId: user.id }} />
                </Suspense>
              </CatchBoundary>
              <CatchBoundary getResetKey={() => panelAttempt} errorComponent={PanelError}>
                <Suspense fallback={<p role="status" className="p-3 text-xs text-board-muted">Checking account status…</p>}>
                  <AccountPanels view="timezone" panelProps={{ orgId, userId: user.id, mode: "status" }} />
                  <AccountPanels view="count" panelProps={{ state: countState, onRetry: notificationCount.retry }} />
                </Suspense>
              </CatchBoundary>
            </div>
          ) : null}

          {accountView !== "menu" ? (
            <CatchBoundary key={`${orgId}:${localUser.id}`} getResetKey={() => panelAttempt} errorComponent={PanelError}>
              <Suspense fallback={<p role="status" aria-label="Loading account view" className="p-5 text-sm text-board-muted">Loading…</p>}>
                {accountView === "profile" ? (
                  <AccountPanels view="profile" panelProps={{ user: localUser, role, orgName, onUserUpdated: handleUserUpdated }} />
                ) : (
                  <AccountPanels view="notifications" panelProps={{ orgId, userId: localUser.id, slug, onUnreadChange: notificationCount.accept, onNavigate: () => setAccountOpen(false) }} />
                )}
              </Suspense>
            </CatchBoundary>
          ) : null}


        </DialogContent>
      </Dialog>
    </>
  );
}
