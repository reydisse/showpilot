import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import * as React from "react";
import * as jsx from "react/jsx-runtime";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { usePersonalResponses } from "../../test/native-personal-responses.js";
import * as contract from "../../../../mobile/src/lib/personal-response-recovery.ts";
const code = ts.transpileModule(
  readFileSync(
    resolve(
      process.cwd(),
      "../mobile/src/components/personal-response-progress.tsx",
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
).outputText;
const container = ({ children }) => React.createElement("div", null, children);
const modules = {
  react: React,
  "react/jsx-runtime": jsx,
  "react-native": {
    View: container,
    Text: container,
    StyleSheet: { create: (v) => v },
  },
  "./app-button": {
    AppButton: ({ label, onPress, disabled }) =>
      React.createElement("button", { onClick: onPress, disabled }, label),
  },
  "./app-field": {
    AppField: ({ label, value, onChangeText, editable }) =>
      React.createElement(
        "label",
        null,
        label,
        React.createElement("input", {
          value,
          disabled: !editable,
          onChange: (e) => onChangeText(e.target.value),
        }),
      ),
  },
  "@/theme/tokens": {
    createThemedStyles: () => () => ({}),
    fontFamily: {},
    radii: {},
  },
  "../lib/personal-response-recovery": contract,
};
const exported = {};
new Function("require", "exports", code)((name) => {
  if (!(name in modules)) throw new Error(`Unmocked ${name}`);
  return modules[name];
}, exported);
const Progress = exported.PersonalResponseProgress;
const selection = {
  assignmentId: "assignment",
  expectedRevision: "revision",
  reviewedVersion: "[1]",
  label: "Audio Sunday",
};
const reply = (command, outcome = "applied") => ({
  orgId: command.orgId,
  userId: command.userId,
  requestId: command.requestId,
  assignmentId: command.assignmentId,
  outcome,
});
const clients = [];
function setup(
  send = vi.fn(async (command) => reply(command)),
  refresh = async () => {},
) {
  const client = new QueryClient();
  clients.push(client);
  function App({ active = true }) {
    const responses = usePersonalResponses(
      { orgId: "org", userId: "user" },
      { enabled: active, send, refresh },
    );
    return jsx.jsxs(QueryClientProvider, {
      client,
      children: [
        jsx.jsx("button", {
          onClick: () => responses.decline(selection),
          children: "Decline",
        }),
        jsx.jsx("button", {
          onClick: () => responses.accept(selection),
          children: "Accept",
        }),
        jsx.jsx(Progress, {
          responses,
          latest: () => ({
            ...selection,
            label: "Camera Sunday",
            expectedRevision: "new",
          }),
        }),
      ],
    });
  }
  const view = render(jsx.jsx(App, {}), {
    wrapper: ({ children }) =>
      jsx.jsx(QueryClientProvider, { client, children }),
  });
  return { send, view, App };
}
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
});
const button = (name) => screen.getByRole("button", { name, exact: true });
it("keeps a note until explicit discard and sends no response for cancellation", () => {
  const { send } = setup();
  fireEvent.click(button("Decline"));
  fireEvent.change(screen.getByLabelText("Reason for declining Audio Sunday"), {
    target: { value: "Away" },
  });
  fireEvent.click(button("Discard response draft…"));
  fireEvent.click(button("Keep note"));
  expect(screen.getByLabelText("Reason for declining Audio Sunday").value).toBe(
    "Away",
  );
  fireEvent.click(button("Discard response draft…"));
  fireEvent.click(button("Discard note"));
  expect(
    screen.queryByLabelText("Reason for declining Audio Sunday"),
  ).toBeNull();
  expect(send).not.toHaveBeenCalled();
});
it("locks notes during unknown outcomes and offers original retry and review", async () => {
  const { send } = setup(
    vi.fn(async () => {
      throw new Error("Lost reply");
    }),
  );
  fireEvent.click(button("Decline"));
  fireEvent.change(screen.getByLabelText("Reason for declining Audio Sunday"), {
    target: { value: "Away" },
  });
  fireEvent.click(button("Confirm decline"));
  await screen.findByRole("button", { name: "Retry original response" });
  expect(
    screen.getByLabelText("Reason for declining Audio Sunday").disabled,
  ).toBe(true);
  expect(button("Review original response")).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Discard response draft…" }),
  ).toBeNull();
  expect(send).toHaveBeenCalledTimes(1);
});
it("keeps the confirmed outcome visible while refreshing without another response", async () => {
  const refresh = vi
    .fn()
    .mockRejectedValueOnce(new Error("Read failed"))
    .mockResolvedValue(undefined);
  const { send } = setup(undefined, refresh);
  fireEvent.click(button("Accept"));
  await screen.findByText("Your response was saved.");
  await screen.findByRole("button", { name: "Refresh response status" });
  fireEvent.click(button("Refresh response status"));
  await screen.findByRole("button", { name: "Finish response" });
  expect(send).toHaveBeenCalledTimes(1);
});
it("requires explicit current-details review and preserves the note", async () => {
  const send = vi.fn(async (command) => reply(command, "conflict"));
  setup(send);
  fireEvent.click(button("Decline"));
  fireEvent.change(screen.getByLabelText("Reason for declining Audio Sunday"), {
    target: { value: "My note" },
  });
  fireEvent.click(button("Confirm decline"));
  await screen.findByRole("button", { name: "Review latest assignment…" });
  fireEvent.click(button("Review latest assignment…"));
  fireEvent.click(button("Keep note"));
  expect(screen.getByLabelText("Reason for declining Audio Sunday").value).toBe(
    "My note",
  );
  fireEvent.click(button("Review latest assignment…"));
  fireEvent.click(button("Use current assignment"));
  expect(
    screen.getByLabelText("Reason for declining Camera Sunday").value,
  ).toBe("My note");
  expect(send).toHaveBeenCalledTimes(1);
});
it("cancels a discard confirmation when the screen loses focus", async () => {
  const { view, App } = setup();
  fireEvent.click(button("Decline"));
  fireEvent.click(button("Discard response draft…"));
  view.rerender(jsx.jsx(App, { active: false }));
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Discard note" })).toBeNull(),
  );
  expect(
    screen.getByLabelText("Reason for declining Audio Sunday"),
  ).toBeTruthy();
});
