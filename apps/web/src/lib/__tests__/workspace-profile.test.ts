import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  WORKSPACE_TYPES,
  MODULE_IDS,
  CORE_MODULES,
  TERM_KEYS,
  DEFAULT_WORKSPACE_MODULES,
  MODULE_SURFACES,
  resolveWorkspaceType,
  resolveWorkspaceProfile,
  resolveModules,
  resolveTerms,
  legacyTerminologyProfile,
  legacyWorkspaceType,
  isWorkspaceTerm,
  workspaceCopy,
  type WorkspaceSettings,
} from "@showpilot/shared";
import {
  workspaceCommandSchema,
  writeWorkspaceProfile,
  type WorkspaceStore,
} from "../workspace/profile.server";
import {
  templatesForWorkspace,
  templateRuntimeSec,
} from "../workspace/templates";
import { deriveResumeScene, archetypeLanding } from "../onboarding-flow";
import { demoEventsForWorkspace } from "../workspace/timecode-demo";

describe("workspace compatibility", () => {
  it.each(WORKSPACE_TYPES)("explicit %s overrides legacy values", (type) => {
    expect(
      resolveWorkspaceType({
        "workspace-type": type,
        "terminology-profile": "church",
      }),
    ).toBe(type);
    expect(["general", "church"]).toContain(legacyTerminologyProfile(type));
    expect(Object.keys(resolveTerms(type)).sort()).toEqual(
      [...TERM_KEYS].sort(),
    );
  });
  it("resolves legacy and missing keys without hiding features", () => {
    expect(resolveWorkspaceType({ "terminology-profile": "general" })).toBe(
      "live_events",
    );
    expect(resolveWorkspaceType({ "terminology-profile": "church" })).toBe(
      "church",
    );
    expect(resolveWorkspaceType({})).toBe("church");
    expect(
      resolveWorkspaceType({
        "workspace-type": "future",
        "terminology-profile": "general",
      }),
    ).toBe("live_events");
    expect(resolveWorkspaceProfile({}).isExplicit).toBe(false);
    expect(resolveModules()).toEqual([...MODULE_IDS]);
    expect(resolveModules('["chat","unknown","chat"]')).toEqual([
      ...CORE_MODULES,
      "chat",
    ]);
    expect(resolveModules([])).toEqual(CORE_MODULES);
  });
  it("applies only allowed custom terms and rejects unsafe input", () => {
    const custom = {
      label: " Productions ",
      terms: {
        event: " festival ",
        events: "festivals",
        item: "Act",
        items: "Acts",
        presenter: "Unsafe override",
      },
    };
    expect(resolveTerms("custom", custom)).toMatchObject({
      event: "festival",
      eventTitle: "Festival",
      eventPlural: "Festivals",
      eventName: "Festival name",
      item: "Act",
      itemPlural: "Acts",
      presenter: "Presenter",
    });
    expect(resolveTerms("church", custom).event).toBe("service");
    for (const value of ["", " ", "<script>", "line\nbreak", "a".repeat(25)])
      expect(isWorkspaceTerm(value)).toBe(false);
    expect(
      workspaceCommandSchema.safeParse({ kind: "custom", custom }).success,
    ).toBe(false);
  });
  it("preserves non-church choices when an old binary sends general", () => {
    for (const type of WORKSPACE_TYPES) {
      expect(legacyWorkspaceType(type, "general")).toBe(
        type === "church" ? "live_events" : type,
      );
      expect(legacyWorkspaceType(type, "church")).toBe("church");
      expect(legacyWorkspaceType(type)).toBe(type);
    }
  });
  it("renders examples without duplicated nouns or church wording", () => {
    const terms = resolveTerms("theatre");
    expect(workspaceCopy("Sunday Morning Service", terms)).toBe(
      "Opening Night",
    );
    expect(workspaceCopy("Show or service title", terms)).toBe(
      "Performance title",
    );
    expect(workspaceCopy("Scan to serve", terms)).toBe("Scan to Sign In");
    expect(workspaceCopy("Covering rundown for Sunday service", terms)).toBe(
      "Covering rundown for this weekend’s performance",
    );
  });
});

