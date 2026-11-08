import * as assignmentHook from "../../test/native-assignment-hook.js";
import * as assignmentContract from "../../../../mobile/src/lib/assignment-recovery.ts";
import * as reminderContract from "../../../../mobile/src/lib/reminder-recovery.ts";
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
    "@/hooks/use-mobile-assignment": assignmentHook,
    "@/lib/assignment-recovery": assignmentContract,
    "@/lib/reminder-recovery": reminderContract,
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
  return exports.ScheduleAssignmentSheet;
}
afterEach(cleanup);
function setup(overrides = {}) {
  const alert = vi.fn(),
    Sheet = loadSheet(alert),
    client = new QueryClient();
  const props = {
    orgId: "org",
    userId: "user",
    active: true,
    initial: {
      editorId: "create:show",
      mode: "create",
      showName: "Sunday",
      base: null,
      fields: {
        showId: "show",
        serviceDate: "2099-01-01",
        timeZone: "UTC",
        role: "",
        department: "Production",
        crewMemberId: null,
        callTime: "",
        notes: "",
      },
    },
    onRead: vi.fn(),
    assignment: null,
    crew: [],
    showId: "show",
    serviceDate: "2099-01-01",
    showName: "Sunday",
    timeZone: "UTC",
    onClose: vi.fn(),
    onSave: vi.fn(() => new Promise(() => {})),
    onRefresh: vi.fn(async () => {}),
    onCommand: vi.fn(() => new Promise(() => {})),
  };
  Object.assign(props, overrides);
  const draw = (open) =>
    React.createElement(
      QueryClientProvider,
      { client },
      open ? React.createElement(Sheet, props) : null,
    );
  return { ...render(draw(true)), props, client, alert, draw };
}
it("retains the native assignment draft across closing and reopening", () => {
  const view = setup();
  fireEvent.change(screen.getByLabelText("Position"), {
    target: { value: "Retained camera position" },
  });
  fireEvent.change(screen.getByLabelText("Manager note (optional)"), {
    target: { value: "Keep this preparation note" },
  });
  view.rerender(view.draw(false));
  view.rerender(view.draw(true));
  expect(screen.getByLabelText("Position").value).toBe(
    "Retained camera position",
  );
  expect(screen.getByLabelText("Manager note (optional)").value).toBe(
    "Keep this preparation note",
  );
});
it("locks the submitted assignment fields while the save is unconfirmed", async () => {
  const view = setup();
  fireEvent.change(screen.getByLabelText("Position"), {
    target: { value: "Original position" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add open position" }));
  await act(async () => {});
  expect(screen.getByLabelText("Position").disabled).toBe(true);
  expect(view.props.onClose).not.toHaveBeenCalled();
});

it("confirmed crew replacement requires inline confirmation and Cancel sends nothing", async () => {
  const initial = {
    editorId: "edit:position",
    mode: "edit",
    showName: "Sunday",
    base: {
      id: "position",
      revision: "revision",
      status: "confirmed",
      crewMemberId: "crew",
      responseNote: "Ready",
    },
    fields: {
      showId: "show",
      serviceDate: "2099-01-01",
      timeZone: "UTC",
      role: "Camera",
      department: "Video",
      crewMemberId: "crew",
      callTime: "",
      notes: "",
    },
  };
  const view = setup({
    initial,
    crew: [
      {
        id: "crew",
        name: "Current crew",
        email: "crew@example.test",
        role: "Camera",
      },
    ],
  });
  fireEvent.click(screen.getByRole("button", { name: /Open position/ }));
  fireEvent.click(screen.getByRole("button", { name: "Save assignment" }));
  expect(screen.getByText("Replace confirmed crew member?")).toBeTruthy();
  expect(screen.getByLabelText("Position").disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(view.props.onCommand).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Position").disabled).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Save assignment" }));
  fireEvent.click(screen.getByRole("button", { name: "Make position open" }));
  await waitFor(() => expect(view.props.onCommand).toHaveBeenCalledTimes(1));
  expect(view.props.onCommand.mock.calls[0][0].operation).toMatchObject({
    kind: "edit",
    expectedRevision: "revision",
    fields: { crewMemberId: null },
  });
  expect(view.alert).not.toHaveBeenCalled();
});
it("removal names its scope, requires confirmation, and sends the reviewed revision", async () => {
  const initial = {
    editorId: "delete:position",
    mode: "delete",
    showName: "Sunday",
    base: {
      id: "position",
      revision: "revision",
      status: "assigned",
      crewMemberId: null,
      responseNote: "",
    },
    fields: {
      showId: "show",
      serviceDate: "2099-01-01",
      timeZone: "UTC",
      role: "Camera",
      department: "Video",
      crewMemberId: null,
      callTime: "",
      notes: "",
    },
  };
  const view = setup({ initial });
  fireEvent.click(screen.getByRole("button", { name: "Review removal" }));
  expect(
    screen.getByText(/Camera will be removed from Sunday on 2099-01-01/),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(view.props.onCommand).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Review removal" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove position" }));
  await waitFor(() => expect(view.props.onCommand).toHaveBeenCalledTimes(1));
  expect(view.props.onCommand.mock.calls[0][0].operation).toEqual({
    kind: "delete",
    id: "position",
    expectedRevision: "revision",
  });
});
it("discarding an unsent draft requires confirmation and never sends a command", () => {
  const view = setup();
  fireEvent.change(screen.getByLabelText("Position"), {
    target: { value: "Discard this" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.getByLabelText("Position").value).toBe("Discard this");
  fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
  act(() => {
    fireEvent.click(screen.getByRole("button", { name: "Confirm discard" }));
    view.rerender(view.draw(false));
  });
  expect(view.props.onClose).toHaveBeenCalledTimes(1);
  expect(view.props.onCommand).not.toHaveBeenCalled();
  view.rerender(view.draw(true));
  expect(screen.getByLabelText("Position").value).toBe("");
});
