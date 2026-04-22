import { createFileRoute, useRouter } from "@tanstack/react-router";
import { PageSkeleton } from "@/components/ui/Skeleton";
import { useState } from "react";
import {
  Users,
  UserPlus,
  Shield,
  Crown,
  Copy,
  Check,
  X,
  Mail,
  Trash2,
  ChevronDown,
  Briefcase,
  Wrench,
  Megaphone,
  User,
} from "lucide-react";
import { getCrewMembers } from "@/lib/data";
import {
  getOrgMembers,
  getOrgInvitations,
  inviteMember,
  updateMemberRole,
  removeMember,
  cancelInvitation,
} from "@/lib/session";
import { authClient } from "@/lib/auth-client";
import { ROLE_META, ASSIGNABLE_ROLES } from "@/lib/permissions";
import { hasPermission } from "@/lib/app-permissions";
import { MemberTable } from "@/components/admin/MemberTable";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import type { Member } from "@/types";

export const Route = createFileRoute("/$slug/team")({
  pendingComponent: () => <PageSkeleton />,
  loader: async ({ context }) => {
    const { withPermission } = await import("@/lib/route-permissions");
    await withPermission(context.role, "settings:members", context.slug, context.orgId);
    const [orgMembers, invitations, crewMembers] = await Promise.all([
      getOrgMembers({ data: { orgId: context.orgId } }),
      getOrgInvitations({ data: { orgId: context.orgId } }),
      getCrewMembers({ data: { orgId: context.orgId } }),
    ]);
    return {
      orgMembers,
      invitations,
      crewMembers: crewMembers as unknown as Member[],
      orgId: context.orgId,
      role: context.role,
    };
  },
  component: TeamPage,
});

type Tab = "members" | "crew";

