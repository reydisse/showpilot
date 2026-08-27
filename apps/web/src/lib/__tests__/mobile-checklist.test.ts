import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleMobileApi,
  type MobileApiDatabase,
  type MobileApiStatement,
} from "../mobile-api.server";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  resolveAccess: vi.fn(),
}));

vi.mock("../auth", () => ({
  getAuth: () => ({ api: { getSession: mocks.getSession } }),
}));

vi.mock("../effective-access", () => ({
  resolveEffectiveAccess: mocks.resolveAccess,
}));

interface ChecklistTemplateFixture {
  id: string;
  orgId: string;
  label: string;
  category: string;
  sortOrder: number;
  createdAt: string;
}

interface ChecklistEntryFixture {
  id: string;
  orgId: string;
  templateId: string;
  showId: string;
  serviceDate: string;
  checked: boolean;
  checkedBy: string | null;
  checkedAt: string | null;
}

interface FakeState {
  templates: ChecklistTemplateFixture[];
  entries: ChecklistEntryFixture[];
  show: {
    id: string;
    orgId: string;
    serviceDate: string;
    name: string;
    scheduledStartTime: string | null;
    location: string;
    status: string;
  };
  rundownItems: Array<{
    id: string;
    title: string;
    type: "song" | "segment";
    duration: number;
    notes: string;
    assignee: string;
    cue: string;
    hardStop: boolean;
  }>;
}

function createState(): FakeState {
  return {
    templates: [{
      id: "template-camera",
      orgId: "org-1",
      label: "Camera checks",
      category: "visuals",
      sortOrder: 0,
      createdAt: "2026-08-01T10:00:00.000Z",
    }],
    entries: [{
      id: "entry-camera",
      orgId: "org-1",
      templateId: "template-camera",
      showId: "show-1",
      serviceDate: "2026-09-06",
      checked: false,
      checkedBy: null,
      checkedAt: null,
    }],
    show: {
      id: "show-1",
      orgId: "org-1",
      serviceDate: "2026-09-06",
      name: "Sunday Morning",
      scheduledStartTime: "09:30",
      location: "Main auditorium",
      status: "stopped",
    },
    rundownItems: [{
      id: "item-song",
      title: "Opening worship",
      type: "song",
      duration: 300_000,
      notes: "Lyrics and lower thirds ready",
      assignee: "Worship team",
      cue: "Band starts",
      hardStop: false,
    }],
  };
}

