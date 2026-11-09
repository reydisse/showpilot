import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import * as React from "react";
import * as queries from "@tanstack/react-query";
import * as sha2 from "@noble/hashes/sha2.js";
import * as drafts from "@showpilot/shared/chat-attachment-draft";
import * as contracts from "@showpilot/shared/chat-attachment";
const code = ts.transpileModule(readFileSync(resolve(process.cwd(), "../mobile/src/hooks/use-chat-attachments.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
export function loadNativeAttachmentHook({ File, manipulate, upload, cancel, platform = "ios", fetch }) {
  const modules = {
    react: React, "@tanstack/react-query": queries, "react-native": { Platform: { OS: platform } },
    "expo-file-system": { File }, "expo/fetch": { fetch },
    "expo-image-manipulator": { manipulateAsync: manipulate, SaveFormat: { JPEG: "jpeg" } },
    "@noble/hashes/sha2.js": sha2, "@showpilot/shared/chat-attachment-draft": drafts,
    "@showpilot/shared/chat-attachment": contracts,
    "../lib/mobile-api": { uploadMobileChatAttachment: upload, cancelMobileChatUpload: cancel },
    "../lib/request-id": { createLocalRequestUuid: () => crypto.randomUUID() },
  }, exported = {};
  new Function("require", "exports", code)(name => { if (!(name in modules)) throw new Error(`Unmocked native attachment import ${name}`); return modules[name]; }, exported);
  return exported.useChatAttachments;
}
