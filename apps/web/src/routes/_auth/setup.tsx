import { workspaceCopy } from "@showpilot/shared";
import { useTerms as useWorkspaceTerms } from "@/components/workspace/WorkspaceProvider";
import { WorkspacePicker } from "@/components/workspace/WorkspacePicker";
import { WorkspaceProvider } from "@/components/workspace/WorkspaceProvider";
import {
  resolveWorkspaceProfile,
  type WorkspaceProfile,
} from "@showpilot/shared";
import {
  saveWorkspaceType,
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
  Plus,
  QrCode,
  SlidersHorizontal,
  Timer,
  type LucideIcon,
} from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { identifyAnalytics, track } from "@/lib/analytics";
import {
  checkOrgSlug,
  completeOnboarding,
  getOnboardingProgress,
  markOnboardingStarted,
  saveOnboardingRole,
  seedOrgTemplate,
} from "@/lib/onboarding";
import {
  archetypeLanding,
  deriveResumeScene,
  type OnboardingArchetype,
} from "@/lib/onboarding-flow";
import { addCrewMember } from "@/lib/data";
import { inviteMember } from "@/lib/session";
import { generateMemberId } from "@/lib/import-members-csv";
import { ASSIGNABLE_ROLES, ROLE_META } from "@/lib/permissions";
import { validateSetupTeam, type SetupCrewRow, type SetupInviteRow } from "@/lib/setup-team";
import { DEPARTMENTS, getDepartment } from "@/types/index";
import {
  templateBadge,
  type OnboardingTemplate,
  type OnboardingTemplateId,
} from "@/lib/templates";
import { getTodayDateString } from "@/lib/utils";
import type { RundownItem } from "@/types/rundown";

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

interface SeedState {
  status: "idle" | "pending" | "done" | "error";
  template: OnboardingTemplateId | null;
  items: RundownItem[];
}

const fmt = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
const fmtLong = (sec: number) => {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
};

