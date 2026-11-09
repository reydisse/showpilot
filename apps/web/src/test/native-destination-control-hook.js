import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import * as React from "react";
import * as queries from "@tanstack/react-query";
import * as deadline from "../../../mobile/src/lib/request-deadline.ts";
import * as contract from "@showpilot/shared/destination-control";
import * as shared from "@showpilot/shared";
import * as retained from "./native-retained-requests.js";
import * as requestIds from "../../../mobile/src/lib/request-id.ts";

// Native and web use different React versions. Execute the unmodified native
// hook with the test renderer's React/Query pair, not two React dispatchers.
const code = ts.transpileModule(
  readFileSync(
    resolve(process.cwd(), "../mobile/src/hooks/use-destination-control.ts"),
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
  react: React,
  "@showpilot/shared": shared,
  "./use-retained-requests": retained,
  "@tanstack/react-query": queries,
  "@showpilot/shared/destination-control": contract,
  "../lib/request-id": requestIds,
  "../lib/request-deadline": deadline,
};
const exported = {};
new Function("require", "exports", code)((name) => {
  if (!(name in modules))
    throw new Error(`Unmocked native hook import ${name}`);
  return modules[name];
}, exported);
export const useDestinationControl = exported.useDestinationControl;
