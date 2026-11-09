import { ProPresenterOutputControl } from "@/components/rundown/ProPresenterOutputControl";
import { NotificationPreferences } from "@/components/settings/NotificationPreferences";
import { TimezoneSetting } from "@/components/settings/TimezoneSetting";
import { SettingsTeamInvitations } from "@/components/admin/SettingsTeamInvitations";
import { useOperatorRead } from "@/hooks/useOperatorRead";
import { ReadFailureNotice } from "@/components/layout/ReadFailureNotice";
import { useSettingsReturnTo } from "@/components/layout/AppShell";
import { CredentialSettingInput } from "@/components/settings/CredentialSettingInput";
import type { CredentialChange } from "@/lib/credential-fields";
import { BridgeTargetSettings } from "@/components/settings/BridgeTargetSettings";
import { BridgeInstallationSettings } from "@/components/settings/BridgeInstallationSettings";
import { ConfidenceSection } from "@/components/settings/ConfidenceSection";
import { CONFIDENCE_LAYOUT_KEY } from "@/lib/confidence-layout";
import { WorkspaceSettings } from "@/components/workspace/WorkspaceSettings";
import { createFileRoute, useRouter, useBlocker } from "@tanstack/react-router";
import { PageSkeleton } from "@/components/ui/Skeleton";
import { ShowReportExport } from "@/components/settings/ShowReportExport";
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
  MessageSquare,
  Clock,
  Shield,
  UserPlus,
  ChevronRight,
  ArrowLeft,
  Tv,
  CreditCard,
  Gamepad2,
  Mail,
  MonitorSmartphone,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { IntegrationCard } from "@/components/settings/IntegrationCard";
import { SettingSaveNotice, settingLabel } from "@/components/settings/SettingSaveNotice";
import type { SettingChange } from "@/lib/setting-writes";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { useSettingAutosave } from "@/components/settings/useSettingAutosave";
import { KioskSection } from "@/components/settings/KioskSection";
import { CompanionSection } from "@/components/settings/CompanionSection";
import { useDisplayLink } from "@/hooks/useDisplayLink";
import { CsvImportSection } from "@/components/settings/CsvImportSection";
import {
  getManageableOrgSettings,
  updateOrgSetting,
  updateOrgCredential,
  updateRundownPinProtection,
  getOrgMembers,
  getRecentWebhookEvents,
  setCloudEnabled,
  type WebhookEventLogItem,
} from "@/lib/settings";
import { getRundownPinRequirement } from "@/lib/rbac";
import {
  getOrgBilling,
} from "@/lib/billing";
import { BillingSection } from "@/components/settings/BillingSection";
import { ClearChatHistory } from "@/components/settings/ClearChatHistory";
import { testChatConnection } from "@/lib/chat-proxy";
import { testProPresenterConnection } from "@/lib/rundown";
import { testOntimeConnection } from "@/lib/ontime";
import { DeleteOrganization } from "@/components/settings/DeleteOrganization";
import { ResetSavedGraphics } from "@/components/settings/ResetSavedGraphics";
import { hasAnyPermission, hasPermission, isAdminTier } from "@/lib/app-permissions";
import { ROLE_META } from "@/lib/permissions";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ContextHelp } from "@/components/ui/context-help";
// ─── Route ──────────────────────────────────────────────────

export const Route = createFileRoute("/$slug/settings")({
  pendingComponent: () => <PageSkeleton />,
  validateSearch: (search: Record<string, unknown>): { section?: SectionId } => ({
    section: parseSectionId(search.section),
  }),
  loader: async ({ context }) => {
    // The organization layout verifies membership; feature settings keep their own permissions.
    const canReadMembers = hasPermission(context.role, "settings:members");
    const canReadBilling = hasPermission(context.role, "settings:billing");
    const [settings, members, billing, rundownPin] = await Promise.all([
      getManageableOrgSettings({ data: { orgId: context.orgId } }),
      canReadMembers ? getOrgMembers({ data: { orgId: context.orgId } }) : Promise.resolve([]),
      canReadBilling
        ? getOrgBilling({ data: { orgId: context.orgId } })
        : Promise.resolve(null),
      canReadMembers
        ? getRundownPinRequirement({ data: { orgId: context.orgId } })
        : Promise.resolve({ enabled: false }),
    ]);
    return {
      settings,
      members,
      billing,
      orgId: context.orgId,
      slug: context.slug,
      org: context.org,
      role: context.role,
      rundownPinEnabled: rundownPin.enabled,
    };
  },
  component: SettingsPage,
});

// ─── Types ──────────────────────────────────────────────────

type SectionId =
  | "workspace"
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

function parseSectionId(value: unknown): SectionId | undefined {
  switch (value) {
    case "workspace":
    case "organization":
    case "team":
    case "people":
    case "billing":
    case "integrations":
    case "production":
    case "lowerthirds":
    case "kiosk":
    case "companion":
    case "notifications":
    case "api":
    case "danger":
      return value;
    default:
      return undefined;
  }
}

interface NavItem {
  id: SectionId;
  label: string;
  icon: React.ElementType;
}

const NAV_ITEMS: NavItem[] = [
  { id: "workspace", label: "Workspace", icon: Building2 },
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
  const loaderData = Route.useLoaderData();
  return (
    <OrganizationSettingsPage key={loaderData.orgId} loaderData={loaderData} />
  );
}

