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
import * as managementHook from "../../test/native-rundown-details-hook.js";
import * as managementContract from "../../../../mobile/src/lib/rundown-details-recovery.ts";
import * as serviceTime from "../../../../mobile/src/lib/service-time.ts";
import * as queries from "@tanstack/react-query";
import * as requestIds from "../../../../mobile/src/lib/request-id.ts";

// Execute the actual native sheet. Only native rendering/device boundaries are
// replaced; draft state, submission and confirmation logic remain production code.
const source = readFileSync(
  resolve(process.cwd(), "../mobile/src/components/rundown-show-sheet.tsx"),
  "utf8",
);
const code = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.ReactJSX,
  },
}).outputText;
function loadSheet(send, read, focus) {
  const container = ({ children }) =>
    React.createElement("div", null, children);
  const modules = {
    "@/hooks/use-rundown-details": managementHook,
    "@/hooks/use-screen-polling": { useScreenFocus: () => focus.active },
    "@/lib/rundown-details-recovery": managementContract,
    "@/lib/mobile-api": {
      commandMobileRundownDetails: send,
      readMobileRundownDetails: read,
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
    "@/lib/service-time": serviceTime,
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
  return exports.RundownShowSheet;
}
afterEach(cleanup);

const snapshot = {
  id: "show",
  serviceDate: "2099-01-01",
  name: "Original show",
  location: "Main",
  updatedAt: "2026-01-01T00:00:00Z",
  scheduledStartTime: null,
  scheduledCallTime: null,
};
const initial = {
  orgId: "org",
  userId: "user",
  showId: "show",
  revision: 4,
  timeZone: "UTC",
  snapshot,
};
function setup() {
  const send = vi.fn(async (command) => ({
    orgId: command.orgId,
    userId: command.userId,
    showId: command.showId,
    requestId: command.requestId,
    outcome: "applied",
    snapshot,
  }));
  const read = vi.fn(async () => initial),
    focus = { active: true },
    client = new QueryClient();
  const Sheet = loadSheet(send, read, focus),
    props = { orgId: "org", userId: "user", showId: "show", onClose: vi.fn() };
  const mount = () =>
    render(
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(Sheet, props),
      ),
    );
  return { send, read, focus, client, mount, props };
}
const field = () => screen.getByLabelText("Show or service title");
const click = (name) =>
  fireEvent.click(screen.getByRole("button", { name, exact: true }));
it("keeps the reviewed details draft when the form closes and reopens", async () => {
  const f = setup(),
    view = f.mount();
  await screen.findByLabelText("Show or service title");
  fireEvent.change(field(), { target: { value: "Keep my draft" } });
  view.unmount();
  f.mount();
  expect(field().value).toBe("Keep my draft");
  expect(f.read).toHaveBeenCalledTimes(1);
});
it("freezes fields after an unconfirmed reply and retries the frozen request", async () => {
  const f = setup();
  f.send.mockRejectedValueOnce(new Error("Reply lost"));
  f.mount();
  await screen.findByLabelText("Show or service title");
  fireEvent.change(field(), { target: { value: "Reviewed show" } });
  click("Save details");
  await screen.findByRole("button", { name: "Retry original details save" });
  expect(field().disabled).toBe(true);
  expect(
    screen.queryByRole("button", { name: "Discard details draft…" }),
  ).toBeNull();
  click("Retry original details save");
  await screen.findByRole("button", { name: "Finish details change" });
  expect(f.send.mock.calls[1][0]).toEqual(f.send.mock.calls[0][0]);
  expect(f.send.mock.calls[0][0]).toMatchObject({
    name: "Reviewed show",
    expectedRevision: 4,
    expectedUpdatedAt: snapshot.updatedAt,
  });
});
it("requires explicit confirmation before replacing or discarding a draft", async () => {
  const f = setup();
  f.mount();
  await screen.findByLabelText("Show or service title");
  fireEvent.change(field(), { target: { value: "Keep me" } });
  click("Load current details…");
  click("Keep draft");
  expect(f.read).toHaveBeenCalledTimes(1);
  expect(field().value).toBe("Keep me");
  f.read.mockRejectedValueOnce(new Error("Read failed"));
  click("Load current details…");
  click("Replace with current details");
  await screen.findByText("Read failed");
  expect(field().value).toBe("Keep me");
  click("Discard details draft…");
  click("Keep draft");
  expect(f.props.onClose).not.toHaveBeenCalled();
  click("Discard details draft…");
  click("Discard draft");
  expect(f.props.onClose).toHaveBeenCalledTimes(1);
  expect(f.send).not.toHaveBeenCalled();
});
