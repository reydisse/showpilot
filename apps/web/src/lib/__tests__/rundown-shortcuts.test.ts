import { afterEach, describe, expect, it } from "vitest";
import { rundownShortcut, type RundownShortcut } from "../rundown-shortcuts";

afterEach(() => { document.body.replaceChildren(); });

function press(options: KeyboardEventInit, target: HTMLElement = document.body): RundownShortcut | null {
  let action: RundownShortcut | null = null;
  const listener = (event: KeyboardEvent) => { action = rundownShortcut(event); };
  window.addEventListener("keydown", listener);
  target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...options }));
  window.removeEventListener("keydown", listener);
  return action;
}

describe("rundown keyboard transport", () => {
  it("never starts or advances from bare Space, N or P", () => {
    for (const key of [" ", "n", "p"]) expect(press({ key })).toBeNull();
    expect(press({ key: " ", code: "Space", shiftKey: true })).toBe("toggle-playback");
    expect(press({ key: "N", code: "KeyN", shiftKey: true })).toBe("next");
    expect(press({ key: "P", code: "KeyP", shiftKey: true })).toBe("previous");
  });

  it("ignores typing, contenteditable elements, held keys and browser shortcuts", () => {
    for (const tag of ["input", "textarea", "select", "button", "a"]) {
      const element = document.createElement(tag);
      document.body.appendChild(element);
      expect(press({ key: "N", shiftKey: true }, element)).toBeNull();
    }
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    const child = document.createElement("span"); editable.appendChild(child); document.body.appendChild(editable);
    expect(press({ key: "N", shiftKey: true }, child)).toBeNull();
    for (const flags of [{ repeat: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      expect(press({ key: " ", shiftKey: true, ...flags })).toBeNull();
    }
  });

  it("does not run shortcuts behind an open confirmation", () => {
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog"); dialog.setAttribute("aria-modal", "true");
    document.body.appendChild(dialog);
    expect(press({ key: "N", shiftKey: true })).toBeNull();
    expect(press({ key: "s" })).toBeNull();
  });
});
