import { describe, it, expect } from "vitest";
import { parseCsv, mapColumns } from "@/lib/import-members-csv";

describe("parseCsv", () => {
  it("parses simple rows", () => {
    expect(parseCsv("name,email\nJane,jane@x.com\n")).toEqual([
      ["name", "email"],
      ["Jane", "jane@x.com"],
    ]);
  });

  it("handles quoted fields with commas and escaped quotes", () => {
    expect(parseCsv('name,notes\n"Smith, Jane","says ""hi"""')).toEqual([
      ["name", "notes"],
      ["Smith, Jane", 'says "hi"'],
    ]);
  });

  it("handles CRLF line endings and skips blank lines", () => {
    expect(parseCsv("a,b\r\n1,2\r\n\r\n3,4\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
  });
});

describe("mapColumns", () => {
  it("maps simple name,email,role headers case-insensitively", () => {
    expect(mapColumns(["Name", "Email", "Role"])).toEqual({
      name: 0,
      email: 1,
      role: 2,
    });
  });

  it("maps Planning Center export headers", () => {
    expect(mapColumns(["First Name", "Last Name", "Email Address", "Position"])).toEqual({
      firstName: 0,
      lastName: 1,
      email: 2,
      role: 3,
    });
  });

  it("ignores unknown columns", () => {
    expect(mapColumns(["name", "email", "Birthday"])).toEqual({ name: 0, email: 1 });
  });
});
