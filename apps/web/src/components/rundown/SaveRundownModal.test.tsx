import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SaveRundownModal } from "./SaveRundownModal";
import { saveRundownTemplate } from "@/lib/rundown";
import type { RundownItem } from "@/types/rundown";
vi.mock("@/lib/rundown", () => ({ saveRundownTemplate: vi.fn() }));
vi.mock("@/components/workspace/WorkspaceProvider", async () => {
  const { resolveWorkspaceProfile } = await import("@showpilot/shared");
  return { useTerms: () => resolveWorkspaceProfile({}).terms };
});
const item: RundownItem = { id: "item", title: "Original", type: "segment", duration: 300000, notes: "", assignee: "", cue: "", status: "upcoming", sortOrder: 0, hardStop: false };
const props = () => ({ orgId: "fixture-org", items: [item], initialServiceName: "Fixture show", initialStartTime: "09:00", onClose: vi.fn() });
beforeEach(() => { vi.mocked(saveRundownTemplate).mockResolvedValue({ ok: true, id: "saved" }); });
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.useRealTimers(); });
function submit() { fireEvent.change(screen.getByLabelText("Template Name"), { target: { value: "Sunday" } }); fireEvent.click(screen.getByRole("button", { name: "Save" })); }
it("saves the named snapshot once and closes after acknowledgement", async () => {
  const input = props(); render(<SaveRundownModal {...input} />); submit();
  await waitFor(() => expect(input.onClose).toHaveBeenCalledTimes(1));
  expect(saveRundownTemplate).toHaveBeenCalledWith({ data: expect.objectContaining({ id: expect.any(String), orgId: input.orgId, name: "Sunday", items: [item] }) });
});
it("keeps the same ID and immutable snapshot on retry after the live rundown changes", async () => {
  vi.mocked(saveRundownTemplate).mockRejectedValueOnce(new Error("lost response"));
  const input = props(); const view = render(<SaveRundownModal {...input} />); submit();
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("could not be confirmed"));
  expect(screen.getByRole("alert").querySelector("time")?.dateTime).toBeTruthy();
  const first = vi.mocked(saveRundownTemplate).mock.calls[0][0];
  view.rerender(<SaveRundownModal {...input} items={[{ ...item, title: "Changed" }]} />);
  expect(screen.getByLabelText("Template Name")).toHaveProperty("disabled", true);
  fireEvent.click(screen.getByRole("button", { name: "Retry save" }));
  await waitFor(() => expect(input.onClose).toHaveBeenCalledTimes(1));
  expect(vi.mocked(saveRundownTemplate).mock.calls[1][0]).toEqual(first);
});
it("times out, retries the same save, and ignores the original late acknowledgement", async () => {
  let finish: ((value: { ok: true; id: string }) => void) | undefined;
  vi.mocked(saveRundownTemplate).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  vi.useFakeTimers(); const input = props(); render(<SaveRundownModal {...input} />); submit();
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  expect(screen.queryByRole("status")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry save" }));
  await act(async () => { await Promise.resolve(); });
  expect(input.onClose).toHaveBeenCalledTimes(1);
  await act(async () => finish?.({ ok: true, id: "saved" }));
  expect(input.onClose).toHaveBeenCalledTimes(1);
  expect(vi.mocked(saveRundownTemplate).mock.calls[0][0]).toEqual(vi.mocked(saveRundownTemplate).mock.calls[1][0]);
});
it("blocks repeated submits while pending and ignores completion after workspace change", async () => {
  let finish: ((value: { ok: true; id: string }) => void) | undefined;
  vi.mocked(saveRundownTemplate).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const input = props(); const view = render(<SaveRundownModal {...input} />); submit();
  fireEvent.submit(screen.getByLabelText("Template Name").closest("form")!);
  expect(saveRundownTemplate).toHaveBeenCalledTimes(1);
  view.rerender(<SaveRundownModal {...input} orgId="other-org" />);
  await act(async () => finish?.({ ok: true, id: "saved" }));
  expect(input.onClose).not.toHaveBeenCalled();
});
it.each(["removed", "conflict"] as const)("explains a terminal %s result without offering another retry", async reason => {
  vi.mocked(saveRundownTemplate).mockResolvedValue({ ok: false, reason });
  render(<SaveRundownModal {...props()} />); submit();
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain(reason === "removed" ? "then removed" : "conflicts");
  expect(screen.queryByRole("button", { name: "Retry save" })).toBeNull();
  fireEvent.submit(screen.getByLabelText("Template Name").closest("form")!);
  expect(saveRundownTemplate).toHaveBeenCalledTimes(1);
});
