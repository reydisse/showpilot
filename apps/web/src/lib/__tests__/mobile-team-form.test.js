import * as teamHook from "../../test/native-team-hook.js";
import * as teamContract from "../../../../mobile/src/lib/team-recovery.ts";
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
    "@/hooks/use-mobile-team": teamHook,
    "@/lib/team-recovery": teamContract,
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
  return exports.ScheduleTeamSheet;
}
afterEach(cleanup);
function setup() {
  const alert = vi.fn(),
    Sheet = loadSheet(alert),
    client = new QueryClient();
  const props = {
    orgId: "org",
    userId: "user",
    active: true,
    showId: "show",
    initial: {
      showId: "show",
      serviceDate: "2099-01-01",
      showName: "Sunday",
      timeZone: "UTC",
      department: "",
      rows: [],
    },
    crew: [
      {
        id: "camera",
        name: "Camera crew",
        email: "camera@example.test",
        role: "Camera",
      },
    ],
    onClose: vi.fn(),
    onSave: vi.fn(() => new Promise(() => {})),
    onCommand: vi.fn(() => new Promise(() => {})),
    onRefresh: vi.fn(async () => {}),
  };
  const draw = (open) =>
    React.createElement(
      QueryClientProvider,
      { client },
      open ? React.createElement(Sheet, props) : null,
    );
  return { ...render(draw(true)), props, client, draw };
}
it("retains the selected team, department and edited roles after closing", () => {
  const view = setup();
  fireEvent.change(screen.getByLabelText("Team or department"), {
    target: { value: "Broadcast" },
  });
  fireEvent.click(screen.getByRole("button", { name: /Camera crew/ }));
  fireEvent.change(screen.getByLabelText("Role for Camera crew"), {
    target: { value: "Camera director" },
  });
  view.rerender(view.draw(false));
  view.rerender(view.draw(true));
  expect(screen.getByLabelText("Team or department").value).toBe("Broadcast");
  expect(screen.getByLabelText("Role for Camera crew").value).toBe(
    "Camera director",
  );
});
it("reviews the selected people before sending invitations", async () => {
  const view = setup();
  fireEvent.change(screen.getByLabelText("Team or department"), {
    target: { value: "Broadcast" },
  });
  fireEvent.click(screen.getByRole("button", { name: /Camera crew/ }));
  fireEvent.click(
    screen.getByRole("button", { name: "Create team and send 1 invitation" }),
  );
  await act(async () => {});
  expect(view.props.onSave).not.toHaveBeenCalled();
  expect(
    screen.getByRole("button", { name: "Cancel team creation" }),
  ).toBeTruthy();
});
it("Cancel sends nothing, confirmation locks roles, and reviewed creation sends once", async () => {
  const view = setup();
  fireEvent.change(screen.getByLabelText("Team or department"), {
    target: { value: "Broadcast" },
  });
  fireEvent.click(screen.getByRole("button", { name: /Camera crew/ }));
  fireEvent.click(
    screen.getByRole("button", { name: "Create team and send 1 invitation" }),
  );
  expect(screen.getByLabelText("Role for Camera crew").disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Cancel team creation" }));
  expect(view.props.onCommand).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Role for Camera crew").disabled).toBe(false);
  fireEvent.click(
    screen.getByRole("button", { name: "Create team and send 1 invitation" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Create reviewed team" }));
  await waitFor(() => expect(view.props.onCommand).toHaveBeenCalledTimes(1));
  expect(view.props.onCommand.mock.calls[0][0].operation).toMatchObject({
    kind: "create",
    fields: { crewMemberId: "camera", department: "Broadcast", role: "Camera" },
  });
  expect(screen.getByLabelText("Role for Camera crew").disabled).toBe(true);
  expect(view.props.onClose).not.toHaveBeenCalled();
});
it("keeps unavailable selected people visible instead of silently dropping their draft", () => {
  const view = setup();
  fireEvent.change(screen.getByLabelText("Team or department"), {
    target: { value: "Broadcast" },
  });
  fireEvent.click(screen.getByRole("button", { name: /Camera crew/ }));
  view.props.crew = [];
  view.rerender(view.draw(true));
  expect(screen.getByLabelText("Role for Camera crew").value).toBe("Camera");
  expect(screen.getByText(/roster contact is unavailable/)).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Create team and send 1 invitation" })
      .disabled,
  ).toBe(true);
});
it("losing focus cancels the reviewed invitation confirmation", () => {
  const view = setup();
  fireEvent.change(screen.getByLabelText("Team or department"), {
    target: { value: "Broadcast" },
  });
  fireEvent.click(screen.getByRole("button", { name: /Camera crew/ }));
  fireEvent.click(
    screen.getByRole("button", { name: "Create team and send 1 invitation" }),
  );
  view.props.active = false;
  view.rerender(view.draw(true));
  expect(
    screen.queryByRole("button", { name: "Create reviewed team" }),
  ).toBeNull();
  expect(view.props.onCommand).not.toHaveBeenCalled();
});