function fakeDatabase(state: FakeState): MobileApiDatabase {
  function statement(sql: string, params: unknown[]): MobileApiStatement {
    return {
      async first<T>() {
        if (sql.startsWith("SELECT id FROM organization WHERE id = ?")) {
          return (params[0] === "org-1" ? { id: "org-1" } : null) as T | null;
        }
        if (sql.startsWith("SELECT id FROM organization WHERE slug = ?")) return null;
        if (sql.includes("FROM rundown WHERE id = ? AND orgId = ?")) {
          return (state.show.id === params[0] && state.show.orgId === params[1] ? state.show : null) as T | null;
        }
        throw new Error(`Unhandled first query: ${sql}`);
      },
      async all<T>() {
        if (sql.includes("FROM checklist_entry e") && sql.includes("JOIN checklist_template t")) {
          const results = state.entries
            .filter((entry) => entry.orgId === params[0] && entry.showId === params[1])
            .flatMap((entry) => {
              const template = state.templates.find((candidate) => candidate.id === entry.templateId);
              return template ? [{
                ...entry,
                checked: entry.checked ? 1 : 0,
                label: template.label,
                category: template.category,
                sortOrder: template.sortOrder,
              }] : [];
            });
          return { results: results as T[] };
        }
        if (sql.includes("FROM rundown") && sql.includes("serviceDate BETWEEN")) {
          return { results: [state.show] as T[] };
        }
        if (sql.includes("SELECT id, label FROM checklist_template")) {
          return { results: state.templates.filter((template) => template.orgId === params[0]) as T[] };
        }
        if (sql.includes("SELECT templateId FROM checklist_entry")) {
          return {
            results: state.entries
              .filter((entry) => entry.orgId === params[0] && entry.showId === params[1])
              .map(({ templateId }) => ({ templateId })) as T[],
          };
        }
        if (sql.includes("FROM rundown_item WHERE orgId = ? AND showId = ?")) {
          return { results: state.rundownItems as T[] };
        }
        throw new Error(`Unhandled all query: ${sql}`);
      },
      async run() {
        if (sql.includes("INSERT OR IGNORE INTO \"checklist_template\"")) {
          const [id, orgId, label, category] = params as [string, string, string, string];
          if (state.templates.some((template) => template.id === id)) {
            return { success: true, meta: { changes: 0 } };
          }
          state.templates.push({ id, orgId, label, category, sortOrder: 0, createdAt: new Date().toISOString() });
          return { success: true, meta: { changes: 1 } };
        }
        if (sql.includes("INSERT OR IGNORE INTO \"checklist_entry\"")) {
          const [id, orgId, templateId, showId, serviceDate] = params as [string, string, string, string, string];
          if (state.entries.some((entry) => entry.orgId === orgId && entry.showId === showId && entry.templateId === templateId)) {
            return { success: true, meta: { changes: 0 } };
          }
          state.entries.push({ id, orgId, templateId, showId, serviceDate, checked: false, checkedBy: null, checkedAt: null });
          return { success: true, meta: { changes: 1 } };
        }
        if (sql.startsWith("UPDATE checklist_entry")) {
          const [checked, checkedBy, checkedAt, entryId, orgId] = params as [number, string | null, string | null, string, string];
          const entry = state.entries.find((candidate) => candidate.id === entryId && candidate.orgId === orgId);
          if (!entry) return { success: true, meta: { changes: 0 } };
          entry.checked = Boolean(checked);
          entry.checkedBy = checkedBy;
          entry.checkedAt = checkedAt;
          return { success: true, meta: { changes: 1 } };
        }
        if (sql.startsWith("DELETE FROM checklist_entry")) {
          const [entryId, orgId] = params as [string, string];
          const before = state.entries.length;
          state.entries = state.entries.filter((entry) => entry.id !== entryId || entry.orgId !== orgId);
          return { success: true, meta: { changes: before - state.entries.length } };
        }
        if (sql.startsWith("UPDATE checklist_template")) {
          const [category, templateId, orgId] = params as [string, string, string];
          const template = state.templates.find((candidate) => candidate.id === templateId && candidate.orgId === orgId);
          if (!template) return { success: true, meta: { changes: 0 } };
          template.category = category;
          return { success: true, meta: { changes: 1 } };
        }
        throw new Error(`Unhandled run query: ${sql}`);
      },
    };
  }

  return {
    prepare(sql) {
      return { bind: (...params) => statement(sql, params) };
    },
    async batch(statements) {
      return Promise.all(statements.map((item) => item.run()));
    },
  };
}

async function mobileRequest(db: MobileApiDatabase, path: string, body?: Record<string, unknown>) {
  const response = await handleMobileApi(new Request(`https://showpilot.tech${path}`, body ? {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  } : undefined), { DB: db });
  if (!response) throw new Error("Mobile API did not handle checklist route");
  return response;
}

