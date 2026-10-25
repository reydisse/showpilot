export type SignInDesign = "rhythm" | "afterglow" | "in-sync";

/** October 2026 launches with Rhythm. Calendar months use UTC everywhere. */
export function getSignInDesign(date: Date): SignInDesign {
  const monthsSinceLaunch =
    (date.getUTCFullYear() - 2026) * 12 + date.getUTCMonth() - 9;
  const index = ((monthsSinceLaunch % 3) + 3) % 3;
  return index === 0 ? "rhythm" : index === 1 ? "afterglow" : "in-sync";
}

export const signInArtworkCopy = {
  rhythm: {
    overline: "LESS FRICTION. MORE FLOW.",
    title: "Every cue.\nA little more in sync.",
    description: "A calm place to bring your next\ngreat moment together.",
  },
  afterglow: {
    overline: "THE MOMENT BEFORE THE MOMENT.",
    title: "Make room\nfor a great show.",
    description:
      "Everything you need, quietly in place.\nNow let’s bring it to life.",
  },
  "in-sync": {
    overline: "GOOD SHOWS START TOGETHER.",
    title: "Everyone ready.\nEverything in reach.",
    description:
      "From the first cue to the final moment.\nKeep your whole team connected.",
  },
} satisfies Record<
  SignInDesign,
  { overline: string; title: string; description: string }
>;
