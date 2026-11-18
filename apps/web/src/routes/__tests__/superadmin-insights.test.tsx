import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SuperAdminInsights } from "../-superadmin-insights";
import { getFeatureUsage, getAuditLog } from "@/lib/superadmin";
vi.mock("@/lib/superadmin", () => ({ getOrg360: vi.fn(), getAuditLog: vi.fn(), getFeatureUsage: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it("loads a usage window directly and retains inactive organizations", async () => {
  vi.mocked(getFeatureUsage).mockResolvedValue({ days: 7, from: 0, to: 1, summary: [{ feature: "Rundowns", total: 2, activeOrgs: 1 }], orgs: [{ id: "private-id", name: "Quiet organization", counts: {} }] });
  render(<SuperAdminInsights orgs={[]} />);
  expect(screen.getByText("Select a window to view feature usage.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "7 days" }));
  await waitFor(() => expect(getFeatureUsage).toHaveBeenCalledWith({ data: { days: 7 } }));
  expect(await screen.findByText("Quiet organization")).toBeTruthy();
  expect(screen.getByText("0")).toBeTruthy();
  expect(screen.queryByText("private-id")).toBeNull();
});
it("presents resolved audit actors and readable events", async () => {
  vi.mocked(getAuditLog).mockResolvedValue({ total: 1, events: [{ id: "event-id", orgId: "org-id", orgName: "Example", actorUserId: "user-id", actorLabel: "Alex", action: "permission_granted", source: "permission", target: "resource-id", createdAtMs: 1795000000000 }] });
  render(<SuperAdminInsights orgs={[]} />);
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  expect(await screen.findByText("Alex")).toBeTruthy();
  expect(screen.getByText("Permission granted")).toBeTruthy();
  expect(screen.getByText("1 events · Page 1 of 1")).toBeTruthy();
  expect(screen.queryByText("user-id")).toBeNull();
});