function OrganizationSettingsPage({
  loaderData,
}: {
  loaderData: ReturnType<typeof Route.useLoaderData>;
}) {
  const { settings, members, billing, orgId, slug, org, role, rundownPinEnabled } = loaderData;
  const { user } = Route.useRouteContext();
  const [confidenceLayoutValue, setConfidenceLayoutValue] = useState<string | undefined>(settings[CONFIDENCE_LAYOUT_KEY]);
  const [confidenceDirty, setConfidenceDirty] = useState(false);
  const [invitationDirty, setInvitationDirty] = useState(false);
  const { section } = Route.useSearch();
  const navigate = Route.useNavigate();
  const router = useRouter();
  const settingsReturnTo = useSettingsReturnTo();
  const goBack = () => void router.navigate({ href: settingsReturnTo ?? `/${slug}/show` });
  const backLabel = settingsReturnTo ? "Back to previous page" : "Back to Show Flow";
  const persistSetting = useCallback(
    (change: SettingChange, signal: AbortSignal) =>
      updateOrgSetting({ data: { orgId, ...change }, signal }),
    [orgId],
  );
  const { getSetting, editSetting, saveSetting, retrySetting, resolveConflict, saveState, hasUnsavedChanges, acceptSavedSetting } = useSettingAutosave({
    initialSettings: settings,
    persist: persistSetting,
  });

  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) => invitationDirty || confidenceDirty || (hasUnsavedChanges && current.pathname !== next.pathname),
    enableBeforeUnload: hasUnsavedChanges || confidenceDirty || invitationDirty, withResolver: true,
  });

  const saveCredential = useCallback(async (key: string, change: CredentialChange) => {
    const result = await updateOrgCredential({ data: { orgId, key, change } });
    acceptSavedSetting(result.key, result.value);
  }, [orgId, acceptSavedSetting]);

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
    if (item.id === "workspace") return true;
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

  const resolvedSection = section && visibleNavItems.some((item) => item.id === section)
    ? section
    : (visibleNavItems[0]?.id ?? "organization");
  const activeNavItem = visibleNavItems.find((item) => item.id === resolvedSection);

  const openBilling = useCallback(() => {
    void navigate({ search: { section: "billing" } });
  }, [navigate]);

  const sectionProps = {
    orgId,
    slug,
    role,
    org,
    getSetting,
    editSetting,
    saveSetting,
    saveCredential,
    members,
    openBilling,
    rundownPinEnabled,
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden lg:flex-row">
      <aside className="hidden w-72 shrink-0 border-r border-board-border bg-board-bg/75 lg:flex lg:min-h-0 lg:flex-col">
        <div className="shrink-0 border-b border-board-border px-5 py-5">
          <button
            type="button"
            onClick={goBack}
            className="flex min-h-11 items-center gap-2 rounded-lg px-2 text-sm text-board-muted transition-colors hover:bg-board-border/40 hover:text-board-text"
          >
            <ArrowLeft className="size-4" />
            <span>{backLabel}</span>
          </button>
          <div className="mt-4 px-2">
            <h1 className="text-lg font-semibold text-board-text">Settings</h1>
            <p className="mt-1 text-xs leading-5 text-board-muted">Organization, production, and integrations</p>
          </div>
        </div>
        <nav aria-label="Settings sections" className="modern-scrollbar min-h-0 flex-1 overflow-y-auto p-3">
          <div className="flex flex-col gap-1">
            {visibleNavItems.map((item) => {
              const Icon = item.icon;
              const isActive = resolvedSection === item.id;
              return (
                <button
                  type="button"
                  key={item.id}
                  onClick={() => void navigate({ search: { section: item.id } })}
                  aria-current={isActive ? "page" : undefined}
                  className={`flex min-h-11 w-full items-center gap-3 rounded-lg border-l-2 px-3 py-2.5 text-left text-sm transition-colors ${
                    isActive
                      ? "border-fire-500 bg-fire-500/10 text-fire-500"
                      : item.id === "danger"
                        ? "border-transparent text-red-400/80 hover:bg-red-500/10 hover:text-red-400"
                        : "border-transparent text-board-muted hover:bg-board-border/40 hover:text-board-text"
                  }`}
                >
                  <Icon className="size-[18px] shrink-0" />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </div>
        </nav>
      </aside>

      <div className="shrink-0 border-b border-board-border bg-board-bg/90 px-4 py-3 lg:hidden">
        <button type="button" onClick={goBack} className="flex min-h-11 items-center gap-2 text-sm text-board-muted transition-colors hover:text-board-text">
          <ArrowLeft className="size-4" />
          {backLabel}
        </button>
        <Select
          value={resolvedSection}
          onValueChange={(value) => {
            const item = visibleNavItems.find((candidate) => candidate.id === value);
            if (item) void navigate({ search: { section: item.id } });
          }}
        >
          <SelectTrigger aria-label="Settings section" className="mt-2 h-12 w-full border-board-border bg-board-card px-4 text-board-text">
            <SelectValue placeholder="Choose a settings section">{activeNavItem?.label}</SelectValue>
          </SelectTrigger>
          <SelectContent className="border-board-border bg-board-card text-board-text">
            <SelectGroup>
              {visibleNavItems.map((item) => {
                const Icon = item.icon;
                return (
                  <SelectItem key={item.id} value={item.id}><Icon />{item.label}</SelectItem>
                );
              })}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>

      <div className="modern-scrollbar min-h-0 flex-1 overflow-y-auto">
        <div className="safe-area-bottom mx-auto max-w-5xl px-4 py-5 sm:px-6 sm:py-7 lg:px-10 lg:py-9">
          <div className="mb-4 min-h-6">
            <SettingSaveNotice state={saveState} retry={retrySetting} resolveConflict={resolveConflict} />
          </div>
          <div className="max-w-4xl">
            {resolvedSection === "workspace" && (
              <WorkspaceSettings
                userId={user.id}
                orgId={orgId}
                canResumeSetup={role === "owner"}
                canManage={canViewOrganization && (role === "owner" || role === "admin")}
              />
            )}
            {resolvedSection === "organization" && (
            <OrganizationSection {...sectionProps} />
          )}
            {resolvedSection === "team" && <TeamSection {...sectionProps} onInvitationDirty={setInvitationDirty} />}
            {resolvedSection === "people" && (
            <CsvImportSection orgId={orgId} openBilling={openBilling} />
          )}
            {resolvedSection === "billing" && (
            <div><SectionHeader title="Billing" description="Plans and payment for this organization" /><BillingSection orgId={orgId} billing={billing} /></div>
          )}
            {resolvedSection === "integrations" && (
            <IntegrationsSection {...sectionProps} />
          )}
            {resolvedSection === "production" && (
            <ProductionSection {...sectionProps} confidenceLayoutValue={confidenceLayoutValue} onConfidenceLayoutApplied={value => { setConfidenceLayoutValue(value); if (value !== undefined) acceptSavedSetting(CONFIDENCE_LAYOUT_KEY, value); }} onConfidenceDirtyChange={setConfidenceDirty} />
          )}
            {resolvedSection === "lowerthirds" && (
            <LowerThirdsSection {...sectionProps} />
          )}
            {resolvedSection === "kiosk" && (
            <KioskSection orgId={orgId} slug={slug} userId={user.id} members={members} />
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
        </div>
      </div>
      <Dialog open={blocker.status === "blocked"} onOpenChange={open => { if (!open) blocker.reset?.(); }}>
        <DialogContent><DialogHeader><DialogTitle>Leave Settings?</DialogTitle><DialogDescription>An unconfirmed save may still complete. Leaving discards local edits and retry controls. Review the saved settings when you return.</DialogDescription></DialogHeader><DialogFooter><Button className="min-h-11" variant="outline" onClick={() => blocker.reset?.()}>Stay</Button><Button className="min-h-11" onClick={() => blocker.proceed?.()}>Leave Settings</Button></DialogFooter></DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Shared types / helpers ─────────────────────────────────

interface SectionProps {
  orgId: string;
  slug: string;
  role: string;
  org: {
    id: string;
    name: string;
    slug: string;
    logo: string | null;
    createdAt: Date;
    metadata: string | null;
    cloud_enabled: boolean;
  };
  getSetting: (key: string, fallback?: string) => string;
  editSetting: (key: string, value: string) => void;
  saveSetting: (key: SettingChange["key"], value: string) => Promise<boolean>;
  saveCredential: (key: string, change: CredentialChange) => Promise<void>;
  members: Array<{
    id: string;
    role: string;
    createdAt: Date;
    user: { id: string; name: string; email: string; image: string | null };
  }>;
  openBilling: () => void;
  rundownPinEnabled: boolean;
}

function SectionHeader({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="mb-7 flex items-center gap-3">
      <h1 className="font-[family-name:var(--font-display)] text-2xl font-semibold tracking-tight text-board-text">
        {title}
      </h1>
      <ContextHelp title={title} description={description} />
    </div>
  );
}

function SettingsGroup({
  title,
  description,
  icon: Icon,
  children,
}: {
  title: string;
  description: string;
  icon: React.ElementType;
  children: React.ReactNode;
}) {
  return (
    <section aria-label={title} className="overflow-hidden rounded-xl border border-board-border bg-board-card/45">
      <header className="flex items-start gap-3 border-b border-board-border px-4 py-4 sm:px-5">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-fire-500/10 text-fire-500">
          <Icon className="size-4" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-board-text">{title}</h2>
          <p className="mt-0.5 text-xs leading-5 text-board-muted">{description}</p>
        </div>
      </header>
      <div className="divide-y divide-board-border/70">{children}</div>
    </section>
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
  editSetting,
  saveSetting,
  type = "text",
}: {
  settingKey: SettingChange["key"];
  placeholder?: string;
  getSetting: SectionProps["getSetting"];
  saveSetting: SectionProps["saveSetting"];
  editSetting: SectionProps["editSetting"];
  type?: string;
}) {
  const value = getSetting(settingKey);
  return (
    <input
      type={type}
      value={value}
      aria-label={settingLabel(settingKey)}
      onChange={(e) => editSetting(settingKey, e.target.value)}
      onBlur={() => saveSetting(settingKey, value)}
      placeholder={placeholder}
      className="min-h-11 w-full px-4 py-2.5 rounded-xl bg-board-bg border border-board-border text-board-text placeholder:text-board-muted/50 focus:outline-none focus:border-fire-500 transition-colors text-sm"
    />
  );
}

function SettingToggle({
  settingKey,
  label,
  getSetting,
  saveSetting,
  warning,
  defaultEnabled = false,
  description,
  row = false,
}: {
  settingKey: SettingChange["key"];
  label: string;
  getSetting: SectionProps["getSetting"];
  saveSetting: SectionProps["saveSetting"];
  warning?: string;
  defaultEnabled?: boolean;
  description?: string;
  row?: boolean;
}) {
  const savedValue = getSetting(settingKey);
  const enabled = savedValue === "true" || (savedValue === "" && defaultEnabled);
  return (
    <div className={row ? "px-4 py-3.5 sm:px-5" : undefined}>
      <div className="flex min-h-8 items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium text-board-text">{label}</p>
          {description ? (
            <p className="mt-0.5 text-xs leading-5 text-board-muted">{description}</p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => saveSetting(settingKey, enabled ? "false" : "true")}
          role="switch"
          aria-checked={enabled}
          aria-label={label}
          className="relative h-11 w-11 shrink-0 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fire-500"
        >
          <span aria-hidden="true" className={`absolute inset-x-0 top-2.5 h-6 rounded-full ${enabled ? "bg-fire-500" : "bg-board-border"}`} />
          <span
            className={`absolute left-0.5 top-3 size-5 rounded-full bg-white shadow-sm transition-transform ${
              enabled ? "translate-x-5" : ""
            }`}
          />
        </button>
      </div>
      {warning && enabled && (
        <p className="mt-2 flex items-start gap-1.5 text-xs leading-5 text-amber-400">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
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
  settingKey: SettingChange["key"];
  options: { value: string; label: string }[];
  getSetting: SectionProps["getSetting"];
  saveSetting: SectionProps["saveSetting"];
}) {
  const value = getSetting(settingKey, options[0]?.value);
  return (
    <select
      value={value}
      aria-label={settingLabel(settingKey)}
      onChange={(e) => void saveSetting(settingKey, e.target.value)}
      className="min-h-11 w-full px-4 py-2.5 rounded-xl bg-board-bg border border-board-border text-board-text focus:outline-none focus:border-fire-500 transition-colors text-sm appearance-none"
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

function OrganizationSection({
  org,
  orgId,
  role,
  getSetting,
  saveSetting,
  rundownPinEnabled,
}: SectionProps) {
  const canManageRundownPin = hasPermission(role, "settings:members");
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
          <TimezoneSetting value={getSetting("org-timezone")} onChange={value => void saveSetting("org-timezone", value)} />
        </FieldGroup>

        <FieldGroup label="Created" description="Date in UTC.">
          <div className="px-4 py-2.5 rounded-xl bg-board-bg border border-board-border text-board-muted text-sm">
            {new Date(org.createdAt).toLocaleDateString("en-CA", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })}
          </div>
        </FieldGroup>

        {canManageRundownPin ? (
          <RundownPinSettings orgId={orgId} initiallyEnabled={rundownPinEnabled} />
        ) : null}
      </div>
    </div>
  );
}

function RundownPinSettings({
  orgId,
  initiallyEnabled,
}: {
  orgId: string;
  initiallyEnabled: boolean;
}) {
  const [enabled, setEnabled] = useState(initiallyEnabled);
  const [pin, setPin] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmingDisable, setConfirmingDisable] = useState(false);
  const [message, setMessage] = useState<{
    kind: "success" | "error";
    text: string;
  } | null>(null);

  const savePin = async () => {
    setMessage(null);
    if (!/^\d{4,8}$/u.test(pin)) {
      setMessage({ kind: "error", text: "Use 4 to 8 digits." });
      return;
    }
    if (pin !== confirmation) {
      setMessage({ kind: "error", text: "The PIN entries do not match." });
      return;
    }

    setSaving(true);
    try {
      await updateRundownPinProtection({
        data: { orgId, action: "set", pin },
      });
      setEnabled(true);
      setPin("");
      setConfirmation("");
      setMessage({
        kind: "success",
        text: initiallyEnabled || enabled ? "Rundown PIN changed." : "Rundown PIN enabled.",
      });
    } catch (error) {
      setMessage({
        kind: "error",
        text: error instanceof Error ? error.message : "Could not save the rundown PIN.",
      });
    } finally {
      setSaving(false);
    }
  };

  const disablePin = async () => {
    setSaving(true);
    setMessage(null);
    try {
      await updateRundownPinProtection({ data: { orgId, action: "disable" } });
      setEnabled(false);
      setConfirmingDisable(false);
      setPin("");
      setConfirmation("");
      setMessage({ kind: "success", text: "Rundown PIN disabled." });
    } catch (error) {
      setMessage({
        kind: "error",
        text: error instanceof Error ? error.message : "Could not disable the rundown PIN.",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsGroup
      title="Rundown protection"
      description="Technical Managers can view shows and rundowns freely. The organization PIN unlocks rundown editing and live controls. Owners, administrators, and directors are not prompted."
      icon={Shield}
    >
      <div className="space-y-4 px-4 py-4 sm:px-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-board-text">Technical Manager PIN</p>
            <p className="mt-1 text-xs leading-5 text-board-muted">
              The existing PIN is never displayed. Enter a new one to {enabled ? "replace it" : "turn protection on"}.
            </p>
          </div>
          <span className={`rounded-full border px-2.5 py-1 text-xs font-medium ${
            enabled
              ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-400"
              : "border-board-border bg-board-bg text-board-muted"
          }`}>
            {enabled ? "Enabled" : "Disabled"}
          </span>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <FieldGroup label={enabled ? "New PIN" : "PIN"}>
            <input
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              value={pin}
              onChange={(event) => setPin(event.target.value.replace(/\D/gu, "").slice(0, 8))}
              placeholder="4 to 8 digits"
              className="w-full rounded-xl border border-board-border bg-board-bg px-4 py-2.5 text-board-text outline-none transition-colors placeholder:text-board-muted/50 focus:border-fire-500"
            />
          </FieldGroup>
          <FieldGroup label="Confirm PIN">
            <input
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value.replace(/\D/gu, "").slice(0, 8))}
              placeholder="Repeat PIN"
              className="w-full rounded-xl border border-board-border bg-board-bg px-4 py-2.5 text-board-text outline-none transition-colors placeholder:text-board-muted/50 focus:border-fire-500"
            />
          </FieldGroup>
        </div>

        {message ? (
          <p
            role={message.kind === "error" ? "alert" : "status"}
            className={`text-xs ${message.kind === "error" ? "text-red-400" : "text-emerald-400"}`}
          >
            {message.text}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void savePin()}
            disabled={saving || !pin || !confirmation}
            className="rounded-lg bg-fire-500 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-fire-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? "Saving..." : enabled ? "Change PIN" : "Enable PIN"}
          </button>

          {enabled && !confirmingDisable ? (
            <button
              type="button"
              onClick={() => {
                setMessage(null);
                setConfirmingDisable(true);
              }}
              disabled={saving}
              className="rounded-lg border border-board-border px-4 py-2 text-sm text-board-muted transition-colors hover:border-red-500/30 hover:bg-red-500/10 hover:text-red-400"
            >
              Disable PIN
            </button>
          ) : null}
        </div>

        {enabled && confirmingDisable ? (
          <div className="rounded-xl border border-red-500/20 bg-red-500/10 p-3">
            <p className="text-sm text-red-300">Technical Managers will return to their assigned permissions. The PIN will no longer grant editing or live controls.</p>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={() => void disablePin()}
                disabled={saving}
                className="rounded-lg bg-red-500 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
              >
                {saving ? "Disabling..." : "Confirm disable"}
              </button>
              <button
                type="button"
                onClick={() => setConfirmingDisable(false)}
                disabled={saving}
                className="rounded-lg px-3 py-2 text-xs text-board-muted hover:bg-board-border/50"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </SettingsGroup>
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

function TeamSection({ members, orgId, onInvitationDirty }: SectionProps & { onInvitationDirty: (dirty: boolean) => void }) {
  return (
    <div>
      <SectionHeader
        title="Team & Roles"
        description="Manage your organization members and roles"
      />

      <SettingsTeamInvitations orgId={orgId} onDirtyChange={onInvitationDirty} />

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

// ─── INTEGRATIONS ───────────────────────────────────────────

function IntegrationsSection({ orgId, getSetting, editSetting, saveSetting, saveCredential }: SectionProps) {
  const { user } = Route.useRouteContext();
  const chatAdapter = getSetting("chat-adapter", "native");
  const rundownAdapter = getSetting("rundown-adapter", "native");

  return (
    <div>
      <SectionHeader
        title="Integrations"
        description={"Connect external tools to ShowPilot's shared services"}
      />
      <div className="mb-8"><BridgeTargetSettings orgId={orgId} /></div>

      {/* Invite form */}
      <div className="mb-8">
        <p className="text-[10px] font-medium uppercase tracking-widest text-board-muted/50 mb-3">
          Chat gateway
        </p>
        <p className="text-xs text-board-muted mb-4">
          ShowPilot Chat is always available. External gateway:{" "}
          <span className="text-board-text font-medium capitalize">
            {chatAdapter === "native" ? "None" : chatAdapter}
          </span>
        </p>
        <div className="space-y-3">
          {/* Canonical ShowPilot chat with no external mirror */}
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
                  No external gateway
                </h3>
                <p className="text-xs text-board-muted">
                  Keep the shared ShowPilot conversation on mobile, web, and Desktop
                  without mirroring it to another platform.
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
            description="Sync one Slack channel with ShowPilot on every client"
            connected={chatAdapter === "slack"}
            onConnect={() => saveSetting("chat-adapter", "slack")}
            onDisconnect={() => saveSetting("chat-adapter", "native")}
            onTest={() => testChatConnection({ data: { orgId, platform: "slack" } })}
          >
            <div className="space-y-2">
              <FieldGroup label="Bot Token">
                <CredentialSettingInput
                  label="Slack bot token"
                  configured={Boolean(getSetting("slack-token"))}
                  save={change => saveCredential("slack-token", change)}
                  placeholder="xoxb-..."
                />
              </FieldGroup>
              <FieldGroup label="Channel ID">
                <SettingInput
                  settingKey="slack-channel"
                  placeholder="C01234ABCDE"
                  getSetting={getSetting}
                  saveSetting={saveSetting}
                  editSetting={editSetting}
                />
              </FieldGroup>
              <FieldGroup
                label="Signing Secret"
                description="Required for live inbound messages and complete Slack thread sync. Add the event URL below to your Slack app's Event Subscriptions."
              >
                <CredentialSettingInput
                  label="Slack signing secret"
                  configured={Boolean(getSetting("slack-signing-secret"))}
                  save={change => saveCredential("slack-signing-secret", change)}
                  placeholder="Slack app signing secret"
                />
              </FieldGroup>
              <div className="rounded-lg border border-board-border bg-board-bg/60 px-3 py-2">
                <p className="text-[10px] font-medium uppercase tracking-wider text-board-muted">Slack event URL</p>
                <code className="mt-1 block break-all text-[11px] text-board-text">https://showpilot.tech/api/integrations/slack/events/{orgId}</code>
                <p className="mt-1 text-[10px] leading-4 text-board-muted">Subscribe to the <code>message.channels</code> event. Use <code>message.groups</code> instead for a private channel.</p>
              </div>
            </div>
          </IntegrationCard>

          {/* Mattermost */}
          <IntegrationCard
            name="Mattermost"
            icon={<MessageSquare className="w-4 h-4" />}
            description="Sync one Mattermost channel with ShowPilot on every client"
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
                  editSetting={editSetting}
                />
              </FieldGroup>
              <FieldGroup label="Bot Token">
                <CredentialSettingInput
                  label="Mattermost token"
                  configured={Boolean(getSetting("mattermost-token"))}
                  save={change => saveCredential("mattermost-token", change)}
                  placeholder="Bot token"
                />
              </FieldGroup>
              <FieldGroup label="Channel ID">
                <SettingInput
                  settingKey="mattermost-channel"
                  placeholder="Channel ID"
                  getSetting={getSetting}
                  saveSetting={saveSetting}
                  editSetting={editSetting}
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
                <CredentialSettingInput
                  label="Teams webhook URL"
                  configured={Boolean(getSetting("teams-webhook-url"))}
                  save={change => saveCredential("teams-webhook-url", change)}
                  placeholder="https://outlook.office.com/webhook/..."
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
            description="Sync one Discord channel with ShowPilot on every client"
            connected={chatAdapter === "discord"}
            onConnect={() => saveSetting("chat-adapter", "discord")}
            onDisconnect={() => saveSetting("chat-adapter", "native")}
            onTest={() => testChatConnection({ data: { orgId, platform: "discord" } })}
          >
            <div className="space-y-2">
              <FieldGroup label="Bot Token">
                <CredentialSettingInput
                  label="Discord bot token"
                  configured={Boolean(getSetting("discord-bot-token"))}
                  save={change => saveCredential("discord-bot-token", change)}
                  placeholder="Bot token"
                />
              </FieldGroup>
              <FieldGroup label="Channel ID">
                <SettingInput
                  settingKey="discord-channel-id"
                  placeholder="Channel ID"
                  getSetting={getSetting}
                  saveSetting={saveSetting}
                  editSetting={editSetting}
                />
              </FieldGroup>
            </div>
          </IntegrationCard>
        </div>
      </div>

      {/* Invite form */}
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
                  editSetting={editSetting}
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
            description="Use the venue Bridge to connect ProPresenter and share its live slide feed."
            testLabel="Apply & test"
            connected={rundownAdapter === "propresenter"}
            onConnect={() => saveSetting("rundown-adapter", "propresenter")}
            onDisconnect={() => saveSetting("rundown-adapter", "native")}
            onTest={async () => {
              const host = getSetting("propresenter-host").trim();
              if (!host) throw new Error("Set ProPresenter host first");
              const saved = await Promise.all([
                saveSetting("propresenter-host", host),
                saveSetting("propresenter-port", getSetting("propresenter-port") || "50001"),
                saveSetting("propresenter-api-port", getSetting("propresenter-api-port") || "1025"),
              ]);
              if (saved.some(confirmed => !confirmed)) throw new Error("Settings were not confirmed. Resolve the save notice before testing ProPresenter.");
              const result = await testProPresenterConnection({ data: { orgId } });
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
                  editSetting={editSetting}
                />
              </FieldGroup>
              <FieldGroup label="Port">
                <SettingInput
                  settingKey="propresenter-port"
                  placeholder="50001"
                  getSetting={getSetting}
                  saveSetting={saveSetting}
                  editSetting={editSetting}
                />
              </FieldGroup>
              <FieldGroup label="API Port (Remote Control)">
                <SettingInput
                  settingKey="propresenter-api-port"
                  placeholder="1025"
                  getSetting={getSetting}
                  saveSetting={saveSetting}
                  editSetting={editSetting}
                />
                <p className="text-[9px] text-board-muted/40 mt-1">
                  Found in PP Preferences → Network → "Network Port". Different from Stage Display port.
                </p>
              </FieldGroup>
              <FieldGroup label="Stage Display Password">
                <CredentialSettingInput
                  label="ProPresenter password"
                  configured={Boolean(getSetting("propresenter-password"))}
                  save={change => saveCredential("propresenter-password", change)}
                  placeholder="(leave blank if none)"
                />
                <p className="text-xs text-board-muted mt-2">Save your changes, then choose Apply &amp; test to update the venue connection. Changing the password or ports reconnects ProPresenter.</p>
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
                <p className="text-[10px] font-medium text-board-muted/60 uppercase tracking-widest mb-2">Venue Bridge</p>
                <div className="px-3 py-2.5 rounded-lg bg-amber-500/5 border border-amber-500/10 mb-3">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-amber-400 mb-1">Connect from the venue computer</p>
                  <p className="text-xs text-board-muted">
                    Run <strong className="text-board-text">ShowPilot Desktop or Bridge</strong> on the same network as ProPresenter and approve its Stage Display and API ports in Settings → API. The venue computer authenticates privately and shares the slide feed with your operators.
                  </p>
                </div>
                <p className="text-[10px] font-medium text-board-muted/60 uppercase tracking-widest mb-2">Stage Display</p>
                <p className="text-xs text-board-muted/50 mb-2">
                  Stream live lyrics and scripture from ProPresenter to stage kiosk displays.
                  Show or hide the shared output here or from Rundown.
                </p>
                <ProPresenterOutputControl orgId={orgId} userId={user.id} surface="settings" enabled />
                <div className="mt-3">
                  <FieldGroup label="Default lyrics output" description="Used when loading a song cue map into Timecode.">
                    <SettingSelect
                      settingKey="lyrics-output"
                      options={[
                        { value: "both", label: "Native display + ProPresenter" },
                        { value: "native", label: "Native display only" },
                        { value: "propresenter", label: "ProPresenter only" },
                      ]}
                      getSetting={getSetting}
                      saveSetting={saveSetting}
                    />
                  </FieldGroup>
                </div>
              </div>
            </div>
          </IntegrationCard>

          {rundownAdapter === "planning-center" ? (
            <div className="rounded-xl border border-board-border bg-board-card p-4">
              <p className="text-sm text-board-text">Planning Center is unavailable. Switch to ShowPilot to manage your rundown here.</p>
              <button
                onClick={() => saveSetting("rundown-adapter", "native")}
                className="mt-3 rounded-lg bg-fire-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-fire-600"
              >
                Use ShowPilot rundown
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ─── PRODUCTION DEFAULTS ────────────────────────────────────

function ProductionSection({ orgId, slug, getSetting, editSetting, saveSetting, confidenceLayoutValue, onConfidenceLayoutApplied, onConfidenceDirtyChange }: SectionProps & { confidenceLayoutValue: string | undefined; onConfidenceLayoutApplied: (value: string | undefined) => void; onConfidenceDirtyChange: (dirty: boolean) => void }) {
  return (
    <div>
      <SectionHeader
        title="Production Defaults"
        description="Default settings for rundowns, timers, and displays"
      />
      <div className="space-y-5">
        <FieldGroup
          label="Default crew call lead (minutes)"
          description="Used only when a show does not have its own crew call time."
        >
          <SettingInput
            settingKey="default-call-lead-minutes"
            placeholder="90"
            getSetting={getSetting}
            saveSetting={saveSetting}
            type="number"
                  editSetting={editSetting}
                />
        </FieldGroup>

        <FieldGroup label="Default Countdown Duration (minutes)">
          <SettingInput
            settingKey="default-countdown-minutes"
            placeholder="5"
            getSetting={getSetting}
            saveSetting={saveSetting}
            type="number"
                  editSetting={editSetting}
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
      <ConfidenceSection orgId={orgId} slug={slug} initialValue={confidenceLayoutValue} onApplied={onConfidenceLayoutApplied} onDirtyChange={onConfidenceDirtyChange} />
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

function LowerThirdsSection({ orgId, slug, role, org, getSetting, editSetting, saveSetting }: SectionProps) {
  const [copiedUrl, setCopiedUrl] = useState(false);
  const overlayLink = useDisplayLink(slug, "overlay");

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
                  editSetting={editSetting}
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
              {overlayLink.url || (overlayLink.pending ? "Creating display link…" : "Display link unavailable")}
            </code>
            <button
              type="button"
              disabled={!overlayLink.url}
              onClick={() => {
                void overlayLink.copy().then((copied) => {
                  if (copied) { setCopiedUrl(true); setTimeout(() => setCopiedUrl(false), 2000); }
                });
              }}
              aria-label={copiedUrl ? "Overlay URL copied" : "Copy overlay URL"}
              title={copiedUrl ? "Overlay URL copied" : "Copy overlay URL"}
              className="min-h-11 min-w-11 p-2 rounded-lg text-board-muted hover:text-board-text hover:bg-board-border/50 transition-colors"
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
              {overlayLink.url && <QRCodeSVG value={overlayLink.url} size={96} />}
            </div>
            <div className="text-xs text-board-muted space-y-2">
              <p>Paste this link into OBS/vMix for clean output, or scan the QR code to open that display on another device. The monitor view adds connection status and Retry. This link expires in 8 hours.</p>
              {overlayLink.error && <p role="alert" className="text-red-300">{overlayLink.error}</p>}
              <button type="button" disabled={overlayLink.pending} onClick={overlayLink.refresh} className="min-h-11 underline">Create a fresh link</button>
              {overlayLink.errorAt !== null && <p className="text-xs text-board-muted">Last error <time dateTime={new Date(overlayLink.errorAt).toISOString()}>{new Date(overlayLink.errorAt).toLocaleTimeString()}</time></p>}
              {overlayLink.monitorUrl && <a href={overlayLink.monitorUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center px-3 text-sm text-fire-500 underline outline-none focus-visible:ring-2 focus-visible:ring-fire-500">Open overlay monitor</a>}
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

function NotificationsSection({ orgId, getSetting, saveSetting }: SectionProps) {
  const { user } = Route.useRouteContext();
  return (
    <div>
      <SectionHeader
        title="Notifications"
        description="Set organization guardrails while each member controls which categories can interrupt them."
      />
      <div className="space-y-4">
        <SettingsGroup title="Organization policy" description="Workspace owners can disable chat alerts for everyone. Personal choices still apply to every enabled category." icon={Bell}>
          <SettingToggle row settingKey="notify-app-chat" label="Allow chat notifications" description="Permit personal alerts for direct messages, mentions, invitations, and reactions." defaultEnabled getSetting={getSetting} saveSetting={saveSetting} />

        </SettingsGroup>

        <SettingsGroup title="Your notification categories" description="Choose which alerts can interrupt you." icon={Bell}>
          <div className="p-4"><NotificationPreferences orgId={orgId} userId={user.id} /></div>
        </SettingsGroup>

        <SettingsGroup title="Delivery" description="Every notification remains available in ShowPilot. Members choose which categories may also interrupt them on a device." icon={MonitorSmartphone}>
          <NotificationPolicyRow label="Personal inbox" description="All categories always appear in the ShowPilot inbox." status="Always on" />
          <NotificationPolicyRow label="Device notifications" description="Each category can send a push or Desktop alert when device permission is enabled." status="Member choice" />
          <NotificationPolicyRow label="Assignment email" description="Send or resend a crew member’s assignment email from Schedule when the roster is ready." status="From Schedule" icon={Mail} />
        </SettingsGroup>
      </div>
    </div>
  );
}

function NotificationPolicyRow({
  label,
  description,
  status,
  icon: Icon,
}: {
  label: string;
  description: string;
  status: string;
  icon?: React.ElementType;
}) {
  return (
    <div className="flex min-h-16 items-start gap-3 px-4 py-3.5 sm:px-5">
      {Icon ? (
        <Icon className="mt-0.5 size-4 shrink-0 text-board-muted" />
      ) : null}
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-board-text">{label}</p>
        <p className="mt-0.5 text-xs leading-5 text-board-muted">{description}</p>
      </div>
      <span className="shrink-0 rounded-full border border-board-border bg-board-bg/55 px-2.5 py-1 text-[10px] font-semibold text-board-muted">
        {status}
      </span>
    </div>
  );
}

// ─── API & WEBHOOKS ─────────────────────────────────────────

function ApiSection({ orgId, role, getSetting, saveCredential }: SectionProps) {
  const readEvents = useCallback((signal: AbortSignal) => getRecentWebhookEvents({ data: { orgId }, signal }), [orgId]);
  const eventsRead = useOperatorRead<WebhookEventLogItem[] | null>({
    key: orgId, initialValue: null, read: readEvents,
    errorMessage: "Could not read recent webhook events. Any displayed events are the last confirmed result.",
  });
  const webhookEvents = eventsRead.value ?? [];
  const isLoadingEvents = eventsRead.value === null && !eventsRead.error;

  return (
    <div>
      <SectionHeader
        title="API & Webhooks"
        description="Manage API keys and webhook endpoints for external integrations"
      />
      <div className="space-y-5">
        <BridgeInstallationSettings orgId={orgId} />
        {hasAnyPermission(role, ["settings:api_keys", "settings:integrations"]) && <BridgeTargetSettings orgId={orgId} />}

        {/* Webhook URL */}
        <FieldGroup
          label="Webhook URL"
          description="Incoming webhook endpoint for external triggers"
        >
          <CredentialSettingInput
                  label="Webhook URL"
                  configured={Boolean(getSetting("webhook-url"))}
                  save={change => saveCredential("webhook-url", change)}
                  placeholder="https://your-server.com/webhook"
                />
        </FieldGroup>

        {/* Recent webhook delivery history */}
        <div className="rounded-xl border border-board-border bg-board-card/50 p-4">
          <p className="text-[10px] font-medium uppercase tracking-widest text-board-muted/50 mb-3">
            Recent Webhook Events
          </p>
          <ReadFailureNotice error={eventsRead.error} refreshing={eventsRead.refreshing} retry={eventsRead.retry} label="Retry webhook events" />
          {isLoadingEvents ? (
            <div className="flex items-center justify-center gap-2 text-xs text-board-muted py-6">
              <RefreshCw className="w-3 h-3 animate-spin" />
              <span>Loading events...</span>
            </div>
          ) : eventsRead.value === null ? null : webhookEvents.length === 0 ? (
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
  const { user } = Route.useRouteContext();
  return (
    <div>
      <SectionHeader
        title="Danger Zone"
        description="Irreversible and destructive actions"
      />
      <div className="space-y-4">
        <ResetSavedGraphics orgId={org.id} orgName={org.name} userId={user.id} />

        <ClearChatHistory orgId={org.id} orgName={org.name} userId={user.id} />

        <ShowReportExport key={org.id} orgId={org.id} slug={org.slug} />

        <DeleteOrganization orgId={org.id} orgName={org.name} userId={user.id}
          onDeleted={() => { window.location.href = "/org-deleted"; }} />
      </div>
    </div>
  );
}
