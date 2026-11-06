import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
const fixture = vi.hoisted(() => ({ slug: "venue", monitor: true }));
vi.mock("@tanstack/react-router", () => ({ createFileRoute: () => (options: { component: () => ReactNode }) => ({ options, useParams: () => ({ orgSlug: fixture.slug }), useSearch: () => ({ monitor: fixture.monitor }) }) }));
vi.mock("@/components/display/DisplayAccessGate", () => ({ DisplayAccessGate: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/lib/lt-templates", () => ({
  DEFAULT_CONTROLS: { accentColor: "#f59e0b", bgOpacity: 85, primarySize: 46, secondarySize: 26, posX: 5, posY: 82, animSpeed: "normal" },
  TEMPLATES: [{ id: "classic" }],
  getTemplate: () => ({ render: (title: string, subtitle: string, visible: boolean) => <p data-visible={String(visible)}>{title}{subtitle}</p> }),
  LtStage: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
import { Route } from "@/routes/overlay/$orgSlug";
const Page = Route.options.component!;
const response = (title: string) => new Response(JSON.stringify([{ id: "graphic", title, subtitle: "", style: "{}" }]));
const tick = async (ms = 0) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
beforeEach(() => { vi.useFakeTimers(); fixture.slug = "venue"; fixture.monitor = true; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("overlay reads", () => {
  it("does not overlap stalled requests and discards a timed-out reply after recovery", async () => {
    let finishOld: (response: Response) => void = () => {};
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; })).mockImplementation(async () => response("Current graphic"));
    vi.stubGlobal("fetch", fetch);
    render(<Page />);
    await tick(2_000); expect(fetch).toHaveBeenCalledTimes(1);
    await tick(7_000);
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(screen.getByText("Current graphic")).toBeTruthy();
    await act(async () => { finishOld(response("Old graphic")); });
    await tick(50);
    expect(screen.queryByText("Old graphic")).toBeNull();
    expect(screen.getByText("Current graphic")).toBeTruthy();
  });
});


describe("overlay continuity", () => {
  it("retains the mounted graphic through failure and retry, with diagnostics only in monitor mode", async () => {
    let offline = false;
    const fetch = vi.fn(async () => { if (offline) throw new Error("offline"); return response("Confirmed graphic"); });
    vi.stubGlobal("fetch", fetch);
    const { rerender } = render(<Page />); await tick(); await tick(50);
    const graphic = screen.getByText("Confirmed graphic");
    expect(graphic.getAttribute("data-visible")).toBe("true");
    offline = true; await tick(500);
    expect(screen.getByRole("alert").textContent).toContain("Keeping the last confirmed output");
    expect(document.querySelector("time")).toBeTruthy();
    expect(screen.getByText("Confirmed graphic")).toBe(graphic);
    fixture.monitor = false; rerender(<Page />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.title).toContain("reconnecting");
    expect(document.querySelector(".overlay-container")?.getAttribute("data-connection-state")).toBe("reconnecting");
    fixture.monitor = true; rerender(<Page />); offline = false;
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Retry overlay" })); });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Confirmed graphic")).toBe(graphic);
    expect(graphic.getAttribute("data-visible")).toBe("true");
  });

  it("updates text in place, honors layer order and completes exits even while empty polls continue", async () => {
    let rows = [{ id: "a", title: "Alpha" }, { id: "b", title: "Bravo" }];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(rows))));
    render(<Page />); await tick(50);
    const alpha = screen.getByText("Alpha");
    rows = [{ id: "b", title: "Bravo" }, { id: "a", title: "Changed alpha" }];
    await tick(500);
    expect(screen.getByText("Changed alpha")).toBe(alpha);
    expect(alpha.getAttribute("data-visible")).toBe("true");
    expect([...document.querySelectorAll("[data-overlay-graphic]")].map(node => node.getAttribute("data-overlay-graphic"))).toEqual(["b", "a"]);
    rows = []; await tick(500);
    expect(alpha.getAttribute("data-visible")).toBe("false");
    await tick(650);
    expect(document.querySelectorAll("[data-overlay-graphic]")).toHaveLength(0);
  });

  it("cancels a pending exit when the same graphic becomes active again", async () => {
    let rows = [{ id: "a", title: "Alpha" }];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(rows))));
    render(<Page />); await tick(50);
    const alpha = screen.getByText("Alpha");
    rows = []; await tick(500);
    rows = [{ id: "a", title: "Alpha returns" }]; await tick(500); await tick(200);
    expect(screen.getByText("Alpha returns")).toBe(alpha);
    expect(alpha.getAttribute("data-visible")).toBe("true");
  });

  it("rejects a malformed composition atomically instead of clearing or showing a partial replacement", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementationOnce(async () => response("Confirmed graphic"))
      .mockImplementation(async () => new Response(JSON.stringify([{ id: "next", title: "Partial replacement" }, { id: "bad", title: "Invalid style", style: JSON.stringify({ controls: { primarySize: -50 } }) }])));
    vi.stubGlobal("fetch", fetch);
    render(<Page />); await tick(50); await tick(500);
    expect(screen.getByText("Confirmed graphic")).toBeTruthy();
    expect(screen.queryByText("Partial replacement")).toBeNull();
    expect(screen.queryByText("Invalid style")).toBeNull();
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("removes protected output and stops polling after an access rejection until explicit recheck", async () => {
    let denied = false;
    const fetch = vi.fn(async () => denied ? new Response("Unauthorized", { status: 401 }) : response("Private graphic"));
    vi.stubGlobal("fetch", fetch);
    render(<Page />); await tick(50); denied = true; await tick(500);
    expect(screen.queryByText("Private graphic")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("display is unavailable");
    const calls = fetch.mock.calls.length; await tick(60_000);
    expect(fetch).toHaveBeenCalledTimes(calls);
    denied = false;
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Check display access" })); });
    expect(screen.getByText("Private graphic")).toBeTruthy();
  });

  it("cancels old workspace reads and animations when scope changes or output unmounts", async () => {
    let finishOld: (response: Response) => void = () => {};
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementationOnce(async () => response("Old workspace"))
      .mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }))
      .mockImplementation(async () => response("New workspace"));
    vi.stubGlobal("fetch", fetch);
    const { rerender, unmount } = render(<Page />); await tick(550);
    fixture.slug = "other"; rerender(<Page />);
    expect(screen.queryByText("Old workspace")).toBeNull();
    await tick();
    expect(fetch.mock.calls[1][1]?.signal?.aborted).toBe(true);
    await act(async () => { finishOld(response("Late old workspace")); });
    expect(screen.getByText("New workspace")).toBeTruthy();
    expect(screen.queryByText("Late old workspace")).toBeNull();
    unmount(); await tick(60_000);
    expect(vi.getTimerCount()).toBe(0);
  });
});


it("keeps incoming graphics above fading outgoing layers during replacement", async () => {
  let rows = [{ id: "old", title: "Outgoing" }];
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(rows))));
  render(<Page />); await tick(); await tick(50);
  rows = [{ id: "new", title: "Incoming" }]; await tick(500); await tick(50);
  expect([...document.querySelectorAll("[data-overlay-graphic]")].map(node => node.getAttribute("data-overlay-graphic"))).toEqual(["old", "new"]);
  expect(screen.getByText("Outgoing").getAttribute("data-visible")).toBe("false");
  expect(screen.getByText("Incoming").getAttribute("data-visible")).toBe("true");
  await tick(650);
  expect(screen.queryByText("Outgoing")).toBeNull();
  expect(screen.getByText("Incoming")).toBeTruthy();
});
