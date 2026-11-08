import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import * as React from "react";
import * as jsx from "react/jsx-runtime";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import * as inventoryHook from "../../test/native-inventory-hook.js";
import * as requestIds from "../../../../mobile/src/lib/request-id.ts";

// Execute the actual native sheet. Only native rendering/device boundaries are
// replaced; draft state, submission and confirmation logic remain production code.
const source = readFileSync(
  resolve(process.cwd(), "../mobile/src/components/schedule-sheets.tsx"),
  "utf8",
);
const code = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.ReactJSX,
  },
}).outputText;
function loadSheet(alert) {
  const container = ({ children }) =>
    React.createElement("div", null, children);
  const modules = {
    "@/hooks/use-mobile-inventory": inventoryHook,
    react: React,
    "react/jsx-runtime": jsx,
    "@showpilot/shared": {
      workspaceCopy: (text) => text,
      WORKSPACE_DEFINITIONS: {},
    },
    "@/providers/workspace-provider": {
      useTerms: () => ({}),
      useWorkspace: () => ({}),
    },
    "react-native": {
      Alert: { alert },
      Modal: container,
      ScrollView: container,
      View: container,
      Text: ({ children }) => React.createElement("span", null, children),
      Pressable: ({ children, onPress, disabled, accessibilityLabel }) =>
        React.createElement(
          "button",
          { onClick: onPress, disabled, "aria-label": accessibilityLabel },
          children,
        ),
      TextInput: ({ value, onChangeText }) =>
        React.createElement("input", {
          value,
          onChange: (event) => onChangeText(event.target.value),
        }),
      StyleSheet: { create: (value) => value },
    },
    "@/components/app-button": {
      AppButton: ({ label, onPress, disabled }) =>
        React.createElement("button", { onClick: onPress, disabled }, label),
    },
    "@/components/app-field": {
      AppField: ({ label, value, onChangeText, editable }) =>
        React.createElement(
          "label",
          null,
          label,
          React.createElement("input", {
            value,
            disabled: editable === false,
            onChange: (event) => onChangeText(event.target.value),
          }),
        ),
    },
    "@/components/page": { Page: container },
    "@/lib/request-id": requestIds,
    "@/lib/service-time": {},
    "@/theme/tokens": {
      createThemedStyles: () => () => ({}),
      useAppTheme: () => ({ colors: {} }),
      fontFamily: {},
      radii: {},
      spacing: {},
    },
  };
  const exports = {};
  new Function("require", "exports", code)((name) => {
    if (name.startsWith("lucide-react-native/")) return { default: () => null };
    if (!(name in modules)) throw new Error(`Unmocked native import ${name}`);
    return modules[name];
  }, exports);
  return exports.ScheduleInventorySheet;
}
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
function setup() {
  const alert = vi.fn(),
    Sheet = loadSheet(alert),
    client = new QueryClient();
  const props = {
    orgId: "org",
    userId: "user",
    active: true,
    archivedInventory: [],
    inventory: [
      {
        id: "item",
        name: "Weekly show",
        itemCount: 0,
        location: "",
        description: "",
        defaultStartTime: null,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    savedTemplates: [],
    canManage: true,
    onClose: vi.fn(),
    onCommand: vi.fn(async (command) => ({
      requestId: command.requestId,
      id:
        command.operation.kind === "create"
          ? command.requestId
          : command.operation.id,
      outcome: "applied",
      item: null,
    })),
    onRefresh: vi.fn(async () => {}),
    onUse: vi.fn(),
  };
  const draw = (open) =>
    React.createElement(
      QueryClientProvider,
      { client },
      open ? React.createElement(Sheet, props) : null,
    );
  return { ...render(draw(true)), props, alert, draw };
}
it("retains a native inventory draft when its sheet is closed and reopened", () => {
  const view = setup();
  fireEvent.change(screen.getByLabelText("Show name"), {
    target: { value: "Retained native draft" },
  });
  view.rerender(view.draw(false));
  view.rerender(view.draw(true));
  expect(screen.getByLabelText("Show name").value).toBe(
    "Retained native draft",
  );
});
it("asks before archiving a reusable show and cancellation sends nothing", async () => {
  const view = setup();
  fireEvent.click(screen.getByRole("button", { name: "Archive Weekly show" }));
  await act(async () => {});
  expect(view.props.onCommand).not.toHaveBeenCalled();
  expect(view.alert).toHaveBeenCalledWith(
    expect.stringMatching(/Archive/),
    expect.stringMatching(/scheduled/i),
    expect.any(Array),
  );
  const choices = view.alert.mock.calls[0][2];
  choices.find((choice) => choice.style === "cancel")?.onPress?.();
  expect(view.props.onCommand).not.toHaveBeenCalled();
});
it("keeps the submitted draft immutable while its outcome is unconfirmed", async () => {
  const view = setup();
  view.props.onCommand.mockReturnValue(new Promise(() => {}));
  fireEvent.change(screen.getByLabelText("Show name"), {
    target: { value: "Original native draft" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add to inventory" }));
  await waitFor(() => expect(view.props.onCommand).toHaveBeenCalledTimes(1));
  expect(screen.getByLabelText("Show name").disabled).toBe(true);
});
it("abandoned archive confirmation cannot write after closing the sheet", async () => {
  const view = setup();
  fireEvent.click(screen.getByRole("button", { name: "Archive Weekly show" }));
  const approve = view.alert.mock.calls[0][2].find(
    (choice) => choice.style === "destructive",
  ).onPress;
  view.rerender(view.draw(false));
  await act(async () => approve());
  expect(view.props.onCommand).not.toHaveBeenCalled();
});
it("confirmed archive captures the reviewed item version and preserves a creation draft", async () => {
  const view = setup();
  fireEvent.change(screen.getByLabelText("Show name"), {
    target: { value: "Unrelated draft" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Archive Weekly show" }));
  await act(async () =>
    view.alert.mock.calls[0][2]
      .find((choice) => choice.style === "destructive")
      .onPress(),
  );
  expect(view.props.onCommand.mock.calls[0][0].operation).toEqual({
    kind: "archive",
    id: "item",
    archived: true,
    expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
  });
  expect(screen.getByLabelText("Show name").value).toBe("Unrelated draft");
});
it("shows refresh failure inline and retries the refresh without repeating creation", async () => {
  const view = setup();
  view.props.onRefresh.mockRejectedValueOnce(new Error("Schedule read failed"));
  fireEvent.change(screen.getByLabelText("Show name"), {
    target: { value: "Created once" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add to inventory" }));
  await screen.findByText("Schedule read failed");
  fireEvent.click(screen.getByRole("button", { name: "Refresh inventory" }));
  await waitFor(() =>
    expect(screen.getByLabelText("Show name").value).toBe(""),
  );
  expect(view.props.onCommand).toHaveBeenCalledTimes(1);
  expect(view.props.onRefresh).toHaveBeenCalledTimes(2);
});
it("preserves an unavailable source until the operator explicitly replaces it", async () => {
  const view = setup();
  view.props.savedTemplates = [
    { id: "source", name: "Chosen source", itemCount: 1 },
  ];
  view.rerender(view.draw(true));
  fireEvent.change(screen.getByLabelText("Show name"), {
    target: { value: "New show" },
  });
  fireEvent.click(screen.getByText("Chosen source"));
  view.props.savedTemplates = [];
  view.rerender(view.draw(true));
  expect(
    screen.getByText(/selected saved rundown is unavailable/),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Add to inventory" }).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByText("Empty rundown"));
  expect(
    screen.getByRole("button", { name: "Add to inventory" }).disabled,
  ).toBe(false);
  expect(view.props.onCommand).not.toHaveBeenCalled();
});
it("retains a late success while unfocused and requires refresh when returning", async () => {
  const view = setup();
  let resolve;
  view.props.onCommand.mockImplementation(
    (command) =>
      new Promise((done) => {
        resolve = () =>
          done({
            requestId: command.requestId,
            id: command.requestId,
            outcome: "applied",
            item: null,
          });
      }),
  );
  fireEvent.change(screen.getByLabelText("Show name"), {
    target: { value: "Pending native show" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add to inventory" }));
  await waitFor(() => expect(view.props.onCommand).toHaveBeenCalledTimes(1));
  view.props.active = false;
  view.rerender(view.draw(true));
  await act(async () => resolve());
  expect(view.props.onRefresh).not.toHaveBeenCalled();
  view.props.active = true;
  view.rerender(view.draw(true));
  fireEvent.click(screen.getByRole("button", { name: "Refresh inventory" }));
  await waitFor(() =>
    expect(screen.getByLabelText("Show name").value).toBe(""),
  );
  expect(view.props.onCommand).toHaveBeenCalledTimes(1);
});
