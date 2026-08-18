import { useNavigate } from "@tanstack/react-router";
import { Bell, CheckCheck, CircleAlert, ExternalLink, Inbox } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getPersonalNotifications, markAllPersonalNotificationsRead, markPersonalNotificationRead, type PersonalNotification } from "@/lib/personal-notifications";
import { getNotificationDestination } from "@/lib/notification-destination";

export function NotificationCenter({ orgId, slug, collapsed, onUnreadChange, onNavigate, placement = "sidebar" }: { orgId: string; slug: string; collapsed: boolean; onUnreadChange?: (count: number) => void; onNavigate?: () => void; placement?: "sidebar" | "account" }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<PersonalNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const refresh = useCallback(async () => {
    try { const result = await getPersonalNotifications({ data: { orgId } }); setItems(result.notifications); setUnread(result.unread); onUnreadChange?.(result.unread); }
    catch { /* Navigation must remain usable if inbox retrieval fails. */ }
  }, [orgId, onUnreadChange]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 60_000);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const onMessage = (event: MessageEvent) => { if (event.data?.type === "showpilot-notification") void refresh(); };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [refresh]);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!root.current?.contains(target) && !panel.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const read = async (id: string) => {
    setItems((current) => current.map((item) => item.id === id ? { ...item, readAt: item.readAt ?? new Date().toISOString() } : item));
    setUnread((current) => { const next = Math.max(0, current - (items.find((item) => item.id === id)?.readAt ? 0 : 1)); onUnreadChange?.(next); return next; });
    await markPersonalNotificationRead({ data: { orgId, id } });
  };
  const readAll = async () => {
    setLoading(true); setItems((current) => current.map((item) => ({ ...item, readAt: item.readAt ?? new Date().toISOString() }))); setUnread(0); onUnreadChange?.(0);
    try {
      await markAllPersonalNotificationsRead({ data: { orgId } });
      setActionError(null);
    } catch {
      setActionError("Could not mark notifications read. Please try again.");
      await refresh();
    } finally { setLoading(false); }
  };

  return <div ref={root} className="relative">
    <button type="button" aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`} aria-expanded={open} onClick={() => setOpen((value) => !value)} className={`relative flex items-center rounded-lg min-h-11 transition-colors ${collapsed ? "justify-center w-full p-2.5" : "w-full gap-3 px-3 py-2.5"} ${open ? "bg-board-border/60 text-board-text" : "text-board-muted hover:bg-board-border/50 hover:text-board-text"}`}>
      <Bell className="w-[18px] h-[18px] shrink-0" />{!collapsed ? <span className="text-sm font-medium">Notifications</span> : null}{unread > 0 ? <span className={`${collapsed ? "absolute right-1 top-1" : "ml-auto"} min-w-5 h-5 px-1 rounded-full bg-fire-500 text-white text-[10px] font-semibold flex items-center justify-center tabular-nums`}>{unread > 99 ? "99+" : unread}</span> : null}
    </button>
    {open && typeof document !== "undefined" ? createPortal(<>
      {placement === "account" && (
        <button
          type="button"
          aria-label="Close notifications"
          onClick={() => setOpen(false)}
          className="pointer-events-auto fixed inset-0 z-[9999] cursor-default bg-black/65 backdrop-blur-md"
        />
      )}
      <div ref={panel} role={placement === "account" ? "dialog" : undefined} aria-modal={placement === "account" ? true : undefined} className={`pointer-events-auto fixed z-[10000] max-h-[min(560px,82vh)] rounded-2xl border border-board-border bg-board-card shadow-2xl overflow-hidden ${placement === "account" ? "left-1/2 top-1/2 w-[min(440px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2" : `left-3 right-3 bottom-20 lg:right-auto lg:bottom-4 ${collapsed ? "lg:left-[72px]" : "lg:left-[244px]"} w-auto lg:w-[360px]`}`}>
      <header className="flex items-center gap-2 px-4 py-3 border-b border-board-border"><div><h2 className="text-sm font-semibold text-board-text">Notifications</h2><p className="text-[10px] text-board-muted">Assignments and operational updates</p></div>{unread ? <button type="button" disabled={loading} onClick={() => void readAll()} className="ml-auto inline-flex items-center gap-1 text-[10px] text-board-muted hover:text-board-text disabled:opacity-50"><CheckCheck className="w-3.5 h-3.5" />Mark all read</button> : null}</header>
      {actionError ? <p role="alert" className="border-b border-red-500/20 bg-red-500/[0.06] px-4 py-2 text-[10px] text-red-300">{actionError}</p> : null}
      <div className="max-h-[430px] overflow-y-auto divide-y divide-board-border/60">{items.length ? items.map((item) => <NotificationRow key={item.id} item={item} onOpen={async () => {
        setOpen(false);
        onNavigate?.();
        void read(item.id).catch(() => { /* Reading is best-effort and must never block the destination. */ });
        await navigateToNotification(navigate, slug, item.actionUrl);
      }} />) : <div className="px-4 py-10 text-center"><Inbox className="w-7 h-7 text-board-muted/50 mx-auto" /><p className="text-xs text-board-muted mt-2">Nothing waiting for you.</p></div>}</div>
      </div>
    </>, document.body) : null}
  </div>;
}

function NotificationRow({ item, onOpen }: { item: PersonalNotification; onOpen(): Promise<void> }) {
  const content = <><span className={`mt-0.5 w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${item.severity === "critical" ? "bg-red-500/15 text-red-400" : "bg-yellow-400/10 text-yellow-300"}`}><CircleAlert className="w-3.5 h-3.5" /></span><span className="min-w-0 flex-1"><span className="flex items-start gap-2"><strong className="text-xs font-medium text-board-text">{item.title}</strong>{!item.readAt ? <span className="mt-1 w-1.5 h-1.5 rounded-full bg-fire-500 shrink-0" /> : null}</span><span className="block text-[11px] leading-relaxed text-board-muted mt-1">{item.message}</span><span className="block text-[9px] text-board-muted/60 mt-1.5">{relativeTime(item.createdAt)}</span></span>{item.actionUrl ? <ExternalLink className="w-3 h-3 text-board-muted shrink-0" /> : null}</>;
  const className = `flex items-start gap-3 px-4 py-3 text-left hover:bg-board-border/30 transition-colors ${item.readAt ? "opacity-75" : "bg-fire-500/[.025]"}`;
  return <button type="button" onClick={() => void onOpen()} className={`w-full ${className}`}>{content}</button>;
}

type Navigate = ReturnType<typeof useNavigate>;
async function navigateToNotification(navigate: Navigate, slug: string, actionUrl: string) {
  // Notification URLs are data, not trusted router destinations. Map the
  // supported actions explicitly so a database value cannot navigate users
  // outside their organization or to an unintended external URL.
  const destination = getNotificationDestination(actionUrl);
  if (!destination) return;
  if (destination.kind === "tech-manager") {
    await navigate({ to: "/$slug/dashboard/tech-manager", params: { slug }, search: { date: undefined } });
    return;
  }
  if (destination.kind === "incident") {
    await navigate({ to: "/$slug/production/incidents", params: { slug }, search: { incident: destination.incident, date: destination.date } });
    return;
  }
  if (destination.kind === "schedule") {
    await navigate({ to: "/$slug/schedule", params: { slug }, search: { date: destination.date, assignment: destination.assignment } });
    return;
  }
  await navigate({ to: "/$slug/chat", params: { slug }, search: { room: destination.room } });
}

function relativeTime(value: string) { const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000)); if (seconds < 60) return "just now"; const minutes = Math.round(seconds / 60); if (minutes < 60) return `${minutes}m ago`; const hours = Math.round(minutes / 60); if (hours < 24) return `${hours}h ago`; return `${Math.round(hours / 24)}d ago`; }
