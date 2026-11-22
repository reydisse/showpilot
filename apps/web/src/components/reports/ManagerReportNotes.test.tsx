import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ShowReport } from "@/lib/report";
import type {
  ReportNoteWrite,
  ReportNoteWriteResult,
} from "@/lib/report-note-write";
import { ManagerReportNotes } from "./ManagerReportNotes";

const mocks = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock("@/lib/show-report-notes", () => ({ saveShowReportNote: mocks.save }));
beforeEach(() => {
  mocks.save.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const report: ShowReport = {
  generatedAt: "2026-11-07T12:00:00Z",
  showId: "show",
  serviceDate: "2026-11-07",
  organization: { id: "org", name: "Fixture", slug: "fixture" },
  summary: {
    totalItems: 0,
    completedItems: 0,
    plannedDurationMs: 0,
    finalPlayback: "stop",
    currentItemId: null,
    elapsedMs: 0,
  },
  rundown: {
    items: [],
    timer: {
      playback: "stop",
      currentItemId: null,
      elapsed: 0,
      startedAt: null,
      pausedAt: null,
      mode: "count-down",
      serverTime: 0,
    },
    stageMessage: "",
    name: "Show",
    scheduledStartTime: null,
  },
  incidents: [],
  checklist: [],
  crew: [],
  cueSheets: [],
  managerNotes: [],
  viewer: { userId: "operator", writableNoteLanes: ["pm", "tm"] },
};
function result(
  data: ReportNoteWrite,
  summary = data.summary,
  revision = 0,
): ReportNoteWriteResult {
  return {
    requestId: data.requestId,
    outcome: "applied",
    currentNote: {
      id: "note",
      showId: data.showId,
      userId: "operator",
      authorName: "Operator",
      role: data.role,
      summary,
      wins: data.wins,
      issues: data.issues,
      followUps: data.followUps,
      revision,
      createdAt: "2026-11-07T12:00:00Z",
      updatedAt: "2026-11-07T12:00:00Z",
    },
  };
}
// Each manager role is its own card; a role without a saved note opens ready to write.
const card = (role: "Production" | "Technical") =>
  within(screen.getByRole("group", { name: `${role} Manager note` }));
const edit = (value: string, role: "Production" | "Technical" = "Production") =>
  fireEvent.change(card(role).getByRole("textbox", { name: "Overall summary" }), {
    target: { value },
  });

it("keeps independent drafts for each manager role", () => {
  const onEditingChange = vi.fn();
  render(
    <ManagerReportNotes
      report={report}
      onNoteChange={vi.fn()}
      onEditingChange={onEditingChange}
    />,
  );
  edit("Production draft");
  edit("Technical draft", "Technical");
  expect(card("Production").getByDisplayValue("Production draft")).toBe(
    card("Production").getByRole("textbox", { name: "Overall summary" }),
  );
  expect(card("Technical").getByDisplayValue("Technical draft")).toBe(
    card("Technical").getByRole("textbox", { name: "Overall summary" }),
  );
  expect(card("Technical").getByText("Unsaved changes")).toBeTruthy();
  expect(mocks.save).not.toHaveBeenCalled();
  expect(onEditingChange).toHaveBeenLastCalledWith({
    dirty: true,
    unconfirmed: false,
  });
});

it("bounds a missing reply, freezes the captured draft and retries the same save", async () => {
  vi.useFakeTimers();
  mocks.save
    .mockImplementationOnce(() => new Promise(() => {}))
    .mockImplementationOnce(async ({ data }: { data: ReportNoteWrite }) =>
      result(data),
    );
  const onNoteChange = vi.fn(),
    onEditingChange = vi.fn();
  render(
    <ManagerReportNotes
      report={report}
      onNoteChange={onNoteChange}
      onEditingChange={onEditingChange}
    />,
  );
  edit("Original draft");
  fireEvent.click(card("Production").getByRole("button", { name: "Save my note" }));
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  expect(screen.getByRole("alert").textContent).toContain("Couldn't save your note.");
  expect(
    card("Production")
      .getByRole("textbox", { name: "Overall summary" })
      .matches(":disabled"),
  ).toBe(true);
  expect(mocks.save.mock.calls[0][0].signal.aborted).toBe(true);
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Retry note save" })),
  );
  expect(mocks.save.mock.calls[1][0].data).toEqual(
    mocks.save.mock.calls[0][0].data,
  );
  expect(onNoteChange).toHaveBeenCalledOnce();
  // Saved: the card shows the note read-only with an edit action.
  expect(card("Production").getByText("Original draft")).toBeTruthy();
  expect(card("Production").getByRole("button", { name: "Edit my note" })).toBeTruthy();
  expect(onEditingChange).toHaveBeenLastCalledWith({
    dirty: false,
    unconfirmed: false,
  });
});

it("preserves a conflicting draft until the operator reviews the saved version", async () => {
  mocks.save.mockImplementationOnce(
    async ({ data }: { data: ReportNoteWrite }) => ({
      ...result(data, "Newer saved note", 4),
      outcome: "conflict",
    }),
  );
  mocks.save.mockImplementationOnce(
    async ({ data }: { data: ReportNoteWrite }) =>
      result(data, data.summary, 5),
  );
  render(
    <ManagerReportNotes
      report={report}
      onNoteChange={vi.fn()}
      onEditingChange={vi.fn()}
    />,
  );
  edit("My local draft");
  await act(async () =>
    fireEvent.click(card("Production").getByRole("button", { name: "Save my note" })),
  );
  expect(screen.getByRole("alert").textContent).toContain("Newer saved note");
  expect(card("Production").getByDisplayValue("My local draft")).toBe(
    card("Production").getByRole("textbox", { name: "Overall summary" }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Keep my draft for review" }),
  );
  expect(mocks.save).toHaveBeenCalledOnce();
  await act(async () =>
    fireEvent.click(card("Production").getByRole("button", { name: "Save my note" })),
  );
  expect(mocks.save.mock.calls[1][0].data.expectedRevision).toBe(4);
  expect(mocks.save.mock.calls[1][0].data.requestId).not.toBe(
    mocks.save.mock.calls[0][0].data.requestId,
  );
});
