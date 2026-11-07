import { expect, it } from "vitest";
import { safeAuthReturnTo, verificationEmailCallback, verificationHref } from "../auth-navigation";
it.each(["/", "/setup?mode=new", "/delete-account?token=abc123", "/venue/chat?room=planning#message-5", "/venue/timecode?showId=abc", "/invite/abc", "/venue/assets?search=Hello%20world"])("preserves an app destination: %s", path => {
  expect(safeAuthReturnTo(path)).toBe(path);
});
it.each([undefined, null, 123, {}, "", "https://other.test/path", "https://auth-return.invalid/path", "//other.test", "/\\other.test", "/..//other.test", "/%2fother.test", "/%5cother.test", "/%0a/other.test", "/\t/other.test", "/bad%xx", "/api/auth/sign-out", "/%61pi/auth/sign-out", "/_serverFn/execute", "/login", "/verify-email?returnTo=/verify-email", "/reset-password?token=x", "/forgot-password", "/" + "a".repeat(2048)])("rejects external, ambiguous, recursive or action destinations: %j", path => {
  expect(safeAuthReturnTo(path)).toBeUndefined();
});
it("keeps verification as the email landing page while carrying a safe deep link", () => {
  const target = "/venue/chat?room=planning#message-5";
  const callback = verificationHref(target);
  expect(callback).toBe("/verify-email?returnTo=%2Fvenue%2Fchat%3Froom%3Dplanning%23message-5");
  expect(verificationEmailCallback(callback, "https://app.showpilot.tech")).toBe(callback);
  expect(verificationEmailCallback(`https://app.showpilot.tech${callback}`, "https://app.showpilot.tech")).toBe(callback);
  for (const other of ["https://other.test" + callback, "/venue/chat", "/verify-email?returnTo=//other.test", "/verify-email?returnTo=/api/auth/sign-out", null]) {
    expect(verificationEmailCallback(other, "https://app.showpilot.tech")).toBe("/verify-email");
  }
  expect(verificationHref("https://other.test")).toBe("/verify-email");
});
it("preserves a bounded Planning invite carrying fifty recipient IDs", async () => {
  const { signToken } = await import("../kiosk-token");
  const token = `planning_chat_${await signToken({ scope: "planning-chat", orgId: "org", orgSlug: "venue", roomId: "planning", exp: 2000000000, targetUserIds: Array.from({ length: 50 }, () => crypto.randomUUID()) }, "navigation-fixture")}`;
  const destination = `/join/chat/planning/${token}`;
  expect(destination.length).toBeGreaterThan(2048);
  expect(safeAuthReturnTo(destination)).toBe(destination);
});
it.each(["/join/chat/planning/" + "a".repeat(3000), "/join/chat/planning/planning_chat_" + "a".repeat(8200) + ".b.c", "/join/chat/planning/planning_chat_" + "a".repeat(3000) + ".b.c?next=//elsewhere"])("rejects unbounded or ambiguous long invite destinations", path => {
  expect(safeAuthReturnTo(path)).toBeUndefined();
});
