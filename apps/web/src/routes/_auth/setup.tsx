import { useSetupChoices } from "@/hooks/useSetupChoices";
import { SetupChoiceStatus } from "@/components/onboarding/SetupChoiceStatus";
import { parseSetupRole, setupChoiceConfirmed } from "@/lib/setup-choices-contract";
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
import { createFileRoute, redirect, useBlocker, useRouter } from "@tanstack/react-router";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
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
  const router = useRouter();
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
  const [teamVisited, setTeamVisited] = useState(initialScene === 5);
  const [teamState, setTeamState] = useState({ busy: false, saved: false });
  const [drafts, setDrafts] = useState({ organization: false, workspace: false, team: false });
  const [finished, setFinished] = useState(false);
  const [exitTarget, setExitTarget] = useState<string | null>(null);
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const navigation = useRef({ mounted: true, version: 0, leaving: false, suspended: false });
  const currentScene = useRef<SceneNumber>(initialScene);
  const workspaceDraftVersion = useRef(0);
  const workspaceRequestVersion = useRef<number | null>(null);
  useEffect(() => {
    if (choices.pending?.kind === "workspace" && choices.snapshot && setupChoiceConfirmed(choices.snapshot, choices.pending)
      && workspaceRequestVersion.current === workspaceDraftVersion.current) setDrafts(value => ({ ...value, workspace: false }));
  }, [choices.pending, choices.snapshot]);
  const unsaved = useRef(false);
  unsaved.current = drafts.organization || drafts.workspace || (drafts.team && !teamState.saved) || teamState.busy
    || Boolean(choices.pending && (!choices.snapshot || !setupChoiceConfirmed(choices.snapshot, choices.pending)))
    || Boolean(seed.requested && seed.snapshot?.status !== "saved" && seed.snapshot?.status !== "review");
  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) => {
      if (navigation.current.leaving || !unsaved.current || current.pathname === next.pathname) return false;
      navigation.current.suspended = true; navigation.current.version++;
      return true;
    },
    enableBeforeUnload: () => !navigation.current.leaving && unsaved.current,
    withResolver: true,
  });
  const exitOpen = exitTarget !== null || blocker.status === "blocked";
  navigation.current.suspended = exitOpen;

  useEffect(() => {
    identifyAnalytics(user?.id ?? user?.email);
    track("onboarding_started", { resumedAtScene: initialScene });
    // Fire once per wizard mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const transition = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    navigation.current.mounted = true;
    return () => { navigation.current.mounted = false; navigation.current.version++; if (transition.current) clearTimeout(transition.current); };
  }, []);

  const leave = (href: string) => {
    navigation.current.leaving = true; navigation.current.version++;
    if (transition.current) clearTimeout(transition.current);
    setCut(false); setNavigationError(null);
    void router.navigate({ href }).catch(() => {
      if (!navigation.current.mounted) return;
      navigation.current.leaving = false; setFlash(false);
      setNavigationError("Could not open that page. Your saved setup is kept. Try Exit setup again.");
    });
  };
  const workspaceHref = org ? `/${org.slug}${archetypeLanding(archetype, workspace.modules)}` : mode === "new" ? "/" : "/invitations";
  const currentRequest = (version: number) => navigation.current.mounted && !navigation.current.leaving && !navigation.current.suspended && navigation.current.version === version;

  // Broadcast cut between scenes: dip to black, 220ms, with a breath.
  const go = (next: SceneNumber) => {
    navigation.current.version++;
    currentScene.current = next;
    setCut(true);
    if (transition.current) clearTimeout(transition.current);
    transition.current = setTimeout(() => {
      setScene(next);
      if (next === 5) setTeamVisited(true);
      setSkip(false);
      setCut(false);
    }, 220);
  };

  return (
    <WorkspaceProvider profile={workspace}>
      <ConfirmDialog open={exitOpen} title="Exit setup?" variant="warning" confirmLabel="Exit setup" cancelLabel="Keep setting up"
        description={`Saved choices and people stay. Unsaved entries in this tab will be lost. Requests already sent may still finish. ${org ? "Resume unfinished setup from Settings → Workspace." : mode === "new" ? "You can create another organization from the workspace switcher later." : "You can return from Invitations by choosing Create your own organization."}`}
        onOpenChange={open => { if (!open) { navigation.current.suspended = false; setExitTarget(null); if (blocker.status === "blocked" && !navigation.current.leaving) blocker.reset(); } }}
        onConfirm={() => {
          navigation.current.leaving = true; navigation.current.version++;
          if (blocker.status === "blocked") blocker.proceed(); else if (exitTarget) leave(exitTarget);
        }} />
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
        <Slate scene={scene === 3 && (seed.snapshot?.status !== "empty" || seed.busy || seed.failure) ? 4 : scene} />
      </div>

        {/* Persistent header */}
        {(cut || flash) && (
          <div className="absolute inset-0 z-[9]" style={{ background: "#000" }} />
        )}

        <div className="mx-auto max-w-[760px] px-6 pb-16 pt-[108px]" onChangeCapture={() => {
          if (scene === 1) setDrafts(value => ({ ...value, organization: true }));
          if (scene === "1b") { workspaceDraftVersion.current++; setDrafts(value => ({ ...value, workspace: true })); }
          if (scene === 5) setDrafts(value => ({ ...value, team: true }));
        }}>
          <nav aria-label="Setup navigation" className="flex flex-wrap items-center justify-between gap-3 pb-2">
            {scene !== 1 && <button type="button" disabled={scene === 5 && teamState.busy && !finished} className="min-h-11 rounded-lg border border-white/20 px-4 py-2 text-sm focus-visible:outline-2 focus-visible:outline-amber-400 disabled:opacity-50"
              onClick={() => go(scene === "1b" ? 1 : scene === 2 ? "1b" : scene === 5 ? 4 : 2)}>Back</button>}
            <button type="button" className="min-h-11 rounded-lg px-4 py-2 text-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-amber-400"
              onClick={() => { navigation.current.suspended = true; navigation.current.version++; setExitTarget(workspaceHref); }}>Exit setup</button>
          </nav>
          <p className="text-sm text-slate-400">Back keeps your entries in this tab. You can exit now and resume saved progress later.</p>
          {navigationError && <p role="alert" className="mt-3 text-sm text-red-300">{navigationError}</p>}
          {scene === 1 && org && <section className="space-y-4 pt-10">
            <h1 className="text-3xl font-bold">Your organization is saved</h1><p>{org.name}</p>
            <p className="text-sm text-slate-300">You can change its name in Settings. Continuing uses this organization.</p>
            <button type="button" className="min-h-11 rounded-lg bg-amber-400 px-4 py-2 text-black focus-visible:outline-2 focus-visible:outline-offset-2" onClick={() => go("1b")}>Continue with this organization</button>
          </section>}
          {scene === 1 && !org && (
            <SceneOrgCreate
              user={user}
              additional={mode === "new"}
              canContinue={() => navigation.current.mounted && !navigation.current.leaving && !navigation.current.suspended}
              onCreated={async (created) => {
                const version = navigation.current.version;
                if (!currentRequest(version)) return;
                await navigate({ search: { orgId: created.id }, replace: true });
                if (!currentRequest(version)) return;
                setOrg(created);
                setDrafts(value => ({ ...value, organization: false }));
                go("1b");
              }}
            />
          )}
          {org && (
            <div hidden={scene !== "1b"} className="space-y-5 pt-10">
              {scene === "1b" && <SetupChoiceStatus choices={choices} step="workspace" onContinue={() => go(2)} />}
              {choices.snapshot && <WorkspacePicker busy={choices.busy}
                initial={workspace.isExplicit ? { type: workspace.type, custom: parseWorkspaceCustom(choices.snapshot.settings["workspace-custom"]) ?? undefined, modules: workspace.modules } : undefined}
                onSelect={async (type, custom, modules) => {
                  const version = navigation.current.version;
                  workspaceRequestVersion.current = workspaceDraftVersion.current;
                  const saved = await choices.workspace({ type, custom, modules });
                  if (saved) setDrafts(value => ({ ...value, workspace: false }));
                  if (saved && currentRequest(version)) {
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
                  const version = navigation.current.version;
                  if (await choices.role(selected) && currentRequest(version)) {
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
          {teamVisited && org && !finished && <div hidden={scene !== 5}>
            <SetupTeam key={org.id} orgId={org.id} onStateChange={setTeamState} onFinished={() => {
              setFinished(true);
              if (!navigation.current.mounted || navigation.current.suspended || navigation.current.leaving || currentScene.current !== 5) return;
              track("onboarding_completed", { archetype });
              setFlash(true);
              leave(workspaceHref);
            }} />
          </div>}
          {scene === 5 && finished && <section className="space-y-4 pt-8"><h1 className="text-3xl font-bold">Setup is complete</h1>
            <p>Your saved results are kept. Open your workspace when you're ready.</p>
            <button type="button" className="min-h-11 rounded-lg bg-amber-400 px-4 py-2 text-black focus-visible:outline-2 focus-visible:outline-offset-2" onClick={() => leave(workspaceHref)}>Open workspace</button></section>}
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
  canContinue,
  onCreated,
}: {
  user: { email: string; emailVerified?: boolean } | null;
  additional: boolean;
  canContinue: () => boolean;
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
  const lifetime = useRef(new AbortController());
  useEffect(() => {
    if (lifetime.current.signal.aborted) lifetime.current = new AbortController();
    const controller = lifetime.current;
    return () => controller.abort();
  }, []);

  const slug = slugOverride ?? deriveSlug(orgName);

  // Debounced live uniqueness check with inline availability indicator.
  useEffect(() => {
    const signal = lifetime.current.signal;
    latestSlug.current = slug;
    if (slug.length < 3) {
      setSlugState("idle");
      return;
    }
    setSlugState("checking");
    const id = setTimeout(async () => {
      try {
        const result = await checkOrgSlug({ data: { slug }, signal });
        if (signal.aborted || latestSlug.current !== slug) return;
        setSlugState(result.available ? "ok" : "taken");
        setSuggestion(result.suggestion);
      } catch {
        if (!signal.aborted && latestSlug.current === slug) setSlugState("idle");
      }
    }, 450);
    return () => clearTimeout(id);
  }, [slug]);

  async function handleResendVerification() {
    if (!user?.email) return;
    const signal = lifetime.current.signal;
    setSendingVerification(true);
    setError(null);
    try {
      const { error: sendError } = await authClient.sendVerificationEmail({
        email: user.email,
        callbackURL: "/verify-email",
        fetchOptions: { signal, retry: 0 },
      });
      if (signal.aborted) return;
      if (sendError) throw new Error(sendError.message);
      setVerificationSent(true);
    } catch (err) {
      if (!signal.aborted) setError(err instanceof Error ? err.message : "Failed to send email");
    } finally {
      if (!signal.aborted) setSendingVerification(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if ((!createdOrg && slugState !== "ok") || creating || needsVerification) return;
    const signal = lifetime.current.signal;
    setError(null);
    setCreating(true);
    try {
      let nextOrg = createdOrg;
      if (!nextOrg) {
        const name = orgName.trim();
        const { data: created, error: createError } = await authClient.organization.create({ name, slug, keepCurrentActiveOrganization: true, fetchOptions: { signal, retry: 0 } });
        if (signal.aborted) return;
        if (createError || !created) {
          // Keep the name and let the operator retry or choose another slug.
          throw new Error(createError?.message ?? "Could not create your organization");
        }
        nextOrg = { id: created.id, name, slug };
        setCreatedOrg(nextOrg);
      }
      if (!canContinue()) return;
      const { error: activeError } = await authClient.organization.setActive({
        organizationId: nextOrg.id,
        fetchOptions: { signal, retry: 0 },
      });
      if (signal.aborted || !canContinue()) return;
      if (activeError) throw new Error(activeError.message);

      await markOnboardingStarted({ data: { orgId: nextOrg.id }, signal });
      if (signal.aborted || !canContinue()) return;
      track("org_created", { slug: nextOrg.slug });
      await onCreated(nextOrg);
    } catch (err) {
      if (!signal.aborted) setError(err instanceof Error ? err.message : "Failed to create organization");
    } finally {
      if (!signal.aborted) setCreating(false);
    }
  }

  const ctaReady = (createdOrg !== null || slugState === "ok") && !needsVerification && !creating;

  return (
    <form className="rise" onSubmit={handleSubmit}>
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
