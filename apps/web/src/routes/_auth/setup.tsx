import { useSetupChoices } from "@/hooks/useSetupChoices";
import { SetupChoiceStatus } from "@/components/onboarding/SetupChoiceStatus";
import { parseSetupRole } from "@/lib/setup-choices-contract";
import { useOnboardingSeed } from "@/hooks/useOnboardingSeed";
import { SetupRundownResult } from "@/components/onboarding/SetupRundownResult";
import { SetupTeam } from "@/components/onboarding/SetupTeam";
import { WorkspacePicker } from "@/components/workspace/WorkspacePicker";
import { WorkspaceProvider } from "@/components/workspace/WorkspaceProvider";
import {
  parseWorkspaceCustom,
  resolveWorkspaceProfile,
  type WorkspaceProfile,
} from "@showpilot/shared";
import {
  getWorkspaceProfile,
} from "@/lib/workspace/profile";
import { archetypesForWorkspace } from "@/lib/workspace/archetypes";
import { templatesForWorkspace } from "@/lib/workspace/templates";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Building2,
  Check,
  ChevronRight,
  ClipboardList,
  Headset,
  MailWarning,
  Palette,
  SlidersHorizontal,
  Timer,
  type LucideIcon,
} from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { identifyAnalytics, track } from "@/lib/analytics";
import {
  checkOrgSlug,
  getOnboardingProgress,
  markOnboardingStarted,
} from "@/lib/onboarding";
import {
  archetypeLanding,
  isOnboardingArchetype,
  deriveResumeScene,
  type OnboardingArchetype,
} from "@/lib/onboarding-flow";
import {
  templateBadge,
  type OnboardingTemplate,
} from "@/lib/templates";

// ─────────────────────────────────────────────────────────────
// "First show in 5 minutes" — cinematic onboarding wizard.
// Five scenes, broadcast-dark, every animation ≤ 400ms, all skippable,
// reduced-motion clean. Visual reference: showpilot-onboarding-prototype.jsx.
// Progress persists server-side (appSettings) — refresh resumes the scene.
// ─────────────────────────────────────────────────────────────

export const Route = createFileRoute("/_auth/setup")({
  validateSearch: (search: Record<string, unknown>): { mode?: "new"; orgId?: string } => ({
    mode: search.mode === "new" ? "new" : undefined,
    orgId: typeof search.orgId === "string" ? search.orgId : undefined,
  }),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => {
    const progress = await getOnboardingProgress({ data: deps.mode === "new" ? { mode: "new" } : { mode: "resume", orgId: deps.orgId } });
    if (!progress.authenticated) {
      throw redirect({ to: "/login", search: { returnTo: deps.mode === "new" ? "/setup?mode=new" : undefined } });
    }
    const decision = deriveResumeScene({
      hasOrg: progress.hasOrg,
      isOwner: progress.isOwner,
      started: progress.started,
      hasRole: Boolean(progress.archetype),
      hasWorkspaceType: Boolean(progress.workspaceType),
      hasSeed: Boolean(progress.seededTemplate),
      completed: progress.completed,
    });
    if (decision.kind === "redirect" && progress.org) {
      throw redirect({ to: "/$slug", params: { slug: progress.org.slug } });
    }
    return {
      progress,
      initialWorkspace: progress.org
        ? await getWorkspaceProfile({ data: { orgId: progress.org.id } })
        : resolveWorkspaceProfile({}),
      initialScene: decision.kind === "scene" ? decision.scene : 1,
    };
  },
  component: SetupWizard,
});

// Broadcast palette — matches the approved prototype exactly.
const T = {
  stage: "#0A0B0D",
  panel: "#13151A",
  panelHover: "#191C22",
  border: "#262A32",
  text: "#E9EBEE",
  muted: "#8B919C",
  faint: "#5A6069",
  amber: "#FFB224",
  red: "#E5484D",
  green: "#3DD68C",
} as const;

const SCENE_TITLES = ["On the air", "Your role", "Pick a show", "Build", "Crew & go"] as const;

