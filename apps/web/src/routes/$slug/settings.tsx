import { createFileRoute, useRouter } from "@tanstack/react-router";
import { PageSkeleton } from "@/components/ui/Skeleton";
import { useState, useCallback } from "react";
import {
  Building2,
  Users,
  Puzzle,
  SlidersHorizontal,
  Type,
  Bell,
  Webhook,
  AlertTriangle,
  Copy,
  Check,
  RefreshCw,
  Trash2,
  Download,
  MessageSquare,
  Clock,
  Shield,
  UserPlus,
  Eye,
  EyeOff,
  ChevronRight,
  ArrowLeft,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { IntegrationCard } from "@/components/settings/IntegrationCard";
import {
  getOrgSettings,
  updateOrgSetting,
  getOrgMembers,
  regenerateApiKey,
} from "@/lib/settings";
import { inviteMember } from "@/lib/session";
import { clearChatHistory } from "@/lib/chat";
import { testChatConnection } from "@/lib/chat-proxy";
import { testProPresenterConnection } from "@/lib/rundown";
import { resetLowerThirdLibrary } from "@/lib/lowerthirds";
import { authClient } from "@/lib/auth-client";
import { hasAnyPermission, hasPermission } from "@/lib/app-permissions";

// ─── Route ──────────────────────────────────────────────────

export const Route = createFileRoute("/$slug/settings")({
  pendingComponent: () => <PageSkeleton />,
  loader: async ({ context }) => {
    const { withPermission } = await import("@/lib/route-permissions");
    await withPermission(context.role, [
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
    ], context.slug, context.orgId);
    const canReadMembers = hasPermission(context.role, "settings:members");
    const [settings, members] = await Promise.all([
      getOrgSettings({ data: { orgId: context.orgId } }),
      canReadMembers ? getOrgMembers({ data: { orgId: context.orgId } }) : Promise.resolve([]),
    ]);
    return {
      settings,
      members,
      orgId: context.orgId,
      slug: context.slug,
      org: context.org,
      role: context.role,
    };
  },
  component: SettingsPage,
});

// ─── Types ──────────────────────────────────────────────────

type SectionId =
  | "organization"
  | "team"
  | "integrations"
  | "production"
  | "lowerthirds"
  | "notifications"
  | "api"
  | "danger";

interface NavItem {
  id: SectionId;
  label: string;
  icon: React.ElementType;
}

const NAV_ITEMS: NavItem[] = [
  { id: "organization", label: "Organization", icon: Building2 },
  { id: "team", label: "Team & Roles", icon: Users },
  { id: "integrations", label: "Integrations", icon: Puzzle },
  { id: "production", label: "Production Defaults", icon: SlidersHorizontal },
  { id: "lowerthirds", label: "Lower Thirds", icon: Type },
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "api", label: "API & Webhooks", icon: Webhook },
  { id: "danger", label: "Danger Zone", icon: AlertTriangle },
];

// ─── Main Component ─────────────────────────────────────────

function SettingsPage() {
  const { settings, members, orgId, slug, org, role } = Route.useLoaderData();
  const router = useRouter();
  const [activeSection, setActiveSection] = useState<SectionId>("organization");
  const [localSettings, setLocalSettings] =
    useState<Record<string, string>>(settings);
  const [toast, setToast] = useState<string | null>(null);

  const canEditSettings = hasAnyPermission(role, [
    "settings:organization",
    "settings:integrations",
    "settings:production_defaults",
    "settings:lowerthird_config",
    "settings:notifications",
    "settings:billing",
    "settings:api_keys",
    "settings:webhooks",
    "settings:danger_zone",
    "org:delete",
  ]);
  const canDeleteOrg = hasPermission(role, "org:delete");
  const canManageMembers = hasPermission(role, "settings:members");
  const canManageKiosk = hasPermission(role, "settings:integrations");
  const canViewIntegrations = hasPermission(role, "settings:integrations");

  // Filter nav items based on permissions
  const visibleNavItems = NAV_ITEMS.filter((item) => {
    if (item.id === "danger") return canDeleteOrg;
    if (item.id === "team") return canManageMembers;
    if (item.id === "integrations") return canViewIntegrations;
    if (item.id === "api") return canEditSettings;
    return true; // organization, production, lowerthirds, notifications visible to all
  });

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2000);
  }, []);

  const saveSetting = useCallback(
    async (key: string, value: string) => {
      setLocalSettings((prev) => ({ ...prev, [key]: value }));
      await updateOrgSetting({ data: { orgId, key, value } });
      showToast("Setting saved");
    },
    [orgId, showToast]
  );

  const getSetting = useCallback(
    (key: string, fallback = "") => localSettings[key] ?? fallback,
    [localSettings]
  );

  const sectionProps = { orgId, slug, org, getSetting, saveSetting, members };

  return (
    <div className="h-full min-h-0 flex flex-col lg:flex-row overflow-hidden">
      {/* Settings nav — horizontal scroll on mobile, vertical sidebar on desktop */}
      <nav className="shrink-0 border-b lg:border-b-0 lg:border-r border-board-border bg-board-bg lg:w-56 lg:overflow-y-auto">
        <div className="p-3 md:p-4">
          <button
            onClick={() => router.history.back()}
            className="flex items-center gap-2 text-sm text-board-muted hover:text-board-text transition-colors mb-3 md:mb-4 min-h-[44px] md:min-h-0"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>Back</span>
          </button>
          <div className="flex lg:flex-col gap-1.5 lg:gap-0.5 overflow-x-auto hide-scrollbar pb-1 lg:pb-0">
            {visibleNavItems.map((item) => {
              const Icon = item.icon;
              const isActive = activeSection === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => setActiveSection(item.id)}
                  className={`flex items-center gap-2 lg:gap-2.5 px-3 py-2 rounded-lg text-xs md:text-sm transition-colors whitespace-nowrap min-h-[44px] lg:min-h-0 lg:w-full ${
                    isActive
                      ? "bg-fire-500/15 text-fire-500"
                      : item.id === "danger"
                        ? "text-red-400/70 hover:text-red-400 hover:bg-red-500/10"
                        : "text-board-muted hover:text-board-text hover:bg-board-border/50"
                  }`}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  <span className="truncate">{item.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      </nav>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto min-h-0">
        <div className="max-w-3xl mx-auto p-4 md:p-6 safe-area-bottom">
          {activeSection === "organization" && (
            <OrganizationSection {...sectionProps} />
          )}
          {activeSection === "team" && <TeamSection {...sectionProps} />}
          {activeSection === "integrations" && (
            <IntegrationsSection {...sectionProps} />
          )}
          {activeSection === "production" && (
            <ProductionSection {...sectionProps} />
          )}
          {activeSection === "lowerthirds" && (
            <LowerThirdsSection {...sectionProps} />
          )}
          {activeSection === "notifications" && (
            <NotificationsSection {...sectionProps} />
          )}
          {activeSection === "api" && <ApiSection {...sectionProps} />}
          {activeSection === "danger" && (
            <DangerSection {...sectionProps} router={router} />
          )}
        </div>
      </main>

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 right-6 z-50 px-4 py-2 rounded-lg bg-green-500/20 border border-green-500/30 text-green-400 text-xs font-medium animate-in fade-in slide-in-from-bottom-2 duration-200">
          {toast}
        </div>
      )}
    </div>
  );
}

