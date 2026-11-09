import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { parseOrThrow } from "./validation";
import {
  csvImportCommandSchema,
  csvImportScopeSchema,
} from "./csv-import-contract";
import { readCsvImportContext, writeCsvImport } from "./csv-import.server";
export type { ImportSummary } from "./csv-import-contract";
export const getCsvImportContext = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => parseOrThrow(csvImportScopeSchema, data))
  .handler(({ data }) => readCsvImportContext(getRequestHeaders(), data));
export const importMembersCsv = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(csvImportCommandSchema, data))
  .handler(({ data }) => writeCsvImport(getRequestHeaders(), data, "write"));
export const reviewCsvImport = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(csvImportCommandSchema, data))
  .handler(({ data }) => writeCsvImport(getRequestHeaders(), data, "review"));
