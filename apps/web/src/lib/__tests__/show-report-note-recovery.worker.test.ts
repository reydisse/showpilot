import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { seedRelayMember } from "@/test/relay-fixtures";

const auth = vi.hoisted(() => ({ userId: "" }));
vi.mock("../auth", () => ({
  getAuth: () => ({
    api: {
      getSession: async () => ({
        user: {
          id: auth.userId,
          name: "Report operator",
          email: "report@example.test",
        },
      }),
    },
  }),
}));
vi.mock("@tanstack/react-start/server", () => ({
  getRequestHeaders: () => new Headers(),
}));
vi.mock("@tanstack/react-start", () => {
  const builder = () => {
    let validate = (data: unknown) => data;
    const chain = {
      middleware: () => chain,
      inputValidator: (fn: typeof validate) => {
        validate = fn;
        return chain;
      },
      handler:
        (fn: (input: { data: unknown }) => unknown) =>
        (input: { data: unknown }) =>
          fn({ data: validate(input.data) }),
      server: () => chain,
    };
    return chain;
  };
  return {
    createServerFn: builder,
    createMiddleware: builder,
    createServerOnlyFn: <T>(fn: T): T => fn,
  };
});
import { getShowReportNotes, saveShowReportNote } from "../show-report-notes";
import { applyReportNoteWrite } from "../report-note-write.server";

async function fixture() {
  const f = await seedRelayMember(`report-note-${crypto.randomUUID()}`);
  const showId = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO rundown(id,orgId,serviceDate,name) VALUES (?,?,?,'Report fixture')",
  )
    .bind(showId, f.orgId, "2026-11-07")
    .run();
  auth.userId = f.userId;
  const request = (
    summary: string,
    expectedRevision: number | null = null,
    role: "pm" | "tm" = "pm",
  ) => ({
    orgId: f.orgId,
    showId,
    requestId: crypto.randomUUID(),
    expectedRevision,
    role,
    summary,
    wins: "",
    issues: "",
    followUps: "",
  });
  const read = () => getShowReportNotes({ data: { orgId: f.orgId, showId } });
  return { ...f, showId, request, read };
}

it("retries the original save without overwriting a newer note", async () => {
  const f = await fixture(),
    first = f.request("Original draft");
  await saveShowReportNote({ data: first });
  await saveShowReportNote({ data: f.request("Later confirmed note", 0) });
  await saveShowReportNote({ data: first });
  expect((await f.read()).notes).toMatchObject([
    { summary: "Later confirmed note" },
  ]);
});

it("rejects a changed payload under the same request identity", async () => {
  const f = await fixture(),
    first = f.request("Original draft");
  await saveShowReportNote({ data: first });
  await expect(
    saveShowReportNote({ data: { ...first, summary: "Changed retry" } }),
  ).rejects.toThrow(/different report note/i);
  expect((await f.read()).notes).toMatchObject([{ summary: "Original draft" }]);
});

it("allows only one concurrent first save for the same author and role", async () => {
  const f = await fixture();
  const actor = { id: f.userId, name: "Concurrent operator" };
  const results = await Promise.all([
    applyReportNoteWrite(env.DB, f.request("One"), actor),
    applyReportNoteWrite(env.DB, f.request("Two"), actor),
  ]);
  expect(results).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ outcome: "applied" }),
      expect.objectContaining({ outcome: "conflict" }),
    ]),
  );
  expect((await f.read()).notes).toHaveLength(1);
});

it("rejects an unseen stale revision even after the previous text returns", async () => {
  const f = await fixture();
  await saveShowReportNote({ data: f.request("Original") });
  const late = f.request("Delayed draft", 0);
  await saveShowReportNote({ data: f.request("Intermediate", 0) });
  await saveShowReportNote({ data: f.request("Original", 1) });
  expect(await saveShowReportNote({ data: late })).toMatchObject({
    outcome: "conflict",
  });
  expect((await f.read()).notes).toMatchObject([{ summary: "Original" }]);
});

it("keeps PM and TM note identities separate", async () => {
  const f = await fixture();
  await saveShowReportNote({ data: f.request("Production") });
  await saveShowReportNote({ data: f.request("Technical", null, "tm") });
  expect((await f.read()).notes).toMatchObject([
    { role: "pm", summary: "Production" },
    { role: "tm", summary: "Technical" },
  ]);
});

it("rechecks membership before a receipt can be replayed", async () => {
  const f = await fixture(),
    first = f.request("Saved");
  await saveShowReportNote({ data: first });
  await env.DB.prepare("DELETE FROM member WHERE organizationId=? AND userId=?")
    .bind(f.orgId, f.userId)
    .run();
  await expect(saveShowReportNote({ data: first })).rejects.toThrow();
});

it("rolls back the receipt when the note mutation fails", async () => {
  const f = await fixture(),
    first = f.request("Retry after storage failure");
  await env.DB.prepare(
    "CREATE TRIGGER report_note_fixture_failure BEFORE INSERT ON show_report_note BEGIN SELECT RAISE(ABORT,'fixture failure'); END",
  ).run();
  try {
    await expect(saveShowReportNote({ data: first })).rejects.toThrow();
    expect(
      await env.DB.prepare(
        "SELECT requestId FROM report_note_write_receipt WHERE orgId=? AND actorId=? AND requestId=?",
      )
        .bind(f.orgId, f.userId, first.requestId)
        .first(),
    ).toBeNull();
    expect((await f.read()).notes).toEqual([]);
  } finally {
    await env.DB.prepare("DROP TRIGGER report_note_fixture_failure").run();
  }
  expect(await saveShowReportNote({ data: first })).toMatchObject({
    outcome: "applied",
    currentNote: { summary: first.summary, revision: 0 },
  });
});

it("includes legacy edits in revision checks and retains a conflict receipt", async () => {
  const f = await fixture();
  await saveShowReportNote({ data: f.request("First") });
  await env.DB.prepare(
    "UPDATE show_report_note SET summary='Legacy edit' WHERE orgId=? AND showId=? AND userId=? AND role='pm'",
  )
    .bind(f.orgId, f.showId, f.userId)
    .run();
  const late = f.request("Old edit", 0);
  expect(await saveShowReportNote({ data: late })).toMatchObject({
    outcome: "conflict",
    currentNote: { summary: "Legacy edit", revision: 1 },
  });
  await saveShowReportNote({ data: f.request("First", 1) });
  expect(await saveShowReportNote({ data: late })).toMatchObject({
    outcome: "conflict",
    currentNote: { summary: "First", revision: 2 },
  });
});

it("scopes show access and role permission checks before writing receipts", async () => {
  const f = await fixture(),
    other = await fixture();
  auth.userId = f.userId;
  await expect(
    saveShowReportNote({
      data: { ...f.request("Cross org"), showId: other.showId },
    }),
  ).rejects.toThrow("Show not found");
  await env.DB.prepare(
    "UPDATE member SET role='pm' WHERE organizationId=? AND userId=?",
  )
    .bind(f.orgId, f.userId)
    .run();
  await expect(
    saveShowReportNote({ data: f.request("Forbidden technical", null, "tm") }),
  ).rejects.toThrow(/Technical Manager report access/);
  expect(
    await env.DB.prepare(
      "SELECT requestId FROM report_note_write_receipt WHERE orgId=?",
    )
      .bind(f.orgId)
      .first(),
  ).toBeNull();
});
