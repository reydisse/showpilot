import { expect, it } from "vitest";
import { parseProPresenterFeedEvent } from "../propresenter-client";
it("distinguishes explicit clear from invalid or partial events", () => {
  expect(parseProPresenterFeedEvent("null", 1)).toEqual({ kind: "clear" });
  expect(parseProPresenterFeedEvent('{"text":""}', 1)).toEqual({ kind: "clear" });
  for (const value of ["broken", "{}", '{"status":"offline"}', '{"text":null}']) expect(parseProPresenterFeedEvent(value, 1)).toBeNull();
});
it("retains current/next identity and permits only public slide fields", () => {
  const event = parseProPresenterFeedEvent(JSON.stringify({ text: "Current", nextText: "Upcoming", slideId: "one", nextSlideId: "two", pn: "Service", password: "never-forward", credentials: { secret: "private" } }), 12);
  expect(event).toMatchObject({ kind: "slide", slide: { text: "Current", nextText: "Upcoming", slideId: "one", nextSlideId: "two", presentationName: "Service", receivedAt: 12 } });
  expect(JSON.stringify(event)).not.toMatch(/never-forward|private|credentials|password/);
});
