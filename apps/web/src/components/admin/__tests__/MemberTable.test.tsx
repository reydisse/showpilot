import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MemberTable } from "../MemberTable";
import type { Member } from "@/types";

vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ invalidate: vi.fn() }),
}));

vi.mock("@/lib/data", () => ({ deleteCrewMember: vi.fn() }));

vi.mock("../MemberForm", () => ({ MemberForm: () => null }));

vi.mock("@/components/ui/confirm-dialog", () => ({
  useConfirmDialog: () => ({
    confirm: vi.fn().mockResolvedValue(false),
    ConfirmDialogEl: null,
  }),
}));

const member: Member = {
  id: "crew-1",
  orgId: "org-1",
  memberId: "QA-1",
  name: "Mobile QA",
  role: "Technical Director",
  email: "mobile@example.com",
  photoUrl: "",
  isOnline: false,
  lastCheckIn: null,
  lastCheckOut: null,
  createdAt: "2026-08-27T00:00:00.000Z",
};

describe("MemberTable icon actions", () => {
  it("gives crew management icons clear accessible names", () => {
    render(<MemberTable members={[member]} orgId="org-1" canManage />);

    expect(screen.getByRole("button", { name: "Edit Mobile QA" })).toBeInstanceOf(
      HTMLButtonElement,
    );
    expect(screen.getByRole("button", { name: "Remove Mobile QA" })).toBeInstanceOf(
      HTMLButtonElement,
    );
  });

  it("labels the icon that clears a crew search", () => {
    render(<MemberTable members={[member]} orgId="org-1" canManage />);

    fireEvent.change(screen.getByPlaceholderText("Search by name, role, or ID..."), {
      target: { value: "Mobile" },
    });
    expect(screen.getByRole("button", { name: "Clear crew search" })).toBeInstanceOf(
      HTMLButtonElement,
    );
  });
});