// ─── Shared types / helpers ─────────────────────────────────

interface SectionProps {
  orgId: string;
  slug: string;
  org: { id: string; name: string; slug: string; logo: string | null; createdAt: Date; metadata: string | null };
  getSetting: (key: string, fallback?: string) => string;
  saveSetting: (key: string, value: string) => Promise<void>;
  members: Array<{
    id: string;
    role: string;
    createdAt: Date;
    user: { id: string; name: string; email: string; image: string | null };
  }>;
}

function SectionHeader({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="mb-6">
      <h1 className="text-lg font-semibold text-board-text font-[family-name:var(--font-display)]">
        {title}
      </h1>
      <p className="text-xs text-board-muted mt-0.5">{description}</p>
    </div>
  );
}

function FieldGroup({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label className="block text-sm text-board-muted">{label}</label>
      {description && (
        <p className="text-[10px] text-board-muted/50">{description}</p>
      )}
      {children}
    </div>
  );
}

function SettingInput({
  settingKey,
  placeholder,
  getSetting,
  saveSetting,
  type = "text",
}: {
  settingKey: string;
  placeholder?: string;
  getSetting: SectionProps["getSetting"];
  saveSetting: SectionProps["saveSetting"];
  type?: string;
}) {
  const [value, setValue] = useState(getSetting(settingKey));
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => saveSetting(settingKey, value)}
      placeholder={placeholder}
      className="w-full px-4 py-2.5 rounded-xl bg-board-bg border border-board-border text-board-text placeholder:text-board-muted/50 focus:outline-none focus:border-fire-500 transition-colors text-sm"
    />
  );
}

