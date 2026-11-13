import { ChatAttachmentDraft } from "@showpilot/shared/chat-attachment-draft";
import type { ChatAttachment } from "@showpilot/shared/chat-attachment";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ChatPanel } from "../ChatPanel";
import type { ChatMessage } from "@/lib/adapters/chat-adapter";

let triggerResize = () => {};

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 100 });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  const observers = new Set<MockResizeObserver>();
  class MockResizeObserver implements ResizeObserver {
    private targets = new Set<Element>();
    constructor(private callback: ResizeObserverCallback) {}
    observe(target: Element) {
      this.targets.add(target);
      observers.add(this);
    }
    disconnect() {
      this.targets.clear();
      observers.delete(this);
    }
    unobserve(target: Element) {
      this.targets.delete(target);
      if (this.targets.size === 0) observers.delete(this);
    }
    notify() {
      this.callback([], this);
    }
  }
  triggerResize = () => observers.forEach((observer) => observer.notify());
  globalThis.ResizeObserver = MockResizeObserver;
});

const messages: ChatMessage[] = [
  { id: "root", orgId: "org", senderId: "other", senderName: "Alex", text: "Original message", type: "text", timestamp: 1 },
  { id: "reply", orgId: "org", senderId: "me", senderName: "Sam", text: "First reply", type: "text", timestamp: 2, threadRootId: "root", replyTo: { messageId: "root", senderName: "Alex", text: "Original message" } },
  { id: "nested", orgId: "org", senderId: "other", senderName: "Alex", text: "Reply to reply", type: "text", timestamp: 3, threadRootId: "root", replyTo: { messageId: "reply", senderName: "Sam", text: "First reply" } },
];

