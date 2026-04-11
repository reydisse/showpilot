import { describe, it, expect, vi, beforeEach } from "vitest";
import { BaseDeviceModule } from "../base-module";
import type {
  DeviceConnectionStatus,
  ModuleAction,
  ModuleFeedback,
} from "../types";

/** Concrete test implementation of the abstract base module */
class TestModule extends BaseDeviceModule {
  connectCalled = false;
  disconnectCalled = false;
  shouldFailConnect = false;

  protected async doConnect(): Promise<void> {
    this.connectCalled = true;
    if (this.shouldFailConnect) {
      throw new Error("Connection refused");
    }
  }

  protected doDisconnect(): void {
    this.disconnectCalled = true;
  }

  getActions(): ModuleAction[] {
    return [
      { id: "test_action", label: "Test Action", params: [] },
      {
        id: "parameterized",
        label: "With Param",
        params: [{ id: "level", label: "Level", type: "number", min: 0, max: 1 }],
      },
    ];
  }

  async executeAction(actionId: string, params: Record<string, unknown>): Promise<void> {
    if (actionId === "fail") throw new Error("Action failed");
  }

  getFeedbacks(): ModuleFeedback[] {
    return [
      { id: "is_live", label: "Is Live", type: "boolean", value: false },
      { id: "level", label: "Level", type: "number", value: 0.75 },
    ];
  }
}

describe("BaseDeviceModule", () => {
  let module: TestModule;

  beforeEach(() => {
    module = new TestModule();
  });

  // ─── Initial state ──────────────────────────────────────

  it("starts in disconnected state", () => {
    expect(module.connectionStatus()).toBe("disconnected");
  });

  // ─── Connection lifecycle ───────────────────────────────

  it("transitions to connecting then connected on successful connect", async () => {
    const statuses: DeviceConnectionStatus[] = [];
    module.onStatusChange((s) => statuses.push(s));

    await module.connect();

    expect(statuses).toEqual(["connecting", "connected"]);
    expect(module.connectionStatus()).toBe("connected");
    expect(module.connectCalled).toBe(true);
  });

  it("transitions to connecting then error on failed connect", async () => {
    module.shouldFailConnect = true;
    const statuses: DeviceConnectionStatus[] = [];
    module.onStatusChange((s) => statuses.push(s));

    await module.connect();

    expect(statuses).toEqual(["connecting", "error"]);
    expect(module.connectionStatus()).toBe("error");
  });

  it("passes error message to status listener on failure", async () => {
    module.shouldFailConnect = true;
    const errors: (string | undefined)[] = [];
    module.onStatusChange((_s, err) => errors.push(err));

    await module.connect();

    expect(errors[1]).toBe("Connection refused");
  });

  it("transitions to disconnected on disconnect", async () => {
    await module.connect();
    const statuses: DeviceConnectionStatus[] = [];
    module.onStatusChange((s) => statuses.push(s));

    module.disconnect();

    expect(statuses).toEqual(["disconnected"]);
    expect(module.connectionStatus()).toBe("disconnected");
    expect(module.disconnectCalled).toBe(true);
  });

  it("does not call doConnect if already connected", async () => {
    await module.connect();
    module.connectCalled = false;

    await module.connect();

    expect(module.connectCalled).toBe(false);
  });

  it("does not call doDisconnect if already disconnected", () => {
    module.disconnect();
    expect(module.disconnectCalled).toBe(false);
  });

  // ─── Listener management ────────────────────────────────

  it("unsubscribes status listener when returned function is called", async () => {
    const statuses: DeviceConnectionStatus[] = [];
    const unsub = module.onStatusChange((s) => statuses.push(s));

    unsub();
    await module.connect();

    expect(statuses).toEqual([]);
  });

  it("supports multiple simultaneous status listeners", async () => {
    const a: DeviceConnectionStatus[] = [];
    const b: DeviceConnectionStatus[] = [];
    module.onStatusChange((s) => a.push(s));
    module.onStatusChange((s) => b.push(s));

    await module.connect();

    expect(a).toEqual(["connecting", "connected"]);
    expect(b).toEqual(["connecting", "connected"]);
  });

  // ─── Feedback listeners ─────────────────────────────────

  it("notifies feedback listeners when emitFeedback is called", () => {
    const changes: [string, unknown][] = [];
    module.onFeedbackChange((id, val) => changes.push([id, val]));

    module.emitFeedbackPublic("is_live", true);

    expect(changes).toEqual([["is_live", true]]);
  });

  it("unsubscribes feedback listener", () => {
    const changes: [string, unknown][] = [];
    const unsub = module.onFeedbackChange((id, val) => changes.push([id, val]));

    unsub();
    module.emitFeedbackPublic("is_live", true);

    expect(changes).toEqual([]);
  });

  // ─── Actions ────────────────────────────────────────────

  it("returns declared actions", () => {
    const actions = module.getActions();
    expect(actions).toHaveLength(2);
    expect(actions[0].id).toBe("test_action");
  });

  it("returns declared feedbacks", () => {
    const feedbacks = module.getFeedbacks();
    expect(feedbacks).toHaveLength(2);
    expect(feedbacks[0].id).toBe("is_live");
    expect(feedbacks[1].value).toBe(0.75);
  });
});
