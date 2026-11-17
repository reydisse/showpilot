import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it } from "vitest";
import { plainFailure } from "@showpilot/shared/ui-feedback";

it("displays notification recovery copy while retaining the receipt rejection signal", () => {
  const code = ts.transpileModule(readFileSync("../mobile/src/components/chat-delivery-status.tsx", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const modules = {
    react: React,
    "react/jsx-runtime": { jsx: (type, props, key) => React.createElement(type, { ...props, key }), jsxs: (type, props, key) => React.createElement(type, { ...props, key }) },
    "react-native": { StyleSheet: { create: x => x }, Text: "span", View: "div" },
    "@showpilot/shared/ui-feedback": { plainFailure },
    "@/components/quiet-activity": { QuietActivity: () => null },
    "@/components/failure-text": { FailureText: ({ children }) => React.createElement("span", null, children) },
    "./app-button": { AppButton: () => null },
    "../theme/tokens": { createThemedStyles: () => () => ({}), fontFamily: "" },
  };
  const exported = {};
  new Function("require", "exports", code)(name => {
    if (!(name in modules)) throw new Error(`Unmocked native import ${name}`);
    return modules[name];
  }, exported);
  const error = "The notification result belongs to another message or account.";
  const html = renderToStaticMarkup(React.createElement(exported.ChatDeliveryStatus, {
    items: [{ id: "message", kind: "notification-failed", text: "Hello", error }], connected: true,
  }));
  expect(html).toContain("Crew notifications were not confirmed. Retry notifications without sending the message again.");
  expect(html).not.toContain(error);
});
