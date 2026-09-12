import { env } from "cloudflare:workers";
import { abortAllDurableObjects } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

afterEach(async () => {
  await abortAllDurableObjects();
});

const serviceDate = "2026-09-12";

async function createOrg(orgId: string) {
  await env.DB.prepare(
    `INSERT INTO organization (id, name, slug, createdAt)
     VALUES (?, ?, ?, ?)`,
  ).bind(orgId, "Relay Test", orgId, new Date().toISOString()).run();
}

function relayFor(orgId: string) {
  return env.RUNDOWN_RELAY.getByName(`${orgId}:${serviceDate}`);
}

async function command(
  orgId: string,
  action: string,
  payload: Record<string, unknown>,
) {
  return relayFor(orgId).fetch(new Request(
    `https://rundown.test/command?orgId=${orgId}&serviceDate=${serviceDate}&access=edit`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, payload }),
    },
  ));
}

async function state(orgId: string): Promise<Record<string, unknown>> {
  const response = await relayFor(orgId).fetch(new Request(
    `https://rundown.test/state?orgId=${orgId}&serviceDate=${serviceDate}&access=observe`,
  ));
  return response.json<Record<string, unknown>>();
}

const slide = {
  text: "Amazing grace",
  notes: "Verse 1",
  presentationName: "Amazing Grace",
  isScripture: false,
  updatedAt: 1,
};

describe("RundownRelay ProPresenter output ownership", () => {
  it("keeps venue lyrics live without a rundown-page browser writer", async () => {
    const orgId = "relay-pp-continuity";
    await createOrg(orgId);

    expect((await command(orgId, "pp-output-enabled", { enabled: true })).status).toBe(200);
    expect((await command(orgId, "pp-preview", { slide })).status).toBe(200);

    const firstDevice = await state(orgId);
    const secondDevice = await state(orgId);
    expect(firstDevice).toMatchObject({ ppOutputEnabled: true, ppSlide: { text: slide.text } });
    expect(secondDevice).toMatchObject({ ppOutputEnabled: true, ppSlide: { text: slide.text } });

    const stored = await env.DB.prepare(
      "SELECT value FROM app_setting WHERE orgId = ? AND key = ? LIMIT 1",
    ).bind(orgId, `rundown-ppslide:${serviceDate}`).first<{ value: string }>();
    expect(JSON.parse(stored?.value ?? "null")).toMatchObject({ text: slide.text });
  });

  it("serializes the shared output switch and clears every device together", async () => {
    const orgId = "relay-pp-shared-switch";
    await createOrg(orgId);
    await command(orgId, "pp-output-enabled", { enabled: true });
    await command(orgId, "pp-preview", { slide });

    expect((await command(orgId, "pp-output-enabled", { enabled: false })).status).toBe(200);
    expect(await state(orgId)).toMatchObject({ ppOutputEnabled: false, ppSlide: null });

    const setting = await env.DB.prepare(
      "SELECT value FROM app_setting WHERE orgId = ? AND key = 'propresenter-stage-display' LIMIT 1",
    ).bind(orgId).first<{ value: string }>();
    expect(setting?.value).toBe("false");
  });
});

describe("RundownRelay stage-message continuity", () => {
  it("restores the active message for a reader that joins after the editor leaves", async () => {
    const orgId = "relay-stage-message-continuity";
    await createOrg(orgId);

    expect((await command(orgId, "stage-message", {
      message: "!!PRIORITY!!Hold the stage",
    })).status).toBe(200);

    expect(await state(orgId)).toMatchObject({
      stageMessage: "!!PRIORITY!!Hold the stage",
    });
    const stored = await env.DB.prepare(
      "SELECT value FROM app_setting WHERE orgId = ? AND key = ? LIMIT 1",
    ).bind(orgId, `rundown-message:${serviceDate}`).first<{ value: string }>();
    expect(stored?.value).toBe("!!PRIORITY!!Hold the stage");
  });
});
