import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ChatPanel } from "../ChatPanel";
import type { ChatMessage } from "@/lib/adapters/chat-adapter";

vi.mock("@/components/ui/confirm-dialog", () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(), ConfirmDialogEl: null }),
}));

let triggerResize = () => {};

beforeAll(() => {
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
    fireEvent.scroll(region);
    scrollSpy.mockClear();
    triggerResize();

    expect(scrollSpy).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "New messages" })).toBeInstanceOf(HTMLElement);
  });

  it("opens at the first message after the saved read marker", async () => {
    const scrollSpy = vi.mocked(HTMLElement.prototype.scrollIntoView);
    scrollSpy.mockClear();
    const onReadThrough = vi.fn();

    render(<ChatPanel messages={messages} connectionStatus="connected" unreadCount={2} currentUserId="me" onSendMessage={vi.fn()} hydrated openingReadThrough={1} onReadThrough={onReadThrough} />);

    await waitFor(() => expect(document.getElementById("chat-message-reply")?.scrollIntoView).toHaveBeenCalledWith({ block: "start" }));
    expect(screen.getAllByRole("separator", { name: "New messages" })).toHaveLength(1);
    expect(onReadThrough).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "New messages" }));
    expect(onReadThrough).toHaveBeenCalledWith(3);
  });
});
