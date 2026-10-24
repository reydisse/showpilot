import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ available: true, install: vi.fn(), close: vi.fn() }));
vi.mock("@tauri-apps/plugin-updater", () => ({
  check: async () => native.available ? { version: "0.1.13", downloadAndInstall: native.install, close: native.close } : null,
}));
import { runBridgeUpdate } from "./updates";

beforeEach(() => {
  native.available = true;
  native.install.mockReset().mockResolvedValue(undefined);
  native.close.mockReset().mockResolvedValue(undefined);
});

describe("Bridge updates", () => {
  it("checks without installing and closes the updater resource", async () => {
    await expect(runBridgeUpdate("check")).resolves.toEqual({ kind: "available", version: "0.1.13" });
    expect(native.install).not.toHaveBeenCalled();
    expect(native.close).toHaveBeenCalledOnce();
  });

  it("installs only after an explicit install action without browser dialogs", async () => {
    await expect(runBridgeUpdate("install")).resolves.toEqual({ kind: "installed", version: "0.1.13" });
    expect(native.install).toHaveBeenCalledOnce();
    expect(native.close).toHaveBeenCalledOnce();
  });

  it("releases resources and reports an installation failure", async () => {
    native.install.mockRejectedValueOnce(new Error("Invalid update signature"));
    await expect(runBridgeUpdate("install")).rejects.toThrow("Invalid update signature");
    expect(native.close).toHaveBeenCalledOnce();
  });

  it("reports when no update is available", async () => {
    native.available = false;
    await expect(runBridgeUpdate("check")).resolves.toEqual({ kind: "current" });
    expect(native.install).not.toHaveBeenCalled();
    expect(native.close).not.toHaveBeenCalled();
  });
});