describe("ChatPanel conversation flow", () => {
  it("preserves a rejected message draft and shows the enqueue error", async () => {
    const onSendMessage = vi.fn().mockRejectedValue(new Error("Outgoing queue is full"));
    render(<ChatPanel messages={[]} connectionStatus="connected" unreadCount={0} onSendMessage={onSendMessage} />);
    const textbox = screen.getByRole("textbox");
    fireEvent.change(textbox, { target: { value: "Keep this draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Outgoing queue is full"));
    expect(textbox).toHaveProperty("value", "Keep this draft");
    onSendMessage.mockResolvedValue(undefined);
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(textbox).toHaveProperty("value", ""));
    expect(onSendMessage).toHaveBeenCalledTimes(2);
  });

  it("retains the poll question and options when enqueue fails", async () => {
    const onSendMessage = vi.fn().mockRejectedValue(new Error("Chat is not ready"));
    render(<ChatPanel messages={[]} connectionStatus="connected" unreadCount={0} onSendMessage={onSendMessage} onVotePoll={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Create poll" }));
    fireEvent.change(screen.getByPlaceholderText("Ask a question"), { target: { value: "Ready?" } });
    fireEvent.change(screen.getByPlaceholderText("Option 1"), { target: { value: "Yes" } });
    fireEvent.change(screen.getByPlaceholderText("Option 2"), { target: { value: "Wait" } });
    fireEvent.click(screen.getByRole("button", { name: "Send poll" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Chat is not ready"));
    expect(screen.getByPlaceholderText("Ask a question")).toHaveProperty("value", "Ready?");
    expect(screen.getByPlaceholderText("Option 1")).toHaveProperty("value", "Yes");
    expect(screen.getByPlaceholderText("Option 2")).toHaveProperty("value", "Wait");
  });

  it("retries failed crew notifications without sending the message again", () => {
    const onSendMessage = vi.fn();
    const onRetryNotifications = vi.fn();
    render(<ChatPanel messages={[]} connectionStatus="connected" unreadCount={0} onSendMessage={onSendMessage} onRetryNotifications={onRetryNotifications} notifications={[{
      command: { kind: "message", orgId: "org", userId: "me", roomId: "production", messageId: "sent", requestId: "notification", text: "Stand by", mentionedUserIds: [] },
      label: "Stand by", at: 1234, status: "failed",
    }]} />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Message delivered.");
    expect(alert.textContent).toContain("Stand by");
    expect(alert.querySelector("time")?.dateTime).toBe(new Date(1234).toISOString());
    fireEvent.click(within(alert).getByRole("button", { name: "Retry notifications" }));
    expect(onRetryNotifications).toHaveBeenCalledExactlyOnceWith("notification");
    expect(onSendMessage).not.toHaveBeenCalled();
  });

  it("keeps unknown rooms out of the empty state and exposes a timestamped reconnect action", () => {
    const reconnect = vi.fn();
    const props = { messages: [], unreadCount: 0, onSendMessage: vi.fn(), hydrated: false, onReconnect: reconnect };
    const view = render(<ChatPanel {...props} connectionStatus="connecting" />);
    expect(screen.getByText("Connecting to chat…")).toBeTruthy();
    expect(screen.queryByText("No messages yet")).toBeNull();
    view.rerender(<ChatPanel {...props} connectionStatus="reconnecting" connectionUpdatedAt={1234} />);
    expect(screen.getByRole("alert").querySelector("time")?.dateTime).toBe(new Date(1234).toISOString());
    fireEvent.click(screen.getByRole("button", { name: "Reconnect chat" }));
    expect(reconnect).toHaveBeenCalledOnce();
    expect(screen.queryByText("No messages yet")).toBeNull();
    view.rerender(<ChatPanel {...props} hydrated connectionStatus="connected" />);
    expect(screen.getByText("No messages yet")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reconnect chat" })).toBeNull();
    view.unmount();
  });
  it("shows separate external delivery status on crew cues and preserves their line breaks", () => {
    const cue: ChatMessage = { ...messages[0], id: "crew", type: "cue", text: "Standby cameras\nCamera 2 next", externalDelivery: { platform: "slack", status: "pending" } };
    const props = { connectionStatus: "connected" as const, unreadCount: 0, onSendMessage: vi.fn() };
    const view = render(<ChatPanel {...props} messages={[cue]} />);
    expect(screen.getByText("Sending to slack…")).toBeTruthy();
    const text = view.container.querySelector('[data-chat-message-id="crew"] p');
    expect(text?.textContent).toBe(cue.text);
    expect(text?.classList.contains("whitespace-pre-wrap")).toBe(true);
    view.rerender(<ChatPanel {...props} messages={[{ ...cue, externalDelivery: { platform: "slack", status: "failed", error: "Service unavailable" } }]} />);
    expect(screen.getByRole("alert").textContent).toBe("Not delivered to slack: Service unavailable");
    view.rerender(<ChatPanel {...props} messages={[{ ...cue, externalDelivery: { platform: "slack", status: "sent" } }]} />);
    expect(screen.getByText("Delivered to slack")).toBeTruthy();
  });

  it("loads older messages on request and exposes recoverable queued delivery", async () => {
    const onLoadOlderMessages = vi.fn().mockResolvedValue(undefined);
    const onRetryQueuedMessage = vi.fn();
    const onCancelQueuedMessage = vi.fn();
    const pending: ChatMessage = { ...messages[1], id: "pending", text: "Queued message", delivery: "failed", deliveryError: "Not accepted" };
    render(<ChatPanel messages={[pending]} connectionStatus="disconnected" unreadCount={0} currentUserId="me" onSendMessage={vi.fn()} hasOlderMessages onLoadOlderMessages={onLoadOlderMessages} onRetryQueuedMessage={onRetryQueuedMessage} onCancelQueuedMessage={onCancelQueuedMessage} />);
    fireEvent.click(screen.getByRole("button", { name: "Load older messages" }));
    await waitFor(() => expect(onLoadOlderMessages).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Retry send" }));
    expect(onRetryQueuedMessage).toHaveBeenCalledWith("pending");
    fireEvent.click(screen.getByRole("button", { name: "Remove local copy" }));
    let dialog = screen.getByRole("dialog", { name: "Remove this queued copy?" });
    expect(onCancelQueuedMessage).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(onCancelQueuedMessage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remove local copy" }));
    dialog = screen.getByRole("dialog", { name: "Remove this queued copy?" });
    expect(dialog.textContent).toContain("it may still appear in the conversation");
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove local copy" }));
    await waitFor(() => expect(onCancelQueuedMessage).toHaveBeenCalledExactlyOnceWith("pending"));
  });

  it("keeps the caption and attachment together when Enter is pressed during upload", async () => {
    const onSendMessage = vi.fn();
    const attachment = { id: "00000000-0000-4000-8000-000000000001", name: "notes.txt", url: "/api/chat-file/org/00000000-0000-4000-8000-000000000001/notes.txt", mimeType: "text/plain", size: 5 };
    let completeUpload: (value: typeof attachment) => void = () => {};
    const onUploadAttachment = vi.fn(() => new Promise<typeof attachment>((resolve) => { completeUpload = resolve; }));
    const { container } = render(<ChatPanel messages={[]} connectionStatus="connected" unreadCount={0} onSendMessage={onSendMessage} attachmentDraft={attachmentFixture(attachment, onUploadAttachment)} />);
    const input = container.querySelector('input[type="file"]');
    if (!input) throw new Error("Missing upload input");
    fireEvent.change(input, { target: { files: [new File(["notes"], "notes.txt", { type: "text/plain" })] } });
    const textbox = screen.getByRole("textbox");
    fireEvent.change(textbox, { target: { value: "Read these notes" } });
    expect(screen.getByRole("button", { name: "Send message" }).hasAttribute("disabled")).toBe(true);
    fireEvent.keyDown(textbox, { key: "Enter" });
    expect(onSendMessage).not.toHaveBeenCalled();
    expect(textbox).toHaveProperty("value", "Read these notes");
    await waitFor(() => expect(onUploadAttachment).toHaveBeenCalled());
    await act(async () => { completeUpload(attachment); });
    fireEvent.keyDown(textbox, { key: "Enter" });
    expect(onSendMessage).toHaveBeenCalledExactlyOnceWith("Read these notes", "text", expect.objectContaining({ attachments: [attachment] }));
    await waitFor(() => expect(textbox).toHaveProperty("value", ""));
  });

  it("removes an abandoned upload from server storage when the user discards it", async () => {
    const attachment = { id: "00000000-0000-4000-8000-000000000002", name: "draft.txt", url: "/api/chat-file/org/00000000-0000-4000-8000-000000000002/draft.txt", mimeType: "text/plain", size: 5 };
    const onDiscardAttachment = vi.fn().mockResolvedValue(undefined);
    const { container } = render(<ChatPanel
      messages={[]}
      connectionStatus="connected"
      unreadCount={0}
      onSendMessage={vi.fn()}
      attachmentDraft={attachmentFixture(attachment, undefined, onDiscardAttachment)}
    />);
    const input = container.querySelector('input[type="file"]');
    if (!input) throw new Error("Missing upload input");
    fireEvent.change(input, { target: { files: [new File(["draft"], "draft.txt", { type: "text/plain" })] } });
    await screen.findByText(/Ready to send/);
    fireEvent.click(screen.getByRole("button", { name: "Remove draft.txt" }));
    await waitFor(() => expect(onDiscardAttachment).toHaveBeenCalledWith(attachment));
  });

  it("keeps roots and replies in one chronological conversation", () => {
    render(<ChatPanel messages={messages} connectionStatus="connected" unreadCount={0} currentUserId="me" onSendMessage={vi.fn()} />);

    expect(screen.getAllByText("Original message").length).toBeGreaterThan(0);
    expect(screen.getAllByText("First reply").length).toBeGreaterThan(0);
    expect(screen.getByText("Reply to reply")).toBeInstanceOf(HTMLElement);
    expect(screen.queryByRole("button", { name: "Back to conversation" })).toBeNull();
  });

  it("can reply to a reply without opening a separate thread view", () => {
    const onSendMessage = vi.fn();
    render(<ChatPanel messages={messages} connectionStatus="connected" unreadCount={0} currentUserId="me" onSendMessage={onSendMessage} />);

    fireEvent.click(screen.getAllByRole("button", { name: "Reply to Alex" })[1]);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Nested answer" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(onSendMessage).toHaveBeenCalledWith("Nested answer", "text", expect.objectContaining({
      replyTo: { messageId: "nested", senderName: "Alex", text: "Reply to reply" },
    }));
  });

  it("opens an image inside an authenticated in-app preview", () => {
    const imageMessage: ChatMessage = {
      ...messages[0],
      id: "image",
      senderId: "me",
      senderName: "Sam",
      text: "",
      attachments: [{ id: "file", name: "stage.jpg", url: "/api/chat-file/org/file/stage.jpg", mimeType: "image/jpeg", size: 42 }],
    };
    render(<ChatPanel messages={[imageMessage]} connectionStatus="connected" unreadCount={0} currentUserId="me" onSendMessage={vi.fn()} />);

    const openImage = screen.getByRole("button", { name: "Open stage.jpg" });
    expect(openImage.className).not.toContain("border");
    expect(openImage.textContent).toBe("");
    expect(openImage.closest("[data-attachment-layout]")?.getAttribute("data-attachment-layout")).toBe("image-only");
    expect(openImage.parentElement?.className).not.toContain("sm:grid-cols-2");
    expect(openImage.closest("[data-chat-message-id]")?.className).toContain("justify-end");
    expect(screen.getByRole("button", { name: "Reply to Sam" }).parentElement?.className).toContain("self-end");
    expect(screen.getByRole("button", { name: "Reply to Sam" }).parentElement?.className).not.toContain("right-full");
    fireEvent.click(openImage);
    const preview = screen.getByRole("dialog", { name: "stage.jpg" });
    expect(preview).toBeInstanceOf(HTMLElement);
    expect(within(preview).getByRole("img", { name: "stage.jpg" }).getAttribute("src")).toBe("/api/chat-file/org/file/stage.jpg");
  });

  it("contains long messages and message controls inside the chat viewport", () => {
    const longMessage: ChatMessage = {
      ...messages[0],
      id: "long-message",
      text: "https://example.com/" + "unbroken".repeat(80),
    };
    render(<ChatPanel messages={[longMessage]} connectionStatus="connected" unreadCount={0} currentUserId="me" onSendMessage={vi.fn()} />);

    expect(screen.getByTestId("chat-panel").className).toContain("max-w-full");
    expect(screen.getByTestId("chat-scroll-region").className).toContain("overflow-x-hidden");
    expect(screen.getByText(longMessage.text).className).toContain("[overflow-wrap:anywhere]");
    expect(screen.getByRole("button", { name: "Reply to Alex" }).parentElement?.className).not.toContain("left-full");
    expect(screen.getByRole("button", { name: "Reply to Alex" }).parentElement?.className).not.toContain("opacity-0");
  });

  it("keeps late-loading content at the latest message until the reader scrolls up", async () => {
    const scrollSpy = vi.mocked(HTMLElement.prototype.scrollIntoView);
    scrollSpy.mockClear();
    render(<ChatPanel messages={messages} connectionStatus="connected" unreadCount={0} currentUserId="me" onSendMessage={vi.fn()} />);

    await waitFor(() => expect(scrollSpy).toHaveBeenCalled());
    scrollSpy.mockClear();
    triggerResize();
    expect(scrollSpy).toHaveBeenCalled();

    const region = screen.getByTestId("chat-scroll-region");
    Object.defineProperties(region, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 500 },
      scrollTop: { configurable: true, writable: true, value: 0 },
    });
    triggerResize();
    fireEvent.scroll(region);
    scrollSpy.mockClear();
    triggerResize();

    expect(scrollSpy).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "New messages" })).toBeInstanceOf(HTMLElement);
  });

  it("opens at the latest message and marks it read", async () => {
    const scrollSpy = vi.mocked(HTMLElement.prototype.scrollIntoView);
    scrollSpy.mockClear();
    const onReadThrough = vi.fn();

    render(<ChatPanel messages={messages} connectionStatus="connected" unreadCount={2} currentUserId="me" onSendMessage={vi.fn()} hydrated onReadThrough={onReadThrough} />);

    await waitFor(() => expect(scrollSpy).toHaveBeenCalledWith({ block: "end" }));
    expect(screen.queryByRole("separator", { name: "New messages" })).toBeNull();
    await waitFor(() => expect(onReadThrough).toHaveBeenCalledWith(3));
  });

  it("does not mistake a layout-generated scroll for reading older messages", async () => {
    render(<ChatPanel messages={messages} connectionStatus="connected" unreadCount={0} onSendMessage={vi.fn()} />);
    const region = screen.getByTestId("chat-scroll-region");
    Object.defineProperties(region, {
      clientWidth: { configurable: true, value: 800 },
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 500 },
      scrollTop: { configurable: true, writable: true, value: 400 },
    });
    triggerResize();
    await waitFor(() => expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled());
    Object.defineProperties(region, {
      clientWidth: { configurable: true, value: 390 },
      scrollHeight: { configurable: true, value: 900 },
    });
    const scrollSpy = vi.mocked(HTMLElement.prototype.scrollIntoView);
    scrollSpy.mockClear();
    fireEvent.scroll(region);
    triggerResize();
    expect(scrollSpy).toHaveBeenCalledWith({ block: "end" });
    expect(screen.queryByRole("button", { name: "New messages" })).toBeNull();
  });

  it("opens a previously hidden Show Flow panel at latest after reading older messages", async () => {
    render(<ChatPanel messages={messages} connectionStatus="connected" unreadCount={0} onSendMessage={vi.fn()} />);
    const region = screen.getByTestId("chat-scroll-region");
    Object.defineProperties(region, {
      scrollHeight: { configurable: true, value: 500 },
      scrollTop: { configurable: true, writable: true, value: 0 },
    });
    triggerResize();
    fireEvent.scroll(region);
    expect(screen.getByRole("button", { name: "New messages" })).toBeInstanceOf(HTMLElement);
    Object.defineProperty(region, "clientHeight", { configurable: true, value: 0 });
    triggerResize();
    const scrollSpy = vi.mocked(HTMLElement.prototype.scrollIntoView);
    scrollSpy.mockClear();
    Object.defineProperty(region, "clientHeight", { configurable: true, value: 100 });
    triggerResize();
    expect(scrollSpy).toHaveBeenCalledWith({ block: "end" });
  });
});

