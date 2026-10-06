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

export { ONBOARDING_ARCHETYPES } from "./workspace/archetypes";
import {
  ONBOARDING_ARCHETYPES,
  workspaceArchetypeLanding,
} from "./workspace/archetypes";
import type { ModuleId } from "@showpilot/shared";

export function isOnboardingArchetype(value: string): value is OnboardingArchetype {
  return ONBOARDING_ARCHETYPES.some((archetype) => archetype.id === value);
}

export function archetypeLanding(
  id: string | null | undefined,
  modules?: readonly ModuleId[],
): string {
  return workspaceArchetypeLanding(id, modules);
}

/**
 * The stored membership-metadata record for a Scene 2 selection.
 * Carries the archetype + landing route and nothing else — by design
 * there is no RBAC role in here.
 */
export function buildOnboardingRoleValue(
  archetype: OnboardingArchetype,
  modules?: readonly ModuleId[],
): string {
  return JSON.stringify({
    archetype,
    landing: archetypeLanding(archetype, modules),
  });
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
  hasWorkspaceType?: boolean;
  /** Template seed marker exists (Scene 3 done, blank included). */
  hasSeed: boolean;
  /** GO LIVE pressed. */
  completed: boolean;
}

export type OnboardingResumeDecision =
  | { kind: "scene"; scene: 1 | "1b" | 2 | 3 | 5 }
  | { kind: "redirect" };

/**
 * Where a refresh mid-wizard lands. Derived purely from server state —
 * no localStorage. Members of existing orgs (invited users, orgs created
 * outside the wizard, finished runs) are redirected to the org instead.
 * Scene 4 is a transient build animation, so a seed without completion
 * resumes at Scene 5.
 */
export function deriveResumeScene(
  input: OnboardingResumeInput,
): OnboardingResumeDecision {
  if (!input.hasOrg) return { kind: "scene", scene: 1 };
  if (!input.isOwner || !input.started || input.completed) return { kind: "redirect" };
  if (input.hasWorkspaceType === false) return { kind: "scene", scene: "1b" };
  if (!input.hasRole) return { kind: "scene", scene: 2 };
  if (!input.hasSeed) return { kind: "scene", scene: 3 };
  return { kind: "scene", scene: 5 };
}
