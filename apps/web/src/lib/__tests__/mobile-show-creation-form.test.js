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
import * as creationHook from "../../test/native-show-creation-hook.js";
import * as creationContract from "../../../../mobile/src/lib/show-creation-recovery.ts";
import * as serviceTime from "../../../../mobile/src/lib/service-time.ts";
import * as queries from "@tanstack/react-query";
import * as requestIds from "../../../../mobile/src/lib/request-id.ts";

// Execute the actual native sheet. Only native rendering/device boundaries are
// replaced; draft state, submission and confirmation logic remain production code.
const source = readFileSync(
  resolve(process.cwd(), "../mobile/src/components/show-creation-sheet.tsx"),
  "utf8",
);
const code = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.ReactJSX,
  },
}).outputText;
function loadSheet(send, navigate) {
  const container = ({ children }) =>
    React.createElement("div", null, children);
  const modules = {
    "@/hooks/use-show-creation": creationHook,
    "@/hooks/use-screen-polling": { useScreenFocus: () => true },
    "@/lib/show-creation-recovery": creationContract,
    "@/lib/mobile-api": { commandMobileShowCreation: send },
    "@tanstack/react-query": queries,
    "expo-router": { router: { push: navigate } },
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
  return exports.ShowCreationSheet;
}
afterEach(cleanup);

function setup() {
  const send = vi.fn(() => new Promise(() => {}));
  const navigate = vi.fn(),
    Sheet = loadSheet(send, navigate),
    client = new QueryClient();
  const props = {
    orgId: "org",
    userId: "user",
    initial: {
      serviceDate: "2099-01-01",
      timeZone: "UTC",
      name: "Morning",
      startTime: "09:00",
      callTime: "",
      location: "Main",
      source: { kind: "blank" },
    },
    shows: [
      {
        id: "source",
        serviceDate: "2098-12-25",
        name: "Previous",
        scheduledStartTime: "2098-12-25T09:30:00.000Z",
        scheduledCallTime: "2098-12-25T08:00:00.000Z",
        location: "Stage",
      },
    ],
    inventory: [
      {
        id: "template",
        name: "Inventory show",
        defaultStartTime: "11:00",
        location: "Chapel",
      },
    ],
    onClose: vi.fn(),
  };
  const draw = (open) =>
    React.createElement(
      QueryClientProvider,
      { client },
      open ? React.createElement(Sheet, props) : null,
    );
  return { ...render(draw(true)), props, client, draw, send, navigate };
}
it("closing and reopening retains fields, including selected inventory defaults", () => {
  const view = setup();
  fireEvent.click(
    screen.getByRole("button", { name: "Use inventory: Inventory show" }),
  );
  fireEvent.change(screen.getByLabelText("Show name"), {
    target: { value: "My evening" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Close create show" }));
  expect(view.props.onClose).toHaveBeenCalledTimes(1);
  view.rerender(view.draw(false));
  view.rerender(view.draw(true));
  expect(screen.getByLabelText("Show name").value).toBe("My evening");
  expect(screen.getByLabelText("Start time (optional)").value).toBe("11:00");
  expect(screen.getByLabelText("Venue or location").value).toBe("Chapel");
});
it("keeps a missing source explicit and sends its original identity instead of silently creating blank", async () => {
  const view = setup();
  fireEvent.click(
    screen.getByRole("button", { name: /Copy rundown: Previous/ }),
  );
  view.props.shows = [];
  view.rerender(view.draw(true));
  expect(screen.getByText(/source is not in the current list/)).toBeTruthy();
  expect(screen.getByLabelText("Crew call (optional)").value).toBe("08:00");
  fireEvent.click(screen.getByRole("button", { name: "Create show" }));
  await waitFor(() => expect(view.send).toHaveBeenCalledTimes(1));
  expect(view.send.mock.calls[0][0]).toMatchObject({
    copyFrom: "2098-12-25",
    copyFromShowId: "source",
  });
  expect(screen.getByLabelText("Show name").disabled).toBe(true);
  expect(screen.getByRole("button", { name: "Start blank" }).disabled).toBe(
    true,
  );
  expect(
    screen.getByRole("button", { name: "Close create show" }).disabled,
  ).toBe(false);
});
it("invalid dates and call times disable creation without submitting", () => {
  const view = setup();
  fireEvent.change(screen.getByLabelText("Crew call (optional)"), {
    target: { value: "25:00" },
  });
  expect(screen.getByRole("button", { name: "Create show" }).disabled).toBe(
    true,
  );
  fireEvent.change(screen.getByLabelText("Crew call (optional)"), {
    target: { value: "08:00" },
  });
  fireEvent.change(screen.getByLabelText("Show date"), {
    target: { value: "2099-02-30" },
  });
  expect(screen.getByRole("button", { name: "Create show" }).disabled).toBe(
    true,
  );
  expect(view.send).not.toHaveBeenCalled();
});
it("discard requires explicit confirmation and Keep preserves the draft", () => {
  const view = setup();
  fireEvent.click(screen.getByRole("button", { name: "Discard…" }));
  expect(view.props.onClose).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Keep draft" }));
  expect(screen.getByLabelText("Show name").value).toBe("Morning");
  expect(view.send).not.toHaveBeenCalled();
});
it("unknown creation keeps the form locked and exposes retry and review", async () => {
  const view = setup();
  view.send.mockRejectedValueOnce(new Error("Reply lost"));
  fireEvent.click(screen.getByRole("button", { name: "Create show" }));
  await screen.findByRole("button", { name: "Retry original creation" });
  expect(
    screen.getByRole("button", { name: "Review original creation" }),
  ).toBeTruthy();
  expect(screen.getByLabelText("Show name").disabled).toBe(true);
  expect(screen.queryByRole("button", { name: "Discard…" })).toBeNull();
});
