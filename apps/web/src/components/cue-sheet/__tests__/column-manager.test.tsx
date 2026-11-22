import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("@/lib/cue-sheet", () => ({ CUE_COLUMN_COLORS: ["slate", "amber", "green", "blue", "purple", "pink", "cyan", "red"] }));
import { ColumnManager } from "../column-manager";

afterEach(cleanup);
const column = { id: "lx", label: "LX", color: "blue", sortOrder: 0, width: 220, noteCount: 0 };
const props = () => ({ columns: [column], onMutation: vi.fn(async () => true), locked: false, confirmedOperation: null, onClose: vi.fn() });

it("uses the guarded reversible operation for an empty department", () => {
  const input = props(); render(<ColumnManager {...input} />);
  fireEvent.click(screen.getByRole("button", { name: "Delete LX" }));
  expect(input.onMutation).toHaveBeenCalledExactlyOnceWith({ kind: "delete-empty-column", id: "lx", label: "LX" });
  expect(screen.queryByRole("button", { name: "Delete department" })).toBeNull();
});

it("asks before deleting a department with notes across shows and lets the user cancel", async () => {
  const input = props(); render(<ColumnManager {...input} columns={[{ ...column, noteCount: 3 }]} />);
  fireEvent.click(screen.getByRole("button", { name: "Delete LX" }));
  expect(await screen.findByText(/3 cue notes across all shows/)).toBeTruthy();
  expect(input.onMutation).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(input.onMutation).not.toHaveBeenCalled();
});

it("cancels a rename with Escape rather than accidentally saving on blur", () => {
  const input = props(); render(<ColumnManager {...input} />);
  const name = screen.getByRole("textbox", { name: "Rename LX" });
  name.focus(); fireEvent.change(name, { target: { value: "Not my intended name" } });
  fireEvent.keyDown(name, { key: "Escape" });
  expect(input.onMutation).not.toHaveBeenCalled();
  expect((name as HTMLInputElement).value).toBe("LX");
});