function TeamPage() {
  const { orgMembers, invitations, crewMembers, orgId, role } =
    Route.useLoaderData();
  const [activeTab, setActiveTab] = useState<Tab>("members");

  const canManage = hasPermission(role, "settings:members");

  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold font-[family-name:var(--font-display)] text-board-text">
          Team
        </h1>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 mb-6 border-b border-board-border overflow-x-auto hide-scrollbar">
        <TabButton
          active={activeTab === "members"}
          onClick={() => setActiveTab("members")}
          icon={<Shield className="w-4 h-4" />}
          label="Members"
          count={orgMembers.length}
        />
        <TabButton
          active={activeTab === "crew"}
          onClick={() => setActiveTab("crew")}
          icon={<Users className="w-4 h-4" />}
          label="Crew"
          count={crewMembers.length}
        />
      </div>

      {activeTab === "members" ? (
        <MembersTab
          members={orgMembers}
          invitations={invitations}
          orgId={orgId}
          canManage={canManage}
        />
      ) : (
        <MemberTable members={crewMembers} orgId={orgId} />
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  count: number;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex shrink-0 items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-all -mb-px min-h-[44px] ${
        active
          ? "border-fire-500 text-fire-500"
          : "border-transparent text-board-muted hover:text-board-text"
      }`}
    >
      {icon}
      {label}
      <span
        className={`text-[10px] tabular-nums px-1.5 py-0.5 rounded-full ${
          active
            ? "bg-fire-500/20 text-fire-400"
            : "bg-board-border text-board-muted"
        }`}
      >
        {count}
      </span>
    </button>
  );
}

// ─── Members Tab ─────────────────────────────────────────

interface OrgMember {
  id: string;
  userId: string;
  organizationId: string;
  role: string;
  createdAt: string | Date;
  user: { id: string; name: string; email: string; image: string | null };
}

interface PendingInvitation {
  id: string;
  email: string;
  role: string | null;
  status: string;
  expiresAt: string | Date;
  createdAt: string | Date;
}

function MembersTab({
  members,
  invitations,
  orgId,
  canManage,
}: {
  members: OrgMember[];
  invitations: PendingInvitation[];
  orgId: string;
  canManage: boolean;
}) {
  const router = useRouter();
  const { confirm, ConfirmDialogEl } = useConfirmDialog();
  const [showInviteForm, setShowInviteForm] = useState(false);

  return (
    <div className="space-y-6">
      {/* Invite button */}
      {canManage && (
        <div>
          {showInviteForm ? (
            <InviteForm
              orgId={orgId}
              onDone={() => {
                setShowInviteForm(false);
                router.invalidate();
              }}
              onCancel={() => setShowInviteForm(false)}
            />
          ) : (
            <button
              onClick={() => setShowInviteForm(true)}
              className="flex items-center gap-2 px-4 py-2.5 rounded-xl font-semibold text-sm text-black transition-all duration-200 hover:shadow-lg hover:shadow-fire-500/20 active:scale-[0.98]"
              style={{
                background:
                  "linear-gradient(135deg, #FFC107 0%, #FF8F00 100%)",
              }}
            >
              <UserPlus className="w-4 h-4" />
              Invite Member
            </button>
          )}
        </div>
      )}

      {/* Pending invitations */}
      {canManage && invitations.length > 0 && (
        <div>
          <h3 className="text-xs font-medium uppercase tracking-widest text-board-muted mb-3">
            Pending Invitations
          </h3>
          <div className="space-y-2">
            {invitations.map((inv) => (
              <InvitationRow
                key={inv.id}
                invitation={inv}
                onCancel={async () => {
                  await cancelInvitation({ data: { invitationId: inv.id } });
                  router.invalidate();
                }}
              />
            ))}
          </div>
        </div>
      )}

      {/* Members list */}
      <div>
        <h3 className="text-xs font-medium uppercase tracking-widest text-board-muted mb-3">
          {members.length} Member{members.length !== 1 ? "s" : ""}
        </h3>
        <div className="space-y-2">
          {members.map((m) => (
            <OrgMemberRow
              key={m.id}
              member={m}
              canManage={canManage}
              onRoleChange={async (newRole) => {
                await updateMemberRole({
                  data: { memberId: m.id, role: newRole },
                });
                router.invalidate();
              }}
              onRemove={async () => {
                const ok = await confirm({
                  title: "Remove member",
                  description: `Remove ${m.user.name} from this organization? They will lose access to all org data.`,
                  confirmLabel: "Remove",
                });
                if (!ok) return;
                await removeMember({
                  data: { memberIdOrEmail: m.userId, orgId },
                });
                router.invalidate();
              }}
            />
          ))}
        </div>
      </div>

      {ConfirmDialogEl}
    </div>
  );
}

// ─── Invite Form ─────────────────────────────────────────

function InviteForm({
  orgId,
  onDone,
  onCancel,
}: {
  orgId: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const result = await inviteMember({ data: { email, role, orgId } });
      // Generate invite link
      const link = `${window.location.origin}/invite/${(result as any).id}`;
      setInviteLink(link);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send invite");
    } finally {
      setLoading(false);
    }
  }

  function handleCopy() {
    if (inviteLink) {
      navigator.clipboard.writeText(inviteLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  if (inviteLink) {
    return (
      <div className="p-4 rounded-xl border border-fire-500/20 bg-fire-500/5">
        <p className="text-sm text-board-text mb-2">
          Invitation sent to <span className="font-medium">{email}</span>
        </p>
        <div className="flex items-center gap-2">
          <input
            readOnly
            value={inviteLink}
            className="flex-1 text-xs bg-board-bg border border-board-border rounded-lg px-3 py-2 text-board-muted font-mono"
          />
          <button
            onClick={handleCopy}
            className="p-2 rounded-lg border border-board-border hover:bg-board-border transition-colors text-board-muted"
            title="Copy link"
          >
            {copied ? (
              <Check className="w-4 h-4 text-green-400" />
            ) : (
              <Copy className="w-4 h-4" />
            )}
          </button>
        </div>
        <button
          onClick={onDone}
          className="mt-3 text-xs text-fire-500 hover:underline"
        >
          Done
        </button>
      </div>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="p-4 rounded-xl border border-board-border bg-board-card space-y-3"
    >
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="team@example.com"
            className="w-full rounded-lg border border-board-border bg-board-bg px-3 py-2 text-sm text-board-text placeholder:text-board-muted/50 outline-none focus:border-fire-500/50 focus:ring-1 focus:ring-fire-500/20"
          />
        </div>
        <div className="relative">
          <select
            value={role}
            onChange={(e) => setRole(e.target.value)}
            className="appearance-none rounded-lg border border-board-border bg-board-bg px-3 py-2 pr-8 text-sm text-board-text outline-none focus:border-fire-500/50 cursor-pointer"
          >
            {ASSIGNABLE_ROLES.map((r) => {
              const meta = ROLE_META[r];
              return meta ? (
                <option key={r} value={r}>
                  {meta.label}
                </option>
              ) : null;
            })}
          </select>
          <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-board-muted pointer-events-none" />
        </div>
      </div>

      {error && (
        <p className="text-xs text-red-400">{error}</p>
      )}

      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={loading}
          className="px-4 py-2 rounded-lg text-xs font-semibold text-black transition-all hover:shadow-md active:scale-[0.98] disabled:opacity-50"
          style={{
            background: "linear-gradient(135deg, #FFC107 0%, #FF8F00 100%)",
          }}
        >
          {loading ? "Sending..." : "Send Invite"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 rounded-lg text-xs font-medium text-board-muted hover:text-board-text transition-colors"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

// ─── Invitation Row ──────────────────────────────────────

function InvitationRow({
  invitation,
  onCancel,
}: {
  invitation: PendingInvitation;
  onCancel: () => void;
}) {
  const [cancelling, setCancelling] = useState(false);

  return (
    <div className="flex items-center gap-3 p-3 rounded-xl border border-board-border/60 bg-board-card/50">
      <div className="w-9 h-9 rounded-full bg-board-border flex items-center justify-center shrink-0">
        <Mail className="w-4 h-4 text-board-muted" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm text-board-text truncate">{invitation.email}</p>
        <p className="text-[10px] text-board-muted">
          {ROLE_META[invitation.role ?? "member"]?.label ?? invitation.role ?? "member"} &middot; expires{" "}
          {new Date(invitation.expiresAt).toLocaleDateString()}
        </p>
      </div>
      <button
        onClick={async () => {
          setCancelling(true);
          await onCancel();
        }}
        disabled={cancelling}
        className="p-1.5 rounded-lg hover:bg-red-500/20 transition-colors text-board-muted hover:text-red-400 disabled:opacity-50"
        title="Cancel invitation"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

// ─── Org Member Row ──────────────────────────────────────

const ROLE_STYLES: Record<string, string> = {
  owner: "bg-fire-500/15 text-fire-400 border-fire-500/25",
  admin: "bg-purple-500/15 text-purple-400 border-purple-500/25",
  pm: "bg-emerald-500/15 text-emerald-400 border-emerald-500/25",
  tm: "bg-cyan-500/15 text-cyan-400 border-cyan-500/25",
  stageManager: "bg-amber-500/15 text-amber-400 border-amber-500/25",
  member: "bg-blue-500/15 text-blue-400 border-blue-500/25",
};

const ROLE_ICONS: Record<string, React.ReactNode> = {
  owner: <Crown className="w-3 h-3" />,
  admin: <Shield className="w-3 h-3" />,
  pm: <Briefcase className="w-3 h-3" />,
  tm: <Wrench className="w-3 h-3" />,
  stageManager: <Megaphone className="w-3 h-3" />,
  member: <User className="w-3 h-3" />,
};

function OrgMemberRow({
  member,
  canManage,
  onRoleChange,
  onRemove,
}: {
  member: OrgMember;
  canManage: boolean;
  onRoleChange: (role: string) => void;
  onRemove: () => void;
}) {
  const [showRoleMenu, setShowRoleMenu] = useState(false);

  const roleStyle = ROLE_STYLES[member.role] ?? ROLE_STYLES.member;
  const roleIcon = ROLE_ICONS[member.role] ?? ROLE_ICONS.member;
  const roleLabel = ROLE_META[member.role]?.label ?? member.role;
  const isOwner = member.role === "owner";

  return (
    <div className="group flex items-center gap-3 p-3 rounded-xl bg-board-card border border-board-border hover:border-fire-500/20 transition-all duration-200">
      <div className="w-10 h-10 rounded-full overflow-hidden bg-board-border shrink-0">
        {member.user.image ? (
          <img
            src={member.user.image}
            alt={member.user.name}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-fire-500/20 to-fire-700/20 text-fire-400 text-sm font-semibold">
            {member.user.name.charAt(0)}
          </div>
        )}
      </div>

      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-board-text truncate">
          {member.user.name}
        </p>
        <p className="text-xs text-board-muted truncate">
          {member.user.email}
        </p>
      </div>

      {/* Role badge / selector */}
      <div className="relative">
        {canManage && !isOwner ? (
          <button
            onClick={() => setShowRoleMenu(!showRoleMenu)}
            className={`flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider px-2 py-1 rounded-md border cursor-pointer transition-colors ${roleStyle}`}
          >
            {roleIcon}
            {roleLabel}
            <ChevronDown className="w-2.5 h-2.5 opacity-60" />
          </button>
        ) : (
          <span
            className={`flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider px-2 py-1 rounded-md border ${roleStyle}`}
          >
            {roleIcon}
            {roleLabel}
          </span>
        )}

        {showRoleMenu && (
          <>
            <div
              className="fixed inset-0 z-40"
              onClick={() => setShowRoleMenu(false)}
            />
            <div className="absolute right-0 top-full mt-1 z-50 w-56 rounded-xl border border-board-border bg-board-card shadow-2xl py-1.5">
              {ASSIGNABLE_ROLES.map((r) => {
                const meta = ROLE_META[r];
                if (!meta) return null;
                const style = ROLE_STYLES[r] ?? ROLE_STYLES.member;
                return (
                  <button
                    key={r}
                    onClick={() => {
                      onRoleChange(r);
                      setShowRoleMenu(false);
                    }}
                    className={`w-full text-left px-3 py-2 transition-colors ${
                      member.role === r
                        ? "bg-fire-500/10"
                        : "hover:bg-board-border/50"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className={`text-[10px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded border ${style}`}
                      >
                        {meta.label}
                      </span>
                      {member.role === r && (
                        <Check className="w-3 h-3 text-fire-500 ml-auto" />
                      )}
                    </div>
                    <p className="text-[10px] text-board-muted mt-0.5 pl-0.5">
                      {meta.description}
                    </p>
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>

      {/* Remove button */}
      {canManage && !isOwner && (
        <button
          onClick={onRemove}
          className="p-1.5 rounded-lg opacity-0 group-hover:opacity-100 hover:bg-red-500/20 transition-all text-board-muted hover:text-red-400"
          title="Remove member"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}
