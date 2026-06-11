import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ShowPageTabs } from "../ShowPageTabs";

describe("ShowPageTabs", () => {
  it("renders all show tabs", () => {
    const onChange = vi.fn();
    render(<ShowPageTabs activeTab="show" onChange={onChange} />);

    expect(screen.getByRole("tab", { name: "Show" })).not.toBe(undefined);
    expect(screen.getByRole("tab", { name: "Chat" })).not.toBe(undefined);
    expect(screen.getByRole("tab", { name: "Rundown" })).not.toBe(undefined);
  });

  it("marks the active tab as selected", () => {
    const onChange = vi.fn();
    render(<ShowPageTabs activeTab="chat" onChange={onChange} />);

    const chatTab = screen.getByRole("tab", { name: "Chat" });
    const showTab = screen.getByRole("tab", { name: "Show" });

    expect(chatTab.getAttribute("aria-selected")).toBe("true");
    expect(showTab.getAttribute("aria-selected")).toBe("false");
  });

  it("triggers onChange from click and Enter/Space", async () => {
    const onChange = vi.fn();
    render(<ShowPageTabs activeTab="show" onChange={onChange} />);

    fireEvent.click(screen.getByRole("tab", { name: "Rundown" }));
    expect(onChange).toHaveBeenCalledWith("rundown");

    const chatTab = screen.getByRole("tab", { name: "Chat" });
    chatTab.focus();
    fireEvent.keyDown(chatTab, { key: "Enter", code: "Enter", charCode: 13, keyCode: 13 });
    expect(onChange).toHaveBeenCalledWith("chat");

    fireEvent.keyDown(chatTab, { key: " ", code: "Space", charCode: 32, keyCode: 32 });
    expect(onChange).toHaveBeenCalledWith("chat");
  });
});
