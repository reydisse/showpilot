import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useChatComposer } from "../../test/native-chat-composer-hook.js";
afterEach(cleanup);
const scope = { user: "operator", org: "org", room: "production" };
function setup() {
  const client = new QueryClient(); const wrapper = ({ children }) => React.createElement(QueryClientProvider, { client }, children);
  const mount = (initialProps = scope) => renderHook(p => useChatComposer(p.user, p.org, p.room), { initialProps, wrapper });
  return { ...mount(), mount, client };
}
it.each(["user", "org", "room"])("retains the whole composer independently across %s changes", async field => {
  const f = setup(), message = { id: "parent", text: "Question", type: "text", senderName: "Crew", timestamp: 1 };
  await act(async () => { f.result.current.setText("My draft"); f.result.current.setMessageType("cue"); f.result.current.setReplyingTo(message); f.result.current.setEditing(message); f.result.current.setPollQuestion("Ready?"); f.result.current.setPollOptions(["Yes", "No"]); });
  const old = f.result.current.capture(), oldSetter = f.result.current.setText;
  f.rerender({ ...scope, [field]: "other" }); expect(f.result.current.draft.text).toBe("");
  await act(async () => oldSetter("Late wrong room")); expect(f.result.current.draft.text).toBe("");
  await act(async () => f.result.current.setText("Other room")); f.rerender(scope); expect(f.result.current.draft).toEqual(old);
});
it("retains unsent text and poll choices after unmount", async () => {
  const f = setup(); await act(async () => { f.result.current.setText("Return here"); f.result.current.setPollOptions(options => [...options, "Later"]); });
  f.unmount(); const next = f.mount(); expect(next.result.current.draft.text).toBe("Return here"); expect(next.result.current.draft.pollOptions).toHaveLength(3);
});
it("does not clear newer typing after an earlier edit is acknowledged", async () => {
  const f = setup(); await act(async () => f.result.current.setText("Submitted")); const submitted = f.result.current.capture();
  await act(async () => f.result.current.setText("Newer typing")); await act(async () => f.result.current.clear(submitted)); expect(f.result.current.draft.text).toBe("Newer typing");
  await act(async () => f.result.current.clear(f.result.current.capture())); expect(f.result.current.draft.text).toBe("");
});
it("clears a confirmed original draft without changing the currently visible room", async () => {
  const f = setup(); await act(async () => f.result.current.setText("Submitted")); const submitted = f.result.current.capture(), clear = f.result.current.clear;
  f.rerender({ ...scope, room: "planning" }); await act(async () => f.result.current.setText("Planning"));
  await act(async () => clear(submitted)); expect(f.result.current.draft.text).toBe("Planning");
  f.rerender(scope); expect(f.result.current.draft.text).toBe("");
});

it("keeps an unfinished poll when a separate text message is sent", async () => {
  const f = setup(); await act(async () => { f.result.current.setText("Separate message"); f.result.current.setPollQuestion("Ready?"); f.result.current.setPollOptions(["Yes", "Later"]); });
  await act(async () => f.result.current.clear(f.result.current.capture()));
  expect(f.result.current.draft).toMatchObject({ text: "", pollQuestion: "Ready?", pollOptions: ["Yes", "Later"] });
});
