import { act, cleanup, render, waitFor } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopControllers } from "../DesktopControllers";

const native = vi.hoisted(() => ({
  enabled: false,
  loadBridge: vi.fn(),
  loadNotifications: vi.fn(),
  mountBridge: vi.fn(),
  mountNotifications: vi.fn(),
  stopBridge: vi.fn(),
  stopNotifications: vi.fn(),
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
  return { DesktopNotificationController: () => {
    useEffect(() => { native.mountNotifications(); return native.stopNotifications; }, []);
    return null;
  } };
});

afterEach(cleanup);

describe("native background controller loading", () => {
  it("never imports native controllers in a browser session", () => {
    native.enabled = false;
    render(<><DesktopControllers /><main>Show flow</main></>);
    expect(native.loadBridge).not.toHaveBeenCalled();
    expect(native.loadNotifications).not.toHaveBeenCalled();
  });

  it("matches SSR before hydrating native services, keeps the page visible, and cleans up", async () => {
    native.enabled = true;
    const app = <><DesktopControllers /><main>Show flow</main></>;
    const container = document.createElement("div");
    container.innerHTML = renderToString(app);
    document.body.appendChild(container);
    expect(native.loadBridge).not.toHaveBeenCalled();
    expect(native.loadNotifications).not.toHaveBeenCalled();
    const onRecoverableError = vi.fn();
    let root: ReturnType<typeof hydrateRoot> | undefined;
    await act(async () => { root = hydrateRoot(container, app, { onRecoverableError }); });
    try {
      expect(container.textContent).toBe("Show flow");
      await waitFor(() => {
        expect(native.mountBridge).toHaveBeenCalledTimes(1);
        expect(native.mountNotifications).toHaveBeenCalledTimes(1);
      });
      expect(onRecoverableError).not.toHaveBeenCalled();
      expect(container.textContent).toBe("Show flow");
    } finally {
      act(() => root?.unmount());
      container.remove();
    }
    expect(native.stopBridge).toHaveBeenCalledTimes(1);
    expect(native.stopNotifications).toHaveBeenCalledTimes(1);
  });
});
