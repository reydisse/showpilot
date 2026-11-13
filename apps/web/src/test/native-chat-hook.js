import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import * as React from "react";
import * as queries from "@tanstack/react-query";
import * as history from "../../../mobile/src/lib/chat-history.ts";
import * as deadline from "../../../mobile/src/lib/request-deadline.ts";
import * as notification from "@showpilot/shared/chat-notification";
import * as ids from "../../../mobile/src/lib/request-id.ts";
// Execute the unchanged native hook with the renderer's React/Query pair.
export function loadChatHook(transport, AppState, fetch, notifyMobileChat = async input => ({ ...input, notified: 1 })) {
  const code = ts.transpileModule(readFileSync(resolve(process.cwd(), "../mobile/src/hooks/use-chat-relay.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const modules = { react: React, "@tanstack/react-query": queries, "expo/fetch": { fetch }, "react-native": { AppState },
    "@/lib/auth-transport": transport, "@/lib/chat-history": history, "@/lib/env": { SHOWPILOT_URL: "https://fixture.invalid" },
    "../lib/mobile-api": { notifyMobileChat }, "@showpilot/shared/chat-notification": notification, "../lib/request-deadline": deadline, "../lib/request-id": ids };
  const exported = {};
  new Function("require", "exports", code)(name => {
    if (!(name in modules)) throw new Error(`Unmocked native import ${name}`);
    return modules[name];
  }, exported);
  return exported.useChatRelay;
}
