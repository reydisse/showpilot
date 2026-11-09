import { z } from "zod";
import { emailSchema, idSchema } from "./validation";
import { mapColumns, parseCsv } from "./import-members-csv";
export const MAX_CSV_BYTES = 512 * 1024;
export const MAX_CSV_ROWS = 500;
export const csvTextSchema = z
  .string()
  .min(1, "CSV is empty")
  .max(MAX_CSV_BYTES, "CSV too large (max 512 KB)")
  .refine(
    (value) => new TextEncoder().encode(value).byteLength <= MAX_CSV_BYTES,
    "CSV too large (max 512 KB)",
  );
export const csvImportScopeSchema = z.object({
  orgId: idSchema,
  userId: idSchema,
});
export const csvImportContextSchema = csvImportScopeSchema.extend({
  serverTime: z.number(),
});
export const csvImportCommandSchema = csvImportScopeSchema.extend({
  requestId: z.uuid(),
  expiresAt: z.number().int().positive(),
  csv: csvTextSchema,
});
export const csvRowErrorSchema = z.object({
  line: z.number().int().positive(),
  message: z.string(),
});
export const importSummarySchema = z.object({
  imported: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  errors: z.array(csvRowErrorSchema),
});
export const csvImportResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    requestId: z.uuid(),
    outcome: z.literal("applied"),
    summary: importSummarySchema,
  }),
  z.object({
    requestId: z.uuid(),
    outcome: z.enum(["cancelled", "expired", "conflict"]),
  }),
]);
export type CsvImportScope = z.infer<typeof csvImportScopeSchema>;
export type CsvImportCommand = z.infer<typeof csvImportCommandSchema>;
export type CsvImportResult = z.infer<typeof csvImportResultSchema>;
export type ImportSummary = z.infer<typeof importSummarySchema>;
const rowSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100, "Name too long"),
  email: emailSchema,
  role: z.string().trim().max(50, "Role too long"),
});
export function parseCrewImport(csv: string) {
  const text = csvTextSchema.safeParse(csv);
  if (!text.success)
    throw new Error(
      text.error.issues[0]?.message ?? "The CSV could not be read.",
    );
  const rows = parseCsv(text.data);
  if (rows.length < 2)
    throw new Error("CSV needs a header row and at least one data row");
  if (rows.length - 1 > MAX_CSV_ROWS)
    throw new Error(`Too many rows (max ${MAX_CSV_ROWS})`);
  const columns = mapColumns(rows[0]);
  if (columns.name === undefined && columns.firstName === undefined)
    throw new Error('Missing a "name" column (or "First Name"/"Last Name")');
  if (columns.email === undefined) throw new Error('Missing an "email" column');
  const valid: Array<z.infer<typeof rowSchema> & { line: number }> = [],
    errors: ImportSummary["errors"] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i],
      line = i + 1;
    const name =
      columns.name !== undefined
        ? row[columns.name]
        : `${columns.firstName === undefined ? "" : (row[columns.firstName] ?? "")} ${columns.lastName === undefined ? "" : (row[columns.lastName] ?? "")}`.trim();
    const parsed = rowSchema.safeParse({
      name,
      email: (row[columns.email] ?? "").trim().toLowerCase(),
      role: columns.role === undefined ? "" : (row[columns.role] ?? ""),
    });
    if (parsed.success)
      valid.push({ ...parsed.data, role: parsed.data.role || "Crew", line });
    else
      errors.push({
        line,
        message: parsed.error.issues[0]?.message ?? "Invalid row",
      });
  }
  return { valid, errors };
}
