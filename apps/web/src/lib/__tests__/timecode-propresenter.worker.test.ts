import { abortAllDurableObjects } from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import { timecodeFixture } from "@/test/timecode-fixtures";
import {
  approveTestBridgeTarget,
  openTestBridge,
} from "@/test/bridge-fixtures";
import type { AutomationActionType, AutomationEvent } from "@/types/timecode";
import { TIMECODE_FEED_STALL_MS } from "@/types/timecode";
import { framesToTimecode } from "@/lib/timecode";

afterEach(abortAllDurableObjects);
const target = "propresenter:192.168.1.20:50001";
const atZero = { hours: 0, minutes: 0, seconds: 0, frames: 0 };
const cue = {
  id: "cue",
  label: "Prop cue",
  triggerTimecode: atZero,
  action: "pp-trigger-prop",
  payload: { propName: "Standby" },
};

async function setup() {
  const test = await timecodeFixture();
  const bridge = await openTestBridge(test.orgId);
  await approveTestBridgeTarget(test.orgId, "propresenter", target);
  bridge.socket.send(
    JSON.stringify({ type: "device-status", target, connected: true }),
  );
  await expect
    .poll(async () => (await bridge.stub.getBridgeStatus()).connectedTargets)
    .toContain(target);
  const received: {
    id: string;
    action: string;
    command: Record<string, unknown>;
    at: number;
  }[] = [];
  let rejectAction: string | undefined;
  let pauseAction: string | undefined;
  const acknowledge = (id: string, action: string) =>
    bridge.socket.send(
      JSON.stringify({
        type: "command-response",
        id,
        success: action !== rejectAction,
        error: action === rejectAction ? "Fixture rejection" : undefined,
        response:
          action === "resolve-prop"
            ? JSON.stringify({ propUuid: "prop-uuid" })
            : undefined,
      }),
    );
  bridge.socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.type !== "command") return;
    const command = JSON.parse(message.command);
    received.push({
      id: message.id,
      action: command.action,
      command,
      at: Date.now(),
    });
    if (command.action !== pauseAction) acknowledge(message.id, command.action);
  });
  return {
    ...test,
    bridge,
    received,
    acknowledge,
    reject: (action?: string) => {
      rejectAction = action;
    },
    pause: (action?: string) => {
      pauseAction = action;
    },
    async command(action: string, payload?: unknown, status = 200) {
      const response = await test.stub.fetch(test.url("/command"), {
        method: "POST",
        body: JSON.stringify({ action, payload }),
      });
      expect(response.status).toBe(status);
      await response.text();
    },
    events: async () =>
      (await test.stub.fetch(test.url("/events"))).json<AutomationEvent[]>(),
  };
}

async function feedClock(
  test: Awaited<ReturnType<typeof setup>>,
  continuous = true,
  socketFirst = false,
) {
  const socket = test.controlSocket;
  if (!socket) throw new Error("Missing clock owner socket");
  await test.command("start");
  const format = { frameRate: 30, dropFrame: "ndf" } as const;
  let frame = 0;
  if (socketFirst) {
    socket.send(JSON.stringify({
      type: "command",
      action: "feed-tc",
      payload: { timecode: atZero, format },
    }));
    await expect.poll(async () => (await test.events())[0]?.executionStatus)
      .toBe("dispatching");
  }
  // Continue sending frames independently, as a real source does while
  // ProPresenter acknowledges its commands.
  const interval = continuous
    ? setInterval(() => {
        socket.send(JSON.stringify({
          type: "command",
          action: "feed-tc",
          payload: { timecode: framesToTimecode(++frame, format), format },
        }));
      }, 50)
    : undefined;
  const request = test.command("feed-tc", { timecode: atZero, format });
  return {
    async waitForCompletion() {
      await request;
      // A socket frame may own dispatch before the HTTP frame arrives. Its
      // response then confirms only that frame, not the pending cue execution.
      await expect.poll(async () => {
        const status = (await test.events())[0]?.executionStatus;
        return status === "acknowledged" || status === "failed";
      }).toBe(true);
    },
    stop: () => clearInterval(interval),
  };
}

it("resolves the exact prop before clearing only props, waits, then triggers with unique receipts", async () => {
  const test = await setup();
  await test.command("add-event", {
    ...cue,
    payload: { propName: "Standby", action: "clear-all", propUuid: "injected" },
  });
  const feed = await feedClock(test);
  try {
    await feed.waitForCompletion();
  } finally {
    feed.stop();
  }
  expect(test.received.map((row) => row.command)).toEqual([
    { action: "resolve-prop", propName: "Standby" },
    { action: "clear-props" },
    { action: "trigger-prop", propUuid: "prop-uuid" },
  ]);
  expect(new Set(test.received.map((row) => row.id)).size).toBe(3);
  expect(test.received[2].at - test.received[1].at).toBeGreaterThanOrEqual(200);
  expect(await test.events()).toEqual([
    expect.objectContaining({ fired: true, executionStatus: "acknowledged" }),
  ]);
});

