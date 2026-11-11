import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
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
const edit = (value: string) =>
  fireEvent.change(screen.getByRole("textbox", { name: "Overall summary" }), {
    target: { value },
  });

it("retains independent drafts while switching between manager roles", () => {
  const onEditingChange = vi.fn();
  render(
    <ManagerReportNotes
      report={report}
      onNoteChange={vi.fn()}
      onEditingChange={onEditingChange}
    />,
  );
  edit("Production draft");
  fireEvent.click(
    screen.getByRole("button", { name: "Technical Manager note" }),
  );
  edit("Technical draft");
  fireEvent.click(
    screen.getByRole("button", { name: /Production Manager note/ }),
  );
  expect(screen.getByDisplayValue("Production draft")).toBe(
    screen.getByRole("textbox", { name: "Overall summary" }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: /Technical Manager note/ }),
  );
  expect(screen.getByDisplayValue("Technical draft")).toBe(
    screen.getByRole("textbox", { name: "Overall summary" }),
  );
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
  fireEvent.click(screen.getByRole("button", { name: "Save my notes" }));
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  expect(screen.getByRole("alert").textContent).toContain("may have completed");
  expect(
    screen
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
  expect(screen.getByDisplayValue("Original draft")).toBe(
    screen.getByRole("textbox", { name: "Overall summary" }),
  );
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
    fireEvent.click(screen.getByRole("button", { name: "Save my notes" })),
  );
  expect(screen.getByRole("alert").textContent).toContain("Newer saved note");
  expect(screen.getByDisplayValue("My local draft")).toBe(
    screen.getByRole("textbox", { name: "Overall summary" }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Keep my draft for review" }),
  );
  expect(mocks.save).toHaveBeenCalledOnce();
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Save my notes" })),
  );
  expect(mocks.save.mock.calls[1][0].data.expectedRevision).toBe(4);
  expect(mocks.save.mock.calls[1][0].data.requestId).not.toBe(
    mocks.save.mock.calls[0][0].data.requestId,
  );
});
