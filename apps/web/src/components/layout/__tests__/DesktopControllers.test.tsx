import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopControllers } from "../DesktopControllers";
import { DesktopNotificationNotice } from "../DesktopNotificationNotice";
import type { DesktopNotificationDelivery } from "../DesktopNotificationContext";

const native = vi.hoisted(() => ({
  enabled: false,
  loadBridge: vi.fn(),
  loadNotifications: vi.fn(),
  mountBridge: vi.fn(),
  mountNotifications: vi.fn(),
  stopBridge: vi.fn(),
  stopNotifications: vi.fn(),
  retryNotifications: vi.fn(),
  mountPage: vi.fn(),
  stopPage: vi.fn(),
}));

vi.mock("@/lib/desktop-runtime", () => ({ isDesktopRuntime: () => native.enabled }));
vi.mock("../DesktopBridgeController", async () => {
  native.loadBridge();
  const { useEffect } = await import("react");
  return { DesktopBridgeController: () => {
    useEffect(() => { native.mountBridge(); return native.stopBridge; }, []);
    return null;
  } };
});
vi.mock("../DesktopNotificationController", async () => {
  native.loadNotifications();
  const { useEffect } = await import("react");
  return { DesktopNotificationController: ({ onDeliveryChange }: { onDeliveryChange: (delivery: DesktopNotificationDelivery | null) => void }) => {
    useEffect(() => {
      native.mountNotifications();
      onDeliveryChange({ state: { kind: "load-failed", failure: { message: "Fixture alerts unavailable", at: Date.now() } }, retry: native.retryNotifications });
      return () => { native.stopNotifications(); onDeliveryChange(null); };
    }, [onDeliveryChange]);
    return null;
  } };
});

afterEach(cleanup);

function Page() {
  useEffect(() => { native.mountPage(); return native.stopPage; }, []);
  return <main>Show flow<input aria-label="Draft" defaultValue="" /><DesktopNotificationNotice /></main>;
}

describe("native background controller loading", () => {
  it("never imports native controllers in a browser session", () => {
    native.enabled = false;
    render(<DesktopControllers><main>Show flow</main></DesktopControllers>);
    expect(native.loadBridge).not.toHaveBeenCalled();
    expect(native.loadNotifications).not.toHaveBeenCalled();
  });

  it("hydrates lazy native services without remounting the page and exposes alert recovery", async () => {
    native.enabled = true;
    const app = <DesktopControllers><Page /></DesktopControllers>;
    const container = document.createElement("div");
    container.innerHTML = renderToString(app);
    document.body.appendChild(container);
    const draft = screen.getByRole("textbox", { name: "Draft" });
    fireEvent.change(draft, { target: { value: "Operator draft" } });
    expect(native.loadBridge).not.toHaveBeenCalled();
    expect(native.loadNotifications).not.toHaveBeenCalled();
    const onRecoverableError = vi.fn();
    let root: ReturnType<typeof hydrateRoot> | undefined;
    await act(async () => { root = hydrateRoot(container, app, { onRecoverableError }); });
    try {
      expect(container.textContent).toContain("Show flow");
      await waitFor(() => {
        expect(native.mountBridge).toHaveBeenCalledTimes(1);
        expect(native.mountNotifications).toHaveBeenCalledTimes(1);
      });
      expect(onRecoverableError).not.toHaveBeenCalled();
      expect(screen.getByRole("textbox", { name: "Draft" })).toBe(draft);
      expect(screen.getByDisplayValue("Operator draft")).toBe(draft);
      expect(native.mountPage).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("alert").textContent).toContain("Fixture alerts unavailable");
      fireEvent.click(screen.getByRole("button", { name: "Retry desktop alerts" }));
      expect(native.retryNotifications).toHaveBeenCalledTimes(1);
    } finally {
      act(() => root?.unmount());
      container.remove();
    }
    expect(native.stopBridge).toHaveBeenCalledTimes(1);
    expect(native.stopNotifications).toHaveBeenCalledTimes(1);
    expect(native.stopPage).toHaveBeenCalledTimes(1);
  });
});