it.each([
  { continuous: true, socketFirst: false },
  { continuous: true, socketFirst: true },
  { continuous: false, socketFirst: false },
])(
  "finishes a slow automatic prop sequence: continuous=$continuous, socketFirst=$socketFirst",
  async ({ continuous, socketFirst }) => {
    const test = await setup();
    test.pause("clear-props");
    await test.command("add-event", cue);
    const feed = await feedClock(test, continuous, socketFirst);
    try {
      await expect.poll(() => test.received.at(-1)?.action).toBe("clear-props");
      await new Promise((resolve) => setTimeout(resolve, TIMECODE_FEED_STALL_MS + 250));
    } finally {
      const clear = test.received.find((row) => row.action === "clear-props");
      if (clear) test.acknowledge(clear.id, clear.action);
      try {
        await feed.waitForCompletion();
      } finally {
        feed.stop();
      }
    }
    expect((await test.events())[0]).toMatchObject({
      fired: continuous,
      executionStatus: continuous ? "acknowledged" : "failed",
    });
    expect(test.received.map((row) => row.action)).toEqual(
      continuous
        ? ["resolve-prop", "clear-props", "trigger-prop"]
        : ["resolve-prop", "clear-props"],
    );
    if (!continuous) {
      expect((await test.events())[0]).toMatchObject({
        executionRetryable: false,
        executionError: expect.stringContaining("interrupted after dispatch"),
      });
    }
  },
);

it.each(["resolve-prop", "clear-props", "trigger-prop"])(
  "fails on %s rejection and permits an explicit retry with fresh receipt IDs",
  async (action) => {
    const test = await setup();
    test.reject(action);
    await test.command("add-event", cue);
    await test.command("fire-event", { id: cue.id });
    expect((await test.events())[0]).toMatchObject({
      fired: false,
      executionStatus: "failed",
    });
    const failedCommands = [...test.received];
    expect(failedCommands.at(-1)?.action).toBe(action);
    test.reject();
    await test.command("retry-event", { id: cue.id });
    expect((await test.events())[0]).toMatchObject({
      fired: true,
      executionStatus: "acknowledged",
      executionAttempts: 1,
    });
    const retry = test.received.slice(failedCommands.length);
    expect(retry.map((row) => row.action)).toEqual([
      "resolve-prop",
      "clear-props",
      "trigger-prop",
    ]);
    expect(
      retry.every((row) => !failedCommands.some((old) => old.id === row.id)),
    ).toBe(true);
  },
);

it.each([
  "pp-trigger-previous",
  "pp-clear-props",
  "pp-trigger-prop",
] satisfies AutomationActionType[])(
  "honors disable and reviewed re-fire for %s",
  async (action) => {
    const test = await setup();
    await test.command("add-event", { ...cue, action, enabled: false });
    await test.command("fire-event", { id: cue.id }, 400);
    expect(test.received).toEqual([]);
    await test.command("set-event-enabled", {
      id: cue.id,
      enabled: true,
    });
    await test.command("fire-event", { id: cue.id });
    const first = (await test.events())[0];
    expect(first.fired).toBe(true);
    const count = test.received.length;
    await test.command("fire-event", { id: cue.id }, 400);
    expect(test.received).toHaveLength(count);
    await test.command("rearm-event", {
      id: cue.id,
      confirmed: true,
      expected: { fired: true, skipped: false, executionId: first.executionId },
    });
    await test.command("fire-event", { id: cue.id });
    expect(test.received).toHaveLength(count * 2);
  },
);

it("does not let a payload change Next into a different command", async () => {
  const test = await setup();
  await test.command("add-event", {
    ...cue,
    action: "pp-trigger-next",
    payload: { action: "clear" },
  });
  await test.command("fire-event", { id: cue.id });
  expect(test.received.map((row) => row.command)).toEqual([{ action: "next" }]);
});

