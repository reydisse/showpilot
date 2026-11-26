/** Phases from the stage timer: normal, then amber alert, red danger, red overtime. */
export type StageTimerPhase = "normal" | "alert" | "danger" | "overtime";

export const RECEDED_TIMER_COLOR = "rgba(255,255,255,0.5)";

/**
 * Colour for the countdown when a priority message or slide takes the main space.
 * A calm countdown may recede to grey, but a warning must stay visible: the speaker
 * needs to see they are running out of time exactly when "wrap up" is on screen.
 */
export function secondaryTimerColor(phase: StageTimerPhase, phaseColor: string): string {
  return phase === "normal" ? RECEDED_TIMER_COLOR : phaseColor;
}