it("defers composer height writes outside ResizeObserver and cancels them on unmount", () => {
  const frames = new Map<number, FrameRequestCallback>(); let next = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++next, callback); return next; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  try {
    const view = render(<ChatPanel messages={[]} connectionStatus="connected" unreadCount={0} onSendMessage={vi.fn()} />);
    const textarea = view.container.querySelector("textarea"); if (!textarea) throw new Error("Composer missing");
    let width = 320;
    Object.defineProperty(textarea, "clientWidth", { configurable: true, get: () => width });
    Object.defineProperty(textarea, "scrollHeight", { configurable: true, get: () => 96 });
    textarea.style.height = "44px";
    act(() => triggerResize());
    expect(textarea.style.height).toBe("44px");
    act(() => { for (const [id, callback] of frames) { frames.delete(id); callback(1); } });
    expect(textarea.style.height).toBe("96px");
    width = 240; act(() => triggerResize());
    expect(frames.size).toBeGreaterThan(0);
    view.unmount(); expect(frames.size).toBe(0);
  } finally { vi.unstubAllGlobals(); }
});

it("keeps uncertain edits visible and blocks conflicting row actions until recovery", () => {
  const command = { orgId: "org", userId: "me", roomId: "production", messageId: "reply", requestId: crypto.randomUUID(), expiresAt: Date.now() + 10000,
    operation: { kind: "edit" as const, text: "My captured draft", expectedEditTime: 2 } };
  const retry = vi.fn(), dismiss = vi.fn();
  render(<ChatPanel messages={[messages[1]]} connectionStatus="connected" unreadCount={0} currentUserId="me" onSendMessage={vi.fn()} onEditMessage={vi.fn()} onDeleteMessage={vi.fn()} onSetReaction={vi.fn()}
    mutations={[{ command, state: "unknown", error: "Change not confirmed", at: 1000 }]} onRetryMutation={retry} onDismissMutation={dismiss} />);
  const status = screen.getByRole("region", { name: "Message changes" });
  expect(status.textContent).toContain("My captured draft"); expect(status.textContent).toContain("Change not confirmed");
  expect(screen.getByRole("button", { name: "Edit message" })).toHaveProperty("disabled", true);
  expect(screen.getByRole("button", { name: "Delete message" })).toHaveProperty("disabled", true);
  expect(screen.getByRole("button", { name: "Choose reaction" })).toHaveProperty("disabled", true);
  expect(within(status).queryByRole("button", { name: "Dismiss result" })).toBeNull();
  fireEvent.click(within(status).getByRole("button", { name: "Recover original change" }));
  expect(retry).toHaveBeenCalledWith(command.requestId); expect(dismiss).not.toHaveBeenCalled();
});

