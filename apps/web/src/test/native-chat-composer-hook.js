import * as composer from "@showpilot/shared/chat-composer";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import * as React from "react";
import * as queries from "@tanstack/react-query";
const code = ts.transpileModule(readFileSync(resolve(process.cwd(), "../mobile/src/hooks/use-chat-composer.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const modules = { react: React, "@tanstack/react-query": queries, "@showpilot/shared/chat-composer": composer }, exported = {};
new Function("require", "exports", code)(name => { if (!(name in modules)) throw new Error(`Unmocked native import ${name}`); return modules[name]; }, exported);
export const useChatComposer = exported.useChatComposer;