function SettingToggle({
  settingKey,
  label,
  getSetting,
  saveSetting,
  warning,
}: {
  settingKey: string;
  label: string;
  getSetting: SectionProps["getSetting"];
  saveSetting: SectionProps["saveSetting"];
  warning?: string;
}) {
  const enabled = getSetting(settingKey) === "true";
  return (
    <div>
      <label className="flex items-center gap-3 cursor-pointer">
        <button
          type="button"
          onClick={() => saveSetting(settingKey, enabled ? "false" : "true")}
          className={`relative w-9 h-5 rounded-full transition-colors ${
            enabled ? "bg-fire-500" : "bg-board-border"
          }`}
        >
          <span
            className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
              enabled ? "translate-x-4" : ""
            }`}
          />
        </button>
        <span className="text-sm text-board-text">{label}</span>
      </label>
      {warning && enabled && (
        <p className="mt-1.5 ml-12 text-[10px] text-amber-400 flex items-center gap-1">
          <AlertTriangle className="w-3 h-3" />
          {warning}
        </p>
      )}
    </div>
  );
}

function SettingSelect({
  settingKey,
  options,
  getSetting,
  saveSetting,
}: {
  settingKey: string;
  options: { value: string; label: string }[];
  getSetting: SectionProps["getSetting"];
  saveSetting: SectionProps["saveSetting"];
}) {
  const value = getSetting(settingKey, options[0]?.value);
  return (
    <select
      value={value}
      onChange={(e) => saveSetting(settingKey, e.target.value)}
      className="w-full px-4 py-2.5 rounded-xl bg-board-bg border border-board-border text-board-text focus:outline-none focus:border-fire-500 transition-colors text-sm appearance-none"
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}

// ─── ORGANIZATION ───────────────────────────────────────────

function OrganizationSection({ org, getSetting, saveSetting }: SectionProps) {
  return (
    <div>
      <SectionHeader
        title="Organization"
        description="General organization settings"
      />
      <div className="space-y-5">
        <FieldGroup label="Organization Name">
          <div className="px-4 py-2.5 rounded-xl bg-board-bg border border-board-border text-board-text text-sm">
            {org.name}
          </div>
          <p className="text-[10px] text-board-muted/50">
            Contact support to change your organization name.
          </p>
        </FieldGroup>

        <FieldGroup label="Slug">
          <div className="px-4 py-2.5 rounded-xl bg-board-bg border border-board-border text-board-muted text-sm font-mono">
            /{org.slug}
          </div>
        </FieldGroup>

        <FieldGroup label="Timezone">
          <SettingSelect
            settingKey="org-timezone"
            getSetting={getSetting}
            saveSetting={saveSetting}
            options={[
              { value: "America/New_York", label: "Eastern Time (ET)" },
              { value: "America/Chicago", label: "Central Time (CT)" },
              { value: "America/Denver", label: "Mountain Time (MT)" },
              { value: "America/Los_Angeles", label: "Pacific Time (PT)" },
              { value: "America/Anchorage", label: "Alaska Time (AKT)" },
              { value: "Pacific/Honolulu", label: "Hawaii Time (HT)" },
              { value: "Europe/London", label: "GMT / UTC" },
              { value: "Europe/Berlin", label: "Central European (CET)" },
              { value: "Africa/Accra", label: "Ghana (GMT)" },
              { value: "Africa/Lagos", label: "West Africa (WAT)" },
              { value: "Africa/Nairobi", label: "East Africa (EAT)" },
              { value: "Asia/Tokyo", label: "Japan (JST)" },
              { value: "Australia/Sydney", label: "Australia Eastern (AEST)" },
            ]}
          />
        </FieldGroup>

        <FieldGroup label="Created">
          <div className="px-4 py-2.5 rounded-xl bg-board-bg border border-board-border text-board-muted text-sm">
            {new Date(org.createdAt).toLocaleDateString()}
          </div>
        </FieldGroup>
      </div>
    </div>
  );
}

// ─── TEAM & ROLES ───────────────────────────────────────────

const ROLE_COLORS: Record<string, string> = {
  owner: "bg-fire-500/15 text-fire-500 border-fire-500/25",
  admin: "bg-purple-500/15 text-purple-400 border-purple-500/25",
  member: "bg-blue-500/15 text-blue-400 border-blue-500/25",
  viewer: "bg-board-border text-board-muted border-board-border",
};

function TeamSection({ members, orgId }: SectionProps) {
  const router = useRouter();
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("member");
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);

  const handleInvite = async () => {
    if (!inviteEmail.trim()) return;
    setInviting(true);
    setInviteError(null);
    try {
      await inviteMember({ data: { email: inviteEmail.trim(), role: inviteRole, orgId } });
      setInviteEmail("");
      setInviteRole("member");
      router.invalidate();
    } catch (err) {
      setInviteError(err instanceof Error ? err.message : "Failed to send invite");
    } finally {
      setInviting(false);
    }
  };

  return (
    <div>
      <SectionHeader
        title="Team & Roles"
        description="Manage your organization members and roles"
      />

      {/* Invite form */}
      <div className="rounded-xl border border-board-border bg-board-card p-4 mb-5">
        <p className="text-xs font-medium text-board-muted mb-3 flex items-center gap-1.5">
          <UserPlus className="w-3.5 h-3.5" />
          Invite a new member
        </p>
          <div className="flex gap-2">
            <input
            type="email"
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
            placeholder="email@example.com"
            className="flex-1 px-4 py-2.5 rounded-xl bg-board-bg border border-board-border text-board-text placeholder:text-board-muted/50 focus:outline-none focus:border-fire-500 transition-colors text-sm"
          />
          <select
            value={inviteRole}
            onChange={(e) => setInviteRole(e.target.value)}
            className="px-3 py-2.5 rounded-xl bg-board-bg border border-board-border text-board-text text-sm appearance-none focus:outline-none focus:border-fire-500"
          >
            <option value="admin">Admin</option>
            <option value="member">Operator</option>
            <option value="viewer">Viewer</option>
          </select>
            <button
              type="button"
              onClick={handleInvite}
              disabled={inviting || !inviteEmail.trim()}
              className="px-4 py-2.5 rounded-xl bg-fire-500 text-white text-sm font-medium hover:bg-fire-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
            {inviting ? "Inviting..." : "Invite"}
            </button>
          </div>
          {inviteError && (
            <p className="mt-2 text-xs text-red-400">{inviteError}</p>
          )}
        </div>

      {/* Members list */}
      <div className="space-y-2">
        {members.map((member) => (
          <div
            key={member.id}
            className="flex items-center gap-3 px-4 py-3 rounded-xl border border-board-border bg-board-card"
          >
            <div className="w-8 h-8 rounded-full bg-board-bg border border-board-border flex items-center justify-center text-xs font-medium text-board-muted shrink-0">
              {member.user.name?.charAt(0)?.toUpperCase() ?? "?"}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-board-text truncate">
                {member.user.name}
              </p>
              <p className="text-xs text-board-muted truncate">
                {member.user.email}
              </p>
            </div>
            <span
              className={`text-[10px] font-medium uppercase tracking-wider px-2 py-0.5 rounded border ${
                ROLE_COLORS[member.role] ?? ROLE_COLORS.member
              }`}
            >
              {member.role}
            </span>
          </div>
        ))}
        {members.length === 0 && (
          <div className="text-center py-8">
            <Users className="w-8 h-8 text-board-muted/30 mx-auto mb-2" />
            <p className="text-sm text-board-muted">No members found</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── INTEGRATIONS ───────────────────────────────────────────

function IntegrationsSection({ orgId, getSetting, saveSetting }: SectionProps) {
  const chatAdapter = getSetting("chat-adapter", "native");
  const rundownAdapter = getSetting("rundown-adapter", "native");

  return (
    <div>
      <SectionHeader
        title="Integrations"
        description="Connect external tools or use ShowPilot's native features"
      />

      {/* Chat Integrations */}
      <div className="mb-8">
        <p className="text-[10px] font-medium uppercase tracking-widest text-board-muted/50 mb-3">
          Chat Integration
        </p>
        <p className="text-xs text-board-muted mb-4">
          Current:{" "}
          <span className="text-board-text font-medium capitalize">
            {chatAdapter === "native" ? "ShowPilot Native" : chatAdapter}
          </span>
        </p>
        <div className="space-y-3">
          {/* Native option */}
          <div
            className={`rounded-xl border p-4 transition-all cursor-pointer ${
              chatAdapter === "native"
                ? "bg-board-card border-fire-500/25 ring-1 ring-fire-500/20"
                : "bg-board-card border-board-border hover:border-board-muted/30"
            }`}
            onClick={() => saveSetting("chat-adapter", "native")}
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-fire-500/15 border border-fire-500/25 flex items-center justify-center">
                <MessageSquare className="w-4 h-4 text-fire-500" />
              </div>
              <div className="flex-1">
                <h3 className="text-sm font-semibold text-board-text">
                  ShowPilot Native Chat
                </h3>
                <p className="text-xs text-board-muted">
                  Built-in production chat with message types, roles, and
                  real-time delivery
                </p>
              </div>
              {chatAdapter === "native" && (
                <Check className="w-4 h-4 text-fire-500" />
              )}
            </div>
          </div>

          {/* Slack */}
          <IntegrationCard
            name="Slack"
            icon={<MessageSquare className="w-4 h-4" />}
            description="Connect a Slack channel for production chat"
            connected={chatAdapter === "slack"}
            onConnect={() => saveSetting("chat-adapter", "slack")}
            onDisconnect={() => saveSetting("chat-adapter", "native")}
            onTest={() => testChatConnection({ data: { orgId, platform: "slack" } })}
          >
            <div className="space-y-2">
              <FieldGroup label="Bot Token">
                <SettingInput
                  settingKey="slack-token"
                  placeholder="xoxb-..."
                  getSetting={getSetting}
                  saveSetting={saveSetting}
                />
              </FieldGroup>
              <FieldGroup label="Channel ID">
                <SettingInput
                  settingKey="slack-channel"
                  placeholder="C01234ABCDE"
                  getSetting={getSetting}
                  saveSetting={saveSetting}
                />
              </FieldGroup>
            </div>
          </IntegrationCard>

          {/* Mattermost */}
          <IntegrationCard
            name="Mattermost"
            icon={<MessageSquare className="w-4 h-4" />}
            description="Connect via Mattermost bot token for production chat"
            connected={chatAdapter === "mattermost"}
            onConnect={() => saveSetting("chat-adapter", "mattermost")}
            onDisconnect={() => saveSetting("chat-adapter", "native")}
            onTest={() => testChatConnection({ data: { orgId, platform: "mattermost" } })}
          >
            <div className="space-y-2">
              <FieldGroup label="Server URL">
                <SettingInput
                  settingKey="mattermost-url"
                  placeholder="https://mattermost.example.com"
                  getSetting={getSetting}
                  saveSetting={saveSetting}
                />
              </FieldGroup>
              <FieldGroup label="Bot Token">
                <SettingInput
                  settingKey="mattermost-token"
                  placeholder="Bot token"
                  getSetting={getSetting}
                  saveSetting={saveSetting}
                />
              </FieldGroup>
              <FieldGroup label="Channel ID">
                <SettingInput
                  settingKey="mattermost-channel"
                  placeholder="Channel ID"
                  getSetting={getSetting}
                  saveSetting={saveSetting}
                />
              </FieldGroup>
            </div>
          </IntegrationCard>

          {/* Microsoft Teams */}
          <IntegrationCard
            name="Microsoft Teams"
            icon={<MessageSquare className="w-4 h-4" />}
            description="Send messages to a Teams channel via webhook (send only)"
            connected={chatAdapter === "teams"}
            onConnect={() => saveSetting("chat-adapter", "teams")}
            onDisconnect={() => saveSetting("chat-adapter", "native")}
            onTest={() => testChatConnection({ data: { orgId, platform: "teams" } })}
          >
            <div className="space-y-2">
              <FieldGroup label="Webhook URL">
                <SettingInput
                  settingKey="teams-webhook-url"
                  placeholder="https://outlook.office.com/webhook/..."
                  getSetting={getSetting}
                  saveSetting={saveSetting}
                />
              </FieldGroup>
              <p className="text-[10px] text-board-muted/60 mt-1">
                Teams webhook is send-only. Messages sent from Teams will not
                appear in ShowPilot.
              </p>
            </div>
          </IntegrationCard>

          {/* Discord */}
          <IntegrationCard
            name="Discord"
            icon={<MessageSquare className="w-4 h-4" />}
            description="Connect a Discord channel via bot token"
            connected={chatAdapter === "discord"}
            onConnect={() => saveSetting("chat-adapter", "discord")}
            onDisconnect={() => saveSetting("chat-adapter", "native")}
            onTest={() => testChatConnection({ data: { orgId, platform: "discord" } })}
          >
            <div className="space-y-2">
              <FieldGroup label="Bot Token">
                <SettingInput
                  settingKey="discord-bot-token"
                  placeholder="Bot token"
                  getSetting={getSetting}
                  saveSetting={saveSetting}
                />
              </FieldGroup>
              <FieldGroup label="Channel ID">
                <SettingInput
                  settingKey="discord-channel-id"
                  placeholder="Channel ID"
                  getSetting={getSetting}
                  saveSetting={saveSetting}
                />
              </FieldGroup>
            </div>
          </IntegrationCard>
        </div>
      </div>

      {/* Rundown & Timer Integrations */}
      <div className="mb-8">
        <p className="text-[10px] font-medium uppercase tracking-widest text-board-muted/50 mb-3">
          Rundown & Timer Integration
        </p>
        <p className="text-xs text-board-muted mb-4">
          Current:{" "}
          <span className="text-board-text font-medium capitalize">
            {rundownAdapter === "native" ? "ShowPilot Native" : rundownAdapter}
          </span>
        </p>
        <div className="space-y-3">
          {/* Native option */}
          <div
            className={`rounded-xl border p-4 transition-all cursor-pointer ${
              rundownAdapter === "native"
                ? "bg-board-card border-fire-500/25 ring-1 ring-fire-500/20"
                : "bg-board-card border-board-border hover:border-board-muted/30"
            }`}
            onClick={() => saveSetting("rundown-adapter", "native")}
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-fire-500/15 border border-fire-500/25 flex items-center justify-center">
                <Clock className="w-4 h-4 text-fire-500" />
              </div>
              <div className="flex-1">
                <h3 className="text-sm font-semibold text-board-text">
                  ShowPilot Native Rundown
                </h3>
                <p className="text-xs text-board-muted">
                  Built-in runsheet builder with timers, drag-and-drop, and
                  multi-operator sync
                </p>
              </div>
              {rundownAdapter === "native" && (
                <Check className="w-4 h-4 text-fire-500" />
              )}
            </div>
          </div>

          {/* OnTime */}
          <IntegrationCard
            name="OnTime"
            icon={<Clock className="w-4 h-4" />}
            description="Connect to OnTime for professional broadcast rundowns and timers"
            connected={rundownAdapter === "ontime"}
            onConnect={() => saveSetting("rundown-adapter", "ontime")}
            onDisconnect={() => saveSetting("rundown-adapter", "native")}
            onTest={() =>
              new Promise((r) => setTimeout(r, 1000))
            }
          >
            <div className="space-y-3">
              <FieldGroup label="OnTime Server URL">
                <SettingInput
                  settingKey="ontime-url"
                  placeholder="http://localhost:4001"
                  getSetting={getSetting}
                  saveSetting={saveSetting}
                />
              </FieldGroup>
              <SettingToggle
                settingKey="ontime-sync-rundown"
                label="Sync rundown from OnTime"
                getSetting={getSetting}
                saveSetting={saveSetting}
              />
              <SettingToggle
                settingKey="ontime-send-commands"
                label="Allow SP to send commands to OnTime"
                getSetting={getSetting}
                saveSetting={saveSetting}
              />
            </div>
          </IntegrationCard>

          {/* ProPresenter */}
          <IntegrationCard
            name="ProPresenter"
            icon={<SlidersHorizontal className="w-4 h-4" />}
            description="Stream slides from ProPresenter via the ShowPilot Gateway Bridge"
            connected={rundownAdapter === "propresenter"}
            onConnect={() => saveSetting("rundown-adapter", "propresenter")}
            onDisconnect={() => saveSetting("rundown-adapter", "native")}
            onTest={async () => {
              const host = getSetting("propresenter-host");
              const port = parseInt(getSetting("propresenter-port") || "50001", 10);
              const apiPort = parseInt(getSetting("propresenter-api-port") || "0", 10);
              if (!host) throw new Error("Set ProPresenter host first");
              const result = await testProPresenterConnection({ data: { host, port, apiPort: apiPort || undefined } });
              if (!result.ok) throw new Error(result.error || "Connection failed");
            }}
          >
            <div className="space-y-3">
              <FieldGroup label="ProPresenter Host">
                <SettingInput
                  settingKey="propresenter-host"
                  placeholder="192.168.1.100"
                  getSetting={getSetting}
                  saveSetting={saveSetting}
                />
              </FieldGroup>
              <FieldGroup label="Port">
                <SettingInput
                  settingKey="propresenter-port"
                  placeholder="50001"
                  getSetting={getSetting}
                  saveSetting={saveSetting}
                />
              </FieldGroup>
              <FieldGroup label="API Port (Remote Control)">
                <SettingInput
                  settingKey="propresenter-api-port"
                  placeholder="1025"
                  getSetting={getSetting}
                  saveSetting={saveSetting}
                />
                <p className="text-[9px] text-board-muted/40 mt-1">
                  Found in PP Preferences → Network → "Network Port". Different from Stage Display port.
                </p>
              </FieldGroup>
              <FieldGroup label="Stage Display Password">
                <SettingInput
                  settingKey="propresenter-password"
                  placeholder="(leave blank if none)"
                  getSetting={getSetting}
                  saveSetting={saveSetting}
                />
              </FieldGroup>
              <SettingToggle
                settingKey="propresenter-pull-order"
                label="Pull service order from ProPresenter"
                getSetting={getSetting}
                saveSetting={saveSetting}
              />
              <SettingToggle
                settingKey="propresenter-send-cues"
                label="Allow SP to send cues to ProPresenter"
                getSetting={getSetting}
                saveSetting={saveSetting}
                warning="This gives ShowPilot control over your ProPresenter. Only enable if your TD is aware."
              />
              <div className="mt-3 pt-3 border-t border-board-border">
                <p className="text-[10px] font-medium text-board-muted/60 uppercase tracking-widest mb-2">Gateway Bridge</p>
                <div className="px-3 py-2.5 rounded-lg bg-amber-500/5 border border-amber-500/10 mb-3">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-amber-400 mb-1">Required for Production</p>
                  <p className="text-xs text-board-muted">
                    ProPresenter runs on your local network and ShowPilot runs in the cloud — they can't talk directly.
                    The <strong className="text-board-text">ShowPilot Gateway Bridge</strong> runs on a computer on the same network as PP
                    and relays slide data to ShowPilot automatically. Set it up at <code className="text-amber-400/80">http://localhost:9450</code> on the bridge machine.
                  </p>
                </div>
                <p className="text-[10px] font-medium text-board-muted/60 uppercase tracking-widest mb-2">Stage Display</p>
                <p className="text-xs text-board-muted/50 mb-2">
                  Stream live lyrics and scripture from ProPresenter to stage kiosk displays.
                  Enable in the rundown page when ready to stream during a service.
                </p>
                <SettingToggle
                  settingKey="propresenter-stage-display"
                  label="Enable PP slide streaming to stage display"
                  getSetting={getSetting}
                  saveSetting={saveSetting}
                />
              </div>
            </div>
          </IntegrationCard>

          {/* Planning Center */}
          <IntegrationCard
            name="Planning Center"
            icon={<Clock className="w-4 h-4" />}
            description="Pull service plans from Planning Center Services (read-only)"
            connected={rundownAdapter === "planning-center"}
            onConnect={() => saveSetting("rundown-adapter", "planning-center")}
            onDisconnect={() => saveSetting("rundown-adapter", "native")}
            onTest={() =>
              new Promise((r) => setTimeout(r, 1000))
            }
          >
            <div className="space-y-3">
              <SettingToggle
                settingKey="pco-auto-sync"
                label="Auto-sync service plan"
                getSetting={getSetting}
                saveSetting={saveSetting}
              />
              <FieldGroup label="Auto-refresh interval">
                <SettingSelect
                  settingKey="pco-refresh-interval"
                  getSetting={getSetting}
                  saveSetting={saveSetting}
                  options={[
                    { value: "15", label: "Every 15 minutes" },
                    { value: "30", label: "Every 30 minutes" },
                    { value: "60", label: "Every 60 minutes" },
                  ]}
                />
              </FieldGroup>
            </div>
          </IntegrationCard>
        </div>
      </div>

      {/* Future Integrations */}
      <div>
        <p className="text-[10px] font-medium uppercase tracking-widest text-board-muted/50 mb-3">
          Future Integrations
        </p>
        <div className="space-y-3">
          <IntegrationCard
            name="FreeCom"
            icon={<MessageSquare className="w-4 h-4" />}
            description="Browser-based WebRTC party-line intercom for production teams"
            connected={false}
            comingSoon
            onConnect={() => {}}
            onDisconnect={() => {}}
          />
          <IntegrationCard
            name="OpenClaw"
            icon={<Shield className="w-4 h-4" />}
            description="AI production agent for automation and intelligent show management"
            connected={false}
            comingSoon
            onConnect={() => {}}
            onDisconnect={() => {}}
          />
        </div>
      </div>
    </div>
  );
}

// ─── PRODUCTION DEFAULTS ────────────────────────────────────

function ProductionSection({ getSetting, saveSetting }: SectionProps) {
  return (
    <div>
      <SectionHeader
        title="Production Defaults"
        description="Default settings for rundowns, timers, and displays"
      />
      <div className="space-y-5">
        <FieldGroup label="Default Countdown Duration (minutes)">
          <SettingInput
            settingKey="default-countdown-minutes"
            placeholder="5"
            getSetting={getSetting}
            saveSetting={saveSetting}
            type="number"
          />
        </FieldGroup>

        <FieldGroup label="Default Timer Mode">
          <SettingSelect
            settingKey="default-timer-mode"
            getSetting={getSetting}
            saveSetting={saveSetting}
            options={[
              { value: "countdown", label: "Countdown" },
              { value: "countup", label: "Count Up" },
              { value: "clock", label: "Time of Day" },
            ]}
          />
        </FieldGroup>

        <FieldGroup label="Clock Display Format">
          <SettingSelect
            settingKey="clock-format"
            getSetting={getSetting}
            saveSetting={saveSetting}
            options={[
              { value: "12hr", label: "12-hour (2:30 PM)" },
              { value: "24hr", label: "24-hour (14:30)" },
            ]}
          />
        </FieldGroup>

        <FieldGroup label="Timezone Display">
          <SettingSelect
            settingKey="timezone-display"
            getSetting={getSetting}
            saveSetting={saveSetting}
            options={[
              { value: "local", label: "Local timezone" },
              { value: "org", label: "Organization timezone" },
              { value: "utc", label: "UTC" },
            ]}
          />
        </FieldGroup>

        <FieldGroup label="Overtime Behavior">
          <SettingSelect
            settingKey="overtime-behavior"
            getSetting={getSetting}
            saveSetting={saveSetting}
            options={[
              { value: "flash", label: "Flash red on overtime" },
              { value: "countup", label: "Continue counting up (red)" },
              { value: "stop", label: "Stop at zero" },
            ]}
          />
        </FieldGroup>
      </div>
    </div>
  );
}

// ─── LOWER THIRDS ───────────────────────────────────────────

function LowerThirdsSection({ slug, getSetting, saveSetting }: SectionProps) {
  const [copiedUrl, setCopiedUrl] = useState(false);
  const overlayUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/${slug}/streaming/graphics/overlay`
      : `/${slug}/streaming/graphics/overlay`;

  return (
    <div>
      <SectionHeader
        title="Lower Thirds"
        description="Default styles, animation, and overlay configuration"
      />
      <div className="space-y-5">
        <FieldGroup label="Default Style">
          <SettingSelect
            settingKey="l3-default-style"
            getSetting={getSetting}
            saveSetting={saveSetting}
            options={[
              { value: "default", label: "Default - Dark bar, lower-left" },
              { value: "minimal", label: "Minimal - Name only, thin accent" },
              {
                value: "scripture",
                label: "Scripture - Centered, larger text",
              },
            ]}
          />
        </FieldGroup>

        <FieldGroup label="Animation Speed">
          <SettingSelect
            settingKey="l3-animation-speed"
            getSetting={getSetting}
            saveSetting={saveSetting}
            options={[
              { value: "fast", label: "Fast (150ms)" },
              { value: "normal", label: "Normal (250ms)" },
              { value: "slow", label: "Slow (400ms)" },
            ]}
          />
        </FieldGroup>

        <SettingToggle
          settingKey="l3-auto-clear"
          label="Auto-clear lower thirds"
          getSetting={getSetting}
          saveSetting={saveSetting}
        />

        {getSetting("l3-auto-clear") === "true" && (
          <FieldGroup label="Auto-clear Duration (seconds)">
            <SettingInput
              settingKey="l3-auto-clear-duration"
              placeholder="10"
              getSetting={getSetting}
              saveSetting={saveSetting}
              type="number"
            />
          </FieldGroup>
        )}

        {/* Overlay URL */}
        <div className="rounded-xl border border-board-border bg-board-card/50 p-4">
          <p className="text-[10px] font-medium uppercase tracking-widest text-board-muted/50 mb-3">
            Overlay URL for OBS / vMix
          </p>
          <div className="flex items-center gap-2 mb-4">
            <code className="flex-1 text-xs text-board-muted bg-board-bg px-3 py-2 rounded-lg truncate">
              {overlayUrl}
            </code>
            <button
              onClick={() => {
                navigator.clipboard.writeText(overlayUrl);
                setCopiedUrl(true);
                setTimeout(() => setCopiedUrl(false), 2000);
              }}
              className="p-2 rounded-lg text-board-muted hover:text-board-text hover:bg-board-border/50 transition-colors"
            >
              {copiedUrl ? (
                <Check className="w-4 h-4 text-green-400" />
              ) : (
                <Copy className="w-4 h-4" />
              )}
            </button>
          </div>

          {/* QR Code */}
          <div className="flex items-start gap-4">
            <div className="p-2 bg-white rounded-lg">
              <QRCodeSVG value={overlayUrl} size={96} />
            </div>
            <div className="text-xs text-board-muted space-y-2">
              <p className="font-medium text-board-text">Setup Instructions</p>
              <details className="group">
                <summary className="cursor-pointer hover:text-board-text flex items-center gap-1">
                  <ChevronRight className="w-3 h-3 group-open:rotate-90 transition-transform" />
                  OBS Browser Source
                </summary>
                <ol className="mt-1 ml-4 space-y-0.5 text-[10px] list-decimal">
                  <li>In OBS, add a new Browser Source</li>
                  <li>Paste the overlay URL above</li>
                  <li>Set width to 1920, height to 1080</li>
                  <li>Check "Shutdown source when not visible"</li>
                </ol>
              </details>
              <details className="group">
                <summary className="cursor-pointer hover:text-board-text flex items-center gap-1">
                  <ChevronRight className="w-3 h-3 group-open:rotate-90 transition-transform" />
                  vMix Browser Input
                </summary>
                <ol className="mt-1 ml-4 space-y-0.5 text-[10px] list-decimal">
                  <li>In vMix, add a Web Browser input</li>
                  <li>Paste the overlay URL above</li>
                  <li>Set resolution to 1920x1080</li>
                </ol>
              </details>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── NOTIFICATIONS ──────────────────────────────────────────

function NotificationsSection({ getSetting, saveSetting }: SectionProps) {
  return (
    <div>
      <SectionHeader
        title="Notifications"
        description="Configure how you receive alerts and notifications"
      />
      <div className="space-y-5">
        <p className="text-[10px] font-medium uppercase tracking-widest text-board-muted/50">
          Email Notifications
        </p>
        <SettingToggle
          settingKey="notify-email-service-reminder"
          label="Service reminders"
          getSetting={getSetting}
          saveSetting={saveSetting}
        />
        <SettingToggle
          settingKey="notify-email-team-changes"
          label="Team membership changes"
          getSetting={getSetting}
          saveSetting={saveSetting}
        />
        <SettingToggle
          settingKey="notify-email-incidents"
          label="Incident reports"
          getSetting={getSetting}
          saveSetting={saveSetting}
        />

        <div className="border-t border-board-border pt-5" />

        <p className="text-[10px] font-medium uppercase tracking-widest text-board-muted/50">
          In-App Notifications
        </p>
        <SettingToggle
          settingKey="notify-app-chat"
          label="New chat messages"
          getSetting={getSetting}
          saveSetting={saveSetting}
        />
        <SettingToggle
          settingKey="notify-app-cue"
          label="Cue alerts"
          getSetting={getSetting}
          saveSetting={saveSetting}
        />
        <SettingToggle
          settingKey="notify-app-timer"
          label="Timer warnings (overtime)"
          getSetting={getSetting}
          saveSetting={saveSetting}
        />

        <div className="border-t border-board-border pt-5" />

        <p className="text-[10px] font-medium uppercase tracking-widest text-board-muted/50">
          Sound
        </p>
        <SettingToggle
          settingKey="notify-sound-enabled"
          label="Chat alert sound"
          getSetting={getSetting}
          saveSetting={saveSetting}
        />
        {getSetting("notify-sound-enabled") === "true" && (
          <FieldGroup label="Alert Volume">
            <SettingSelect
              settingKey="notify-sound-volume"
              getSetting={getSetting}
              saveSetting={saveSetting}
              options={[
                { value: "low", label: "Low" },
                { value: "medium", label: "Medium" },
                { value: "high", label: "High" },
              ]}
            />
          </FieldGroup>
        )}
      </div>
    </div>
  );
}

// ─── API & WEBHOOKS ─────────────────────────────────────────

function ApiSection({ orgId, getSetting, saveSetting }: SectionProps) {
  const [apiKey, setApiKey] = useState(getSetting("api-key", ""));
  const [showKey, setShowKey] = useState(false);
  const [regenerating, setRegenerating] = useState(false);

  const handleRegenerate = async () => {
    setRegenerating(true);
    try {
      const newKey = await regenerateApiKey({ data: { orgId } });
      setApiKey(newKey);
      setShowKey(true);
    } finally {
      setRegenerating(false);
    }
  };

  return (
    <div>
      <SectionHeader
        title="API & Webhooks"
        description="Manage API keys and webhook endpoints for external integrations"
      />
      <div className="space-y-5">
        {/* API Key */}
        <div className="rounded-xl border border-board-border bg-board-card p-4">
          <p className="text-xs font-medium text-board-muted mb-3">API Key</p>
          <div className="flex items-center gap-2 mb-3">
            <code className="flex-1 text-xs text-board-muted bg-board-bg px-3 py-2 rounded-lg font-mono truncate">
              {apiKey
                ? showKey
                  ? apiKey
                  : apiKey.slice(0, 6) + "..." + apiKey.slice(-4)
                : "No API key generated"}
            </code>
            {apiKey && (
              <button
                onClick={() => setShowKey(!showKey)}
                className="p-2 rounded-lg text-board-muted hover:text-board-text hover:bg-board-border/50 transition-colors"
              >
                {showKey ? (
                  <EyeOff className="w-4 h-4" />
                ) : (
                  <Eye className="w-4 h-4" />
                )}
              </button>
            )}
          </div>
          <button
            onClick={handleRegenerate}
            disabled={regenerating}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-board-border text-board-muted text-xs font-medium hover:text-board-text hover:bg-board-border/50 transition-colors disabled:opacity-50"
          >
            {regenerating ? (
              <RefreshCw className="w-3 h-3 animate-spin" />
            ) : (
              <RefreshCw className="w-3 h-3" />
            )}
            {apiKey ? "Regenerate" : "Generate"} API Key
          </button>
        </div>

        {/* Webhook URL */}
        <FieldGroup
          label="Webhook URL"
          description="Incoming webhook endpoint for external triggers"
        >
          <SettingInput
            settingKey="webhook-url"
            placeholder="https://your-server.com/webhook"
            getSetting={getSetting}
            saveSetting={saveSetting}
          />
        </FieldGroup>

        {/* Event Log placeholder */}
        <div className="rounded-xl border border-board-border bg-board-card/50 p-4">
          <p className="text-[10px] font-medium uppercase tracking-widest text-board-muted/50 mb-3">
            Recent Webhook Events
          </p>
          <div className="text-center py-6">
            <Webhook className="w-8 h-8 text-board-muted/30 mx-auto mb-2" />
            <p className="text-xs text-board-muted">No recent events</p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── DANGER ZONE ────────────────────────────────────────────

function DangerSection({
  org,
  router: _router,
}: SectionProps & { router: ReturnType<typeof useRouter> }) {
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [busy, setBusy] = useState<null | "lowerthirds" | "chat" | "export">(null);

  const handleResetLowerThirds = async () => {
    setBusy("lowerthirds");
    try {
      await resetLowerThirdLibrary({ data: { orgId: org.id } });
    } finally {
      setBusy(null);
    }
  };

  const handleClearChat = async () => {
    setBusy("chat");
    try {
      await clearChatHistory({ data: { orgId: org.id } });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <SectionHeader
        title="Danger Zone"
        description="Irreversible and destructive actions"
      />
      <div className="space-y-4">
        {/* Reset lower thirds */}
        <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-4 flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-board-text">
              Reset all lower thirds
            </p>
            <p className="text-xs text-board-muted">
              Clear all saved graphic templates
            </p>
          </div>
          <button
            onClick={handleResetLowerThirds}
            disabled={busy !== null}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-red-500/30 text-red-400 text-xs font-medium hover:bg-red-500/10 transition-colors disabled:opacity-50"
          >
            <Trash2 className="w-3 h-3" />
            {busy === "lowerthirds" ? "Resetting..." : "Reset"}
          </button>
        </div>

        {/* Clear chat history */}
        <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-4 flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-board-text">
              Clear chat history
            </p>
            <p className="text-xs text-board-muted">
              Remove all chat messages from native chat
            </p>
          </div>
          <button
            onClick={handleClearChat}
            disabled={busy !== null}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-red-500/30 text-red-400 text-xs font-medium hover:bg-red-500/10 transition-colors disabled:opacity-50"
          >
            <Trash2 className="w-3 h-3" />
            {busy === "chat" ? "Clearing..." : "Clear"}
          </button>
        </div>

        {/* Export data */}
        <div className="rounded-xl border border-board-border bg-board-card p-4 flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-board-text">
              Export org data
            </p>
            <p className="text-xs text-board-muted">
              Download all organization data as JSON
            </p>
          </div>
          <button
            disabled
            title="Export not wired yet"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-board-border text-board-muted text-xs font-medium opacity-50 cursor-not-allowed"
          >
            <Download className="w-3 h-3" />
            Export
          </button>
        </div>

        {/* Delete organization */}
        <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-4">
          <div className="flex items-center justify-between mb-3">
            <div>
              <p className="text-sm font-medium text-red-400">
                Delete organization
              </p>
              <p className="text-xs text-board-muted">
                Permanently delete this organization and all its data. This
                cannot be undone.
              </p>
            </div>
          </div>

          {!showDeleteConfirm ? (
              <button
                onClick={() => setShowDeleteConfirm(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-500/20 text-red-400 text-xs font-medium hover:bg-red-500/30 transition-colors"
              >
              <Trash2 className="w-3 h-3" />
              Delete Organization
            </button>
          ) : (
            <div className="space-y-3">
              <p className="text-xs text-board-muted">
                Type{" "}
                <span className="font-mono text-red-400 font-medium">
                  {org.name}
                </span>{" "}
                to confirm:
              </p>
              <input
                type="text"
                value={deleteConfirm}
                onChange={(e) => setDeleteConfirm(e.target.value)}
                placeholder={org.name}
                className="w-full px-4 py-2.5 rounded-xl bg-board-bg border border-red-500/30 text-board-text placeholder:text-board-muted/50 focus:outline-none focus:border-red-500 transition-colors text-sm"
              />
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    setShowDeleteConfirm(false);
                    setDeleteConfirm("");
                  }}
                  className="px-3 py-1.5 rounded-lg border border-board-border text-board-muted text-xs font-medium hover:bg-board-border/50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  disabled={deleteConfirm !== org.name}
                  title="Delete organization is not wired yet"
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-500 text-white text-xs font-medium hover:bg-red-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Trash2 className="w-3 h-3" />
                  Permanently Delete
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
