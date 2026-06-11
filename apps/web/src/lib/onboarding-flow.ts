// ─────────────────────────────────────────────────────────────
// Pure onboarding flow logic — archetypes, landing routes, and
// wizard resume derivation. No server or React imports so both the
// wizard route and unit tests can use it directly.
// ─────────────────────────────────────────────────────────────

/**
 * Scene 2 archetypes. These are personalization + analytics only and are
 * intentionally broader than the RBAC system — selecting one NEVER touches
 * the Better Auth `role` field (the wizard runner stays `owner`).
 */
export type OnboardingArchetype = "td" | "pm" | "sm" | "cd" | "pastor" | "op";

export interface ArchetypeDef {
  id: OnboardingArchetype;
  label: string;
  desc: string;
  /** Org-relative landing path used at the end of Scene 5. */
  landing: string;
}

export const ONBOARDING_ARCHETYPES: readonly ArchetypeDef[] = [
  { id: "td", label: "Technical Director", desc: "Runs the booth", landing: "/show" },
  { id: "pm", label: "Production Manager", desc: "Plans & coordinates", landing: "/dashboard/prod-manager" },
  { id: "sm", label: "Stage Manager", desc: "Calls the show", landing: "/rundown" },
  { id: "cd", label: "Creative / Worship Dir.", desc: "Owns the content", landing: "/streaming/graphics" },
  { id: "pastor", label: "Pastor / Staff", desc: "Oversees everything", landing: "/dashboard/prod-manager" },
  { id: "op", label: "Operator / Volunteer", desc: "Runs a position", landing: "/show" },
];

export function isOnboardingArchetype(value: string): value is OnboardingArchetype {
  return ONBOARDING_ARCHETYPES.some((archetype) => archetype.id === value);
}

export function archetypeLanding(id: string | null | undefined): string {
  return ONBOARDING_ARCHETYPES.find((archetype) => archetype.id === id)?.landing ?? "/show";
}

// ─── Resume derivation ───────────────────────────────────────

export interface OnboardingResumeInput {
  hasOrg: boolean;
  /** Wizard runner is the Better Auth `owner` of the org. */
  isOwner: boolean;
  /** Org was created through the wizard (checkpoint #1 marker). */
  started: boolean;
  /** Scene 2 archetype persisted (checkpoint #2). */
  hasRole: boolean;
  /** Template seed marker exists (Scene 3 done, blank included). */
  hasSeed: boolean;
  /** GO LIVE pressed. */
  completed: boolean;
}

export type OnboardingResumeDecision =
  | { kind: "scene"; scene: 1 | 2 | 3 | 5 }
  | { kind: "redirect" };

/**
 * Where a refresh mid-wizard lands. Derived purely from server state —
 * no localStorage. Members of existing orgs (invited users, orgs created
 * outside the wizard, finished runs) are redirected to the org instead.
 * Scene 4 is a transient build animation, so a seed without completion
 * resumes at Scene 5.
 */
export function deriveResumeScene(input: OnboardingResumeInput): OnboardingResumeDecision {
  if (!input.hasOrg) return { kind: "scene", scene: 1 };
  if (!input.isOwner || !input.started || input.completed) return { kind: "redirect" };
  if (!input.hasRole) return { kind: "scene", scene: 2 };
  if (!input.hasSeed) return { kind: "scene", scene: 3 };
  return { kind: "scene", scene: 5 };
}
