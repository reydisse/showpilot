import * as deletionHook from "../../test/native-template-delete-hook.js";
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
import * as managementHook from "../../test/native-rundown-replacement-hook.js";
import * as queries from "@tanstack/react-query";
import * as requestIds from "../../../../mobile/src/lib/request-id.ts";

// Execute the actual native sheet. Only native rendering/device boundaries are
// replaced; draft state, submission and confirmation logic remain production code.
const source = readFileSync(
  resolve(process.cwd(), "../mobile/src/components/rundown-template-sheet.tsx"),
  "utf8",
);
const code = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.ReactJSX,
  },
}).outputText;
function loadSheet(alert, read, send, deleting) {
  const container = ({ children }) =>
    React.createElement("div", null, children);
  const modules = {
    "@/components/template-save-form": { TemplateSaveForm: () => null },
    "@/hooks/use-rundown-replacement": managementHook,
    "@/hooks/use-template-delete": deletionHook,
    "@/hooks/use-screen-polling": { useScreenFocus: () => true },
    "@/lib/mobile-api": {
      deleteMobileRundownTemplate: deleting,
      readMobileRundownReplacement: read,
      commandMobileRundownReplacement: send,
    },

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
      Alert: { alert },
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
  function evaluate(code) {
    const exports = {};
    new Function("require", "exports", code)((name) => {
      if (name === "@/components/rundown-replacement-form" || name === "@/components/template-delete-status")
        return evaluate(
          ts.transpileModule(
            readFileSync(
              resolve(
                process.cwd(),
                name === "@/components/template-delete-status" ? "../mobile/src/components/template-delete-status.tsx" : "../mobile/src/components/rundown-replacement-form.tsx",
              ),
              "utf8",
            ),
            {
              compilerOptions: {
                module: ts.ModuleKind.CommonJS,
                target: ts.ScriptTarget.ES2022,
                jsx: ts.JsxEmit.ReactJSX,
              },
            },
          ).outputText,
        );
      if (name === "./app-button") return modules["@/components/app-button"];
      if (name.startsWith("lucide-react-native/"))
        return { default: () => null };
      if (!(name in modules)) throw new Error(`Unmocked native import ${name}`);
      return modules[name];
    }, exports);
    return exports;
  }
  return evaluate(code).RundownTemplateSheet;
}
afterEach(cleanup);

const template = {
  id: "template",
  name: "Reviewed template",
  itemCount: 1,
  serviceName: "Sunday",
  scheduledStartTime: "09:00",
  updatedAt: "2026-11-08T00:00:00Z",
};
function setup() {
  const read = vi.fn(async (scope) => ({
    ...scope,
    label: "Reviewed template",
    targetName: "Target",
    serviceDate: "2026-11-08",
    expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
    expectedRevision: 0,
    canReplace: true,
    timeZone: "UTC",
    copy: {
      serviceName: "Copied",
      scheduledStartTime: null,
      location: "Room",
      items: [],
    },
  }));
  const send = vi.fn().mockRejectedValue(new Error("Reply lost")),
    alert = vi.fn(),
    client = new QueryClient(),
    deleting = vi.fn().mockRejectedValue(new Error("Deletion reply lost")),
    Sheet = loadSheet(alert, read, send, deleting);
  const props = {
    orgId: "org",
    userId: "user",
    showId: "show",
    copy: { serviceName: "Original", scheduledStartTime: "", items: [] },
    canCapture: true,
    loading: false,
    onClose: vi.fn(),
    onRetry: vi.fn(),
    refreshing: false,
    templates: [template],
    previousShows: [],
  };
  const mount = () =>
    render(
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(Sheet, props),
      ),
    );
  return { read, send, deleting, alert, client, props, mount };
}
it("renders an in-product replacement confirmation when native alerts are unavailable", async () => {
  const f = setup();
  f.mount();
  fireEvent.click(screen.getByRole("button", { name: "Load", exact: true }));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Confirm rundown replacement" }),
    ).toBeTruthy(),
  );
  expect(screen.getByText("Replace current rundown?")).toBeTruthy();
  expect(f.alert).not.toHaveBeenCalled();
  expect(f.send).not.toHaveBeenCalled();
});
it("retains the original replacement and reviewed copy across an uncertain response and remount", async () => {
  const f = setup(),
    view = f.mount();
  fireEvent.click(screen.getByRole("button", { name: "Load", exact: true }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Confirm rundown replacement" }),
  );
  await screen.findByRole("button", { name: "Retry original replacement" });
  const original = f.send.mock.calls[0][0];
  view.unmount();
  f.props.templates = [{ ...template, name: "Changed source" }];
  f.mount();
  fireEvent.click(
    await screen.findByRole("button", { name: "Retry original replacement" }),
  );
  await waitFor(() => expect(f.send).toHaveBeenCalledTimes(2));
  expect(f.send.mock.calls[1][0]).toEqual(original);
  expect(f.read).toHaveBeenCalledTimes(1);
});
it("requires explicit source reread after cancellation before a new replacement", async () => {
  const f = setup();
  f.send.mockImplementation(async (command, review) => ({
    ...command,
    outcome: review ? "cancelled" : "applied",
    revision: null,
  }));
  // Lose the first response so review is reachable.
  f.send.mockRejectedValueOnce(new Error("Lost"));
  f.mount();
  fireEvent.click(screen.getByRole("button", { name: "Load", exact: true }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Confirm rundown replacement" }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Review original replacement" }),
  );
  await screen.findByRole("button", { name: "Finish replacement" });
  expect(
    screen.queryByRole("button", { name: "Confirm rundown replacement" }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Review current copy…" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Load current replacement" }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Confirm rundown replacement" }),
  );
  await waitFor(() => expect(f.send).toHaveBeenCalledTimes(3));
  expect(f.send.mock.calls[2][0].requestId).not.toBe(
    f.send.mock.calls[0][0].requestId,
  );
});
it("shows a visible template deletion confirmation when native alerts are unavailable", async () => {
  const f = setup();
  f.mount();
  fireEvent.click(screen.getByRole("button", { name: "Delete Reviewed template" }));
  expect(screen.getByRole("button", { name: "Confirm template deletion" })).toBeTruthy();
  expect(screen.getByText(/Existing shows are not affected/)).toBeTruthy();
  expect(f.deleting).not.toHaveBeenCalled();
  expect(f.alert).not.toHaveBeenCalled();
});

