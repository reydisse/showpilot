import * as retained from "./native-retained-requests.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import * as React from "react";
import * as queries from "@tanstack/react-query";
import * as deadline from "../../../mobile/src/lib/request-deadline.ts";
import * as contract from "../../../mobile/src/lib/reminder-recovery.ts";
import * as requestIds from "../../../mobile/src/lib/request-id.ts";

// Native and web use different React versions. Execute the unmodified native
// hook with the test renderer's React/Query pair, not two React dispatchers.
const code = ts.transpileModule(
  readFileSync(
    resolve(process.cwd(), "../mobile/src/hooks/use-mobile-reminders.ts"),
    "utf8",
  ),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  },
).outputText;
const modules = {
  "./use-retained-requests": retained,
  react: React,
  "@tanstack/react-query": queries,
  "../lib/reminder-recovery": contract,
  "../lib/request-id": requestIds,
  "../lib/request-deadline": deadline,
};
const exported = {};
new Function("require", "exports", code)((name) => {
  if (!(name in modules))
    throw new Error(`Unmocked native hook import ${name}`);
  return modules[name];
}, exported);
export const useMobileReminders = exported.useMobileReminders;

export const reminderSlot = exported.reminderSlot;
export const reminderRetryable = exported.reminderRetryable;
