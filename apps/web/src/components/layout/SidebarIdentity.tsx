import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { Bell, BellRing, CheckCircle2, ChevronLeft, ChevronRight, LogOut, Settings, UserRound } from "lucide-react";
import { Link, useNavigate } from "@tanstack/react-router";
import { ROLE_COLOURS } from "./account-role";
import { getPersonalNotifications } from "@/lib/personal-notifications";
import { authClient } from "@/lib/auth-client";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { enablePushForOrg, isPushSupported } from "@/lib/notifications";
import {
  PERSONAL_NOTIFICATION_COUNT_EVENT,
  readPersonalNotificationCount,
} from "@/lib/notification-events";
import { cn } from "@/lib/utils";
import {
  DESKTOP_NOTIFICATION_POLL_EVENT,
  getDesktopNotificationPermission,
  isDesktopNotificationSupported,
  isDesktopRuntime,
} from "@/lib/desktop-runtime";

const ProfilePanel = lazy(() =>
  import("./ProfileModal").then((module) => ({ default: module.ProfilePanel })),
);
const NotificationInbox = lazy(() =>
  import("./NotificationCenter").then((module) => ({
    default: module.NotificationInbox,
  })),
);

function AccountPanelFallback() {
  return (
    <div
      aria-label="Loading account view"
      className="flex min-h-64 flex-1 items-center justify-center"
    >
      <span className="size-5 animate-spin rounded-full border-2 border-board-border border-t-fire-500" />
    </div>
  );
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
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
  const navigate = useNavigate();
  const [accountOpen, setAccountOpen] = useState(false);
  const [accountView, setAccountView] = useState<AccountView>("menu");
  const [localUser, setLocalUser] = useState(user);
  const [unread, setUnread] = useState(0);
  const [pushPermission, setPushPermission] = useState<NotificationPermission>("default");
  const [pushSupported, setPushSupported] = useState(false);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushStatusReady, setPushStatusReady] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);
  const [enablingPush, setEnablingPush] = useState(false);
  const [confirmSignOut, setConfirmSignOut] = useState(false);

  const roleColour = ROLE_COLOURS[role] ?? ROLE_COLOURS.member;
  const initials = getInitials(localUser.name);
  const roleLabel = ROLE_LABELS[role] ?? role;

  const refreshUnread = useCallback(async () => {
    try {
      const result = await getPersonalNotifications({ data: { orgId } });
      setUnread(result.unread);
    } catch {
      // Account access must remain available if notification retrieval fails.
    }
  }, [orgId]);

  useEffect(() => {
    const onNotificationCount = (event: Event) => {
      const detail = readPersonalNotificationCount(event);
      if (detail?.orgId === orgId) setUnread(detail.unread);
    };
    window.addEventListener(PERSONAL_NOTIFICATION_COUNT_EVENT, onNotificationCount);
    return () => window.removeEventListener(PERSONAL_NOTIFICATION_COUNT_EVENT, onNotificationCount);
  }, [orgId]);

  useEffect(() => {
    if (accountView === "notifications" || isDesktopRuntime()) return;
    void refreshUnread();
    const timer = window.setInterval(refreshUnread, 20_000);
    return () => window.clearInterval(timer);
  }, [accountView, refreshUnread]);

  useEffect(() => {
    let active = true;
    const supported = isPushSupported();
    setPushSupported(supported);
    setPushEnabled(false);
    setPushError(null);
    setPushStatusReady(!supported);
    if (!supported) return () => { active = false; };

    const resolveStatus = async () => {
      if (isDesktopNotificationSupported()) {
        const permission = await getDesktopNotificationPermission();
        if (!active) return;
        setPushPermission(permission);
        setPushEnabled(permission === "granted");
        setPushStatusReady(true);
        return;
      }

      const permission = Notification.permission;
      if (!active) return;
      setPushPermission(permission);
      if (permission === "granted") {
        try {
          await enablePushForOrg(orgId, false);
          if (active) setPushEnabled(true);
        } catch {
          if (active) setPushEnabled(false);
        }
      }
      if (active) setPushStatusReady(true);
    };

    void resolveStatus();
    return () => { active = false; };
  }, [orgId]);

  const enablePush = async () => {
    setEnablingPush(true);
    try {
      const permission = await enablePushForOrg(orgId);
      setPushPermission(permission);
      setPushEnabled(permission === "granted");
      if (permission === "granted" && isDesktopNotificationSupported()) {
        window.dispatchEvent(new Event(DESKTOP_NOTIFICATION_POLL_EVENT));
      }
      setPushError(null);
    } catch (error) {
      const permission = isDesktopNotificationSupported()
        ? await getDesktopNotificationPermission()
        : typeof Notification === "undefined" ? "denied" : Notification.permission;
      setPushPermission(permission);
      setPushError(error instanceof Error ? error.message : "Could not enable device notifications");
    } finally {
      setEnablingPush(false);
    }
  };

  const handleUserUpdated = (updates: { name?: string; image?: string }) => {
    setLocalUser((current) => ({
      ...current,
      ...(updates.name !== undefined ? { name: updates.name } : {}),
      ...(updates.image !== undefined ? { image: updates.image } : {}),
    }));
  };

  const signOut = async () => {
    await authClient.signOut();
    setAccountOpen(false);
    await navigate({ to: "/login" });
  };

  const requestMenuSignOut = async () => {
    if (!confirmSignOut) {
      setConfirmSignOut(true);
      window.setTimeout(() => setConfirmSignOut(false), 4_000);
      return;
    }
    await signOut();
  };

  const avatar = (
    <div className="relative shrink-0">
      <div
        className="flex size-7 items-center justify-center overflow-hidden rounded-full text-[9px] font-bold text-white ring-2 ring-board-card"
        style={{ backgroundColor: roleColour }}
      >
        {localUser.image ? <img src={localUser.image} alt={localUser.name} className="size-full object-cover" /> : initials}
      </div>
      {unread > 0 ? (
        <span
          aria-label={`${unread} unread notification${unread === 1 ? "" : "s"}`}
          className="absolute -bottom-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full border-2 border-board-card bg-fire-500 px-0.5 text-[8px] font-extrabold leading-none text-black shadow-sm"
        >
          {unread > 99 ? "99+" : unread}
        </span>
      ) : null}
    </div>
  );

  const closeAccount = (open: boolean) => {
    setAccountOpen(open);
    if (!open) {
      setAccountView("menu");
      setConfirmSignOut(false);
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
      <button
        type="button"
        onClick={() => setAccountOpen(true)}
        title="Account menu"
        className={cn(
          "relative flex min-h-11 w-full items-center rounded-lg text-board-muted transition-colors hover:bg-board-border/50 hover:text-board-text",
          collapsed ? "justify-center p-2.5" : "gap-2.5 px-3 py-2.5",
        )}
      >
        {avatar}
        {!collapsed ? (
          <>
            <div className="min-w-0 flex-1 text-left">
              <p className="truncate text-xs font-medium leading-tight text-board-text">{localUser.name}</p>
              <p className="truncate text-[10px] leading-tight" style={{ color: roleColour }}>{roleLabel}</p>
            </div>
            <ChevronRight className="size-3.5 shrink-0 opacity-35" />
          </>
        ) : null}
      </button>

      <Dialog open={accountOpen} onOpenChange={closeAccount}>
        <DialogContent
          className={cn(
            "flex max-h-[min(760px,calc(100dvh-2rem))] min-h-0 flex-col gap-0 overflow-hidden border-board-border bg-board-card p-0 text-board-text shadow-[0_24px_80px_rgba(0,0,0,0.5)]",
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
                  {localUser.image ? <img src={localUser.image} alt="" className="size-full object-cover" /> : initials}
                </div>
              ) : (
                <button type="button" onClick={() => setAccountView("menu")} className="flex size-10 shrink-0 items-center justify-center rounded-lg text-board-muted transition-colors hover:bg-board-border/50 hover:text-board-text" aria-label="Back to account">
                  <ChevronLeft className="size-5" />
                </button>
              )}
              <div className="min-w-0">
                <DialogTitle className="truncate text-base">{viewTitle}</DialogTitle>
                <DialogDescription className="mt-1 truncate text-xs text-board-muted">{viewDescription}</DialogDescription>
              </div>
            </div>
          </DialogHeader>

          {accountView === "menu" ? (
            <div className="modern-scrollbar min-h-0 flex-1 overflow-y-auto px-3 py-3">
              <div className="mb-2 flex items-center justify-between rounded-lg border border-board-border bg-board-bg/35 px-3 py-2.5 text-xs text-board-muted">
                <span className="truncate">{orgName}</span>
                <span className="ml-3 shrink-0 font-medium" style={{ color: roleColour }}>{roleLabel}</span>
              </div>

              <button type="button" onClick={() => setAccountView("notifications")} className="flex min-h-12 w-full items-center gap-3 rounded-lg px-3 py-3 text-board-muted transition-colors hover:bg-board-border/50 hover:text-board-text">
                <Bell className="size-[18px]" />
                <span className="text-sm font-medium">Notifications</span>
                {unread > 0 ? <span className="ml-auto flex h-5 min-w-5 items-center justify-center rounded-full bg-fire-500 px-1 text-[10px] font-semibold text-black">{unread > 99 ? "99+" : unread}</span> : <ChevronRight className="ml-auto size-3.5 opacity-40" />}
              </button>

              {pushSupported && pushStatusReady ? (
                pushEnabled || pushPermission === "denied" ? (
                  <div className="flex min-h-12 w-full items-center gap-3 rounded-lg px-3 py-3 text-board-muted">
                    {pushEnabled ? <CheckCircle2 className="size-[18px] text-green-500" /> : <BellRing className="size-[18px] text-red-400" />}
                    <span className="min-w-0 text-left">
                      <span className="block text-sm font-medium text-board-text">Device notifications</span>
                      <span className="mt-0.5 block text-xs leading-5">{pushEnabled ? "Enabled on this device" : "Blocked in browser or system settings"}</span>
                    </span>
                  </div>
                ) : (
                  <button type="button" disabled={enablingPush} onClick={() => void enablePush()} className="flex min-h-12 w-full items-center gap-3 rounded-lg px-3 py-3 text-board-muted transition-colors hover:bg-board-border/50 hover:text-board-text disabled:opacity-50">
                    <BellRing className="size-[18px]" />
                    <span className="min-w-0 text-left">
                      <span className="block text-sm font-medium text-board-text">Device notifications</span>
                      <span className="mt-0.5 block text-xs leading-5">{enablingPush ? "Enabling on this device" : "Enable alerts when ShowPilot is in the background"}</span>
                    </span>
                    <ChevronRight className="ml-auto size-3.5 opacity-40" />
                  </button>
                )
              ) : null}
              {pushError ? <p role="alert" className="px-3 py-1 text-xs leading-5 text-red-400">{pushError}</p> : null}

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

              <button type="button" onClick={() => void requestMenuSignOut()} className="flex min-h-12 w-full items-center gap-3 rounded-lg px-3 py-3 text-red-400 transition-colors hover:bg-red-500/10 hover:text-red-300">
                <LogOut className="size-[18px]" />
                <span className="text-sm font-medium">{confirmSignOut ? "Tap again to sign out" : "Sign Out"}</span>
              </button>
            </div>
          ) : null}

          {accountView === "profile" ? (
            <Suspense fallback={<AccountPanelFallback />}>
              <ProfilePanel user={localUser} role={role} orgName={orgName} onUserUpdated={handleUserUpdated} onSignOut={signOut} />
            </Suspense>
          ) : null}

          {accountView === "notifications" ? (
            <Suspense fallback={<AccountPanelFallback />}>
              <NotificationInbox orgId={orgId} slug={slug} onUnreadChange={setUnread} onNavigate={() => setAccountOpen(false)} />
            </Suspense>
          ) : null}

          {accountView === "menu" ? (
            <div className="flex shrink-0 items-center gap-2 border-t border-board-border px-5 py-3 text-[11px] text-board-muted">
              <Bell className="size-3" />
              {unread > 0 ? `${unread} unread notification${unread === 1 ? "" : "s"}` : "You’re all caught up"}
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