it("offers cleanup recovery for an applied delete and dismissal only after cleanup completes", () => {
  const command = { orgId: "org", userId: "me", roomId: "production", messageId: "reply", requestId: crypto.randomUUID(), expiresAt: Date.now() + 10000,
    operation: { kind: "delete" as const, expectedEditTime: 2 } };
  const result = { command, outcome: "applied" as const, at: 2000, cleanup: "failed" as const };
  const retry = vi.fn(), dismiss = vi.fn();
  const base = { messages: [], connectionStatus: "connected" as const, unreadCount: 0, onSendMessage: vi.fn(), onRetryMutation: retry, onDismissMutation: dismiss };
  const view = render(<ChatPanel {...base} mutations={[{ command, state: "settled", result, at: 2000 }]} />);
  expect(screen.getByRole("alert").textContent).toContain("Message deleted");
  expect(screen.queryByRole("button", { name: "Dismiss result" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry attachment cleanup" })); expect(retry).toHaveBeenCalledWith(command.requestId);
  view.rerender(<ChatPanel {...base} mutations={[{ command, state: "settled", result: { ...result, cleanup: "complete" }, at: 2001 }]} />);
  fireEvent.click(screen.getByRole("button", { name: "Dismiss result" })); expect(dismiss).toHaveBeenCalledWith(command.requestId);
});

it("submits the captured edit version even when a newer message arrives while typing", async () => {
  const edit = vi.fn().mockRejectedValue(new Error("The message changed. Review it again."));
  const base = { connectionStatus: "connected" as const, currentUserId: "me", unreadCount: 0, onSendMessage: vi.fn(), onEditMessage: edit };
  const view = render(<ChatPanel {...base} messages={[messages[1]]} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit message" }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "My unfinished edit" } });
  view.rerender(<ChatPanel {...base} messages={[{ ...messages[1], text: "A newer edit", editedAt: 99 }]} />);
  fireEvent.click(screen.getByRole("button", { name: "Save message" }));
  await waitFor(() => expect(edit).toHaveBeenCalledWith("reply", "My unfinished edit", 2));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Review it again"));
  expect(screen.getByRole("textbox")).toHaveProperty("value", "My unfinished edit");
});

it("keeps a failed attachment removal recoverable without sending that attachment", async () => {
  const attachment = { id: "00000000-0000-4000-8000-000000000003", name: "notes.txt", url: "/api/chat-file/org/00000000-0000-4000-8000-000000000003/notes.txt", mimeType: "text/plain", size: 5 };
  const remove = vi.fn().mockRejectedValue(new Error("Storage unavailable"));
  const send = vi.fn().mockResolvedValue(undefined);
  const { container } = render(<ChatPanel messages={[]} connectionStatus="connected" unreadCount={0} onSendMessage={send}
    attachmentDraft={attachmentFixture(attachment, undefined, remove)} />);
  const input = container.querySelector('input[type="file"]'); if (!input) throw new Error("Missing upload input");
  fireEvent.change(input, { target: { files: [new File(["notes"], "notes.txt", { type: "text/plain" })] } });
  await screen.findByText(/Ready to send/);
  fireEvent.click(screen.getByRole("button", { name: "Remove notes.txt" }));
  await waitFor(() => expect(remove).toHaveBeenCalledWith(attachment));
  const retry = await screen.findByRole("button", { name: "Retry removing notes.txt" });
  expect(screen.getByRole("alert").textContent).toContain("Storage unavailable");
  remove.mockResolvedValue(undefined); fireEvent.click(retry);
  await waitFor(() => expect(remove).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Retry removing notes.txt" })).toBeNull());
});

it("does not silently delete an unsent attachment when navigating away", async () => {
  const attachment = { id: "00000000-0000-4000-8000-000000000004", name: "draft.txt", url: "/api/chat-file/org/00000000-0000-4000-8000-000000000004/draft.txt", mimeType: "text/plain", size: 5 };
  const discard = vi.fn().mockResolvedValue(undefined);
  const draft = attachmentFixture(attachment, undefined, discard);
  const view = render(<ChatPanel messages={[]} connectionStatus="connected" unreadCount={0} onSendMessage={vi.fn()}
    attachmentDraft={draft} />);
  const input = view.container.querySelector('input[type="file"]'); if (!input) throw new Error("Missing upload input");
  fireEvent.change(input, { target: { files: [new File(["draft"], "draft.txt", { type: "text/plain" })] } });
  await screen.findByText(/Ready to send/);
  view.unmount();
  expect(discard).not.toHaveBeenCalled();
  render(<ChatPanel messages={[]} connectionStatus="connected" unreadCount={0} onSendMessage={vi.fn()} attachmentDraft={draft} />);
  expect(screen.getByRole("button", { name: "Remove draft.txt" })).toBeTruthy();
  expect(screen.getByText(/Ready to send/)).toBeTruthy();
});

function attachmentFixture(attachment: ChatAttachment, upload: () => Promise<ChatAttachment> = async () => attachment, cancel: (file: ChatAttachment) => Promise<void> = async () => {}) {
  return new ChatAttachmentDraft<File, File>({ orgId: "org", capacity: 6, newId: () => attachment.id,
    prepare: async file => ({ spec: { uploadId: attachment.id, name: attachment.name, mimeType: attachment.mimeType, size: attachment.size, sha256: "a".repeat(64) }, body: file }),
    upload, cancel: () => cancel(attachment),
  });
}
