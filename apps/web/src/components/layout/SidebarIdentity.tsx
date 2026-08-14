import { useCallback, useEffect, useState } from "react";
import { Bell, BellRing, ChevronRight, Settings, UserRound } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { ProfileModal, ROLE_COLOURS } from "./ProfileModal";
import { NotificationCenter } from "./NotificationCenter";
import { getPersonalNotifications } from "@/lib/personal-notifications";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { enablePushForOrg, isPushSupported } from "@/lib/notifications";

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

interface SidebarIdentityProps {
  collapsed: boolean;
  user: { id: string; name: string; email: string; image?: string | null };
  role: string;
  orgName: string;
  orgId: string;
  slug: string;
  canAccessSettings: boolean;
}

export function SidebarIdentity({ collapsed, user, role, orgName, orgId, slug, canAccessSettings }: SidebarIdentityProps) {
  const [accountOpen, setAccountOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [localUser, setLocalUser] = useState(user);
  const [unread, setUnread] = useState(0);
  const [pushPermission, setPushPermission] = useState<NotificationPermission>("default");
  const [pushSupported, setPushSupported] = useState(false);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);
  const [enablingPush, setEnablingPush] = useState(false);

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
    void refreshUnread();
    const timer = window.setInterval(refreshUnread, 20_000);
    return () => window.clearInterval(timer);
  }, [refreshUnread]);

  useEffect(() => {
    setPushSupported(isPushSupported());
    if (typeof Notification === "undefined") return;
    setPushPermission(Notification.permission);
    if (Notification.permission === "granted") void enablePushForOrg(orgId, false).then(() => setPushEnabled(true)).catch(() => setPushEnabled(false));
  }, [orgId]);

  const enablePush = async () => {
    setEnablingPush(true);
    try {
      setPushPermission(await enablePushForOrg(orgId));
      setPushEnabled(true);
      setPushError(null);
    } catch (error) {
      setPushPermission(typeof Notification === "undefined" ? "denied" : Notification.permission);
      setPushError(error instanceof Error ? error.message : "Could not enable push notifications");
    }
    finally { setEnablingPush(false); }
  };

  const handleUserUpdated = (updates: { name?: string; image?: string }) => {
    setLocalUser((u) => ({
      ...u,
      ...(updates.name !== undefined ? { name: updates.name } : {}),
      ...(updates.image !== undefined ? { image: updates.image } : {}),
    }));
  };

  const openProfile = () => {
    setAccountOpen(false);
    // Let Radix finish removing its focus trap before the profile dialog
    // claims focus. Without this, both surfaces briefly stack and jump.
    window.setTimeout(() => setModalOpen(true), 180);
  };

  const avatar = (
    <div className="relative shrink-0">
      <div
        className="w-7 h-7 rounded-full flex items-center justify-center overflow-hidden text-[9px] font-bold text-white select-none ring-2 ring-board-card"
        style={{ backgroundColor: roleColour }}
      >
        {localUser.image ? (
          <img src={localUser.image} alt={localUser.name} className="w-full h-full object-cover" />
        ) : (
          initials
        )}
      </div>
      {unread > 0 && (
        <span
          aria-label={`${unread} unread notification${unread === 1 ? "" : "s"}`}
          className="absolute -bottom-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full border-2 border-board-card bg-fire-500 px-0.5 text-[8px] font-extrabold leading-none text-white shadow-sm"
        >
          {unread > 99 ? "99+" : unread}
        </span>
      )}
    </div>
  );

  return (
    <>
      <button
        onClick={() => setAccountOpen(true)}
        title="Account menu"
        className={`relative flex items-center rounded-lg transition-colors w-full text-board-muted hover:bg-board-border/50 hover:text-board-text min-h-[44px] ${
          collapsed ? "justify-center p-2.5" : "gap-2.5 px-3 py-2.5"
        }`}
      >
        {avatar}
        {!collapsed && (
          <>
            <div className="flex-1 min-w-0 text-left">
              <p className="text-xs font-medium text-board-text truncate leading-tight">{localUser.name}</p>
              <p className="text-[10px] text-board-muted truncate leading-tight" style={{ color: roleColour }}>
                {roleLabel}
              </p>
            </div>
            <ChevronRight className="w-3.5 h-3.5 shrink-0 opacity-35" />
          </>
        )}
      </button>

      <Dialog open={accountOpen} onOpenChange={setAccountOpen}>
        <DialogContent className="max-h-[min(620px,calc(100dvh-2rem))] overflow-hidden border-board-border bg-board-card p-0 text-board-text shadow-[0_24px_80px_rgba(0,0,0,0.5)] sm:max-w-[420px]">
          <DialogHeader className="border-b border-board-border px-5 py-5 pr-12 text-left">
            <div className="flex items-center gap-3">
              <div
                className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-full text-xs font-bold text-white"
                style={{ backgroundColor: roleColour }}
              >
                {localUser.image ? <img src={localUser.image} alt="" className="h-full w-full object-cover" /> : initials}
              </div>
              <div className="min-w-0">
                <DialogTitle className="truncate text-base">{localUser.name}</DialogTitle>
                <DialogDescription className="mt-0.5 truncate text-xs text-board-muted">
                  {localUser.email}
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          <div className="overflow-y-auto px-3 py-3">
            <div className="mb-2 flex items-center justify-between rounded-lg bg-board-bg/40 px-3 py-2 text-[11px] text-board-muted">
              <span>{orgName}</span>
              <span className="font-medium" style={{ color: roleColour }}>{roleLabel}</span>
            </div>

            <NotificationCenter orgId={orgId} slug={slug} collapsed={false} onUnreadChange={setUnread} onNavigate={() => setAccountOpen(false)} placement="account" />

            {pushSupported && !pushEnabled && (
              <button type="button" disabled={enablingPush || pushPermission === "denied"} onClick={() => void enablePush()} className="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2.5 text-board-muted transition-colors hover:bg-board-border/50 hover:text-board-text disabled:opacity-50">
                <BellRing className="h-[18px] w-[18px]" />
                <span className="text-left text-sm font-medium">{pushPermission === "denied" ? "Push blocked in browser settings" : enablingPush ? "Enabling push…" : "Enable device notifications"}</span>
              </button>
            )}
            {pushError && <p className="px-3 py-1 text-[10px] leading-4 text-red-400">{pushError}</p>}

            {canAccessSettings && (
              <Link
                to="/$slug/settings"
                params={{ slug }}
                onClick={() => setAccountOpen(false)}
                className="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2.5 text-board-muted transition-colors hover:bg-board-border/50 hover:text-board-text"
              >
                <Settings className="h-[18px] w-[18px]" />
                <span className="text-sm font-medium">Settings</span>
                <ChevronRight className="ml-auto h-3.5 w-3.5 opacity-40" />
              </Link>
            )}

            <button
              type="button"
              onClick={openProfile}
              className="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2.5 text-board-muted transition-colors hover:bg-board-border/50 hover:text-board-text"
            >
              <UserRound className="h-[18px] w-[18px]" />
              <span className="text-sm font-medium">Profile and account</span>
              <ChevronRight className="ml-auto h-3.5 w-3.5 opacity-40" />
            </button>
          </div>

          <div className="flex items-center gap-2 border-t border-board-border px-5 py-3 text-[10px] text-board-muted">
            <Bell className="h-3 w-3" />
            {unread > 0 ? `${unread} unread notification${unread === 1 ? "" : "s"}` : "You’re all caught up"}
          </div>
        </DialogContent>
      </Dialog>

      <ProfileModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        user={localUser}
        role={role}
        orgName={orgName}
        onUserUpdated={handleUserUpdated}
      />
    </>
  );
}
