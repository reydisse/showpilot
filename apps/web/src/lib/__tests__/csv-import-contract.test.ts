import { expect, it } from "vitest";
import {
  csvTextSchema,
  MAX_CSV_BYTES,
  parseCrewImport,
} from "../csv-import-contract";
it("bounds UTF-8 bytes as well as character count", () => {
  expect(csvTextSchema.safeParse("a".repeat(MAX_CSV_BYTES)).success).toBe(true);
  expect(
    csvTextSchema.safeParse("é".repeat(MAX_CSV_BYTES / 2 + 1)).success,
  ).toBe(false);
  expect(() => parseCrewImport("é".repeat(MAX_CSV_BYTES / 2 + 1))).toThrow(
    new Error("CSV too large (max 512 KB)"),
  );
});
it("rejects missing columns and excess rows before any import", () => {
  expect(() => parseCrewImport("name\nJane")).toThrow(
    'Missing an "email" column',
  );
  expect(() =>
    parseCrewImport(
      "name,email\n" +
        Array.from(
          { length: 501 },
          (_, i) => `Person ${i},p${i}@import.invalid`,
        ).join("\n"),
    ),
  ).toThrow("max 500");
});
