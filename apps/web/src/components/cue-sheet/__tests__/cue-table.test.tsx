import { fireEvent, render, screen } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CueTable } from "../cue-table";
import type { CueColumnRow, CueRow } from "@/lib/cue-sheet-derive";

const originalResizeObserver = globalThis.ResizeObserver;
const scrollHeightDescriptor = Object.getOwnPropertyDescriptor(
  HTMLTextAreaElement.prototype,
  "scrollHeight",
);

beforeAll(() => {
  class MockResizeObserver {
    observe() {}
    disconnect() {}
    unobserve() {}
  }
  globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
  Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", {
    configurable: true,
    get() {
      return this.value.length > 40 ? 96 : 30;
    },
  });
});

afterAll(() => {
  globalThis.ResizeObserver = originalResizeObserver;
  if (scrollHeightDescriptor) {
    Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", scrollHeightDescriptor);
  } else {
    Reflect.deleteProperty(HTMLTextAreaElement.prototype, "scrollHeight");
  }
});

const columns: CueColumnRow[] = [
  { id: "lighting", label: "Lighting", color: "amber", sortOrder: 0, width: 180 },
];

const rows: CueRow[] = [
  {
    itemId: "item-1",
    title: "Welcome",
    type: "segment",
    isSection: false,
    cue: "GO",
    durationMs: 60_000,
    scheduledStart: null,
    expectedEnd: null,
    status: "upcoming",
    note: "",
    assignee: "",
    notes: {},
  },
];

describe("CueTable note editor", () => {
  it("grows with wrapped note content instead of creating an internal scrollbar", () => {
    render(
      <CueTable
        rows={rows}
        columns={columns}
        hidden={new Set()}
        currentItemId={null}
        canEdit
        onNoteChange={vi.fn()}
        onWidthChange={vi.fn()}
        onReorder={vi.fn()}
      />,
    );

    const editor = screen.getByRole("textbox");
    expect(editor.style.height).toBe("30px");
    expect(editor.classList.contains("overflow-hidden")).toBe(true);

    fireEvent.change(editor, {
      target: {
        value: "This is a long lighting note that wraps across several visual lines in the cue sheet.",
      },
    });

    expect(editor.style.height).toBe("96px");

    const row = editor.closest("tr");
    const rowResizer = screen.getByRole("separator", { name: "Resize Welcome row" });
    if (!(row instanceof HTMLTableRowElement)) throw new Error("Missing cue row");
    vi.spyOn(row, "getBoundingClientRect").mockReturnValue({
      height: 96,
      width: 800,
      top: 0,
      right: 800,
      bottom: 96,
      left: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    fireEvent.pointerDown(rowResizer, { button: 0, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(rowResizer, { clientY: 180, pointerId: 1 });
    expect(row.style.height).toBe("176px");
    fireEvent.pointerUp(rowResizer, { clientY: 180, pointerId: 1 });
    expect(row.style.height).toBe("176px");
  });
});
