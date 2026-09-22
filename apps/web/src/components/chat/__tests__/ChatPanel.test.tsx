import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ChatPanel } from "../ChatPanel";
import type { ChatMessage } from "@/lib/adapters/chat-adapter";

vi.mock("@/components/ui/confirm-dialog", () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(), ConfirmDialogEl: null }),
}));

let triggerResize = () => {};

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 100 });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  class MockResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      triggerResize = () => callback([], this as unknown as ResizeObserver);
    }
    observe() {}
    disconnect() {}
    unobserve() {}
  }
  globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
});

const messages: ChatMessage[] = [
  { id: "root", orgId: "org", senderId: "other", senderName: "Alex", text: "Original message", type: "text", timestamp: 1 },
  { id: "reply", orgId: "org", senderId: "me", senderName: "Sam", text: "First reply", type: "text", timestamp: 2, threadRootId: "root", replyTo: { messageId: "root", senderName: "Alex", text: "Original message" } },
  { id: "nested", orgId: "org", senderId: "other", senderName: "Alex", text: "Reply to reply", type: "text", timestamp: 3, threadRootId: "root", replyTo: { messageId: "reply", senderName: "Sam", text: "First reply" } },
];

describe("ChatPanel conversation flow", () => {
  it("loads older messages on request and exposes recoverable queued delivery", async () => {
    const onLoadOlderMessages = vi.fn().mockResolvedValue(undefined);
    const onRetryQueuedMessage = vi.fn();
    const onCancelQueuedMessage = vi.fn();
    const pending: ChatMessage = { ...messages[1], id: "pending", text: "Queued message", delivery: "failed", deliveryError: "Not accepted" };
    render(<ChatPanel messages={[pending]} connectionStatus="disconnected" unreadCount={0} currentUserId="me" onSendMessage={vi.fn()} hasOlderMessages onLoadOlderMessages={onLoadOlderMessages} onRetryQueuedMessage={onRetryQueuedMessage} onCancelQueuedMessage={onCancelQueuedMessage} />);
    fireEvent.click(screen.getByRole("button", { name: "Load older messages" }));
    await waitFor(() => expect(onLoadOlderMessages).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onRetryQueuedMessage).toHaveBeenCalledWith("pending");
    expect(onCancelQueuedMessage).toHaveBeenCalledWith("pending");
  });

  it("keeps the caption and attachment together when Enter is pressed during upload", async () => {
    const onSendMessage = vi.fn();
    const attachment = { id: "pending-file", name: "notes.txt", url: "/api/chat-file/org/pending-file/notes.txt", mimeType: "text/plain", size: 5 };
    let completeUpload: (value: typeof attachment) => void = () => {};
    const onUploadAttachment = vi.fn(() => new Promise<typeof attachment>((resolve) => { completeUpload = resolve; }));
    const { container } = render(<ChatPanel messages={[]} connectionStatus="connected" unreadCount={0} onSendMessage={onSendMessage} onUploadAttachment={onUploadAttachment} />);
    const input = container.querySelector('input[type="file"]');
    if (!input) throw new Error("Missing upload input");
    fireEvent.change(input, { target: { files: [new File(["notes"], "notes.txt", { type: "text/plain" })] } });
    const textbox = screen.getByRole("textbox");
    fireEvent.change(textbox, { target: { value: "Read these notes" } });
    expect(screen.getByRole("button", { name: "Send message" }).hasAttribute("disabled")).toBe(true);
    fireEvent.keyDown(textbox, { key: "Enter" });
    expect(onSendMessage).not.toHaveBeenCalled();
    expect(textbox).toHaveProperty("value", "Read these notes");
    await act(async () => { completeUpload(attachment); });
    fireEvent.keyDown(textbox, { key: "Enter" });
    expect(onSendMessage).toHaveBeenCalledExactlyOnceWith("Read these notes", "text", expect.objectContaining({ attachments: [attachment] }));
    expect(textbox).toHaveProperty("value", "");
  });

  it("removes an abandoned upload from server storage when the user discards it", async () => {
    const attachment = { id: "draft-file", name: "draft.txt", url: "/api/chat-file/org/draft-file/draft.txt", mimeType: "text/plain", size: 5 };
    const onDiscardAttachment = vi.fn().mockResolvedValue(undefined);
    const { container } = render(<ChatPanel
      messages={[]}
      connectionStatus="connected"
      unreadCount={0}
      onSendMessage={vi.fn()}
      onUploadAttachment={vi.fn().mockResolvedValue(attachment)}
      onDiscardAttachment={onDiscardAttachment}
    />);
    const input = container.querySelector('input[type="file"]');
    if (!input) throw new Error("Missing upload input");
    fireEvent.change(input, { target: { files: [new File(["draft"], "draft.txt", { type: "text/plain" })] } });
    await screen.findByRole("button", { name: "Remove draft.txt" });
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
    expect(screen.getByRole("button", { name: "Reply to Alex" }).parentElement?.className).toContain("[@media(hover:hover)]:absolute");
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
