import { describe, expect, it } from "vitest";
import {
  rundownItemNumbers,
  spreadsheetSafeCsvCell,
  spreadsheetSafeText,
} from "@showpilot/shared";

describe("shared export contract", () => {
  it.each([
    "=1+2",
    "+cmd",
    "-2+3",
    "@SUM(A1:A2)",
    "  =1+2",
    "\t+1+2",
  ])("neutralizes formula-like text without changing stored input: %j", (value) => {
    expect(spreadsheetSafeText(value)).toBe(`'${value}`);
    expect(spreadsheetSafeCsvCell(value)).toBe(`"'${value.replace(/"/g, '""')}"`);
  });

  it("leaves ordinary symbols and sentences intact", () => {
    expect(spreadsheetSafeText("Audio - FOH")).toBe("Audio - FOH");
    expect(spreadsheetSafeText("1+2")).toBe("1+2");
  });

  it("numbers the same rundown hierarchy for every client", () => {
    const numbers = rundownItemNumbers([
      { id: "a", type: "segment" },
      { id: "h1", type: "header" },
      { id: "b", type: "song" },
      { id: "c", type: "segment" },
      { id: "h2", type: "header" },
      { id: "d", type: "segment" },
    ]);
    expect([...numbers.values()]).toEqual(["1", "2", "2.1", "2.2", "3", "3.1"]);
  });
});

// Runtime entry-point guard: both web and Metro import this exact package root.
import * as shared from "@showpilot/shared";
it("exports the complete workspace contract", () => {
  for (const key of [
    "WORKSPACE_TYPES",
    "WORKSPACE_SETTING_KEYS",
    "MODULE_IDS",
    "TERM_KEYS",
    "CORE_MODULES",
    "WORKSPACE_DEFINITIONS",
    "WORKSPACE_MODULES",
    "DEFAULT_WORKSPACE_MODULES",
    "WORKSPACE_TERMS",
    "MODULE_SURFACES",
    "isWorkspaceType",
    "isModuleId",
    "isWorkspaceTerm",
    "resolveWorkspaceType",
    "resolveWorkspaceProfile",
    "resolveModules",
    "resolveTerms",
    "parseWorkspaceCustom",
    "legacyTerminologyProfile",
    "legacyWorkspaceType",
    "moduleForSurface",
    "orgTerms",
    "workspaceCopy",
  ] as const)
    expect(shared[key]).toBeDefined();
});