const WIZARD_CSS = `
  @keyframes spob-rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes spob-lowerThird { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes spob-pulse { 0%,100% { box-shadow: 0 0 0 0 rgba(229,72,77,.45);} 50% { box-shadow: 0 0 0 16px rgba(229,72,77,0);} }
  @keyframes spob-powerOn {
    0% { opacity: 0; transform: scale(.85); box-shadow: 0 0 0 rgba(229,72,77,0); }
    55% { opacity: 1; transform: scale(1.04); box-shadow: 0 0 90px rgba(229,72,77,.55); }
    100% { opacity: 1; transform: scale(1); box-shadow: 0 0 36px rgba(229,72,77,.3); }
  }
  @keyframes spob-vignette { from { opacity: 0; } to { opacity: 1; } }
  .spob .rise { animation: spob-rise .38s ease-out both; }
  .spob .lt { animation: spob-lowerThird .38s ease-out both; }
  .spob .pulse3 { animation: spob-pulse 2s ease-out 3; }
  .spob .powerOn { animation: spob-powerOn .4s ease-out both; }
  .spob .vig { animation: spob-vignette .4s ease-out .15s both; }
  .spob .card { transition: transform .15s ease-out, background .15s ease-out, border-color .15s ease-out; }
  .spob .card:hover { transform: translateY(-2px); background: ${T.panelHover}; border-color: #3A3F49; }
  .spob input::placeholder { color: ${T.faint}; }
  /* Everything skippable: any click/keypress jumps animations to their end state. */
  .spob[data-skip="true"] .rise, .spob[data-skip="true"] .lt {
    animation-duration: 0s !important; animation-delay: 0s !important;
  }
  @media (prefers-reduced-motion: reduce) {
    .spob .rise, .spob .lt, .spob .powerOn, .spob .vig, .spob .pulse3 { animation: none !important; }
    .spob .card, .spob .card:hover { transition: none; transform: none; }
  }
`;

// ─── Persistent timecode clock — runs through every scene ────

function Timecode() {
  // Keep the server and first client render identical. The live clock starts
  // after hydration, so locale and render timing cannot produce mismatched HTML.
  const [now, setNow] = useState<Date | null>(null);
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => {
      setNow(new Date());
      setFrame((f) => (f + 1) % 30);
    }, 33);
    return () => clearInterval(id);
  }, []);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    <div
      className="font-mono flex items-center gap-2 text-[13px] tracking-[0.14em]"
      style={{ color: T.amber }}
    >
      <span
        className="h-[7px] w-[7px] rounded-full"
        style={{ background: T.amber, boxShadow: `0 0 8px ${T.amber}` }}
      />
      {now ? `${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}:${p(frame)}` : "--:--:--:--"}
    </div>
  );
}

function Slate({ scene }: { scene: SceneNumber }) {
  return (
    <div
      className="font-mono text-[11px] uppercase tracking-[0.22em]"
      style={{ color: T.faint }}
    >
      Setup · Step {[1, "1b", 2, 3, 4, 5].indexOf(scene) + 1} of 6 ·{" "}
      {scene === "1b" ? "Workspace" : SCENE_TITLES[scene - 1]}
    </div>
  );
}

// ─── Wizard shell ────────────────────────────────────────────

type SceneNumber = 1 | "1b" | 2 | 3 | 4 | 5;

interface WizardOrg {
  id: string;
  name: string;
  slug: string;
}

const fmt = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;

