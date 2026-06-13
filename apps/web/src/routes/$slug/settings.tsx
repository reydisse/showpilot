import { createFileRoute, useRouter } from "@tanstack/react-router";
import { PageSkeleton } from "@/components/ui/Skeleton";
import { useState, useCallback, useEffect } from "react";
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
  Tv,
  CreditCard,
  FlaskConical,
  ExternalLink,
  Gamepad2,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { IntegrationCard } from "@/components/settings/IntegrationCard";
import { KioskSection } from "@/components/settings/KioskSection";
import { CompanionSection } from "@/components/settings/CompanionSection";
import { CsvImportSection } from "@/components/settings/CsvImportSection";
import {
  getOrgSettings,
  updateOrgSetting,
  getOrgMembers,
  regenerateApiKey,
  getRecentWebhookEvents,
  setCloudEnabled,
  type WebhookEventLogItem,
} from "@/lib/settings";
import { inviteMember } from "@/lib/session";
import {
  getOrgBilling,
  createCheckoutSession,
  createPortalSession,
  type OrgBillingInfo,
} from "@/lib/billing";
import { UpgradePrompt, isPlanLimitError } from "@/components/ui/upgrade-prompt";
import { EmbeddedCheckoutModal } from "@/components/settings/EmbeddedCheckoutModal";
import { getStripePublishableKey, resolveCheckoutUiMode } from "@/lib/checkout";
import { clearChatHistory } from "@/lib/chat";
import { testChatConnection } from "@/lib/chat-proxy";
import { listRundownDates, testProPresenterConnection } from "@/lib/rundown";
import { testOntimeConnection } from "@/lib/ontime";
import { deleteOrganization } from "@/lib/org-deletion";
import { resetLowerThirdLibrary } from "@/lib/lowerthirds";
import { exportShowReport } from "@/lib/report";
import { hasAnyPermission, hasPermission, isAdminTier } from "@/lib/app-permissions";
import { ASSIGNABLE_ROLES, ROLE_META } from "@/lib/permissions";

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
    const canReadBilling = hasPermission(context.role, "settings:billing");
    const [settings, members, billing] = await Promise.all([
      getOrgSettings({ data: { orgId: context.orgId } }),
      canReadMembers ? getOrgMembers({ data: { orgId: context.orgId } }) : Promise.resolve([]),
      canReadBilling
        ? getOrgBilling({ data: { orgId: context.orgId } })
        : Promise.resolve(null),
    ]);
    return {
      settings,
      members,
      billing,
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
  | "people"
  | "billing"
  | "integrations"
  | "production"
  | "lowerthirds"
  | "kiosk"
  | "companion"
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
  { id: "people", label: "Import People", icon: UserPlus },
  { id: "billing", label: "Billing", icon: CreditCard },
  { id: "integrations", label: "Integrations", icon: Puzzle },
  { id: "production", label: "Production Defaults", icon: SlidersHorizontal },
  { id: "lowerthirds", label: "Lower Thirds", icon: Type },
  { id: "kiosk", label: "Kiosk Displays", icon: Tv },
  { id: "companion", label: "Companion / Stream Deck", icon: Gamepad2 },
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "api", label: "API & Webhooks", icon: Webhook },
  { id: "danger", label: "Danger Zone", icon: AlertTriangle },
];

// ─── Main Component ─────────────────────────────────────────

