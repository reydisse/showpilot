import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ChatPanel } from "../ChatPanel";
import type { ChatMessage } from "@/lib/adapters/chat-adapter";

vi.mock("@/components/ui/confirm-dialog", () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(), ConfirmDialogEl: null }),
}));

beforeAll(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
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
      text: "",
      attachments: [{ id: "file", name: "stage.jpg", url: "/api/chat-file/org/file/stage.jpg", mimeType: "image/jpeg", size: 42 }],
    };
    render(<ChatPanel messages={[imageMessage]} connectionStatus="connected" unreadCount={0} currentUserId="me" onSendMessage={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Open stage.jpg" }));
    const preview = screen.getByRole("dialog", { name: "stage.jpg" });
    expect(preview).toBeInstanceOf(HTMLElement);
    expect(within(preview).getByRole("img", { name: "stage.jpg" }).getAttribute("src")).toBe("/api/chat-file/org/file/stage.jpg");
  });
});
