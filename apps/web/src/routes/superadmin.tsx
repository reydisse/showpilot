import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import {
  Users,
  Building2,
  Activity,
  Mail,
  Shield,
  Monitor,
  Clock,
  ChevronDown,
  ListChecks,
  Send,
  Trash2,
} from "lucide-react";
import { getSession } from "@/lib/session";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  SUPER_ADMIN_EMAIL,
  getAllUsers,
  getAllOrgs,
  getAllMembers,
  getRecentSessions,
  getAllInvitations,
  getPlatformStats,
  getWaitlistSignups,
  sendWaitlistInvite,
  deleteWaitlistSignup,
} from "@/lib/superadmin";

export const Route = createFileRoute("/superadmin")({
  beforeLoad: async () => {
    let session;
    try {
      session = await getSession();
    } catch {
      throw redirect({ to: "/login" });
    }
    if (!session || session.user.email !== SUPER_ADMIN_EMAIL) {
      throw redirect({ to: "/login" });
    }
    return { user: session.user };
  },
  loader: async () => {
    const [stats, users, orgs, members, sessions, invitations, waitlist] =
      await Promise.all([
        getPlatformStats(),
        getAllUsers(),
        getAllOrgs(),
        getAllMembers(),
        getRecentSessions(),
        getAllInvitations(),
        getWaitlistSignups(),
      ]);
    return { stats, users, orgs, members, sessions, invitations, waitlist };
  },
  component: SuperAdminDashboard,
});

function StatCard({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: number;
  icon: React.ElementType;
}) {
  return (
    <div className="rounded-xl border border-board-border bg-board-card p-4">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-lg bg-fire-500/10 border border-fire-500/20 flex items-center justify-center">
          <Icon className="w-5 h-5 text-fire-500" />
        </div>
        <div>
          <p className="text-2xl font-bold text-board-text tabular-nums">
            {value}
          </p>
          <p className="text-xs text-board-muted">{label}</p>
        </div>
      </div>
    </div>
  );
}

function parseUserAgent(ua: string | null): string {
  if (!ua) return "Unknown";
  if (ua.includes("iPhone")) return "iPhone";
  if (ua.includes("iPad")) return "iPad";
  if (ua.includes("Android")) return "Android";
  if (ua.includes("Windows")) return "Windows";
  if (ua.includes("Macintosh")) return "Mac";
  if (ua.includes("Linux")) return "Linux";
  return "Other";
}

