import { type WorkspaceType, resolveTerms } from "@showpilot/shared";
const CHURCH_SAMPLES = {
  person: { primary: "Pastor James Mensah", secondary: "Lead Pastor" },
  person2: { primary: "Akua Boateng", secondary: "Worship Leader" },
  scripture: {
    primary:
      "For I know the plans I have for you, declares the Lord, plans to prosper you and not to harm you, plans to give you hope and a future.",
    secondary: "Jeremiah 29:11 — NIV",
  },
  announcement: {
    primary: "Youth Conference 2026",
    secondary: "Register at the Welcome Desk",
  },
  song: { primary: "Way Maker", secondary: "Sinach" },
};

export function previewSamples(type: WorkspaceType) {
  if (type === "church") return CHURCH_SAMPLES;
  const terms = resolveTerms(type);
  return {
    ...CHURCH_SAMPLES,
    person: { primary: terms.presenterExample, secondary: terms.presenter },
    person2: { primary: "Akua Boateng", secondary: "Host" },
    announcement: {
      primary: terms.eventNameExample,
      secondary: "Register at the Welcome Desk",
    },
  };
}