it("keeps a queued Previous after the complete prop sequence", async () => {
  const test = await setup();
  test.pause("clear-props");
  await test.command("add-event", cue);
  await test.command("add-event", {
    ...cue,
    id: "previous",
    action: "pp-trigger-previous",
    payload: {},
  });
  const prop = test.command("fire-event", { id: cue.id });
  await expect.poll(() => test.received.at(-1)?.action).toBe("clear-props");
  const previous = test.command("fire-event", { id: "previous" });
  const clear = test.received.find((row) => row.action === "clear-props");
  if (!clear) throw new Error("Missing clear command");
  test.acknowledge(clear.id, clear.action);
  await Promise.all([prop, previous]);
  expect(test.received.map((row) => row.action)).toEqual([
    "resolve-prop",
    "clear-props",
    "trigger-prop",
    "previous",
  ]);
  expect((await test.events()).every((event) => event.fired)).toBe(true);
});

it("requires an explicit target when more than one ProPresenter is connected", async () => {
  const test = await setup();
  const other = "propresenter:192.168.1.21:50001";
  await approveTestBridgeTarget(test.orgId, "propresenter", other);
  test.bridge.socket.send(
    JSON.stringify({ type: "device-status", target: other, connected: true }),
  );
  await expect
    .poll(
      async () => (await test.bridge.stub.getBridgeStatus()).connectedTargets,
    )
    .toContain(other);
  await test.command("add-event", cue);
  await test.command("fire-event", { id: cue.id });
  expect(test.received).toEqual([]);
  expect((await test.events())[0].executionError).toContain("Choose one");
  await test.command("update-event", {
    id: cue.id,
    updates: { payload: { propName: "Standby", target } },
  });
  await test.command("retry-event", { id: cue.id });
  expect((await test.events())[0].fired).toBe(true);
});

it("checks the reviewed installation inside the Bridge dispatch lock", async () => {
  const test = await setup();
  const result = await test.bridge.stub.dispatchBridgeMessage(
    {
      type: "command",
      id: "wrong-installation",
      protocol: "propresenter",
      target,
      command: '{"action":"clear-props"}',
    },
    {
      source: "automation",
      actorUserId: test.authority.userId,
      executionId: "reviewed-cue",
    },
    "previous-installation",
  );
  expect(result).toMatchObject({
    success: false,
    error: expect.stringContaining("Active Venue Bridge changed"),
  });
  expect(test.received).toEqual([]);
});

it("refuses a prop follow-up after its target disconnects", async () => {
  const test = await setup();
  test.pause("clear-props");
  await test.command("add-event", cue);
  const fire = test.command("fire-event", { id: cue.id });
  try {
    await expect.poll(() => test.received.at(-1)?.action).toBe("clear-props");
    test.bridge.socket.send(
      JSON.stringify({ type: "device-status", target, connected: false }),
    );
    await expect
      .poll(
        async () => (await test.bridge.stub.getBridgeStatus()).connectedTargets,
      )
      .not.toContain(target);
  } finally {
    const clear = test.received.find((row) => row.action === "clear-props");
    if (clear) test.acknowledge(clear.id, clear.action);
    await fire;
  }
  expect(test.received.map((row) => row.action)).toEqual([
    "resolve-prop",
    "clear-props",
  ]);
  expect((await test.events())[0]).toMatchObject({
    fired: false,
    executionStatus: "failed",
  });
});

it("stops the prop sequence when automation is killed while Clear Props is awaiting acknowledgment", async () => {
  const test = await setup();
  test.pause("clear-props");
  await test.command("add-event", cue);
  const fire = test.command("fire-event", { id: cue.id });
  try {
    await expect.poll(() => test.received.at(-1)?.action).toBe("clear-props");
    await test.command("set-triggers-enabled", { enabled: false });
  } finally {
    const clear = test.received.find((row) => row.action === "clear-props");
    if (clear) test.acknowledge(clear.id, clear.action);
    await fire;
  }
  expect(test.received.map((row) => row.action)).toEqual([
    "resolve-prop",
    "clear-props",
  ]);
  expect((await test.events())[0]).toMatchObject({
    fired: false,
    executionStatus: "failed",
  });
});

it("validates prop names on add, update and group replacement without losing the existing timeline", async () => {
  const test = await setup();
  await test.command("add-event", cue);
  const before = await test.events();
  for (const propName of [undefined, " ", 1, "x".repeat(201)]) {
    await test.command(
      "add-event",
      { ...cue, id: "bad", payload: { propName } },
      400,
    );
    await test.command(
      "update-event",
      { id: cue.id, updates: { payload: { propName } } },
      400,
    );
    await test.command(
      "replace-event-group",
      { sourceKey: "props", events: [{ ...cue, payload: { propName } }] },
      400,
    );
    expect(await test.events()).toEqual(before);
  }
});
