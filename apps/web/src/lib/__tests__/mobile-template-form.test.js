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
import * as managementHook from "../../test/native-template-save-hook.js";
import * as queries from "@tanstack/react-query";
import * as requestIds from "../../../../mobile/src/lib/request-id.ts";

// Execute the actual native sheet. Only native rendering/device boundaries are
// replaced; draft state, submission and confirmation logic remain production code.
const source = readFileSync(
  resolve(process.cwd(), "../mobile/src/components/template-save-form.tsx"),
  "utf8",
);
const code = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.ReactJSX,
  },
}).outputText;
function loadSheet(send, focus) {
  const container = ({ children }) =>
    React.createElement("div", null, children);
  const modules = {
    "@/hooks/use-template-save": managementHook,
    "@/hooks/use-screen-polling": { useScreenFocus: () => focus.active },
    "@/lib/mobile-api": { commandMobileTemplateSave: send },
    "@tanstack/react-query": queries,
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
      ActivityIndicator: () => null,
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
  return exports.TemplateSaveForm;
}
afterEach(cleanup);

const originalCopy = {
  serviceName: "Original show",
  scheduledStartTime: "09:30",
  items: [],
};
function setup() {
  const send = vi.fn(async (command) => ({ ...command, outcome: "applied" })),
    focus = { active: true },
    client = new QueryClient(),
    Sheet = loadSheet(send, focus);
  const props = {
    orgId: "org",
    userId: "user",
    showId: "show",
    copy: originalCopy,
    canCapture: true,
  };
  const mount = () =>
    render(
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(Sheet, props),
      ),
    );
  return { send, focus, props, mount, client };
}
const field = () => screen.getByLabelText("Template name");
const click = (name) =>
  fireEvent.click(screen.getByRole("button", { name, exact: true }));
it("keeps a template name when its sheet closes and reopens", () => {
  const f = setup(),
    view = f.mount();
  fireEvent.change(field(), { target: { value: "Retain this template" } });
  view.unmount();
  f.mount();
  expect(field().value).toBe("Retain this template");
});
it("freezes the original template name after a lost reply and retries it on reopening", async () => {
  const f = setup();
  f.send.mockRejectedValueOnce(new Error("Reply lost"));
  const view = f.mount();
  fireEvent.change(field(), { target: { value: "Reviewed template" } });
  click("Save template");
  await screen.findByRole("button", { name: "Retry original template save" });
  expect(field().disabled).toBe(true);
  const original = f.send.mock.calls[0][0];
  view.unmount();
  f.props.copy = { ...originalCopy, serviceName: "New live show" };
  f.mount();
  expect(field().value).toBe("Reviewed template");
  click("Retry original template save");
  await screen.findByText("Template saved.");
  expect(f.send.mock.calls[1][0]).toEqual(original);
  expect(original.serviceName).toBe("Original show");
});
it("replaces a source copy and discards a draft only after explicit confirmation", () => {
  const f = setup(),
    view = f.mount();
  fireEvent.change(field(), { target: { value: "Retained name" } });
  view.unmount();
  f.props.copy = { ...originalCopy, serviceName: "New live show" };
  f.mount();
  expect(screen.getByText(/items from Original show/)).toBeTruthy();
  click("Use current rundown…");
  click("Keep draft");
  expect(screen.getByText(/items from Original show/)).toBeTruthy();
  click("Use current rundown…");
  click("Replace reviewed copy");
  expect(screen.getByText(/items from New live show/)).toBeTruthy();
  expect(field().value).toBe("Retained name");
  click("Discard template draft…");
  click("Keep draft");
  expect(field().value).toBe("Retained name");
  click("Discard template draft…");
  click("Discard draft");
  expect(field().value).toBe("");
});
it("requires explicit editing after cancellation before issuing a new save", async () => {
  const f = setup();
  f.send
    .mockRejectedValueOnce(new Error("Reply lost"))
    .mockImplementationOnce(async (command) => ({
      ...command,
      outcome: "cancelled",
    }));
  f.mount();
  fireEvent.change(field(), { target: { value: "Reviewed template" } });
  click("Save template");
  await screen.findByRole("button", { name: "Review original template save" });
  click("Review original template save");
  await screen.findByRole("button", { name: "Edit cancelled template save" });
  expect(field().disabled).toBe(true);
  click("Edit cancelled template save");
  expect(field().disabled).toBe(false);
  click("Save template");
  await screen.findByText("Template saved.");
  expect(f.send.mock.calls[2][0].requestId).not.toBe(
    f.send.mock.calls[0][0].requestId,
  );
});
it("refreshes only the list after a confirmed save whose refresh failed", async () => {
  const f = setup();
  vi.spyOn(f.client, "invalidateQueries").mockRejectedValueOnce(
    new Error("List read failed"),
  );
  f.mount();
  fireEvent.change(field(), { target: { value: "Reviewed template" } });
  click("Save template");
  await screen.findByText(/List read failed/);
  expect(field().disabled).toBe(true);
  expect(f.send).toHaveBeenCalledTimes(1);
  click("Refresh templates only");
  await screen.findByRole("button", { name: "Finish template save" });
  expect(f.send).toHaveBeenCalledTimes(1);
});
it("shows an invalid-copy error and can recover after reopening with valid details", async () => {
 const f=setup();f.props.copy={...originalCopy,serviceName:"x".repeat(121)};
 const view=f.mount();await screen.findByText(/This rundown copy contains invalid details/);
 expect(screen.getByRole("button",{name:"Capture current rundown"})).toBeTruthy();expect(f.send).not.toHaveBeenCalled();
 view.unmount();f.props.copy=originalCopy;f.mount();await screen.findByLabelText("Template name");
});
