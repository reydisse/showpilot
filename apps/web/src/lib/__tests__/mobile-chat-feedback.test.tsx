import * as React from "react";
import * as runtime from "react/jsx-runtime";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { plainFailure } from "@showpilot/shared/ui-feedback";

// Render the real native components; only native host views and theme bindings
// are replaced. No transport, outbox, receipt, or ownership logic is mocked in.
const colors = { text: "white", textMuted: "gray", amberText: "orange", border: "gray", panelStrong: "black" };
const modules: Record<string, unknown> = {
  react: React,
  "react/jsx-runtime": runtime,
  "react-native": {
    StyleSheet: { create: (value: unknown) => value },
    Text: ({ children, accessibilityRole }: any) => <span role={accessibilityRole}>{children}</span>,
    View: ({ children, testID }: any) => <div data-testid={testID}>{children}</div>,
    ActivityIndicator: ({ accessibilityLabel }: any) => <span role="progressbar" aria-label={accessibilityLabel} />,
  },
  "@showpilot/shared/ui-feedback": { plainFailure },
  "../theme/tokens": { fontFamily: "Fixture", createThemedStyles: (factory: any) => () => factory(colors) },
  "@/theme/tokens": { useAppTheme: () => ({ colors }) },
  "./app-button": { AppButton: ({ label, onPress, disabled }: any) => <button disabled={disabled} onClick={onPress}>{label}</button> },
};
function load(file: string) {
  const code = ts.transpileModule(readFileSync(resolve(process.cwd(), "../mobile/src/", file), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports: Record<string, any> = {};
  new Function("require", "exports", code)((name: string) => { if (!(name in modules)) throw Error(`Unexpected native boundary ${name}`); return modules[name]; }, exports);
  return exports;
}
modules["@/components/quiet-activity"] = load("components/quiet-activity.tsx");
modules["@/components/failure-text"] = load("components/failure-text.tsx");
const Status = load("components/chat-delivery-status.tsx").ChatDeliveryStatus as React.ComponentType<any>;
const message = { id: "fixture-message", text: "Please check camera one", createdAt: 1, frame: "fixture-frame", notification: {} };
afterEach(cleanup);
it.each(["queued", "sending"])("keeps the user's %s message visible with one quiet indicator", kind => {
  const discard = vi.fn(); render(<Status items={[{ ...message, kind }]} connected={false} retry={vi.fn()} retryNotifications={vi.fn()} discard={discard} />);
  expect(screen.getAllByText(message.text)).toHaveLength(1);
  expect(screen.getAllByRole("progressbar", { name: "Sending message" })).toHaveLength(1);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText(/queued|reconnect|sending/i)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Remove from outbox" }));
  expect(discard).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Confirm remove from outbox" }));
  expect(discard).toHaveBeenCalledExactlyOnceWith(message.id);
});
it("shows an uncertain message failure once and retries only its original request", () => {
  const retry = vi.fn(); render(<Status items={[{ ...message, kind: "uncertain", error: "Relay acknowledgement timed out" }]} connected retry={retry} retryNotifications={vi.fn()} discard={vi.fn()} />);
  expect(screen.getAllByRole("alert")).toHaveLength(1);
  expect(screen.getByRole("alert").textContent).toBe("This message needs attention.");
  fireEvent.click(screen.getByRole("button", { name: "Retry original message" }));
  expect(retry).toHaveBeenCalledExactlyOnceWith(message.id);
});
