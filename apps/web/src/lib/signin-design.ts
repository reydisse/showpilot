export type SignInDesign = "rhythm" | "afterglow" | "in-sync";

/** October 2026 launches with Rhythm. Calendar months use UTC everywhere. */
export function getSignInDesign(date: Date): SignInDesign {
  const monthsSinceLaunch =
    (date.getUTCFullYear() - 2026) * 12 + date.getUTCMonth() - 9;
  const index = ((monthsSinceLaunch % 3) + 3) % 3;
  return index === 0 ? "rhythm" : index === 1 ? "afterglow" : "in-sync";
}
