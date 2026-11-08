import * as reminderContract from "../../../../mobile/src/lib/reminder-recovery.ts";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import * as React from "react";
import * as jsx from "react/jsx-runtime";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import * as hook from "../../test/native-copy-hook.js";
import * as contract from "../../../../mobile/src/lib/copy-recovery.ts";

// Actual native progress component; replace only native rendering boundaries.
const code = ts.transpileModule(
  readFileSync(
    resolve(
      process.cwd(),
      "../mobile/src/components/schedule-copy-progress.tsx",
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
  "../lib/reminder-recovery": reminderContract,
  "../lib/copy-recovery": contract,
  "../hooks/use-mobile-copy": hook,
};
const exported = {};
new Function("require", "exports", code)((name) => {
  if (!(name in modules)) throw new Error(`Unexpected native import ${name}`);
  return modules[name];
}, exported);
afterEach(cleanup);
function setup({
  kind = "confirmed",
  refresh = "done",
  changed = false,
  email = "accepted",
  reason = null,
  available = false,
} = {}) {
  const command = {
    orgId: "org",
    userId: "user",
    requestId: "cc91c80e-4ef3-4dca-aab2-9acc7f584a2b",
    showId: "target",
    serviceDate: "2099-01-08",
    copyFromShowId: "source",
    copyFrom: "2099-01-01",
  };
  const result = {
    ...command,
    copied: reason ? 0 : 1,
    reason,
    items: reason
      ? []
      : [
          {
            id: "position",
            label: "Video · Camera",
            changed,
            invitation: changed
              ? null
              : {
                  id: "position",
                  label: "Video · Camera",
                  email,
                  inAppDelivered: true,
                  reason: null,
                  updatedAt: 1,
                },
          },
        ],
  };
  const attempt = {
    command,
    label: "Previous show → Sunday",
    kind,
    refresh,
    result,
    previous: result,
    at: 1,
    message: "Fixture read failure",
  };
  const copies = {
    work: { target: attempt },
    retry: vi.fn(),
    refresh: vi.fn(),
    another: vi.fn(),
    dismiss: vi.fn(),
  };
  const onCopyAgain = vi.fn();
  render(
    React.createElement(exported.ScheduleCopyProgress, {
      copies,
      canCopyAgain: () => available,
      onCopyAgain,
    }),
  );
  return { copies, onCopyAgain };
}
it("shows per-position invitation uncertainty and offers exact retry", () => {
  const view = setup({ email: "uncertain" });
  expect(screen.getByText("Video · Camera")).toBeTruthy();
  expect(
    screen.getByText(
      /Email acceptance is unknown. Retry checks the same invitation/,
    ),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry team copy" }));
  expect(view.copies.retry).toHaveBeenCalledWith("target");
  expect(
    screen.queryByRole("button", { name: "Dismiss copy result" }),
  ).toBeNull();
});
it("a failed refresh preserves copy results and retries only the read", () => {
  const view = setup({ refresh: "failed" });
  expect(
    screen.getByText(/Email accepted by the delivery service/),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Refresh copied team" }));
  expect(view.copies.refresh).toHaveBeenCalledWith("target");
  expect(view.copies.retry).not.toHaveBeenCalled();
});
it("a changed position remains visible without a recopy claim", () => {
  setup({ changed: true });
  expect(screen.getByText(/position changed or was removed/)).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Review and copy again" }).disabled,
  ).toBe(true);
});
it("a blocked copy explains why and requires another explicit review", () => {
  const view = setup({ reason: "live-show", available: true });
  expect(screen.getByRole("alert").textContent).toMatch(/live or paused/);
  fireEvent.click(
    screen.getByRole("button", { name: "Review and copy again" }),
  );
  expect(view.onCopyAgain).toHaveBeenCalledWith("target");
  expect(view.copies.another).not.toHaveBeenCalled();
});
it("unconfirmed copies retain previous results and cannot be dismissed", () => {
  setup({ kind: "failed" });
  expect(
    screen.getByText(/Some positions and invitations may already be saved/),
  ).toBeTruthy();
  expect(screen.getByText("Previous confirmed result:")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Retry team copy" })).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Dismiss copy result" }),
  ).toBeNull();
});
