import { expect, it } from "vitest";
import { signToken } from "../kiosk-token";
import { inspectCrewChatPass, inspectPlanningChatPass } from "../chat-pass-token";
const secret = "chat-pass-unit-fixture";
const common = () => ({ orgId: "org", orgSlug: "venue", exp: Math.floor(Date.now()/1000)+3600 });
it("distinguishes signature failure from authenticated expiration", async () => {
  const payload = { ...common(), scope: "crew-chat", exp: Math.floor(Date.now()/1000)-1 };
  expect(await inspectCrewChatPass(`chat_${await signToken(payload, secret)}`, secret)).toEqual({ status: "expired" });
  expect(await inspectCrewChatPass(`chat_${await signToken(payload, "other-secret")}`, secret)).toEqual({ status: "invalid" });
});
it.each([undefined, null, "2000000000", Infinity, -1])("rejects invalid/missing Planning expiry %j", async exp => {
  const payload = { ...common(), scope: "planning-chat", roomId: "planning", targetUserIds: ["user"], exp };
  expect(await inspectPlanningChatPass(`planning_chat_${await signToken(payload, secret)}`, secret)).toEqual({ status: "invalid" });
});
it("expires at the exact signed boundary and validates scope before reporting expiry", async () => {
  expect(await inspectCrewChatPass(`chat_${await signToken({ ...common(), scope: "crew-chat", exp: Math.floor(Date.now()/1000) }, secret)}`, secret)).toEqual({ status: "expired" });
  expect(await inspectCrewChatPass(`chat_${await signToken({ ...common(), scope: "kiosk", exp: 1 }, secret)}`, secret)).toEqual({ status: "invalid" });
});
it("requires an intended Planning room and actual recipient identities", async () => {
  for (const fields of [{ roomId: "production", targetUserIds: ["user"] }, { roomId: "planning", targetUserIds: [] }, { roomId: "planning", targetUserIds: [42] }]) {
    expect(await inspectPlanningChatPass(`planning_chat_${await signToken({ ...common(), scope: "planning-chat", ...fields }, secret)}`, secret)).toEqual({ status: "invalid" });
  }
});
it("preserves valid web and mobile token claims without exposing unrelated payload fields", async () => {
  const payload = { ...common(), scope: "planning-chat", roomId: "planning", targetUserIds: ["user"], unrelated: "hidden" };
  expect(await inspectPlanningChatPass(`planning_chat_${await signToken(payload, secret)}`, secret)).toEqual({ status: "valid", pass: { orgId: payload.orgId, orgSlug: payload.orgSlug, exp: payload.exp, targetUserIds: ["user"] } });
  expect(await inspectCrewChatPass(`chat_${await signToken({ ...common(), scope: "crew-chat" }, secret)}`, secret)).toMatchObject({ status: "valid", pass: { orgId: "org", orgSlug: "venue" } });
});
