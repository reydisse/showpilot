import { describe, expect, it, vi } from "vitest";
import { ChatComposer } from "@showpilot/shared/chat-composer";
import { getChatComposer } from "../chat-composer";
const message = { id: "original", text: "Original text" };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
describe("conversation drafts", () => {
  it("preserves text, type and reply while editing and restores them after save", async () => {
    const c = new ChatComposer<typeof message>(); c.setText("Announcement"); c.setMessageType("cue"); c.setReplyingTo(message);
    c.beginEdit(message); c.setText("Correction");
    const send = vi.fn(); await c.send("message", send);
    expect(send.mock.calls[0][0].edit).toEqual({ target: message, text: "Correction" });
    expect(c.getSnapshot()).toMatchObject({ edit: null, message: { text: "Announcement", messageType: "cue", replyingTo: message } });
  });
  it("restores an unsent message when replying during an edit", () => {
    const c = new ChatComposer<typeof message>(); c.setText("Unsent"); c.beginEdit(message); c.setText("Correction"); c.setReplyingTo(message);
    expect(c.getSnapshot()).toMatchObject({ edit: null, message: { text: "Unsent", replyingTo: message } });
  });
  it("does not clear a newer edit when a preceding edit finishes", async () => {
    const c = new ChatComposer<typeof message>(), request = deferred(); c.beginEdit(message);
    const pending = c.send("message", () => request.promise); c.setText("Newer correction"); request.resolve(); await pending;
    expect(c.getSnapshot().edit?.text).toBe("Newer correction");
  });
  it("clears the sent message even when an unrelated poll changes", async () => {
    const c = new ChatComposer<typeof message>(), request = deferred(); c.setText("Submitted");
    const pending = c.send("message", () => request.promise); c.setPollQuestion("Soundcheck?"); request.resolve(); await pending;
    expect(c.getSnapshot()).toMatchObject({ message: { text: "" }, poll: { question: "Soundcheck?" } });
  });
  it("keeps newer reply/type changes after an earlier message finishes", async () => {
    const c = new ChatComposer<typeof message>(), request = deferred(); c.setText("Submitted");
    const pending = c.send("message", () => request.promise); c.setReplyingTo(message); c.setMessageType("alert"); request.resolve(); await pending;
    expect(c.getSnapshot().message).toMatchObject({ text: "Submitted", messageType: "alert", replyingTo: message });
  });
  it("refuses another send across views until the first finishes and retains a rejected draft", async () => {
    const c = new ChatComposer<typeof message>(), request = deferred(); c.setText("Unsent");
    const first = c.send("message", () => request.promise), second = vi.fn();
    expect(await c.send("message", second)).toBe(false); expect(second).not.toHaveBeenCalled();
    request.resolve(); await first;
    c.setText("Rejected"); await expect(c.send("message", () => { throw new Error("Queue full"); })).rejects.toThrow("Queue full");
    expect(c.getSnapshot().message.text).toBe("Rejected"); expect(await c.send("message", () => {})).toBe(true);
  });
  it("scopes web drafts by organization, room, member and the full guest identity", () => {
    const scope = { orgId: crypto.randomUUID(), roomId: "production", currentUserId: "member" };
    const original = getChatComposer(scope); original.setText("Private draft");
    expect(getChatComposer(scope)).toBe(original);
    for (const change of [{ orgId: "other" }, { roomId: "planning" }, { currentUserId: "other" }, { guestToken: "token", guestName: "Guest" }]) {
      expect(getChatComposer({ ...scope, ...change }).getSnapshot().message.text).toBe("");
    }
    const guest = { ...scope, guestToken: "full-token-one", guestName: "Guest One" }; getChatComposer(guest).setText("Guest draft");
    expect(getChatComposer({ ...guest, currentUserId: "another-signed-in-user" }).getSnapshot().message.text).toBe("Guest draft");
    expect(getChatComposer({ ...guest, guestName: "Guest Two" }).getSnapshot().message.text).toBe("");
    expect(getChatComposer({ ...guest, guestToken: "full-token-two" }).getSnapshot().message.text).toBe("");
    expect(getChatComposer({ ...scope, currentUserId: undefined })).not.toBe(getChatComposer({ ...scope, currentUserId: undefined }));
  });
});