function formatDate(d: string | Date): string {
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

type Tab = "waitlist" | "users" | "orgs" | "sessions" | "invitations";

function SuperAdminDashboard() {
  const { stats, users, orgs, members, sessions, invitations, waitlist } =
    Route.useLoaderData();
  const [tab, setTab] = useState<Tab>("waitlist");
  const [sendingInvite, setSendingInvite] = useState<string | null>(null);
  const [sentInvites, setSentInvites] = useState<Set<string>>(new Set());
  const router = useRouter();
  const { confirm, ConfirmDialogEl } = useConfirmDialog();

  // Build user → orgs map
  const userOrgs = new Map<string, { orgName: string; role: string }[]>();
  for (const m of members) {
    const list = userOrgs.get(m.userId) ?? [];
    list.push({ orgName: m.organization.name, role: m.role });
    userOrgs.set(m.userId, list);
  }

  const tabs: { id: Tab; label: string; icon: React.ElementType; count?: number }[] = [
    { id: "waitlist", label: "Waitlist", icon: ListChecks, count: waitlist.length },
    { id: "users", label: "Users", icon: Users },
    { id: "orgs", label: "Organizations", icon: Building2 },
    { id: "sessions", label: "Sessions", icon: Activity },
    { id: "invitations", label: "Invitations", icon: Mail },
  ];

  async function handleSendInvite(signup: { id: string; email: string; name: string }) {
    setSendingInvite(signup.id);
    try {
      await sendWaitlistInvite({ data: signup });
      setSentInvites((prev) => new Set(prev).add(signup.id));
    } catch (err) {
      alert("Failed to send invite: " + (err instanceof Error ? err.message : "Unknown error"));
    } finally {
      setSendingInvite(null);
    }
  }

  async function handleDeleteSignup(id: string) {
    const ok = await confirm({
      title: "Remove from waitlist",
      description: "This will permanently remove this signup. This action cannot be undone.",
      confirmLabel: "Remove",
      variant: "danger",
    });
    if (!ok) return;
    await deleteWaitlistSignup({ data: { id } });
    router.invalidate();
  }

  return (
    <div className="min-h-screen bg-board-bg">
      {/* Header */}
      <header className="border-b border-board-border bg-board-card px-6 py-4">
        <div className="max-w-6xl mx-auto flex items-center gap-3">
          <Shield className="w-5 h-5 text-fire-500" />
          <h1 className="text-lg font-semibold text-board-text">
            <span className="text-fire-500">ShowPilot</span> Super Admin
          </h1>
          <span className="ml-auto text-xs text-board-muted">
            Platform-level dashboard
          </span>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-4 md:px-6 py-6 space-y-6">
        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
          <StatCard label="Waitlist" value={stats.waitlistCount} icon={ListChecks} />
          <StatCard label="Users" value={stats.userCount} icon={Users} />
          <StatCard label="Organizations" value={stats.orgCount} icon={Building2} />
          <StatCard label="Members" value={stats.memberCount} icon={Users} />
          <StatCard label="Active Sessions" value={stats.sessionCount} icon={Monitor} />
          <StatCard label="Pending Invites" value={stats.invitationCount} icon={Mail} />
        </div>

        {/* Tab bar */}
        <div className="flex gap-1 border-b border-board-border">
          {tabs.map((t) => {
            const Icon = t.icon;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors min-h-[44px] ${
                  tab === t.id
                    ? "border-fire-500 text-fire-500"
                    : "border-transparent text-board-muted hover:text-board-text"
                }`}
              >
                <Icon className="w-4 h-4" />
                {t.label}
                {t.count != null && t.count > 0 && (
                  <span className="ml-1 text-[10px] font-medium bg-fire-500/15 text-fire-500 px-1.5 py-0.5 rounded-full">
                    {t.count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Content */}
        {tab === "waitlist" && (
          <div className="space-y-2">
            <p className="text-xs text-board-muted mb-3">
              {waitlist.length} signup{waitlist.length !== 1 ? "s" : ""} on the waitlist
            </p>
            {waitlist.length === 0 ? (
              <div className="rounded-xl border border-board-border bg-board-card p-8 text-center">
                <ListChecks className="w-8 h-8 text-board-muted/30 mx-auto mb-2" />
                <p className="text-sm text-board-muted">No waitlist signups yet</p>
              </div>
            ) : (
              <div className="rounded-xl border border-board-border overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-board-card border-b border-board-border text-left">
                        <th className="px-4 py-3 text-xs font-medium text-board-muted uppercase tracking-wider">Name</th>
                        <th className="px-4 py-3 text-xs font-medium text-board-muted uppercase tracking-wider">Email</th>
                        <th className="px-4 py-3 text-xs font-medium text-board-muted uppercase tracking-wider">Role</th>
                        <th className="px-4 py-3 text-xs font-medium text-board-muted uppercase tracking-wider">Organization</th>
                        <th className="px-4 py-3 text-xs font-medium text-board-muted uppercase tracking-wider">Signed Up</th>
                        <th className="px-4 py-3 text-xs font-medium text-board-muted uppercase tracking-wider text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-board-border">
                      {waitlist.map((signup) => (
                        <tr key={signup.id} className="hover:bg-board-card/50">
                          <td className="px-4 py-3 font-medium text-board-text">
                            {signup.name || <span className="text-board-muted">—</span>}
                          </td>
                          <td className="px-4 py-3 text-board-muted">{signup.email}</td>
                          <td className="px-4 py-3 text-board-muted text-xs">{signup.role || "—"}</td>
                          <td className="px-4 py-3 text-board-muted text-xs">{signup.orgName || "—"}</td>
                          <td className="px-4 py-3 text-board-muted text-xs tabular-nums">{formatDate(signup.createdAt)}</td>
                          <td className="px-4 py-3 text-right">
                            <div className="flex items-center justify-end gap-2">
                              {sentInvites.has(signup.id) ? (
                                <span className="text-[10px] font-medium uppercase px-2 py-1 rounded bg-green-500/10 text-green-400 border border-green-500/20">
                                  Invite Sent
                                </span>
                              ) : (
                                <button
                                  onClick={() => handleSendInvite({ id: signup.id, email: signup.email, name: signup.name })}
                                  disabled={sendingInvite === signup.id}
                                  className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-fire-500/10 text-fire-500 border border-fire-500/20 hover:bg-fire-500/20 transition-colors disabled:opacity-50 min-h-[32px]"
                                >
                                  <Send className="w-3 h-3" />
                                  {sendingInvite === signup.id ? "Sending..." : "Send Invite"}
                                </button>
                              )}
                              <button
                                onClick={() => handleDeleteSignup(signup.id)}
                                className="inline-flex items-center justify-center w-8 h-8 rounded-lg text-board-muted hover:text-red-400 hover:bg-red-500/10 transition-colors"
                                title="Remove from waitlist"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        {tab === "users" && (
          <div className="space-y-2">
            <p className="text-xs text-board-muted mb-3">
              {users.length} registered user{users.length !== 1 ? "s" : ""}
            </p>
            <div className="rounded-xl border border-board-border overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-board-card border-b border-board-border text-left">
                      <th className="px-4 py-3 text-xs font-medium text-board-muted uppercase tracking-wider">
                        User
                      </th>
                      <th className="px-4 py-3 text-xs font-medium text-board-muted uppercase tracking-wider">
                        Email
                      </th>
                      <th className="px-4 py-3 text-xs font-medium text-board-muted uppercase tracking-wider">
                        Organizations
                      </th>
                      <th className="px-4 py-3 text-xs font-medium text-board-muted uppercase tracking-wider">
                        Signed Up
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-board-border">
                    {users.map((user) => {
                      const memberships = userOrgs.get(user.id) ?? [];
                      return (
                        <tr key={user.id} className="hover:bg-board-card/50">
                          <td className="px-4 py-3">
                            <p className="font-medium text-board-text">
                              {user.name}
                            </p>
                          </td>
                          <td className="px-4 py-3 text-board-muted">
                            {user.email}
                          </td>
                          <td className="px-4 py-3">
                            {memberships.length > 0 ? (
                              <div className="flex flex-wrap gap-1">
                                {memberships.map((m, i) => (
                                  <span
                                    key={i}
                                    className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded bg-board-card border border-board-border text-board-text"
                                  >
                                    {m.orgName}
                                    <span className="text-fire-500">
                                      {m.role}
                                    </span>
                                  </span>
                                ))}
                              </div>
                            ) : (
                              <span className="text-board-muted text-xs">
                                No org
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-board-muted text-xs tabular-nums">
                            {formatDate(user.createdAt)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {tab === "orgs" && (
          <div className="space-y-2">
            <p className="text-xs text-board-muted mb-3">
              {orgs.length} organization{orgs.length !== 1 ? "s" : ""}
            </p>
            <div className="grid gap-3">
              {orgs.map((org) => (
                <div
                  key={org.id}
                  className="rounded-xl border border-board-border bg-board-card p-4 flex items-center gap-4"
                >
                  <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-fire-500/20 to-fire-700/20 border border-fire-500/20 flex items-center justify-center shrink-0">
                    {org.logo ? (
                      <img
                        src={org.logo}
                        alt={org.name}
                        className="w-full h-full rounded-xl object-cover"
                      />
                    ) : (
                      <span className="text-lg font-bold text-fire-400">
                        {org.name.charAt(0)}
                      </span>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-board-text">{org.name}</p>
                    <p className="text-xs text-board-muted">/{org.slug}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-lg font-bold text-board-text tabular-nums">
                      {org.memberCount}
                    </p>
                    <p className="text-[10px] text-board-muted">members</p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-xs text-board-muted tabular-nums">
                      {formatDate(org.createdAt)}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === "sessions" && (
          <div className="space-y-2">
            <p className="text-xs text-board-muted mb-3">
              Last 50 sessions
            </p>
            <div className="rounded-xl border border-board-border overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-board-card border-b border-board-border text-left">
                      <th className="px-4 py-3 text-xs font-medium text-board-muted uppercase tracking-wider">
                        User
                      </th>
                      <th className="px-4 py-3 text-xs font-medium text-board-muted uppercase tracking-wider">
                        Device
                      </th>
                      <th className="px-4 py-3 text-xs font-medium text-board-muted uppercase tracking-wider">
                        Started
                      </th>
                      <th className="px-4 py-3 text-xs font-medium text-board-muted uppercase tracking-wider">
                        Expires
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-board-border">
                    {sessions.map((s) => (
                      <tr key={s.id} className="hover:bg-board-card/50">
                        <td className="px-4 py-3">
                          <p className="font-medium text-board-text">
                            {s.user.name}
                          </p>
                          <p className="text-[10px] text-board-muted">
                            {s.user.email}
                          </p>
                        </td>
                        <td className="px-4 py-3">
                          <span className="inline-flex items-center gap-1.5 text-xs text-board-muted">
                            <Monitor className="w-3 h-3" />
                            {parseUserAgent(s.userAgent)}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-board-muted text-xs tabular-nums">
                          {formatDate(s.createdAt)}
                        </td>
                        <td className="px-4 py-3 text-xs tabular-nums">
                          <span
                            className={
                              new Date(s.expiresAt) > new Date()
                                ? "text-green-400"
                                : "text-red-400"
                            }
                          >
                            {formatDate(s.expiresAt)}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {tab === "invitations" && (
          <div className="space-y-2">
            <p className="text-xs text-board-muted mb-3">
              {invitations.length} pending invitation
              {invitations.length !== 1 ? "s" : ""}
            </p>
            {invitations.length === 0 ? (
              <div className="rounded-xl border border-board-border bg-board-card p-8 text-center">
                <Mail className="w-8 h-8 text-board-muted/30 mx-auto mb-2" />
                <p className="text-sm text-board-muted">
                  No pending invitations
                </p>
              </div>
            ) : (
              <div className="grid gap-2">
                {invitations.map((inv) => (
                  <div
                    key={inv.id}
                    className="rounded-xl border border-board-border bg-board-card p-4 flex items-center gap-4"
                  >
                    <Mail className="w-4 h-4 text-board-muted shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-board-text">
                        {inv.email}
                      </p>
                      <p className="text-[10px] text-board-muted">
                        → {inv.organization.name} as{" "}
                        <span className="text-fire-500">{inv.role}</span>
                      </p>
                    </div>
                    <span
                      className={`text-[10px] font-medium uppercase px-2 py-0.5 rounded ${
                        inv.status === "pending"
                          ? "bg-yellow-500/10 text-yellow-400 border border-yellow-500/20"
                          : inv.status === "accepted"
                            ? "bg-green-500/10 text-green-400 border border-green-500/20"
                            : "bg-red-500/10 text-red-400 border border-red-500/20"
                      }`}
                    >
                      {inv.status}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      {ConfirmDialogEl}
    </div>
  );
}
