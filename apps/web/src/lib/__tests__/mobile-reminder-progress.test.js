import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import * as React from "react";
import * as jsx from "react/jsx-runtime";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import * as hook from "../../test/native-reminder-hook.js";
import * as contract from "../../../../mobile/src/lib/reminder-recovery.ts";

// Actual native progress component; replace only native rendering boundaries.
const code = ts.transpileModule(
  readFileSync(
    resolve(
      process.cwd(),
      "../mobile/src/components/schedule-reminder-progress.tsx",
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
const host = ({ children, accessibilityRole }) =>
  React.createElement("div", { role: accessibilityRole }, children);
const modules = {
  "react/jsx-runtime": jsx,
  "react-native": {
    View: host,
    Text: host,
    StyleSheet: { create: (value) => value },
  },
  "./app-button": {
    AppButton: ({ label, onPress, disabled }) =>
      React.createElement("button", { onClick: onPress, disabled }, label),
  },
  "@/theme/tokens": {
    createThemedStyles: () => () => ({}),
    fontFamily: "",
    radii: {},
  },
  "../lib/reminder-recovery": contract,
  "../hooks/use-mobile-reminders": hook,
};
const exported = {};
new Function("require", "exports", code)((name) => {
  if (!(name in modules)) throw new Error(`Unexpected native import ${name}`);
  return modules[name];
}, exported);
afterEach(cleanup);
const command = {
  orgId: "org",
  userId: "user",
  requestId: "cb91c80e-4ef3-4dca-aab2-9acc7f584a2b",
  target: { kind: "show", id: "show" },
};
function setup({
  kind = "confirmed",
  refresh = "done",
  emails = ["accepted"],
  available = true,
} = {}) {
  const result = {
    orgId: command.orgId,
    userId: command.userId,
    requestId: command.requestId,
    items: emails.map((email, i) => ({
      id: String(i),
      label: `Crew ${i}`,
      email,
      inAppDelivered: true,
      reason: null,
      updatedAt: 1,
    })),
  };
  const attempt = {
    command,
    label: "Sunday reminders",
    kind,
    refresh,
    result,
    previous: result,
    at: 1,
    message: "Fixture read failure",
  };
  const reminders = {
    work: { "show:show": attempt },
    retry: vi.fn(),
    refresh: vi.fn(),
    another: vi.fn(),
    dismiss: vi.fn(),
  };
  const draw = () =>
    React.createElement(exported.ScheduleReminderProgress, {
      reminders,
      canSendNew: () => available,
    });
  return { ...render(draw()), reminders, attempt, draw };
}
it("shows every recipient and distinguishes accepted, unknown and rejected email", () => {
  const view = setup({ emails: ["accepted", "uncertain", "failed"] });
  expect(
    screen.getByText("1 of 3 emails accepted by the delivery service."),
  ).toBeTruthy();
  for (let i = 0; i < 3; i++)
    expect(screen.getByText(`Crew ${i}`)).toBeTruthy();
  expect(screen.getByText(/Email acceptance is unknown/)).toBeTruthy();
  expect(screen.getByText(/Email was rejected/)).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Send another reminder" }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry reminders" }));
  expect(view.reminders.retry).toHaveBeenCalledWith("show:show");
});
it("refresh failure keeps the delivery result and offers only a read retry", () => {
  const view = setup({ refresh: "failed" });
  expect(screen.getByRole("alert").textContent).toBe("Fixture read failure");
  expect(screen.getByText(/1 of 1 emails accepted/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Refresh schedule" }));
  expect(view.reminders.refresh).toHaveBeenCalledWith("show:show");
  expect(view.reminders.retry).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("button", { name: "Send another reminder" }),
  ).toBeNull();
});
it("retains previous delivery details while a retry is unconfirmed", () => {
  setup({ kind: "failed", emails: ["accepted", "uncertain"] });
  expect(screen.getByText(/Previous confirmed result: 1 of 2/)).toBeTruthy();
  expect(
    screen.getByText(/Some emails may already have been accepted/),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Retry reminders" })).toBeTruthy();
});
it.each(["expired", "changed"])(
  "%s requires visible review and cannot be dismissed",
  (email) => {
    const view = setup({ emails: [email] });
    expect(
      screen.getByText(/Review the current assignments before sending again/),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Dismiss result" })).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Send new reminders after review" }),
    );
    expect(view.reminders.another).toHaveBeenCalledWith("show:show");
  },
);
it("keeps results visible when the original target is absent and disables fresh delivery", () => {
  setup({ available: false });
  expect(screen.getByText("Sunday reminders")).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Send another reminder" }).disabled,
  ).toBe(true);
  expect(screen.getByText(/Open the original date/)).toBeTruthy();
});
it("pending work offers no second send action", () => {
  setup({ kind: "pending" });
  expect(screen.getByText(/Checking reminder delivery/)).toBeTruthy();
  expect(screen.queryAllByRole("button")).toHaveLength(0);
});