function store(initial: WorkspaceSettings = {}) {
  let settings = { ...initial };
  const writes: [string, string][][] = [];
  const adapter: WorkspaceStore = {
    read: async () => settings,
    write: async (entries) => {
      writes.push(entries);
      settings = { ...settings, ...Object.fromEntries(entries) };
    },
  };
  return { adapter, writes, settings: () => settings };
}
describe("atomic workspace commands", () => {
  it.each(WORKSPACE_TYPES)(
    "initial %s writes its defaults and legacy sync together",
    async (type) => {
      const db = store();
      const profile = await writeWorkspaceProfile(db.adapter, {
        kind: "initial",
        type,
        onlyIfUnconfigured: true,
      });
      expect(db.writes).toHaveLength(1);
      expect(db.settings()["terminology-profile"]).toBe(
        legacyTerminologyProfile(type),
      );
      expect(profile.modules).toEqual(DEFAULT_WORKSPACE_MODULES[type]);
      expect(profile.isExplicit).toBe(true);
    },
  );
  it("preserves modules and custom terms unless reset was selected", async () => {
    const db = store({
      "workspace-type": "custom",
      "workspace-modules": '["chat"]',
      "workspace-custom": '{"label":"Tours","terms":{"event":"Gig"}}',
    });
    const profile = await writeWorkspaceProfile(db.adapter, {
      kind: "type",
      type: "theatre",
      resetModules: false,
    });
    expect(profile.modules).toEqual([...CORE_MODULES, "chat"]);
    expect(db.settings()["workspace-custom"]).toContain("Gig");
    await writeWorkspaceProfile(db.adapter, {
      kind: "type",
      type: "school",
      resetModules: true,
    });
    expect(JSON.parse(db.settings()["workspace-modules"]!)).toEqual(
      DEFAULT_WORKSPACE_MODULES.school,
    );
  });
  it("does not write anything for an omitted legacy field", async () => {
    const db = store({ "workspace-type": "theatre" });
    await writeWorkspaceProfile(db.adapter, { kind: "legacy" });
    expect(db.writes).toHaveLength(0);
    await writeWorkspaceProfile(db.adapter, {
      kind: "legacy",
      terminologyProfile: "general",
    });
    expect(db.settings()["workspace-type"]).toBe("theatre");
    expect(db.settings()["workspace-modules"]).toBeUndefined();
  });
  it("rejects reinitialization and names on a preset without writes", async () => {
    const db = store({ "workspace-type": "theatre" });
    await expect(
      writeWorkspaceProfile(db.adapter, {
        kind: "initial",
        type: "church",
        onlyIfUnconfigured: true,
      }),
    ).rejects.toThrow("already configured");
    await expect(
      writeWorkspaceProfile(db.adapter, {
        kind: "custom",
        custom: { label: "Test", terms: {} },
      }),
    ).rejects.toThrow("custom workspace");
    expect(db.writes).toHaveLength(0);
  });
  it("validates unknown ids before any write", () => {
    expect(
      workspaceCommandSchema.safeParse({
        kind: "type",
        type: "film",
        resetModules: false,
      }).success,
    ).toBe(false);
    expect(
      workspaceCommandSchema.safeParse({ kind: "modules", modules: ["future"] })
        .success,
    ).toBe(false);
  });
});

describe("workspace onboarding and surfaces", () => {
  const minutes: Record<string, number> = {
    keynote: 92,
    concert: 170,
    assembly: 49,
    graduation: 91,
    "two-act": 162,
    rehearsal: 145,
  };
  it.each(WORKSPACE_TYPES)("offers valid templates for %s", (type) => {
    const templates = templatesForWorkspace(type);
    expect(templates.some((t) => t.id === "blank")).toBe(true);
    expect(templates.some((t) => t.id !== "blank")).toBe(true);
    for (const template of templates)
      if (minutes[template.id]) {
        expect(templateRuntimeSec(template)).toBe(minutes[template.id] * 60);
        expect(template.checklist.length).toBeGreaterThanOrEqual(3);
        expect(template.checklist.length).toBeLessThanOrEqual(5);
      }
  });
  it("resumes the type step before an already saved role", () => {
    expect(
      deriveResumeScene({
        hasOrg: true,
        isOwner: true,
        started: true,
        completed: false,
        hasRole: true,
        hasSeed: true,
        hasWorkspaceType: false,
      }),
    ).toEqual({ kind: "scene", scene: "1b" });
    expect(archetypeLanding("cd", DEFAULT_WORKSPACE_MODULES.theatre)).toBe(
      "/show",
    );
  });
  it("maps every sidebar path exactly once without gating public routes", () => {
    const sidebar = readFileSync("src/components/layout/Sidebar.tsx", "utf8");
    const paths = [...sidebar.matchAll(/path: "([^"]+)"/g)].map(
      (match) => match[1],
    );
    const surfaces = Object.values(MODULE_SURFACES).flatMap(
      (value) => value.web,
    );
    expect(new Set(surfaces).size).toBe(surfaces.length);
    for (const path of paths)
      expect(surfaces.filter((surface) => surface === path)).toHaveLength(1);
    expect(Object.keys(MODULE_SURFACES).sort()).toEqual([...MODULE_IDS].sort());
  });
  it("has neutral demo payloads without altering church demos", () => {
    expect(JSON.stringify(demoEventsForWorkspace("church"))).toContain(
      "Psalm 95:1",
    );
    for (const type of WORKSPACE_TYPES.filter((type) => type !== "church"))
      expect(JSON.stringify(demoEventsForWorkspace(type))).not.toMatch(
        /pastor|worship|sunday|scripture|offering/i,
      );
  });
});

import { workspaceSchema } from "../../../../mobile/src/lib/workspace-schema";
it("a newer server may add types, modules and term keys without crashing this mobile binary", () => {
 const result = workspaceSchema.parse({ type: "future-type", label: null, modules: ["chat", "future-module"], terms: { ...resolveTerms("custom"), futureTerm: "Future" }, isExplicit: true });
 expect(result.type).toBe("church");
 expect(result.modules).toEqual([...CORE_MODULES, "chat"]);
 expect(result.terms).not.toHaveProperty("futureTerm");
});
it("does not translate a custom noun a second time", () => {
 const terms = resolveTerms("custom", { label: "Custom", terms: { event: "Sunday", events: "Sundays" } });
 expect(workspaceCopy("Next service", terms)).toBe("Next sunday");
 expect(workspaceCopy("Service title", terms)).toBe("Sunday title");
});
it("keeps school articles and crew activity copy grammatical", () => {
 const terms = resolveTerms("school");
 expect(workspaceCopy("Plan a service", terms)).toBe("Plan an event");
 expect(workspaceCopy("See who's serving in real time", terms)).toBe("See who's working in real time");
 expect(workspaceCopy("Check in for service.", terms)).toBe("Check in for the event.");
});
