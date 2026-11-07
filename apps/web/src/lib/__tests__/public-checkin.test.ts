import { expect, it } from "vitest";
import { publicAttendanceWriteSchema, publicMemberLookupSchema } from "../public-checkin";

it("normalizes a freshly entered ID and bounds public lookup input", () => {
  expect(publicMemberLookupSchema.parse({ slug: "fixture", memberId: " td3917 " })).toEqual({ slug: "fixture", memberId: "TD3917" });
  expect(publicMemberLookupSchema.safeParse({ slug: "fixture", memberId: " " }).success).toBe(false);
  expect(publicMemberLookupSchema.safeParse({ slug: "fixture", memberId: "a".repeat(65) }).success).toBe(false);
});
it("rejects unconditional legacy writes and requires a lookup revision with a request ID", () => {
  const write = { slug: "fixture", memberId: "TD3917", intent: "check-in" };
  expect(publicAttendanceWriteSchema.safeParse(write).success).toBe(false);
  expect(publicAttendanceWriteSchema.safeParse({ ...write, requestId: crypto.randomUUID(), expectedRevision: "a".repeat(64) }).success).toBe(true);
});
