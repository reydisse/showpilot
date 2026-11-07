import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AudioWorkspace } from "@/routes/$slug/dashboard/audio";

const api = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("@/lib/data", () => ({ getMicAssignments: api.read, addMicAssignment: vi.fn(), updateMicAssignment: vi.fn(), deleteMicAssignment: vi.fn(), getDevices: vi.fn() }));
vi.mock("@/lib/settings", () => ({ getOrgSettings: vi.fn() }));
vi.mock("@/lib/rundown", () => ({ getRundownOpeningDate: vi.fn() }));
vi.mock("@/components/workspace/WorkspaceProvider", async () => { const { WORKSPACE_TERMS } = await import("@showpilot/shared"); return { useTerms: () => WORKSPACE_TERMS.church }; });
vi.mock("@/hooks/useServiceDateRollover", () => ({ useServiceDateRollover: () => {} }));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => () => ({ useParams: () => ({ slug: "fixture" }) }),
  useBlocker: () => ({ status: "idle" }),
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));
vi.mock("@/components/show-switcher-menu", () => ({ ShowSwitcherMenu: ({ onSelect }: { onSelect: (show: { id: string; serviceDate: string }) => void }) =>
  <><button onClick={() => onSelect({ id: "first", serviceDate: "2026-11-07" })}>First show</button><button onClick={() => onSelect({ id: "second", serviceDate: "2026-11-07" })}>Second show</button></> }));
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.useRealTimers(); });
const row = { id: "first-channel", orgId: "fixture", showId: "first", channel: 1, label: "First show channel", micType: "wired", micModel: "", notes: "", gainDb: null, phantom: false, muted: false, group: "vocals", mixerConsole: "", mixerChannel: null, mixerChannelType: "", serviceDate: "2026-11-07", createdAt: new Date(), updatedAt: new Date() };
const initial = { assignments: [row], orgId: "fixture", initialServiceDate: "2026-11-07", initialShowId: "first", shows: [], orgTimezone: "UTC", mixers: [] };

it("bounds a selected-show read without showing stale channels or an empty state", async () => {
  vi.useFakeTimers();
  api.read.mockResolvedValueOnce([row]).mockImplementationOnce(() => new Promise(() => {})).mockResolvedValueOnce([]);
  render(<AudioWorkspace initial={initial} />);
  await act(async () => {});
  fireEvent.click(screen.getByText("Second show"));
  expect(screen.queryByLabelText("Selected channel")).toBeNull();
  expect(screen.queryByText("No channels assigned")).toBeNull();
  expect(screen.getByText("Loading channels…")).toBeTruthy();
  await act(() => vi.advanceTimersByTimeAsync(8_000));
  expect(screen.queryByText("Loading channels…")).toBeNull();
  expect(screen.queryByText("No channels assigned")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry channels" }));
  await act(async () => {});
  expect(screen.getByText("No channels assigned")).toBeTruthy();
  expect(api.read.mock.calls.at(-1)?.[0].data.showId).toBe("second");
});

it("a late previous-show reply cannot replace the current patch", async () => {
  let resolveOld: (value: typeof row[]) => void = () => {};
  const old = new Promise<typeof row[]>(resolve => { resolveOld = resolve; });
  api.read.mockReturnValueOnce(old).mockResolvedValueOnce([]);
  render(<AudioWorkspace initial={initial} />);
  await act(async () => {});
  fireEvent.click(screen.getByText("Second show"));
  await act(async () => {});
  expect(screen.getByText("No channels assigned")).toBeTruthy();
  await act(async () => resolveOld([row]));
  expect(screen.queryByLabelText("Selected channel")).toBeNull();
  expect(screen.getByText("No channels assigned")).toBeTruthy();
});