describe("mobile checklist", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue({
      user: { id: "user-1", name: "Mobile Producer", email: "producer@example.com" },
    });
    mocks.resolveAccess.mockResolvedValue({
      role: "admin",
      permissions: ["checklist:view", "checklist:access"],
    });
  });

  it("returns one tenant-scoped show and normalizes legacy departments", async () => {
    mocks.resolveAccess.mockResolvedValue({ role: "member", permissions: ["checklist:view"] });
    const response = await mobileRequest(
      fakeDatabase(createState()),
      "/api/mobile/v1/checklist?orgId=org-1&showId=show-1",
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      canManage: false,
      show: { id: "show-1", serviceDate: "2026-09-06" },
      entries: [{ id: "entry-camera", category: "video", checked: false }],
    });
  });

  it("derives the service date from the authorized show when adding an item", async () => {
    const state = createState();
    const response = await mobileRequest(
      fakeDatabase(state),
      "/api/mobile/v1/checklist/items?orgId=org-1",
      { showId: "show-1", label: "  Test backup playback  ", category: "general", serviceDate: "2099-01-01" },
    );

    expect(response.status).toBe(201);
    expect(state.templates).toContainEqual(expect.objectContaining({ label: "Test backup playback", orgId: "org-1" }));
    expect(state.entries).toContainEqual(expect.objectContaining({ showId: "show-1", serviceDate: "2026-09-06" }));
  });

  it("attributes completion to the authenticated operator and scopes the write by organization", async () => {
    const state = createState();
    const response = await mobileRequest(
      fakeDatabase(state),
      "/api/mobile/v1/checklist/entries/entry-camera/toggle?orgId=org-1",
      { checked: true },
    );

    expect(response.status).toBe(200);
    expect(state.entries[0]).toMatchObject({ checked: true, checkedBy: "Mobile Producer" });
    expect(state.entries[0].checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("retags reusable templates and removes only the selected show entry", async () => {
    const state = createState();
    const db = fakeDatabase(state);
    const categoryResponse = await mobileRequest(
      db,
      "/api/mobile/v1/checklist/templates/template-camera/category?orgId=org-1",
      { category: "lighting" },
    );
    expect(categoryResponse.status).toBe(200);
    expect(state.templates[0].category).toBe("lighting");

    const removeResponse = await mobileRequest(
      db,
      "/api/mobile/v1/checklist/entries/entry-camera/remove?orgId=org-1",
      {},
    );
    expect(removeResponse.status).toBe(200);
    expect(state.entries).toHaveLength(0);
    expect(state.templates).toHaveLength(1);
  });

  it("reuses a matching template without duplicating an existing show entry", async () => {
    const state = createState();
    const response = await mobileRequest(
      fakeDatabase(state),
      "/api/mobile/v1/checklist/items?orgId=org-1",
      { showId: "show-1", label: "camera---checks", category: "general" },
    );
    expect(response.status).toBe(200);
    expect(state.templates).toHaveLength(1);
    expect(state.entries).toHaveLength(1);
  });

  it("re-derives smart suggestions and ignores invented client ids", async () => {
    const state = createState();
    const db = fakeDatabase(state);
    const draftResponse = await mobileRequest(
      db,
      "/api/mobile/v1/checklist/suggestions?orgId=org-1&showId=show-1",
    );
    const draft = await draftResponse.json() as { suggestions: Array<{ id: string }> };
    expect(draft.suggestions.some((suggestion) => suggestion.id === "audio-song-inputs")).toBe(true);

    const applyResponse = await mobileRequest(
      db,
      "/api/mobile/v1/checklist/suggestions/apply?orgId=org-1",
      { showId: "show-1", suggestionIds: ["invented-client-check", "audio-song-inputs"] },
    );

    expect(applyResponse.status).toBe(200);
    await expect(applyResponse.json()).resolves.toEqual({ ok: true, added: 1 });
    expect(state.templates.some((template) => template.label === "Line-check all music inputs and monitor mixes")).toBe(true);
    expect(state.templates.some((template) => template.label === "invented-client-check")).toBe(false);
  });

  it("rejects management mutations without checklist access", async () => {
    mocks.resolveAccess.mockResolvedValue({ role: "member", permissions: ["checklist:view"] });
    const response = await mobileRequest(
      fakeDatabase(createState()),
      "/api/mobile/v1/checklist/entries/entry-camera/toggle?orgId=org-1",
      { checked: true },
    );
    expect(response.status).toBe(403);
  });
});