function SetupWizard() {
  const { progress, initialScene, initialWorkspace } = Route.useLoaderData();
  const { mode } = Route.useSearch();
  const navigate = Route.useNavigate();
  const { user } = Route.useRouteContext() as {
    user: { id?: string; email: string; emailVerified?: boolean } | null;
  };

  const [workspace, setWorkspace] =
    useState<WorkspaceProfile>(initialWorkspace);
  const [workspaceBusy, setWorkspaceBusy] = useState(false);
  const [workspaceError, setWorkspaceError] = useState("");
  const [scene, setScene] = useState<SceneNumber>(initialScene);
  const [cut, setCut] = useState(false);
  const [skip, setSkip] = useState(false);
  const [org, setOrg] = useState<WizardOrg | null>(progress.org);
  const [archetype, setArchetype] = useState<OnboardingArchetype | null>(
    (progress.archetype as OnboardingArchetype | null) ?? null,
  );
  const [flash, setFlash] = useState(false);
  const [seed, setSeed] = useState<SeedState>({
    status: progress.seededTemplate ? "done" : "idle",
    template: (progress.seededTemplate as OnboardingTemplateId | null) ?? null,
    items: [],
  });

  // Selecting a card kicks off the server seed; Scene 4 animates the
  // confirmed result (never fakes progressive writes).
  const startSeed = (orgId: string, template: OnboardingTemplateId) => {
    setSeed({ status: "pending", template, items: [] });
    seedOrgTemplate({
      data: { orgId, template, serviceDate: getTodayDateString() },
    })
      .then((result) => {
        track("seed_completed", { template, itemCount: result.items.length });
        setSeed({ status: "done", template, items: result.items });
      })
      .catch(() => {
        setSeed({ status: "error", template, items: [] });
      });
  };

  useEffect(() => {
    identifyAnalytics(user?.id ?? user?.email);
    track("onboarding_started", { resumedAtScene: initialScene });
    // Fire once per wizard mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Broadcast cut between scenes: dip to black, 220ms, with a breath.
  const go = (next: SceneNumber) => {
    setCut(true);
    setTimeout(() => {
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
            <div className="pt-10">
              {workspaceError && (
                <p role="alert" className="mb-4 text-red-400">
                  {workspaceError}
                </p>
              )}
              <WorkspacePicker
                busy={workspaceBusy}
                onSelect={async (type, custom, modules) => {
                  setWorkspace(
                    resolveWorkspaceProfile({
                      "workspace-type": type,
                      "workspace-custom": JSON.stringify(custom),
                      "workspace-modules": modules
                        ? JSON.stringify(modules)
                        : undefined,
                    }),
                  );
                  setWorkspaceBusy(true);
                  setWorkspaceError("");
                  try {
                    const next = await saveWorkspaceType({
                      data: { orgId: org.id, type, custom, modules },
                    });
                    setWorkspace(next);
                    track("workspace_type_selected", {
                      type,
                      moduleCount: next.modules.length,
                    });
                    go(2);
                  } catch (e) {
                    setWorkspaceError(
                      e instanceof Error
                        ? e.message
                        : "Could not save workspace. Try again.",
                    );
                  } finally {
                    setWorkspaceBusy(false);
                  }
                }}
              />
            </div>
          )}
          {scene === 2 && org && (
            <SceneRole
              workspace={workspace}
              onSelect={(selected) => {
              setArchetype(selected);
              track("role_selected", { role: selected });
              // Optimistic: advance on tap, persist in the background.
              // A failed write just means a refresh re-asks the question.
              void saveOnboardingRole({ data: { orgId: org.id, archetype: selected } }).catch(
                () => {},
              );
              go(3);
            }}
            />
          )}
          {scene === 3 && org && (
            <SceneTemplates
              workspace={workspace}
              onSelect={(template) => {
              track("template_selected", { template: template.id });
              startSeed(org.id, template.id);
              go(4);
            }}
            />
          )}
          {scene === 4 && org && (
          <SceneBuild
            seed={seed}
            onRetry={() => seed.template && startSeed(org.id, seed.template)}
            onDone={() => go(5)}
          />
        )}
          {scene === 5 && org && (
            <SceneTeam
              onGoLive={async ({ crew, invites }) => {
                const used = new Set<string>();
                const work: Promise<unknown>[] = [];
                for (const row of crew) {
                work.push(
                  addCrewMember({
                    data: {
                      orgId: org.id,
                      memberId: generateMemberId(row.name, used),
                      name: row.name,
                      role: row.pos,
                    },
                  }),
                );
              }
                for (const row of invites) {
                work.push(
                  inviteMember({
                    data: { orgId: org.id, email: row.email, role: row.role },
                  }),
                );
              }
                if (crew.length > 0) track("crew_added", { count: crew.length });
                if (invites.length > 0) track("invite_sent", { count: invites.length });
                track("went_live", { archetype });

                setFlash(true); // the "take" — brief dip to black
                const landing = `/${org.slug}${archetypeLanding(archetype, workspace.modules)}`;
                await Promise.allSettled(work);
                await completeOnboarding({ data: { orgId: org.id } }).catch(() => {});
                // ON AIR flash ≤ 400ms, then land on the role-based route.
                // Full reload picks up the new org session context.
                setTimeout(() => {
                window.location.href = landing;
              }, 260);
              }}
            />
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
}: {
  workspace: WorkspaceProfile;
  onSelect: (archetype: OnboardingArchetype) => void;
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
              className="card rise rounded-[14px] border px-[18px] py-5 text-left"
              onClick={() => onSelect(archetype.id)}
              style={{
                animationDelay: `${i * 90}ms`,
                background: T.panel,
                borderColor: T.border,
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

const inputStyle = {
  background: T.stage,
  borderColor: T.border,
  color: T.text,
} as const;

function SceneTeam({
  onGoLive,
}: {
  onGoLive: (team: { crew: SetupCrewRow[]; invites: SetupInviteRow[] }) => Promise<void>;
}) {
  const workspaceTerms = useWorkspaceTerms();
  const [crew, setCrew] = useState<SetupCrewRow[]>([{ name: "", pos: "" }]);
  const [invites, setInvites] = useState<SetupInviteRow[]>([{ email: "", role: "member" }]);
  const [taking, setTaking] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const validation = validateSetupTeam(crew, invites);
  const issueFor = (field: string) => submitted ? validation.issues.find(issue => issue.field === field) : undefined;
  const fieldProps = (field: string) => ({
    id: field, disabled: taking,
    "aria-invalid": Boolean(issueFor(field)),
    "aria-describedby": issueFor(field) ? `${field}-error` : undefined,
  });
  const fieldError = (field: string) => issueFor(field) && (
    <p id={`${field}-error`} className="mt-1 text-sm text-red-300">{issueFor(field)?.message}</p>
  );
  const inputClass = "min-h-11 w-full min-w-0 rounded-lg border px-3 py-2.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-400 disabled:opacity-60";
  const rowActionClass = "mt-2 inline-flex min-h-11 items-center gap-1.5 rounded-lg px-3 text-sm text-slate-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-400 disabled:opacity-60";
  const handleGoLive = () => {
    if (taking) return;
    setSubmitted(true);
    if (validation.issues.length) {
      document.getElementById(validation.issues[0].field)?.focus();
      return;
    }
    setTaking(true);
    void onGoLive({ crew: validation.crew, invites: validation.invites });
  };

  return (
    <form className="rise" noValidate onSubmit={event => { event.preventDefault(); handleGoLive(); }}>
      <h1 className="mb-1.5 mt-9 text-[30px] font-extrabold">Build your team.</h1>
      <p className="mb-[26px]" style={{ color: T.muted }}>
        Crew appear on your status board. Invited members can sign in. Both are optional for now.
      </p>
      {submitted && validation.invalidRows > 0 && (
        <div role="alert" className="mb-5 rounded-xl border border-red-400/40 bg-red-400/10 p-4 text-sm text-red-200">
          <p className="font-semibold">{validation.invalidRows} {validation.invalidRows === 1 ? "row needs" : "rows need"} attention.</p>
          <p>Nothing has been sent. Complete or clear the marked rows before finishing setup.</p>
        </div>
      )}
      <div className="grid min-w-0 gap-3.5 sm:grid-cols-2">
        <section aria-labelledby="setup-crew-title" className="min-w-0 rounded-[14px] border p-4 sm:p-[22px]" style={{ background: T.panel, borderColor: T.border }}>
          <h2 id="setup-crew-title" className="text-base font-bold">Add your crew</h2>
          <p className="mb-3.5 mt-1 text-[13px]" style={{ color: T.muted }}>
            People who appear on the board and check in on show day. No account or login is created.
          </p>
          {crew.map((row, i) => {
            const dept = row.pos.trim() ? getDepartment(row.pos) : null;
            const deptConfig = dept ? DEPARTMENTS[dept] : null;
            return (
              <fieldset key={i} disabled={taking} className="mb-4 min-w-0 border-b pb-3" style={{ borderColor: T.border }}>
                <legend className="mb-2 text-sm font-semibold">Crew {i + 1}</legend>
                <label htmlFor={`crew-${i}-name`} className="mb-1 block text-sm">Crew {i + 1} name</label>
                <input {...fieldProps(`crew-${i}-name`)} value={row.name}
                  onChange={e => setCrew(crew.map((v, j) => j === i ? { ...v, name: e.target.value } : v))}
                  placeholder="Name" autoComplete="off" className={inputClass} style={inputStyle} />
                {fieldError(`crew-${i}-name`)}
                <label htmlFor={`crew-${i}-pos`} className="mb-1 mt-3 block text-sm">Crew {i + 1} position</label>
                <input {...fieldProps(`crew-${i}-pos`)} value={row.pos}
                  onChange={e => setCrew(crew.map((v, j) => j === i ? { ...v, pos: e.target.value } : v))}
                  placeholder="Position (e.g. Camera 2, A1)" autoComplete="off" className={inputClass} style={inputStyle} />
                {fieldError(`crew-${i}-pos`)}
                {deptConfig && <div className={`mt-2 text-xs ${deptConfig.color}`}>{deptConfig.label}</div>}
                <button type="button" className={rowActionClass} aria-label={`Clear crew row ${i + 1}`}
                  onClick={() => setCrew(crew.map((v, j) => j === i ? { name: "", pos: "" } : v))}>Clear row</button>
              </fieldset>
            );
          })}
          {crew.length < 4 && <button type="button" disabled={taking} className={rowActionClass}
            onClick={() => setCrew([...crew, { name: "", pos: "" }])}><Plus size={14} /> Add another crew member</button>}
          <div className="mt-3.5 flex items-center gap-2 border-t pt-3 text-xs" style={{ borderColor: T.border, color: T.muted }}>
            <QrCode size={14} className="shrink-0" style={{ color: T.amber }} />
            {workspaceCopy('On show day, your board shows a "Scan to Serve" code. Crew check in from their phones.', workspaceTerms)}
          </div>
        </section>
        <section aria-labelledby="setup-invites-title" className="min-w-0 rounded-[14px] border p-4 sm:p-[22px]" style={{ background: T.panel, borderColor: T.border }}>
          <h2 id="setup-invites-title" className="text-base font-bold">Invite your leads</h2>
          <p className="mb-3.5 mt-1 text-[13px]" style={{ color: T.muted }}>People who log in to run rundowns, devices, and dashboards.</p>
          {invites.map((row, i) => (
            <fieldset key={i} disabled={taking} className="mb-4 min-w-0 border-b pb-3" style={{ borderColor: T.border }}>
              <legend className="mb-2 text-sm font-semibold">Invitation {i + 1}</legend>
              <label htmlFor={`invite-${i}-email`} className="mb-1 block text-sm">Invitation {i + 1} email</label>
              <input {...fieldProps(`invite-${i}-email`)} value={row.email}
                onChange={e => setInvites(invites.map((v, j) => j === i ? { ...v, email: e.target.value } : v))}
                placeholder="name@example.com" type="email" autoComplete="off" className={inputClass} style={inputStyle} />
              {fieldError(`invite-${i}-email`)}
              <label htmlFor={`invite-${i}-role`} className="mb-1 mt-3 block text-sm">Invitation {i + 1} role</label>
              <select {...fieldProps(`invite-${i}-role`)} value={row.role}
                onChange={e => {
                  const role = ASSIGNABLE_ROLES.find(role => role === e.target.value);
                  if (role) setInvites(invites.map((v, j) => j === i ? { ...v, role } : v));
                }} className={inputClass} style={inputStyle}>
                {ASSIGNABLE_ROLES.map(role => <option key={role} value={role}>{ROLE_META[role].label}</option>)}
              </select>
              {fieldError(`invite-${i}-role`)}
              <p className="mt-1 text-xs" style={{ color: T.muted }}>{ROLE_META[row.role].description}</p>
              <button type="button" className={rowActionClass} aria-label={`Clear invitation row ${i + 1}`}
                onClick={() => setInvites(invites.map((v, j) => j === i ? { email: "", role: "member" } : v))}>Clear row</button>
            </fieldset>
          ))}
          {invites.length < 3 && <button type="button" disabled={taking} className={rowActionClass}
            onClick={() => setInvites([...invites, { email: "", role: "member" }])}><Plus size={14} /> Add another invitation</button>}
        </section>
      </div>
      <div className="mt-8 space-y-3">
        <p role="status" className="text-sm" style={{ color: T.muted }}>
          {validation.crew.length} complete crew {validation.crew.length === 1 ? "row" : "rows"} and {validation.invites.length} complete invitation {validation.invites.length === 1 ? "row" : "rows"}.
        </p>
        <p className="text-sm" style={{ color: T.muted }}>Finish setup saves these people and opens your workspace. It does not start a show or turn on outputs.</p>
        <button type="submit" disabled={taking} className="inline-flex min-h-11 items-center gap-2 rounded-xl px-5 py-3 font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-amber-400 disabled:opacity-60"
          style={{ background: T.amber, color: T.stage }}>{taking ? "Finishing setup…" : "Finish setup"}<ArrowRight size={17} /></button>
      </div>
    </form>
  );
}

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

// ─── Scene 4 — THE HERO MOMENT: the rundown builds itself ────
// The cascade animates already-confirmed server data — items render
// only after the seed responds; nothing fakes progressive writes.

function SceneBuild({
  seed,
  onRetry,
  onDone,
}: {
  seed: SeedState;
  onRetry: () => void;
  onDone: () => void;
}) {
  const [builtCount, setBuiltCount] = useState(0);
  const [armed, setArmed] = useState(false);
  const skipRef = useRef(false);

  const items = seed.status === "done" ? seed.items : [];
  const isBlank = seed.status === "done" && items.length === 0;

  // Cascade: one item every 240ms once the server confirms; click or
  // keypress anywhere jumps straight to the armed end state.
  useEffect(() => {
    if (seed.status !== "done") return;
    setBuiltCount(0);
    setArmed(false);
    skipRef.current = false;
    if (items.length === 0) {
      setArmed(true);
      return;
    }
    let i = 0;
    const id = setInterval(() => {
      if (skipRef.current) {
        setBuiltCount(items.length);
        setArmed(true);
        clearInterval(id);
        return;
      }
      i += 1;
      setBuiltCount(i);
      if (i >= items.length) {
        clearInterval(id);
        setTimeout(() => setArmed(true), 650);
      }
    }, 240);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed.status]);

  useEffect(() => {
    const jump = () => {
      skipRef.current = true;
    };
    window.addEventListener("click", jump);
    window.addEventListener("keydown", jump);
    return () => {
      window.removeEventListener("click", jump);
      window.removeEventListener("keydown", jump);
    };
  }, []);

  const builtTotalSec = Math.round(
    items.slice(0, builtCount).reduce((total, item) => total + item.duration, 0) / 1000,
  );

  return (
    <div className="rise">
      <h1 className="mb-5 mt-9 text-[28px] font-extrabold">
        {isBlank
          ? "The stage is yours."
          : armed
            ? "Your show is built."
            : "Building your show…"}
      </h1>

      {seed.status === "error" && (
        <div
          className="flex items-center justify-between rounded-xl border px-4 py-3 text-sm"
          style={{ borderColor: `${T.red}40`, background: `${T.red}14` }}
        >
          <span style={{ color: "#FCA5A5" }}>
            Couldn't build your show — your org is fine, the rundown just didn't seed.
          </span>
          <button
            type="button"
            onClick={onRetry}
            className="ml-4 shrink-0 rounded-lg border px-3 py-1.5 font-semibold"
            style={{ borderColor: T.border, background: T.panel, color: T.text }}
          >
            Retry
          </button>
        </div>
      )}

      {items.length > 0 && (
        <div className="overflow-hidden rounded-[14px] border" style={{ background: T.panel, borderColor: T.border }}>
          {items.slice(0, builtCount).map((item, i) => (
            <div
              key={item.id}
              className="rise flex items-center justify-between border-b px-[18px] py-[11px]"
              style={{ borderColor: T.border }}
            >
              <span className="flex items-baseline gap-3.5">
                <span className="font-mono text-[11px]" style={{ color: T.faint }}>
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className="text-[15px] font-medium">{item.title}</span>
              </span>
              <span className="font-mono text-[13px]" style={{ color: T.muted }}>
                {fmt(Math.round(item.duration / 1000))}
              </span>
            </div>
          ))}
          <div className="flex justify-between px-[18px] py-[13px] font-mono text-[13px]">
            <span className="tracking-[0.15em]" style={{ color: T.faint }}>
              TOTAL RUNTIME
            </span>
            <span style={{ color: armed ? T.green : T.amber }}>{fmtLong(builtTotalSec)}</span>
          </div>
        </div>
      )}

      {armed && (
        <div className="rise mt-[22px] flex items-center justify-between">
          <div
            className="flex items-center gap-2 font-mono text-xs tracking-[0.2em]"
            style={{ color: T.green }}
          >
            <span className="h-[7px] w-[7px] rounded-full" style={{ background: T.green }} />
            SHOW CLOCK ARMED
          </div>
          <button
            type="button"
            onClick={onDone}
            className="inline-flex items-center gap-2.5 rounded-[10px] px-5 py-[13px] text-base font-semibold"
            style={{ background: T.text, color: T.stage }}
          >
            Get your team in <ArrowRight size={17} />
          </button>
        </div>
      )}
      {!armed && seed.status !== "error" && (
        <p className="mt-3.5 font-mono text-xs" style={{ color: T.faint }}>
          click anywhere to skip
        </p>
      )}
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