function SetupWizard() {
  const { progress, initialScene, initialWorkspace } = Route.useLoaderData();
  const { mode } = Route.useSearch();
  const navigate = Route.useNavigate();
  const { user } = Route.useRouteContext() as {
    user: { id?: string; email: string; emailVerified?: boolean } | null;
  };

  const [scene, setScene] = useState<SceneNumber>(initialScene);
  const [cut, setCut] = useState(false);
  const [skip, setSkip] = useState(false);
  const [org, setOrg] = useState<WizardOrg | null>(progress.org);
  const choices = useSetupChoices(org?.id ?? null);
  const workspace = choices.snapshot ? resolveWorkspaceProfile(choices.snapshot.settings) : initialWorkspace;
  const archetype = choices.snapshot ? parseSetupRole(choices.snapshot.roleValue)?.archetype ?? null
    : typeof progress.archetype === "string" && isOnboardingArchetype(progress.archetype) ? progress.archetype : null;
  const [flash, setFlash] = useState(false);
  const seed = useOnboardingSeed(org?.id ?? null);

  useEffect(() => {
    identifyAnalytics(user?.id ?? user?.email);
    track("onboarding_started", { resumedAtScene: initialScene });
    // Fire once per wizard mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const transition = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (transition.current) clearTimeout(transition.current); }, []);

  // Broadcast cut between scenes: dip to black, 220ms, with a breath.
  const go = (next: SceneNumber) => {
    setCut(true);
    if (transition.current) clearTimeout(transition.current);
    transition.current = setTimeout(() => {
      setScene(next);
      setSkip(false);
      setCut(false);
    }, 220);
  };

  return (
    <WorkspaceProvider profile={workspace}>
      <div
      className="spob fixed inset-0 z-10 overflow-y-auto"
      data-skip={skip}
      style={{ background: T.stage, color: T.text }}
      onClickCapture={() => setSkip(true)}
      onKeyDownCapture={() => setSkip(true)}
    >
        <style>{WIZARD_CSS}</style>

        {/* Persistent header */}
        <div className="absolute inset-x-0 top-0 z-[5] flex flex-wrap items-center justify-between gap-x-6 gap-y-3 px-6 py-[18px]">
        <Timecode />
        <Slate scene={scene} />
      </div>

        {/* Persistent header */}
        {(cut || flash) && (
          <div className="absolute inset-0 z-[9]" style={{ background: "#000" }} />
        )}

        <div className="mx-auto max-w-[760px] px-6 pb-16 pt-[108px]">
          {scene === 1 && (
            <SceneOrgCreate
              user={user}
              additional={mode === "new"}
              onCreated={async (created) => {
                await navigate({ search: { orgId: created.id }, replace: true });
                setOrg(created);
                go("1b");
              }}
            />
          )}
          {scene === "1b" && org && (
            <div className="space-y-5 pt-10">
              <SetupChoiceStatus choices={choices} step="workspace" onContinue={() => go(2)} />
              {choices.snapshot && <WorkspacePicker busy={choices.busy}
                initial={workspace.isExplicit ? { type: workspace.type, custom: parseWorkspaceCustom(choices.snapshot.settings["workspace-custom"]) ?? undefined, modules: workspace.modules } : undefined}
                onSelect={async (type, custom, modules) => {
                  if (await choices.workspace({ type, custom, modules })) {
                    track("workspace_type_selected", { type });
                    go(2);
                  }
                }} />}
            </div>
          )}
          {scene === 2 && org && (
            <div className="space-y-5 pt-10">
              <SetupChoiceStatus choices={choices} step="role" onContinue={() => go(3)} />
              <SceneRole workspace={workspace} disabled={choices.busy || !choices.snapshot}
                selected={choices.pending?.kind === "role" ? choices.pending.archetype : archetype}
                onSelect={async selected => {
                  if (await choices.role(selected)) {
                    track("role_selected", { role: selected });
                    go(3);
                  }
                }} />
            </div>
          )}
          {scene === 3 && org && seed.snapshot?.status === "empty" && !seed.busy && !seed.failure && (
            <SceneTemplates workspace={workspace} onSelect={template => {
              track("template_selected", { template: template.id });
              void seed.save(template.id);
              go(4);
            }} />
          )}
          {org && (scene === 4 || (scene === 3 && (seed.snapshot?.status !== "empty" || seed.busy || seed.failure))) && (
            <SetupRundownResult seed={seed} onDone={() => go(5)} />
          )}
          {scene === 5 && org && (
            <SetupTeam key={org.id} orgId={org.id} onFinished={() => {
              track("onboarding_completed", { archetype });
              setFlash(true);
              window.location.href = `/${org.slug}${archetypeLanding(archetype, workspace.modules)}`;
            }} />
          )}
        </div>
      </div>
    </WorkspaceProvider>
  );
}

// ─── Scene 2 — Role (one question, big targets) ──────────────
// Personalization + analytics only: the selection NEVER changes the
// Better Auth RBAC role — the wizard runner stays `owner`.

const ARCHETYPE_ICONS: Record<OnboardingArchetype, LucideIcon> = {
  td: Headset,
  pm: ClipboardList,
  sm: Timer,
  cd: Palette,
  pastor: Building2,
  op: SlidersHorizontal,
};

function SceneRole({
  onSelect,
  workspace,
  disabled,
  selected,
}: {
  workspace: WorkspaceProfile;
  onSelect: (archetype: OnboardingArchetype) => void;
  disabled: boolean;
  selected: OnboardingArchetype | null;
}) {
  return (
    <div className="rise">
      <h1 className="mb-1.5 mt-10 text-[32px] font-extrabold">What's your role on the team?</h1>
      <p className="mb-7" style={{ color: T.muted }}>
        This just sets up your view — you're the owner either way.
      </p>
      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))" }}>
        {archetypesForWorkspace(workspace.type).map((archetype, i) => {
          const Icon = ARCHETYPE_ICONS[archetype.id];
          return (
            <button
              key={archetype.id}
              type="button"
              disabled={disabled}
              aria-pressed={selected === archetype.id}
              className="card rise rounded-[14px] border px-[18px] py-5 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-400 disabled:opacity-50"
              onClick={() => onSelect(archetype.id)}
              style={{
                animationDelay: `${i * 90}ms`,
                background: T.panel,
                borderColor: selected === archetype.id ? T.amber : T.border,
                color: T.text,
              }}
            >
              <Icon size={22} className="mb-3" style={{ color: T.amber }} />
              <div className="text-[15px] font-semibold">{archetype.label}</div>
              <div className="mt-[3px] text-[13px]" style={{ color: T.muted }}>
                {archetype.desc}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Scene 5 — Build your team + GO LIVE ─────────────────────
// Two distinct populations, never conflated:
//   Crew (operators)   → CrewMember records: show board only, no account.
//   App members (leads) → Better Auth invitations with real RBAC roles.

// ─── Scene 3 — Template selection (show posters) ─────────────
// Previews render client-side from the same template definitions the
// server seeds from — single source of truth.

function SceneTemplates({
  onSelect,
  workspace,
}: {
  workspace: WorkspaceProfile;
  onSelect: (template: OnboardingTemplate) => void;
}) {
  const [hoverTpl, setHoverTpl] = useState<string | null>(null);

  return (
    <div className="rise">
      <h1 className="mb-1.5 mt-10 text-[32px] font-extrabold">
        Pick your first {workspace.terms.event}.
      </h1>
      <p className="mb-7" style={{ color: T.muted }}>
        Hover a card to preview its rundown. You can change everything later.
      </p>
      <div className="grid gap-3.5" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))" }}>
        {templatesForWorkspace(workspace.type).map((template, i) => {
          const open = hoverTpl === template.id && template.items.length > 0;
          return (
            <button
              key={template.id}
              type="button"
              className="card rise rounded-2xl border p-5 text-left"
              onMouseEnter={() => setHoverTpl(template.id)}
              onMouseLeave={() => setHoverTpl(null)}
              onFocus={() => setHoverTpl(template.id)}
              onBlur={() => setHoverTpl(null)}
              onClick={() => onSelect(template)}
              style={{
                animationDelay: `${i * 90}ms`,
                background: `linear-gradient(160deg, ${T.panelHover}, ${T.panel} 60%)`,
                borderColor: T.border,
                color: T.text,
              }}
            >
              <div className="font-mono text-[10px] tracking-[0.2em]" style={{ color: T.amber }}>
                {templateBadge(template)}
              </div>
              <div className="mb-1 mt-2 text-[21px] font-extrabold tracking-[-0.01em]">
                {template.name}
              </div>
              {open && (
                <div className="mt-3 border-t pt-2.5" style={{ borderColor: T.border }}>
                  {template.items.slice(0, 5).map((item, j) => (
                    <div
                      key={item.title}
                      className="rise flex justify-between py-[3px] font-mono text-xs"
                      style={{ animationDelay: `${j * 40}ms`, color: T.muted }}
                    >
                      <span>{item.title}</span>
                      <span>{fmt(item.durationSec)}</span>
                    </div>
                  ))}
                  {template.items.length > 5 && (
                    <div className="pt-1 font-mono text-[11px]" style={{ color: T.faint }}>
                      +{template.items.length - 5} more…
                    </div>
                  )}
                </div>
              )}
              {!open && template.items.length > 0 && (
                <div className="mt-1.5 flex items-center gap-1 text-[13px]" style={{ color: T.faint }}>
                  Preview rundown <ChevronRight size={13} />
                </div>
              )}
              {template.items.length === 0 && (
                <div className="mt-1.5 text-[13px]" style={{ color: T.faint }}>
                  Empty stage. Build it your way.
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Scene 1 — "Get your show on the air" ────────────────────

type SlugState = "idle" | "checking" | "ok" | "taken";

function deriveSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 40);
}

function SceneOrgCreate({
  user,
  additional,
  onCreated,
}: {
  user: { email: string; emailVerified?: boolean } | null;
  additional: boolean;
  onCreated: (org: WizardOrg) => Promise<void>;
}) {
  const needsVerification = Boolean(user && !user.emailVerified);
  const [orgName, setOrgName] = useState("");
  const [slugOverride, setSlugOverride] = useState<string | null>(null);
  const [slugState, setSlugState] = useState<SlugState>("idle");
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createdOrg, setCreatedOrg] = useState<WizardOrg | null>(null);
  const [verificationSent, setVerificationSent] = useState(false);
  const [sendingVerification, setSendingVerification] = useState(false);
  const latestSlug = useRef("");

  const slug = slugOverride ?? deriveSlug(orgName);

  // Debounced live uniqueness check with inline availability indicator.
  useEffect(() => {
    latestSlug.current = slug;
    if (slug.length < 3) {
      setSlugState("idle");
      return;
    }
    setSlugState("checking");
    const id = setTimeout(async () => {
      try {
        const result = await checkOrgSlug({ data: { slug } });
        if (latestSlug.current !== slug) return; // stale response
        setSlugState(result.available ? "ok" : "taken");
        setSuggestion(result.suggestion);
      } catch {
        if (latestSlug.current === slug) setSlugState("idle");
      }
    }, 450);
    return () => clearTimeout(id);
  }, [slug]);

  async function handleResendVerification() {
    if (!user?.email) return;
    setSendingVerification(true);
    setError(null);
    try {
      const { error: sendError } = await authClient.sendVerificationEmail({
        email: user.email,
        callbackURL: "/verify-email",
      });
      if (sendError) throw new Error(sendError.message);
      setVerificationSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send email");
    } finally {
      setSendingVerification(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if ((!createdOrg && slugState !== "ok") || creating || needsVerification) return;
    setError(null);
    setCreating(true);
    try {
      let nextOrg = createdOrg;
      if (!nextOrg) {
        const name = orgName.trim();
        const { data: created, error: createError } = await authClient.organization.create({ name, slug });
        if (createError || !created) {
          // Keep the name and let the operator retry or choose another slug.
          throw new Error(createError?.message ?? "Could not create your organization");
        }
        nextOrg = { id: created.id, name, slug };
        setCreatedOrg(nextOrg);
      }
      const { error: activeError } = await authClient.organization.setActive({
        organizationId: nextOrg.id,
      });
      if (activeError) throw new Error(activeError.message);

      await markOnboardingStarted({ data: { orgId: nextOrg.id } });
      track("org_created", { slug: nextOrg.slug });
      await onCreated(nextOrg);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create organization");
    } finally {
      setCreating(false);
    }
  }

  const ctaReady = (createdOrg !== null || slugState === "ok") && !needsVerification && !creating;

  return (
    <form className="rise" onSubmit={handleSubmit}>
      {additional && <a href="/" className="inline-flex min-h-11 items-center text-sm underline underline-offset-4">Back to workspace</a>}
      <h1 className="mb-2.5 mt-12 text-[40px] font-extrabold leading-tight tracking-[-0.02em]">
        {additional ? "Create another organization" : <>Let's get your first show<br />on the air.</>}
      </h1>
      <p className="mb-9 text-base" style={{ color: T.muted }}>
        {additional ? "Give your new team its own workspace. Your existing organizations stay available in the switcher." : "Name your organization. Everything else takes about four minutes."}
      </p>

      {needsVerification && (
        <div
          className="mb-5 rounded-xl border px-4 py-3"
          style={{ borderColor: `${T.amber}40`, background: `${T.amber}14` }}
        >
          <div className="flex items-start gap-2.5">
            <MailWarning className="mt-0.5 h-4 w-4 shrink-0" style={{ color: T.amber }} />
            <div>
              <p className="text-sm">
                Verify your email to create an organization. We sent a link to{" "}
                <strong>{user?.email}</strong>.
              </p>
              <button
                type="button"
                onClick={handleResendVerification}
                disabled={sendingVerification || verificationSent}
                className="mt-1.5 text-sm font-medium disabled:pointer-events-none disabled:opacity-60"
                style={{ color: T.amber }}
              >
                {verificationSent
                  ? "Email sent — check your inbox"
                  : sendingVerification
                    ? "Sending..."
                    : "Resend verification email"}
              </button>
            </div>
          </div>
        </div>
      )}

      <label htmlFor="organization-name" className="mb-2 block text-sm">Organization name</label>
      <input
        id="organization-name"
        autoFocus
        readOnly={createdOrg !== null || creating}
        value={orgName}
        onChange={(e) => {
          setOrgName(e.target.value);
          setSlugOverride(null);
        }}
        placeholder="e.g. Northside Productions"
        className="w-full rounded-xl border px-5 py-[18px] text-[22px] font-medium outline-none"
        style={{ background: T.panel, borderColor: T.border, color: T.text }}
      />

      {/* Persistent header */}
      {slug.length >= 3 && (
        <div key={slug} className="lt mt-3.5 flex flex-wrap items-center gap-2.5 font-mono text-[13px]">
          <span
            className="rounded-md border px-3 py-2"
            style={{
              background: T.panel,
              borderColor: T.border,
              borderLeft: `3px solid ${slugState === "ok" ? T.green : slugState === "taken" ? T.red : T.amber}`,
              color: T.muted,
            }}
          >
            showpilot.tech/<span style={{ color: T.text }}>{slug}</span>
          </span>
          {slugState === "checking" && (
            <span style={{ color: T.faint }}>checking…</span>
          )}
          {slugState === "ok" && (
            <span className="flex items-center gap-1" style={{ color: T.green }}>
              <Check size={13} /> available
            </span>
          )}
          {slugState === "taken" && (
            <span className="flex items-center gap-1.5" style={{ color: T.red }}>
              <span
                className="inline-block h-[7px] w-[7px] rounded-full"
                style={{ background: T.red }}
              />
              taken
              {suggestion && !createdOrg && (
                <>
                  {" — try "}
                  <button
                    type="button"
                    onClick={() => setSlugOverride(suggestion)}
                    className="underline underline-offset-2"
                    style={{ color: T.text }}
                  >
                    {suggestion}
                  </button>
                </>
              )}
            </span>
          )}
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="mt-4 rounded-lg border px-3 py-2.5 text-sm"
          style={{ borderColor: `${T.red}40`, background: `${T.red}14`, color: "#FCA5A5" }}
        >
          {error}
        </div>
      )}

      <button
        type="submit"
        disabled={!ctaReady}
        className="mt-9 inline-flex items-center gap-2.5 rounded-[10px] border px-[22px] py-3.5 text-base font-semibold"
        style={{
          color: ctaReady ? T.stage : T.faint,
          background: ctaReady ? T.text : T.panel,
          borderColor: T.border,
          cursor: ctaReady ? "pointer" : "default",
        }}
      >
        {creating ? "Creating…" : createdOrg ? "Continue setup" : additional ? "Create organization" : "Build my show"} <ArrowRight size={17} />
      </button>
    </form>
  );
}
