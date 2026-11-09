import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import * as React from "react";
import * as jsx from "react/jsx-runtime";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import * as ids from "../../../../mobile/src/lib/request-id.ts";
const container = ({ children }) => React.createElement("div", null, children);
const modules = {
  react: React,
  "react/jsx-runtime": jsx,
  "@/lib/request-id": ids,
  "react-native": {
    View: container,
    Text: container,
    Modal: container,
    ScrollView: container,
    Switch: () => null,
    StyleSheet: { create: (v) => v },
    Pressable: ({ children, onPress, disabled, accessibilityLabel }) =>
      React.createElement(
        "button",
        { onClick: onPress, disabled, "aria-label": accessibilityLabel },
        children,
      ),
  },
  "@/components/page": { Page: container },
  "@/components/app-button": {
    AppButton: ({ label, onPress, disabled }) =>
      React.createElement("button", { onClick: onPress, disabled }, label),
  },
  "@/components/app-field": {
    AppField: ({ label, value, onChangeText }) =>
      React.createElement(
        "label",
        null,
        label,
        React.createElement("input", {
          value,
          onChange: (e) => onChangeText(e.target.value),
        }),
      ),
  },
  "@/theme/tokens": {
    createThemedStyles: () => () => ({}),
    useAppTheme: () => ({ colors: {} }),
    fontFamily: {},
    radii: {},
    spacing: {},
  },
};
modules["./app-button"] = modules["@/components/app-button"];
function load(name) {
  const code = ts.transpileModule(
    readFileSync(
      resolve(process.cwd(), `../mobile/src/components/${name}.tsx`),
      "utf8",
    ),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
      },
    },
  ).outputText;
  const exported = {};
  new Function("require", "exports", code)((name) => {
    if (name.startsWith("lucide-react-native/")) return { default: () => null };
    if (!(name in modules)) throw new Error(`Missing native module ${name}`);
    return modules[name];
  }, exported);
  return exported;
}
const Sheet = load("rundown-item-sheet").RundownItemSheet;
const Clear = load("rundown-clear-confirmation").RundownClearConfirmation;
const Reset = load("rundown-reset-confirmation").RundownResetConfirmation;
afterEach(cleanup);
const item = {
  id: "cue",
  title: "Welcome",
  type: "segment",
  duration: 60000,
  notes: "",
  assignee: "",
  cue: "",
  status: "upcoming",
  sortOrder: 0,
  revision: 0,
  hardStop: false,
};
function props() {
  return {
    item,
    currentItem: item,
    index: 0,
    itemCount: 2,
    revision: 4,
    currentItemId: "cue",
    canEdit: true,
    onClose: vi.fn(),
    onDelete: vi.fn(),
    onMove: vi.fn(),
    onSave: vi.fn(),
  };
}
it("requires a visible item confirmation before dispatching a deletion", () => {
  const p = props();
  render(React.createElement(Sheet, p));
  fireEvent.click(screen.getByRole("button", { name: "Delete rundown item" }));
  expect(p.onDelete).not.toHaveBeenCalled();
  expect(
    screen.getByRole("button", { name: "Confirm item removal" }),
  ).toBeTruthy();
});
it("keeping an item sends nothing and preserves the editor", () => {
  const p = props();
  render(React.createElement(Sheet, p));
  fireEvent.click(screen.getByRole("button", { name: "Delete rundown item" }));
  expect(screen.getByText(/Removing it stops its timer/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Keep item" }));
  expect(p.onDelete).not.toHaveBeenCalled();
  expect(p.onClose).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("button", { name: "Confirm item removal" }),
  ).toBeNull();
});
it("requires explicit review after the rundown advances and sends the reviewed revision", () => {
  const p = props(),
    view = render(React.createElement(Sheet, p));
  fireEvent.click(screen.getByRole("button", { name: "Delete rundown item" }));
  const next = {
    ...p,
    revision: 5,
    currentItemId: "next",
    currentItem: { ...item, title: "Updated welcome" },
  };
  view.rerender(React.createElement(Sheet, next));
  fireEvent.click(screen.getByRole("button", { name: "Confirm item removal" }));
  expect(p.onDelete).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Review current item" }));
  expect(screen.getByText(/Remove “Updated welcome”/)).toBeTruthy();
  expect(screen.queryByText(/Removing it stops its timer/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Confirm item removal" }));
  expect(p.onDelete).toHaveBeenCalledExactlyOnceWith(next.currentItem, 5);
});
it.each([{ canEdit: false }, { currentItem: null }])(
  "blocks confirmation after access or item disappears: %j",
  (change) => {
    const p = props(),
      view = render(React.createElement(Sheet, p));
    fireEvent.click(
      screen.getByRole("button", { name: "Delete rundown item" }),
    );
    view.rerender(React.createElement(Sheet, { ...p, ...change }));
    fireEvent.click(
      screen.getByRole("button", { name: "Confirm item removal" }),
    );
    expect(p.onDelete).not.toHaveBeenCalled();
  },
);

it("clear reviews the whole show again after any revision change", () => {
  const p = {
    title: "Sunday",
    count: 2,
    revision: 4,
    playing: true,
    active: true,
    onClose: vi.fn(),
    onConfirm: vi.fn(),
  };
  const view = render(React.createElement(Clear, p));
  expect(screen.getByText(/active timer/)).toBeTruthy();
  expect(screen.getByText(/no undo/)).toBeTruthy();
  view.rerender(React.createElement(Clear, { ...p, count: 3, revision: 5 }));
  fireEvent.click(
    screen.getByRole("button", { name: "Confirm clear rundown" }),
  );
  expect(p.onConfirm).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "Review current rundown" }),
  );
  expect(screen.getByText(/all 3 items/)).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: "Confirm clear rundown" }),
  );
  expect(p.onConfirm).toHaveBeenCalledExactlyOnceWith(5);
});
it("keep and lost access cannot clear a rundown", () => {
  const p = {
    title: "Sunday",
    count: 2,
    revision: 4,
    playing: false,
    active: false,
    onClose: vi.fn(),
    onConfirm: vi.fn(),
  };
  render(React.createElement(Clear, p));
  fireEvent.click(
    screen.getByRole("button", { name: "Confirm clear rundown" }),
  );
  expect(p.onConfirm).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Keep rundown" }));
  expect(p.onClose).toHaveBeenCalledTimes(1);
});