it("retains the confirmed deletion across navigation and retries only its original template", async () => {
  const f = setup(), view = f.mount();
  fireEvent.click(screen.getByRole("button", {name: "Delete Reviewed template"}));
  fireEvent.click(screen.getByRole("button", {name: "Confirm template deletion"}));
  await screen.findByRole("button", {name: "Retry deletion of Reviewed template"});
  const original = f.deleting.mock.calls[0][0];
  view.unmount();
  f.props.templates = [{...template,id:"another",name:"Another template"}];
  f.mount();
  fireEvent.click(screen.getByRole("button", {name: "Retry deletion of Reviewed template"}));
  await waitFor(()=>expect(f.deleting).toHaveBeenCalledTimes(2));
  expect(f.deleting.mock.calls[1][0]).toEqual(original);
  expect(original.templateId).toBe("template");
  expect(f.alert).not.toHaveBeenCalled();
});
it("keeps a failed list refresh separate from an acknowledged deletion",async()=>{
  const f=setup();
  f.deleting.mockImplementation(async command=>({...command,ok:true}));
  vi.spyOn(f.client,"invalidateQueries").mockRejectedValueOnce(new Error("List unavailable")).mockResolvedValue(undefined);
  f.mount();
  fireEvent.click(screen.getByRole("button",{name:"Delete Reviewed template"}));
  fireEvent.click(screen.getByRole("button",{name:"Confirm template deletion"}));
  await screen.findByText("List unavailable");
  expect(screen.getByText("Template deleted. Existing shows are not affected.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button",{name:"Refresh saved templates"}));
  await screen.findByRole("button",{name:"Dismiss deletion result"});
  expect(f.deleting).toHaveBeenCalledTimes(1);
});
it("keeping the template closes confirmation without sending a deletion",()=>{
  const f=setup();f.mount();
  fireEvent.click(screen.getByRole("button",{name:"Delete Reviewed template"}));
  fireEvent.click(screen.getByRole("button",{name:"Keep template"}));
  expect(screen.queryByRole("button",{name:"Confirm template deletion"})).toBeNull();
  expect(f.deleting).not.toHaveBeenCalled();
});