function SettingsPage() {
  const { settings, members, billing, orgId, slug, org, role } = Route.useLoaderData();
  const router = useRouter();
  const [activeSection, setActiveSection] = useState<SectionId>("organization");
  const [localSettings, setLocalSettings] =
    useState<Record<string, string>>(settings);
  const [toast, setToast] = useState<string | null>(null);

  const canManageMembers = hasPermission(role, "settings:members");
  const canViewBilling = hasPermission(role, "settings:billing");
  const canViewIntegrations = hasPermission(role, "settings:integrations");
  const canViewOrganization = hasPermission(role, "settings:organization");
  const canViewProduction = hasPermission(role, "settings:production_defaults");
  const canViewLowerThirds = hasPermission(role, "settings:lowerthird_config");
  const canViewNotifications = hasPermission(role, "settings:notifications");
  const canViewApi = hasAnyPermission(role, ["settings:api_keys", "settings:webhooks"]);
  const canViewDanger = hasAnyPermission(role, ["settings:danger_zone", "org:delete"]);

  // Filter nav items based on permissions
  const visibleNavItems = NAV_ITEMS.filter((item) => {
    if (item.id === "organization") return canViewOrganization;
    if (item.id === "team") return canManageMembers;
    if (item.id === "people") return canManageMembers;
    if (item.id === "billing") return canViewBilling;
    if (item.id === "integrations") return canViewIntegrations;
    if (item.id === "production") return canViewProduction;
    if (item.id === "lowerthirds") return canViewLowerThirds;
    if (item.id === "kiosk") return canManageMembers;
    if (item.id === "companion") return hasPermission(role, "settings:api_keys");
    if (item.id === "notifications") return canViewNotifications;
    if (item.id === "api") return canViewApi;
    if (item.id === "danger") return canViewDanger;
    return false;
  });

  const resolvedSection = visibleNavItems.some((item) => item.id === activeSection)
    ? activeSection
    : (visibleNavItems[0]?.id ?? "organization");

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

  const openBilling = useCallback(() => setActiveSection("billing"), []);

  const sectionProps = { orgId, slug, role, org, getSetting, saveSetting, members, openBilling };

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
              const isActive = resolvedSection === item.id;
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
          {resolvedSection === "organization" && (
            <OrganizationSection {...sectionProps} />
          )}
          {resolvedSection === "team" && <TeamSection {...sectionProps} />}
          {resolvedSection === "people" && (
            <CsvImportSection orgId={orgId} openBilling={openBilling} />
          )}
          {resolvedSection === "billing" && (
            <BillingSection {...sectionProps} billing={billing} />
          )}
          {resolvedSection === "integrations" && (
            <IntegrationsSection {...sectionProps} />
          )}
          {resolvedSection === "production" && (
            <ProductionSection {...sectionProps} />
          )}
          {resolvedSection === "lowerthirds" && (
            <LowerThirdsSection {...sectionProps} />
          )}
          {resolvedSection === "kiosk" && (
            <KioskSection orgId={orgId} slug={slug} members={members} />
          )}
          {resolvedSection === "companion" && (
            <CompanionSection orgId={orgId} slug={slug} />
          )}
          {resolvedSection === "notifications" && (
            <NotificationsSection {...sectionProps} />
          )}
          {resolvedSection === "api" && <ApiSection {...sectionProps} />}
          {resolvedSection === "danger" && (
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
  role: string;
  org: { id: string; name: string; slug: string; logo: string | null; createdAt: Date; metadata: string | null; cloud_enabled: boolean };
  getSetting: (key: string, fallback?: string) => string;
  saveSetting: (key: string, value: string) => Promise<void>;
  members: Array<{
    id: string;
    role: string;
    createdAt: Date;
    user: { id: string; name: string; email: string; image: string | null };
  }>;
  openBilling: () => void;
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
            Contact{" "}
            <a href="mailto:support@showpilot.tech" className="text-fire-500/70 hover:text-fire-500">
              support@showpilot.tech
            </a>{" "}
            to change your organization name.
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
  pm: "bg-emerald-500/15 text-emerald-400 border-emerald-500/25",
  tm: "bg-cyan-500/15 text-cyan-400 border-cyan-500/25",
  sm: "bg-amber-500/15 text-amber-400 border-amber-500/25",
  stageManager: "bg-amber-500/15 text-amber-400 border-amber-500/25",
  member: "bg-blue-500/15 text-blue-400 border-blue-500/25",
};

function TeamSection({ members, orgId, openBilling }: SectionProps) {
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
            {ASSIGNABLE_ROLES.map((r) => {
              const roleMeta = ROLE_META[r];
              return (
                <option key={r} value={r}>
                  {roleMeta?.label ?? r}
                </option>
              );
            })}
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
          {inviteError && !isPlanLimitError(inviteError) && (
            <p className="mt-2 text-xs text-red-400">{inviteError}</p>
          )}
        </div>

      <UpgradePrompt
        open={isPlanLimitError(inviteError)}
        onOpenChange={(open) => {
          if (!open) setInviteError(null);
        }}
        message={inviteError ?? ""}
        onUpgrade={() => {
          setInviteError(null);
          openBilling();
        }}
      />

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
              {ROLE_META[member.role as keyof typeof ROLE_META]?.label ?? member.role}
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

// ─── BILLING ────────────────────────────────────────────────

const PLAN_CARDS: Array<{
  plan: "starter" | "pro" | "founding";
  name: string;
  price: number;
  tagline: string;
  features: string[];
}> = [
  {
    plan: "starter",
    name: "Starter",
    price: 39,
    tagline: "For small teams running weekly shows",
    features: ["25 team members", "10 devices", "50 shows", "Integrations", "Kiosk displays"],
  },
  {
    plan: "pro",
    name: "Pro",
    price: 79,
    tagline: "Full production power, no ceilings",
    features: ["100 team members", "Unlimited devices", "Unlimited shows", "Integrations", "Kiosk displays"],
  },
  {
    plan: "founding",
    name: "Founding",
    price: 25,
    tagline: "Everything in Pro, locked in for early teams",
    features: ["All Pro features", "$25/mo locked in", "Founding member badge"],
  },
];

const BILLING_PLAN_BADGES: Record<string, string> = {
  free: "bg-board-border/40 text-board-muted border-board-border",
  starter: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  pro: "bg-fire-500/10 text-fire-500 border-fire-500/20",
};

function billingBannerFromUrl(): "success" | "cancelled" | null {
  if (typeof window === "undefined") return null;
  const value = new URLSearchParams(window.location.search).get("billing");
  return value === "success" || value === "cancelled" ? value : null;
}

function BillingSection({ org, billing }: SectionProps & { billing: OrgBillingInfo | null }) {
  const [banner] = useState<"success" | "cancelled" | null>(billingBannerFromUrl);
  const [checkingOut, setCheckingOut] = useState<string | null>(null);
  const [openingPortal, setOpeningPortal] = useState(false);
  const [billingError, setBillingError] = useState<string | null>(null);
  const [embeddedCheckout, setEmbeddedCheckout] = useState<{
    clientSecret: string;
    planName: string;
  } | null>(null);

  // Drop the ?billing= param so refreshes don't re-show the banner.
  useEffect(() => {
    if (banner) {
      const url = new URL(window.location.href);
      url.searchParams.delete("billing");
      window.history.replaceState({}, "", url);
    }
  }, [banner]);

  if (!billing) {
    return (
      <div>
        <SectionHeader title="Billing" description="Plans and payment" />
        <p className="text-sm text-board-muted">Billing is only visible to owners and admins.</p>
      </div>
    );
  }

  const now = new Date();
  const trialEndsAt = billing.trialEndsAt ? new Date(billing.trialEndsAt) : null;
  const trialActive = trialEndsAt !== null && trialEndsAt > now;
  const trialDaysLeft = trialActive
    ? Math.max(1, Math.ceil((trialEndsAt.getTime() - now.getTime()) / 86_400_000))
    : 0;
  const launchDate = billing.publicLaunchDate ? new Date(billing.publicLaunchDate) : null;
  const betaActive = billing.betaTester && (!launchDate || now < launchDate);

  const handleCheckout = async (plan: "starter" | "pro" | "founding") => {
    setCheckingOut(plan);
    setBillingError(null);
    try {
      // Embedded keeps payment on showpilot.tech; without the publishable
      // key the flow degrades to the original hosted redirect.
      const uiMode = resolveCheckoutUiMode(getStripePublishableKey());
      const result = await createCheckoutSession({
        data: { orgId: org.id, plan, uiMode },
      });
      if (result.mode === "embedded") {
        setEmbeddedCheckout({
          clientSecret: result.clientSecret,
          planName: plan === "founding" ? "Founding" : plan === "pro" ? "Pro" : "Starter",
        });
        setCheckingOut(null);
      } else {
        window.location.href = result.url;
      }
    } catch (err) {
      setBillingError(err instanceof Error ? err.message : "Failed to start checkout");
      setCheckingOut(null);
    }
  };

  const handlePortal = async () => {
    setOpeningPortal(true);
    setBillingError(null);
    try {
      const { url } = await createPortalSession({ data: { orgId: org.id } });
      window.location.href = url;
    } catch (err) {
      setBillingError(err instanceof Error ? err.message : "Failed to open billing portal");
      setOpeningPortal(false);
    }
  };

  const visibleCards = PLAN_CARDS.filter(
    (card) => card.plan !== "founding" || billing.foundingEligible,
  );

  return (
    <div>
      <SectionHeader title="Billing" description="Plans and payment for this organization" />

      {banner === "success" && (
        <div className="mb-5 px-4 py-3 rounded-xl border border-green-500/20 bg-green-500/10 flex items-center gap-2">
          <Check className="w-4 h-4 text-green-400 shrink-0" />
          <p className="text-sm text-green-400">
            Payment successful — your plan will update within a few seconds.
          </p>
        </div>
      )}
      {banner === "cancelled" && (
        <div className="mb-5 px-4 py-3 rounded-xl border border-board-border bg-board-card flex items-center gap-2">
          <p className="text-sm text-board-muted">Checkout cancelled — no changes were made.</p>
        </div>
      )}
      {billingError && (
        <div className="mb-5 px-4 py-3 rounded-xl border border-red-500/20 bg-red-500/10">
          <p className="text-sm text-red-400">{billingError}</p>
        </div>
      )}

      {/* Current plan */}
      <div className="rounded-xl border border-board-border bg-board-card p-4 mb-5">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-sm font-medium text-board-text">Current plan</p>
          <span
            className={`text-[10px] font-medium uppercase px-2 py-0.5 rounded border ${
              BILLING_PLAN_BADGES[billing.effectivePlan] ?? BILLING_PLAN_BADGES.free
            }`}
          >
            {billing.effectivePlan}
          </span>
          {betaActive && (
            <span className="inline-flex items-center gap-1 text-[10px] font-medium uppercase px-2 py-0.5 rounded bg-purple-500/10 text-purple-400 border border-purple-500/20">
              <FlaskConical className="w-2.5 h-2.5" />
              Beta — free until launch
            </span>
          )}
          {billing.foundingMember && (
            <span className="text-[10px] font-medium uppercase px-2 py-0.5 rounded bg-green-500/10 text-green-400 border border-green-500/20">
              Founding member
            </span>
          )}
          {trialActive && !betaActive && (
            <span className="text-[10px] font-medium uppercase px-2 py-0.5 rounded bg-yellow-500/10 text-yellow-400 border border-yellow-500/20">
              Trial — {trialDaysLeft} day{trialDaysLeft !== 1 ? "s" : ""} left
            </span>
          )}
        </div>
        {trialActive && !betaActive && billing.plan === "free" && (
          <p className="text-xs text-board-muted mt-2">
            You have full Pro access during your trial. Pick a plan below to keep it.
          </p>
        )}
        {billing.hasStripeCustomer && (
          <button
            onClick={handlePortal}
            disabled={openingPortal}
            className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-lg text-board-text border border-board-border hover:bg-board-border/50 transition-colors disabled:opacity-50"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            {openingPortal ? "Opening..." : "Manage billing"}
          </button>
        )}
      </div>

      {betaActive ? (
        <div className="rounded-xl border border-purple-500/20 bg-purple-500/5 p-5">
          <div className="flex items-center gap-2 mb-1">
            <FlaskConical className="w-4 h-4 text-purple-400" />
            <p className="text-sm font-medium text-board-text">Beta access</p>
          </div>
          {launchDate ? (
            <>
              <p className="text-xs text-board-muted mb-4">
                Your team has full Pro access free until public launch on{" "}
                <span className="text-board-text font-medium">
                  {launchDate.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}
                </span>
                . Lock in the founding rate now and nothing changes at launch.
              </p>
              <button
                onClick={() => handleCheckout("founding")}
                disabled={checkingOut !== null}
                className="px-4 py-2.5 rounded-xl bg-fire-500 text-white text-sm font-medium hover:bg-fire-600 transition-colors disabled:opacity-50"
              >
                {checkingOut === "founding" ? "Redirecting..." : "Lock in founding rate — $25/mo"}
              </button>
            </>
          ) : (
            <p className="text-xs text-board-muted">
              Your team has full Pro access free until public launch. We&apos;ll let you know
              before anything changes.
            </p>
          )}
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {visibleCards.map((card) => {
            const isCurrent =
              billing.plan === card.plan ||
              (card.plan === "founding" && billing.foundingMember && billing.plan === "pro");
            return (
              <div
                key={card.plan}
                className={`rounded-xl border p-4 flex flex-col ${
                  card.plan === "founding"
                    ? "border-fire-500/30 bg-fire-500/5"
                    : "border-board-border bg-board-card"
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <p className="text-sm font-semibold text-board-text">{card.name}</p>
                  {card.plan === "founding" && (
                    <span className="text-[10px] font-medium uppercase px-2 py-0.5 rounded bg-fire-500/10 text-fire-500 border border-fire-500/20">
                      Limited
                    </span>
                  )}
                </div>
                <p className="text-2xl font-bold text-board-text">
                  ${card.price}
                  <span className="text-xs font-normal text-board-muted">/mo</span>
                </p>
                <p className="text-[11px] text-board-muted mt-1 mb-3">{card.tagline}</p>
                <ul className="space-y-1.5 mb-4 flex-1">
                  {card.features.map((feature) => (
                    <li key={feature} className="flex items-center gap-1.5 text-xs text-board-muted">
                      <Check className="w-3 h-3 text-fire-500 shrink-0" />
                      {feature}
                    </li>
                  ))}
                </ul>
                {isCurrent ? (
                  <span className="text-center text-xs font-medium px-3 py-2.5 rounded-xl border border-board-border text-board-muted">
                    Current plan
                  </span>
                ) : (
                  <button
                    onClick={() => handleCheckout(card.plan)}
                    disabled={checkingOut !== null}
                    className={`text-sm font-medium px-3 py-2.5 rounded-xl transition-colors disabled:opacity-50 ${
                      card.plan === "founding"
                        ? "bg-fire-500 text-white hover:bg-fire-600"
                        : "border border-fire-500/30 text-fire-500 hover:bg-fire-500/10"
                    }`}
                  >
                    {checkingOut === card.plan ? "Redirecting..." : `Choose ${card.name}`}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      <p className="text-[10px] text-board-muted/60 mt-4">
        Subscriptions are handled securely by Stripe. Downgrades keep your data — limits
        apply to new items only.
      </p>

      {embeddedCheckout && (
        <EmbeddedCheckoutModal
          clientSecret={embeddedCheckout.clientSecret}
          planName={embeddedCheckout.planName}
          onClose={() => setEmbeddedCheckout(null)}
        />
      )}
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
            onTest={async () => {
              const result = await testOntimeConnection({ data: { orgId } });
              if (!result.ok) throw new Error(result.error || "Connection failed");
            }}
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

          {/* Planning Center — no adapter implementation yet. Connect stays
              disabled (comingSoon); Disconnect remains live so orgs that
              previously selected it can revert to native. */}
          <IntegrationCard
            name="Planning Center"
            icon={<Clock className="w-4 h-4" />}
            description="Pull service plans from Planning Center Services (read-only)"
            connected={rundownAdapter === "planning-center"}
            comingSoon
            onConnect={() => {}}
            onDisconnect={() => saveSetting("rundown-adapter", "native")}
          />
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

// Org-wide feature flag (organization.cloud_enabled). Owner/admin only.
// Optimistic switch; reverts on failure. When off, lowerthird:* routes show
// the explainer page instead of bouncing to /board (see SHOWPILOT-FIXES-SPEC
// Task A). Crew roles see a read-only state.
function CloudLowerThirdsToggle({
  orgId,
  role,
  initialEnabled,
}: {
  orgId: string;
  role: string;
  initialEnabled: boolean;
}) {
  const router = useRouter();
  const canManage = isAdminTier(role);
  const [enabled, setEnabled] = useState(initialEnabled);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = async () => {
    if (!canManage || saving) return;
    const next = !enabled;
    setEnabled(next); // optimistic
    setSaving(true);
    setError(null);
    try {
      await setCloudEnabled({ data: { orgId, enabled: next } });
      // Refresh route context so guards everywhere see the new flag.
      router.invalidate();
    } catch {
      setEnabled(!next); // revert
      setError("Couldn't update — try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl border border-board-border bg-board-card/50 p-4">
      <div className="flex items-start gap-3">
        <button
          type="button"
          disabled={!canManage || saving}
          onClick={toggle}
          aria-pressed={enabled}
          aria-label="Cloud lower thirds"
          className={`relative mt-0.5 shrink-0 w-9 h-5 rounded-full transition-colors ${
            enabled ? "bg-fire-500" : "bg-board-border"
          } ${canManage ? "cursor-pointer" : "opacity-50 cursor-not-allowed"}`}
        >
          <span
            className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
              enabled ? "translate-x-4" : ""
            }`}
          />
        </button>
        <div className="min-w-0">
          <p className="text-sm font-medium text-board-text">Cloud lower thirds</p>
          <p className="mt-0.5 text-xs text-board-muted">
            Enables browser-triggered lower thirds and the Template Studio.
          </p>
          {!canManage && (
            <p className="mt-1 text-[10px] text-board-muted/60">
              Only an owner or admin can change this.
            </p>
          )}
          {error && <p className="mt-1 text-[10px] text-red-400">{error}</p>}
        </div>
      </div>
    </div>
  );
}

function LowerThirdsSection({ orgId, slug, role, org, getSetting, saveSetting }: SectionProps) {
  const [copiedUrl, setCopiedUrl] = useState(false);
  const overlayUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/overlay/${slug}`
      : `/overlay/${slug}`;

  return (
    <div>
      <SectionHeader
        title="Lower Thirds"
        description="Default styles, animation, and overlay configuration"
      />
      <div className="space-y-5">
        <CloudLowerThirdsToggle
          orgId={orgId}
          role={role}
          initialEnabled={org.cloud_enabled}
        />

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
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 mb-4">
            <code className="flex-1 text-xs text-board-muted bg-board-bg px-3 py-2 rounded-lg break-all sm:truncate overflow-x-auto">
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
          <div className="flex flex-col sm:flex-row items-start gap-4">
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
  const [webhookEvents, setWebhookEvents] = useState<WebhookEventLogItem[]>([]);
  const [isLoadingEvents, setIsLoadingEvents] = useState(true);
  const [eventsError, setEventsError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    const loadEvents = async () => {
      setIsLoadingEvents(true);
      setEventsError(null);

      try {
        const events = await getRecentWebhookEvents({ data: { orgId } });
        if (mounted) setWebhookEvents(events);
      } catch (error) {
        if (!mounted) return;
        setEventsError(
          error instanceof Error ? error.message : "Unable to load webhook events.",
        );
        setWebhookEvents([]);
      } finally {
        if (mounted) setIsLoadingEvents(false);
      }
    };

    loadEvents();

    return () => {
      mounted = false;
    };
  }, [orgId]);

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
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 mb-3">
            <code className="flex-1 text-xs text-board-muted bg-board-bg px-3 py-2 rounded-lg font-mono break-all sm:truncate overflow-x-auto">
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
          {isLoadingEvents ? (
            <div className="flex items-center justify-center gap-2 text-xs text-board-muted py-6">
              <RefreshCw className="w-3 h-3 animate-spin" />
              <span>Loading events...</span>
            </div>
          ) : eventsError ? (
            <div className="text-center py-6 text-xs text-red-400">
              <p>{eventsError}</p>
            </div>
          ) : webhookEvents.length === 0 ? (
            <div className="text-center py-6">
              <Webhook className="w-8 h-8 text-board-muted/30 mx-auto mb-2" />
              <p className="text-xs text-board-muted">No recent events</p>
            </div>
          ) : (
            <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
              {webhookEvents.map((event) => {
                const statusClass =
                  event.status === "success"
                    ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/25"
                    : event.status === "error"
                      ? "bg-red-500/15 text-red-400 border-red-500/25"
                      : event.status === "warning"
                        ? "bg-amber-500/15 text-amber-400 border-amber-500/25"
                        : "bg-blue-500/15 text-blue-400 border-blue-500/25";

                return (
                  <div
                    key={event.id}
                    className="rounded-lg border border-board-border bg-board-bg p-3 text-xs"
                  >
                    <div className="flex items-start justify-between gap-2 mb-1.5">
                      <p className="font-medium text-board-text break-words">
                        {event.source} • {event.type}
                      </p>
                      <span
                        className={`px-2 py-0.5 rounded border text-[10px] font-medium uppercase tracking-wider ${statusClass}`}
                      >
                        {event.status}
                      </span>
                    </div>

                    <p className="text-[10px] text-board-muted">
                      {event.direction} · {new Date(event.timestamp).toLocaleString()}
                    </p>

                    <p className="text-board-text mt-1 break-words">{event.details}</p>

                    {event.payloadSummary && (
                      <p className="text-[10px] text-board-muted mt-1 font-mono break-all">
                        {event.payloadSummary}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── DANGER ZONE ────────────────────────────────────────────

function DangerSection({
  org,
}: SectionProps & { router: ReturnType<typeof useRouter> }) {
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "lowerthirds" | "chat" | "export">(null);
  const [showExportModal, setShowExportModal] = useState(false);
  const [isLoadingExportDates, setIsLoadingExportDates] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [availableDates, setAvailableDates] = useState<Array<{ date: string; itemCount: number }>>([]);
  const [selectedDate, setSelectedDate] = useState("");
  const [selectedFormat, setSelectedFormat] = useState<"json" | "csv" | "xlsx">("json");
  const [selectedSections, setSelectedSections] = useState<string[]>(["summary", "rundown", "incidents", "checklist", "cueSheets"]);

  const handleDeleteOrganization = async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteOrganization({
        data: { orgId: org.id, confirmName: deleteConfirm },
      });
      // The acting session was revoked server-side — full reload to the
      // confirmation page clears all client state.
      window.location.href = "/org-deleted";
    } catch (err) {
      setDeleteError(
        err instanceof Error ? err.message : "Failed to delete organization",
      );
      setDeleting(false);
    }
  };

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

  const handleExport = async () => {
    setBusy("export");
    setExportError(null);
    try {
      const serviceDate = selectedDate || availableDates[0]?.date;
      if (!serviceDate) return;

      const report = await exportShowReport({ data: { orgId: org.id, serviceDate } });
      const filteredReport = {
        generatedAt: report.generatedAt,
        serviceDate: report.serviceDate,
        organization: report.organization,
        ...(selectedSections.includes("summary") ? { summary: report.summary } : {}),
        ...(selectedSections.includes("rundown") ? { rundown: report.rundown } : {}),
        ...(selectedSections.includes("incidents") ? { incidents: report.incidents } : {}),
        ...(selectedSections.includes("checklist") ? { checklist: report.checklist } : {}),
        ...(selectedSections.includes("cueSheets") ? { cueSheets: report.cueSheets } : {}),
      };

      let blob: Blob;
      let extension = selectedFormat;

      if (selectedFormat === "json") {
        blob = new Blob([JSON.stringify(filteredReport, null, 2)], { type: "application/json" });
      } else if (selectedFormat === "csv") {
        const rows: string[][] = [["section", "field", "value"]];
        const csvValue = (value: unknown) => {
          if (value === undefined || value === null) return "";
          if (typeof value === "string") return value;
          return JSON.stringify(value);
        };

        for (const [section, value] of Object.entries(filteredReport)) {
          if (section === "organization") {
            for (const [field, fieldValue] of Object.entries(value as Record<string, unknown>)) {
              rows.push([section, field, csvValue(fieldValue)]);
            }
            continue;
          }
          if (Array.isArray(value)) {
            value.forEach((item, index) => {
              for (const [field, fieldValue] of Object.entries(item)) {
                rows.push([`${section}[${index}]`, field, csvValue(fieldValue)]);
              }
            });
            continue;
          }
          if (value && typeof value === "object") {
            for (const [field, fieldValue] of Object.entries(value)) {
              rows.push([section, field, csvValue(fieldValue)]);
            }
            continue;
          }
          rows.push([section, "value", csvValue(value)]);
        }
        blob = new Blob([
          rows
            .map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(","))
            .join("\n"),
        ], { type: "text/csv" });
      } else {
        const XLSX = await import("xlsx");
        const workbook = XLSX.utils.book_new();

        if (selectedSections.includes("summary")) {
          XLSX.utils.book_append_sheet(
            workbook,
            XLSX.utils.json_to_sheet([report.summary]),
            "Summary",
          );
        }
        if (selectedSections.includes("rundown")) {
          XLSX.utils.book_append_sheet(
            workbook,
            XLSX.utils.json_to_sheet(report.rundown.items),
            "Rundown",
          );
        }
        if (selectedSections.includes("incidents")) {
          XLSX.utils.book_append_sheet(
            workbook,
            XLSX.utils.json_to_sheet(report.incidents),
            "Incidents",
          );
        }
        if (selectedSections.includes("checklist")) {
          XLSX.utils.book_append_sheet(
            workbook,
            XLSX.utils.json_to_sheet(report.checklist),
            "Checklist",
          );
        }
        if (selectedSections.includes("cueSheets")) {
          XLSX.utils.book_append_sheet(
            workbook,
            XLSX.utils.json_to_sheet(report.cueSheets),
            "Cue Sheets",
          );
        }

        const array = XLSX.write(workbook, { bookType: "xlsx", type: "array" });
        blob = new Blob([array], {
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        });
      }

      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${org.slug}-show-report-${serviceDate}.${extension}`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setShowExportModal(false);
    } catch {
      setExportError("Unable to export show data. Please try again.");
    } finally {
      setBusy(null);
    }
  };

  const openExportModal = async () => {
    setExportError(null);
    setIsLoadingExportDates(true);
    setShowExportModal(true);
    try {
      const dates = await listRundownDates({ data: { orgId: org.id } });
      setAvailableDates(dates);
      setSelectedDate(dates[0]?.date ?? "");
      if (!dates.length) {
        setExportError("No show data found for this organization.");
      }
    } catch {
      setExportError("Unable to load show dates. Please try again.");
      setAvailableDates([]);
      setSelectedDate("");
    } finally {
      setIsLoadingExportDates(false);
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
              Choose a past show date and export its data
            </p>
          </div>
          <button
            onClick={openExportModal}
            disabled={busy !== null}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-board-border text-board-muted text-xs font-medium hover:text-board-text hover:bg-board-border/50 transition-colors disabled:opacity-50"
          >
            <Download className="w-3 h-3" />
            Export show data
          </button>
        </div>

        {showExportModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
            <div className="w-full max-w-xl rounded-2xl border border-board-border bg-board-card p-6 shadow-2xl max-h-[90vh] overflow-y-auto">
              <div className="flex items-center justify-between mb-5">
                <h3 className="text-lg font-semibold text-board-text">Export Show Data</h3>
                <button
                  onClick={() => setShowExportModal(false)}
                  className="p-1 rounded-lg hover:bg-board-border transition-colors text-board-muted"
                >
                  ✕
                </button>
              </div>

              <div className="space-y-5">
                {exportError && <p className="text-xs text-red-400">{exportError}</p>}

                {isLoadingExportDates ? (
                  <p className="text-xs text-board-muted">Loading available show dates...</p>
                ) : availableDates.length === 0 ? (
                  <p className="text-xs text-board-muted">
                    No show data found for this organization.
                  </p>
                ) : (
                  <FieldGroup label="Show Date">
                    <select
                      value={selectedDate}
                      onChange={(e) => setSelectedDate(e.target.value)}
                      className="w-full px-4 py-2.5 rounded-xl bg-board-bg border border-board-border text-board-text focus:outline-none focus:border-fire-500 transition-colors text-sm appearance-none"
                    >
                      {availableDates.map((entry) => (
                        <option key={entry.date} value={entry.date}>
                          {entry.date} ({entry.itemCount} items)
                        </option>
                      ))}
                    </select>
                  </FieldGroup>
                )}

                <FieldGroup label="Format">
                  <div className="flex flex-col sm:flex-row gap-2">
                    {([
                      ["json", "JSON"],
                      ["csv", "CSV"],
                      ["xlsx", "Excel"],
                    ] as const).map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        onClick={() => setSelectedFormat(value)}
                        className={`px-4 py-2.5 rounded-xl border text-sm transition-colors ${
                          selectedFormat === value
                            ? "border-fire-500/40 bg-fire-500/10 text-fire-400"
                            : "border-board-border bg-board-bg text-board-muted hover:text-board-text"
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </FieldGroup>

                <FieldGroup label="Include Sections">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {([
                      ["summary", "Summary"],
                      ["rundown", "Rundown"],
                      ["incidents", "Incidents"],
                      ["checklist", "Checklist"],
                      ["cueSheets", "Cue Sheets"],
                    ] as const).map(([value, label]) => {
                      const enabled = selectedSections.includes(value);
                      return (
                        <label
                          key={value}
                          className="flex items-center gap-3 rounded-xl border border-board-border bg-board-bg px-3 py-2.5 cursor-pointer"
                        >
                          <input
                            type="checkbox"
                            checked={enabled}
                            onChange={(e) => {
                              setSelectedSections((prev) =>
                                e.target.checked
                                  ? [...prev, value]
                                  : prev.filter((section) => section !== value)
                              );
                            }}
                            className="w-4 h-4 rounded border-board-border accent-fire-500"
                          />
                          <span className="text-sm text-board-text">{label}</span>
                        </label>
                      );
                    })}
                  </div>
                </FieldGroup>

                <div className="flex flex-col sm:flex-row gap-3 pt-2">
                  <button
                    type="button"
                    onClick={() => setShowExportModal(false)}
                    className="flex-1 px-4 py-2.5 rounded-xl border border-board-border text-board-muted hover:bg-board-border transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleExport}
                    disabled={
                      busy === "export" ||
                      isLoadingExportDates ||
                      availableDates.length === 0 ||
                      !selectedDate ||
                      selectedSections.length === 0
                    }
                    className="flex-1 px-4 py-2.5 rounded-xl bg-fire-500 text-white font-semibold hover:bg-fire-600 disabled:opacity-50 transition-colors"
                  >
                    {busy === "export" ? "Exporting..." : "Download"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

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
              {deleteError && (
                <p className="text-xs text-red-400">{deleteError}</p>
              )}
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    setShowDeleteConfirm(false);
                    setDeleteConfirm("");
                    setDeleteError(null);
                  }}
                  disabled={deleting}
                  className="px-3 py-1.5 rounded-lg border border-board-border text-board-muted text-xs font-medium hover:bg-board-border/50 transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleDeleteOrganization}
                  disabled={deleteConfirm !== org.name || deleting}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-500 text-white text-xs font-medium hover:bg-red-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Trash2 className="w-3 h-3" />
                  {deleting ? "Deleting..." : "Permanently Delete"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