it("reset names its consequences and Keep preserves timing", () => {
  const p = {
    title: "Sunday",
    count: 2,
    revision: 4,
    playing: false,
    active: true,
    onClose: vi.fn(),
    onConfirm: vi.fn(),
  };
  render(React.createElement(Reset, p));
  expect(screen.getByText(/actual start and end times/)).toBeTruthy();
  expect(screen.getByText(/cannot be undone/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Keep timing" }));
  expect(p.onClose).toHaveBeenCalledTimes(1);
  expect(p.onConfirm).not.toHaveBeenCalled();
});
it("reset confirms the exact reviewed revision", () => {
  const p = {
    title: "Sunday",
    count: 2,
    revision: 4,
    playing: false,
    active: true,
    onClose: vi.fn(),
    onConfirm: vi.fn(),
  };
  render(React.createElement(Reset, p));
  fireEvent.click(screen.getByRole("button", { name: "Confirm timing reset" }));
  expect(p.onConfirm).toHaveBeenCalledExactlyOnceWith(4);
});
it("reset blocks live playback and requires review again after a pause", () => {
  const p = {
    title: "Sunday",
    count: 2,
    revision: 4,
    playing: false,
    active: true,
    onClose: vi.fn(),
    onConfirm: vi.fn(),
  };
  const view = render(React.createElement(Reset, p));
  view.rerender(
    React.createElement(Reset, { ...p, playing: true, revision: 5 }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Confirm timing reset" }));
  expect(p.onConfirm).not.toHaveBeenCalled();
  view.rerender(
    React.createElement(Reset, { ...p, playing: false, revision: 6 }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Confirm timing reset" }));
  expect(p.onConfirm).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "Review current timing" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Confirm timing reset" }));
  expect(p.onConfirm).toHaveBeenCalledExactlyOnceWith(6);
});
it("reset remains blocked after control access is lost", () => {
  const p = {
    title: "Sunday",
    count: 2,
    revision: 4,
    playing: false,
    active: false,
    onClose: vi.fn(),
    onConfirm: vi.fn(),
  };
  render(React.createElement(Reset, p));
  fireEvent.click(screen.getByRole("button", { name: "Confirm timing reset" }));
  expect(p.onConfirm).not.toHaveBeenCalled();
});
