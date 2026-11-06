import { timecodeFixture, startFixtureTimecodeFeed } from "@/test/timecode-fixtures";
import { openTestBridge, approveTestBridgeTarget } from "@/test/bridge-fixtures";
import { env } from "cloudflare:workers";
import { abortAllDurableObjects } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

afterEach(async () => {
  await abortAllDurableObjects();
});

function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    socket.addEventListener("message", (event) => {
      try {
        resolve(JSON.parse(String(event.data)) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    }, { once: true });
  });
}

async function openBridge(orgId: string): Promise<WebSocket> { return (await openTestBridge(orgId)).socket; }

async function command({ stub, url }: Awaited<ReturnType<typeof timecodeFixture>>, action: string, payload?: Record<string, unknown>) {
  if (action === "feed-tc") await startFixtureTimecodeFeed(stub, url);
  return stub.fetch(new Request(
    url("/command"),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, payload }),
    },
  ));
}

async function events({ stub, url }: Awaited<ReturnType<typeof timecodeFixture>>) {
  const response = await stub.fetch(
    new Request(url("/events")),
  );
  return response.json<Array<Record<string, unknown>>>();
}

async function seedOrganizationAndDevice(orgId: string) {
  const now = new Date().toISOString();
  const deviceId = `${orgId}-atem-main`;
  await env.DB.prepare(
    "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)",
  ).bind(orgId, "Timecode Device Test", orgId, now).run();
  await env.DB.prepare(
    `INSERT INTO device (id, orgId, name, category, adapterType, settings, enabled, createdAt, updatedAt)
     VALUES (?, ?, ?, 'video', 'atem', ?, 1, ?, ?)`,
  ).bind(
    deviceId,
    orgId,
    "Main ATEM",
    JSON.stringify({ host: "10.0.0.20", port: 9910 }),
    now,
    now,
  ).run();
  await approveTestBridgeTarget(orgId, "atem", "10.0.0.20:9910");
  return deviceId;
}

describe("TimecodeRelay device automation", () => {
  it("dispatches one validated command through Venue Bridge and records acknowledgement", async () => {
    const orgId = "timecode-device-success";
    const deviceId = await seedOrganizationAndDevice(orgId);
    const fixture = await timecodeFixture(orgId);
    const bridge = await openBridge(orgId);
    await command(fixture, "add-event", {
      id: "event-1",
      triggerTimecode: { hours: 0, minutes: 0, seconds: 1, frames: 0 },
      action: "device-action",
      targetDeviceId: deviceId,
      targetActionId: "set_program_input",
      payload: { input: 3 },
      label: "ATEM camera 3",
      toleranceFrames: 2,
    });

    const connectMessage = nextMessage(bridge);
    const feed = command(fixture, "feed-tc", {
      timecode: { hours: 0, minutes: 0, seconds: 1, frames: 0 },
      format: { frameRate: 30, dropFrame: "ndf" },
    });
    await expect(connectMessage).resolves.toMatchObject({
      type: "connect-device",
      protocol: "atem",
      target: "10.0.0.20:9910",
    });
    bridge.send(JSON.stringify({ type: "device-status", target: "10.0.0.20:9910", connected: true }));

    const sentCommand = await nextMessage(bridge);
    expect(sentCommand).toMatchObject({
      type: "command",
      protocol: "atem",
      target: "10.0.0.20:9910",
    });
    expect(JSON.parse(String(sentCommand.command))).toEqual({
      actionId: "set_program_input",
      params: { input: 3 },
    });
    bridge.send(JSON.stringify({ type: "command-response", id: sentCommand.id, success: true, response: "ok" }));
    expect((await feed).ok).toBe(true);

    await expect(events(fixture)).resolves.toEqual([
      expect.objectContaining({
        id: "event-1",
        fired: true,
        executionStatus: "acknowledged",
        executedAt: expect.any(Number),
      }),
    ]);

    let duplicate = false;
    bridge.addEventListener("message", () => { duplicate = true; }, { once: true });
    await command(fixture, "feed-tc", {
      timecode: { hours: 0, minutes: 0, seconds: 1, frames: 1 },
      format: { frameRate: 30, dropFrame: "ndf" },
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(duplicate).toBe(false);
  });

  it("keeps an offline bridge failure visible instead of marking the event successful", async () => {
    const orgId = "timecode-device-offline";
    const deviceId = await seedOrganizationAndDevice(orgId);
    const fixture = await timecodeFixture(orgId);
    await command(fixture, "add-event", {
      id: "event-offline",
      triggerTimecode: { hours: 0, minutes: 0, seconds: 1, frames: 0 },
      action: "device-action",
      payload: { deviceId, actionId: "cut" },
      label: "ATEM cut",
      toleranceFrames: 2,
    });
    await command(fixture, "feed-tc", {
      timecode: { hours: 0, minutes: 0, seconds: 1, frames: 0 },
      format: { frameRate: 30, dropFrame: "ndf" },
    });

    await expect(events(fixture)).resolves.toEqual([
      expect.objectContaining({
        id: "event-offline",
        fired: false,
        executionStatus: "failed",
        executionError: "Venue Bridge is offline.",
      }),
    ]);
  });
});
