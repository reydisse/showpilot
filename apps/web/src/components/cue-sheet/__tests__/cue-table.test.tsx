import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CueTable } from "../cue-table";
import type { CueColumnRow, CueRow } from "@/lib/cue-sheet-derive";

afterEach(cleanup);

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
    expect(editor.style.height).toBe("44px");
    expect(editor.getAttribute("maxlength")).toBe("2000");
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


it("compares an edit with the note seen on focus even if another operator changes it", () => {
  const onNoteChange = vi.fn();
  const props = { columns, hidden: new Set<string>(), currentItemId: null, canEdit: true, onNoteChange, onWidthChange: vi.fn(), onReorder: vi.fn() };
  const { rerender } = render(<CueTable {...props} rows={[{ ...rows[0], notes: { lighting: "Original" } }]} />);
  const editor = screen.getByRole("textbox");
  fireEvent.focus(editor); fireEvent.change(editor, { target: { value: "My edit" } });
  rerender(<CueTable {...props} rows={[{ ...rows[0], notes: { lighting: "Other operator" } }]} />);
  expect((editor as HTMLTextAreaElement).value).toBe("My edit");
  fireEvent.blur(editor);
  expect(onNoteChange).toHaveBeenCalledExactlyOnceWith("item-1", "lighting", "My edit", "Original");
});

it("does not save an escaped edit or offer column writes to a note-only operator", () => {
  const onNoteChange = vi.fn();
  render(<CueTable rows={rows} columns={columns} hidden={new Set()} currentItemId={null} canEdit canManageColumns={false} onNoteChange={onNoteChange} onWidthChange={vi.fn()} onReorder={vi.fn()} />);
  const editor = screen.getByRole("textbox");
  fireEvent.focus(editor); fireEvent.change(editor, { target: { value: "Discard me" } });
  fireEvent.keyDown(editor, { key: "Escape" }); fireEvent.blur(editor);
  expect(onNoteChange).not.toHaveBeenCalled();
  expect(screen.queryByRole("separator", { name: "Resize column" })).toBeNull();
  expect(screen.queryByRole("button", { name: /Move Lighting column/ })).toBeNull();
});

it("saves once on Enter, moves down, and moves between departments with Tab", () => {
  const onNoteChange = vi.fn();
  render(<CueTable rows={[rows[0], { ...rows[0], itemId: "item-2", title: "Message" }]} columns={[columns[0], { ...columns[0], id: "sound", label: "Sound" }]} hidden={new Set()} currentItemId={null} canEdit onNoteChange={onNoteChange} onWidthChange={vi.fn()} onReorder={vi.fn()} />);
  const first = screen.getByRole("textbox", { name: "Edit Lighting: Welcome" });
  first.focus(); fireEvent.change(first, { target: { value: "Lights up" } });
  fireEvent.keyDown(first, { key: "Enter" });
  expect(onNoteChange).toHaveBeenCalledExactlyOnceWith("item-1", "lighting", "Lights up", "");
  expect(document.activeElement).toBe(screen.getByRole("gridcell", { name: "Lighting: Message" }));
  fireEvent.keyDown(document.activeElement!, { key: "Enter" });
  expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Edit Lighting: Message" }));
  fireEvent.keyDown(document.activeElement!, { key: "Tab" });
  expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Edit Sound: Message" }));
  fireEvent.keyDown(document.activeElement!, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Edit Lighting: Message" }));
});

it("keeps collapsed departments out of keyboard navigation without losing their notes", () => {
  const multi = [columns[0], { ...columns[0], id: "production", label: "Production" }, { ...columns[0], id: "sound", label: "Sound" }];
  const props = { rows: [{ ...rows[0], notes: { production: "Hold entrance" } }], columns: multi, hidden: new Set<string>(), currentItemId: null, canEdit: true, onNoteChange: vi.fn(), onWidthChange: vi.fn(), onReorder: vi.fn() };
  const { rerender } = render(<CueTable {...props} collapsed={new Set(["production"])} onCollapse={vi.fn()} />);
  const lighting = screen.getByRole("gridcell", { name: "Lighting: Welcome" });
  lighting.focus(); fireEvent.keyDown(lighting, { key: "ArrowRight" });
  expect(document.activeElement).toBe(screen.getByRole("gridcell", { name: "Sound: Welcome" }));
  expect(screen.queryByRole("textbox", { name: "Edit Production: Welcome" })).toBeNull();
  rerender(<CueTable {...props} collapsed={new Set()} />);
  expect((screen.getByRole("textbox", { name: "Edit Production: Welcome" }) as HTMLTextAreaElement).value).toBe("Hold entrance");
});

it("keeps a department's identity colour on its edge and offers personal focus and sizing", () => {
  const onWidthChange = vi.fn(), onFocusDepartment = vi.fn();
  render(<CueTable rows={rows} columns={columns} hidden={new Set()} currentItemId={null} canEdit={false} canManageColumns={false} canAdjustLayout onFocusDepartment={onFocusDepartment} onNoteChange={vi.fn()} onWidthChange={onWidthChange} onReorder={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Focus Lighting" }));
  expect(onFocusDepartment).toHaveBeenCalledExactlyOnceWith("lighting");
  fireEvent.keyDown(screen.getByRole("separator", { name: "Resize Lighting column" }), { key: "ArrowRight" });
  expect(onWidthChange).toHaveBeenCalledExactlyOnceWith("lighting", 190);
  expect(screen.getByRole("columnheader", { name: /Lighting/ }).style.getPropertyValue("--cue-dept")).toBe("var(--color-dept-amber)");
  expect(screen.queryByRole("textbox")).toBeNull();
});
