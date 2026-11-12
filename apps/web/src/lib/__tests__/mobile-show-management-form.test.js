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
import * as managementHook from "../../test/native-show-management-hook.js";
import * as managementContract from "../../../../mobile/src/lib/show-management-recovery.ts";
import * as serviceTime from "../../../../mobile/src/lib/service-time.ts";
import * as queries from "@tanstack/react-query";
import * as requestIds from "../../../../mobile/src/lib/request-id.ts";

// Execute the actual native sheet. Only native rendering/device boundaries are
// replaced; draft state, submission and confirmation logic remain production code.
const source = readFileSync(
  resolve(process.cwd(), "../mobile/src/components/show-management-sheet.tsx"),
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
    "@/hooks/use-show-management": managementHook,
    "@/hooks/use-screen-polling": { useScreenFocus: () => focus.active },
    "@/lib/show-management-recovery": managementContract,
    "@/lib/mobile-api": {
      commandMobileShowManagement: send,
      readMobileManagedShow: read,
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
  return exports.ShowManagementSheet;
}
afterEach(cleanup);

const snapshot = {
  id: "show",
  serviceDate: "2099-01-01",
  name: "Morning",
  location: "Main",
  updatedAt: "2026-01-01T00:00:00Z",
  scheduledStartTime: "2099-01-01T09:30:00Z",
  scheduledCallTime: null,
};
function setup(mode = "edit") {
  const send = vi.fn(() => new Promise(() => {})),
    read = vi.fn(async () => ({
      orgId: "org",
      userId: "user",
      showId: "show",
      timeZone: "UTC",
      snapshot: { ...snapshot, name: "Current server title" },
    }));
  const focus = { active: true },
    Sheet = loadSheet(send, read, focus),
    client = new QueryClient();
  const props = {
    orgId: "org",
    userId: "user",
    initial: managementContract.showDraftFromSnapshot(mode, snapshot, "UTC"),
    onClose: vi.fn(),
  };
  const draw = (open) =>
    React.createElement(
      QueryClientProvider,
      { client },
      open ? React.createElement(Sheet, props) : null,
    );
  return { ...render(draw(true)), props, client, draw, send, read, focus };
}
it("reviews the exact show before deletion and Keep sends nothing", () => {
  const view = setup("delete");
  fireEvent.click(screen.getByRole("button", { name: "Delete show…" }));
  expect(screen.getByText(/Delete Morning on 2099-01-01/)).toBeTruthy();
  expect(view.send).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Keep show" }));
  expect(view.send).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("button", { name: "Delete reviewed show" }),
  ).toBeNull();
});
it("confirmed deletion sends its reviewed version once and survives close", async () => {
  const view = setup("delete");
  fireEvent.click(screen.getByRole("button", { name: "Delete show…" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete reviewed show" }));
  await waitFor(() => expect(view.send).toHaveBeenCalledTimes(1));
  expect(view.send.mock.calls[0][0]).toMatchObject({
    kind: "delete",
    showId: "show",
    expectedUpdatedAt: snapshot.updatedAt,
  });
  fireEvent.click(screen.getByRole("button", { name: "Close show change" }));
  view.rerender(view.draw(false));
  view.rerender(view.draw(true));
  expect(screen.getByText(/Confirming the original deletion/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Delete show…" })).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Discard retained draft…" }),
  ).toBeNull();
});
it("closing an edit retains all fields and sending locks them", async () => {
  const view = setup();
  fireEvent.change(screen.getByLabelText("Show name"), {
    target: { value: "Evening" },
  });
  fireEvent.change(screen.getByLabelText("Venue or location"), {
    target: { value: "Chapel" },
  });
  view.rerender(view.draw(false));
  view.rerender(view.draw(true));
  expect(screen.getByLabelText("Show name").value).toBe("Evening");
  expect(screen.getByLabelText("Venue or location").value).toBe("Chapel");
  fireEvent.click(screen.getByRole("button", { name: "Save show" }));
  await waitFor(() => expect(view.send).toHaveBeenCalledTimes(1));
  expect(screen.getByLabelText("Show name").disabled).toBe(true);
  expect(
    screen.getByRole("button", { name: "Close show change" }).disabled,
  ).toBe(false);
});
it("loading current values requires confirmation and Keep preserves the unsent draft", async () => {
  const view = setup();
  fireEvent.change(screen.getByLabelText("Show name"), {
    target: { value: "Retain this" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Load current show…" }));
  expect(view.read).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Keep draft" }));
  expect(screen.getByLabelText("Show name").value).toBe("Retain this");
  fireEvent.click(screen.getByRole("button", { name: "Load current show…" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Load current and replace draft" }),
  );
  await waitFor(() =>
    expect(screen.getByLabelText("Show name").value).toBe(
      "Current server title",
    ),
  );
  expect(view.send).not.toHaveBeenCalled();
});
it("an unknown deletion offers exact retry without pretending it can be cancelled", async () => {
  const view = setup("delete");
  view.send.mockRejectedValueOnce(new Error("Cleanup unavailable"));
  fireEvent.click(screen.getByRole("button", { name: "Delete show…" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete reviewed show" }));
  await screen.findByRole("button", { name: "Retry original deletion" });
  expect(screen.getByText(/Deletion may already be accepted/)).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Review original save" }),
  ).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Discard retained draft…" }),
  ).toBeNull();
});
it("another action resumes the earlier draft without replacing it", () => {
  const view = setup();
  fireEvent.change(screen.getByLabelText("Show name"), {
    target: { value: "Keep this edit" },
  });
  view.rerender(view.draw(false));
  view.props.initial = { ...view.props.initial, mode: "delete" };
  view.rerender(view.draw(true));
  expect(screen.getByText(/Your earlier edit is retained/)).toBeTruthy();
  expect(screen.getByLabelText("Show name").value).toBe("Keep this edit");
  expect(screen.queryByRole("button", { name: "Delete show…" })).toBeNull();
});
it("leaving the screen cancels an unsubmitted destructive confirmation", () => {
  const view = setup("delete");
  fireEvent.click(screen.getByRole("button", { name: "Delete show…" }));
  view.focus.active = false;
  view.rerender(view.draw(true));
  expect(
    screen.queryByRole("button", { name: "Delete reviewed show" }),
  ).toBeNull();
  expect(view.send).not.toHaveBeenCalled();
});
