import { withRelayMember } from "@/test/relay-fixtures";
import { env } from "cloudflare:workers";
import { abortAllDurableObjects, evictDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import type { RundownItem } from "@/types/rundown";
import { nextPlayableItem } from "../rundown-transport";
import { hasLiveRundownAuthority } from "../live-rundown-authority.server";

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

function nextFrame(socket: WebSocket, expectedType: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      try {
        const parsed: unknown = JSON.parse(typeof event.data === "string" ? event.data : "");
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          reject(new Error("Rundown relay sent a non-object frame"));
          return;
        }
        const frame = parsed as Record<string, unknown>;
        if (frame.type !== expectedType) {
          socket.addEventListener("message", onMessage, { once: true });
          return;
        }
        resolve(frame);
      } catch (error) {
        reject(error);
      }
    };
    socket.addEventListener("message", onMessage, { once: true });
  });
}

async function command(
  orgId: string,
  action: string,
  payload: Record<string, unknown>,
  access: "edit" | "control" = "edit",
) {
  const response = await relayFor(orgId).fetch(new Request(
    await withRelayMember(`https://rundown.test/command?orgId=${orgId}&serviceDate=${serviceDate}&access=${access}`),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, payload }),
    },
  ));
  await response.arrayBuffer();
  return response;
}

async function state(orgId: string): Promise<Record<string, unknown>> {
  const response = await relayFor(orgId).fetch(new Request(
    await withRelayMember(`https://rundown.test/state?orgId=${orgId}&serviceDate=${serviceDate}&access=observe`),
  ));
  return response.json<Record<string, unknown>>();
}

const slide = {
  text: "Amazing grace",
  notes: "Verse 1",
  presentationName: "Amazing Grace",
  isScripture: false,
  updatedAt: 1,
  slideId: "verse-1",
  nextText: "How sweet the sound",
  nextSlideId: "verse-2",
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
    expect(JSON.parse(stored?.value ?? "null")).toMatchObject({ text: slide.text, nextText: slide.nextText, slideId: slide.slideId, nextSlideId: slide.nextSlideId });
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

describe("RundownRelay live authority", () => {
  it("closes live sockets and erases durable state during show purge", async () => {
    const orgId = "relay-show-purge";
    await createOrg(orgId);
    await command(orgId, "stage-message", { message: "Delete this show" });
    const response = await relayFor(orgId).fetch(new Request(
      await withRelayMember(`https://rundown.test/ws?orgId=${orgId}&serviceDate=${serviceDate}&showId=show-1&access=observe`),
      { headers: { Upgrade: "websocket" } },
    ));
    if (!response.webSocket) throw new Error("Rundown upgrade did not return a WebSocket");
    const socket = response.webSocket;
    const hydration = nextFrame(socket, "hydrate");
    socket.accept();
    await hydration;
    const closed = new Promise<CloseEvent>((resolve) => {
      socket.addEventListener("close", (event) => resolve(event), { once: true });
    });

    const purged = await relayFor(orgId).fetch(new Request(
      await withRelayMember(`https://rundown.test/internal/purge-show?orgId=${orgId}&showId=show-1&serviceDate=${serviceDate}`),
      { method: "POST", headers: { "x-showpilot-internal-secret": "worker-test-secret-for-local-integration-only" } },
    ));
    expect(purged.status).toBe(200);
    await expect(closed).resolves.toMatchObject({ code: 4404, reason: "Show deleted" });
    expect(await state(orgId)).toMatchObject({ stageMessage: "", items: [], revision: 0 });
  });

  it("closes live sockets and erases durable state during organization purge", async () => {
    const orgId = "relay-org-purge";
    await createOrg(orgId);
    await command(orgId, "stage-message", { message: "Delete me" });
    const response = await relayFor(orgId).fetch(new Request(
      await withRelayMember(`https://rundown.test/ws?orgId=${orgId}&serviceDate=${serviceDate}&access=observe`),
      { headers: { Upgrade: "websocket" } },
    ));
    if (!response.webSocket) throw new Error("Rundown upgrade did not return a WebSocket");
    const socket = response.webSocket;
    const hydration = nextFrame(socket, "hydrate");
    socket.accept();
    await hydration;
    const closed = new Promise<CloseEvent>((resolve) => {
      socket.addEventListener("close", (event) => resolve(event), { once: true });
    });

    const denied = await relayFor(orgId).fetch(new Request(
      await withRelayMember(`https://rundown.test/internal/purge-org?orgId=${orgId}`),
      { method: "POST" },
    ));
    expect(denied.status).toBe(401);

    const purged = await relayFor(orgId).fetch(new Request(
      await withRelayMember(`https://rundown.test/internal/purge-org?orgId=${orgId}`),
      {
        method: "POST",
        headers: { "x-showpilot-internal-secret": "worker-test-secret-for-local-integration-only" },
      },
    ));
    expect(purged.status).toBe(200);
    await expect(closed).resolves.toMatchObject({ code: 4404 });
    expect(await state(orgId)).toMatchObject({ stageMessage: "", items: [], revision: 0 });
  });

  it("rejects a command on the same socket after grant revocation", async () => {
    const orgId = "relay-revoked-grant";
    const userId = "relay-member";
    const sessionId = "relay-session";
    const now = new Date().toISOString();
    await createOrg(orgId);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
         VALUES (?, ?, ?, 1, ?, ?)`,
      ).bind(userId, "Relay Member", "relay-member@example.com", now, now),
      env.DB.prepare(
        `INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, userId, activeOrganizationId)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(sessionId, "2099-01-01T00:00:00.000Z", "relay-token", now, now, userId, orgId),
      env.DB.prepare(
        `INSERT INTO member (id, organizationId, userId, role, createdAt)
         VALUES (?, ?, ?, 'member', ?)`,
      ).bind("relay-membership", orgId, userId, now),
      env.DB.prepare(
        `INSERT INTO member_permission_grant
           (id, orgId, userId, capability, permissions, startsOn, expiresOn, reason,
            grantedByUserId, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, NULL, '', ?, ?, ?)`,
      ).bind(
        "relay-grant",
        orgId,
        userId,
        "rundown-operator",
        JSON.stringify(["rundown:edit"]),
        "2026-01-01",
        userId,
        now,
        now,
      ),
    ]);
    await expect(hasLiveRundownAuthority(env.DB, {
      userId,
      sessionId,
      orgId,
      rundownPin: null,
    }, "rundown:edit")).resolves.toBe(true);

    const response = await relayFor(orgId).fetch(new Request(
      `https://rundown.test/ws?orgId=${orgId}&serviceDate=${serviceDate}&access=edit&authUserId=${userId}&authSessionId=${sessionId}`,
      { headers: { Upgrade: "websocket" } },
    ));
    expect(response.status).toBe(101);
    if (!response.webSocket) throw new Error("Rundown upgrade did not return a WebSocket");
    const socket = response.webSocket;
    const hydration = nextFrame(socket, "hydrate");
    socket.accept();
    const hydrated = await hydration;
    const hydratedState = hydrated.state as { revision: number };

    const accepted = nextFrame(socket, "command-result");
    socket.send(JSON.stringify({
      type: "command",
      id: "before-revoke",
      expectedRevision: hydratedState.revision,
      action: "stage-message",
      payload: { message: "Before revoke" },
    }));
    expect(await accepted).toEqual(expect.objectContaining({ accepted: true }));

    await env.DB.prepare(
      "UPDATE member_permission_grant SET revokedAt = ?, updatedAt = ? WHERE id = ?",
    ).bind(now, now, "relay-grant").run();

    const rejected = nextFrame(socket, "command-result");
    socket.send(JSON.stringify({
      type: "command",
      id: "after-revoke",
      expectedRevision: hydratedState.revision + 1,
      action: "stage-message",
      payload: { message: "After revoke" },
    }));
    await expect(rejected).resolves.toMatchObject({ accepted: false, reason: "forbidden" });
    expect(await state(orgId)).toMatchObject({ stageMessage: "Before revoke" });
  });
});

describe("RundownRelay running order matches confidence displays", () => {
  it("rejects expired HTTP and socket transport without advancing, and acknowledges applied retries", async () => {
    const orgId = "relay-transport-deadline";
    await createOrg(orgId);
    await command(orgId, "seed", { items: [
      { id: "first", title: "First", type: "segment", duration: 60000, notes: "", assignee: "", cue: "", status: "upcoming", sortOrder: 0, hardStop: false },
    ] });
    const before = await state(orgId);
    const post = async (id: string, expiresAt: number) => {
      const response = await relayFor(orgId).fetch(new Request(
        await withRelayMember(`https://rundown.test/command?orgId=${orgId}&serviceDate=${serviceDate}&access=control`),
        { method: "POST", body: JSON.stringify({ action: "timer-next", id, expiresAt, expectedRevision: before.revision }) },
      ));
      return { status: response.status, body: await response.json() };
    };
    expect(await post("http-late", Date.now() - 1)).toMatchObject({ status: 409, body: { reason: "expired", revision: before.revision } });
    expect(await state(orgId)).toMatchObject({ revision: before.revision, timer: { playback: "stop" } });

    const response = await relayFor(orgId).fetch(new Request(
      await withRelayMember(`https://rundown.test/ws?orgId=${orgId}&serviceDate=${serviceDate}&access=control`),
      { headers: { Upgrade: "websocket" } },
    ));
    if (!response.webSocket) throw new Error("Missing rundown socket");
    const socket = response.webSocket;
    const hydration = nextFrame(socket, "hydrate");
    socket.accept();
    await hydration;
    const freshState = nextFrame(socket, "state");
    const rejected = nextFrame(socket, "command-result");
    socket.send(JSON.stringify({ type: "command", action: "timer-next", id: "ws-late", expiresAt: Date.now() - 1 }));
    expect(await rejected).toMatchObject({ accepted: false, reason: "expired", revision: before.revision });
    expect(await freshState).toMatchObject({ state: { timer: { playback: "stop" } } });
    expect(await post("applied", Date.now() + 5_000)).toMatchObject({ status: 200, body: { ok: true } });
    const after = await state(orgId);
    expect(after).toMatchObject({ timer: { playback: "play", currentItemId: "first" } });
    expect(await post("applied", Date.now() - 1)).toMatchObject({ status: 200, body: { duplicate: true, revision: after.revision } });
    expect(await state(orgId)).toMatchObject({ revision: after.revision, timer: { currentItemId: "first" } });
    socket.close();
  });

  it("rejects reset while playing and allows it after a pause", async () => {
    const orgId = "relay-reset-playing-guard";
    await createOrg(orgId);
    const item = { id: "segment", title: "Live", type: "segment", duration: 60000, notes: "", assignee: "", cue: "", status: "upcoming", sortOrder: 0, hardStop: false };
    await command(orgId, "seed", { items: [item] });
    await command(orgId, "timer-start", { itemId: item.id }, "control");
    const before = await state(orgId);
    expect((await command(orgId, "reset", {})).status).toBe(400);
    expect(await state(orgId)).toMatchObject({ revision: before.revision, timer: { playback: "play", currentItemId: item.id } });
    await command(orgId, "timer-pause", {}, "control");
    expect((await command(orgId, "reset", {})).status).toBe(200);
    expect(await state(orgId)).toMatchObject({ timer: { playback: "stop", currentItemId: null }, items: [{ status: "upcoming", actualStart: null, actualEnd: null }] });
  });

  it("deletes the current item atomically and undo restores it without restarting or losing later edits", async () => {
    const orgId = "relay-delete-undo";
    await createOrg(orgId);
    const item = (id: string) => ({ id, title: id, type: "segment", duration: 60000, notes: "", assignee: "", cue: "", status: "upcoming", sortOrder: 0, hardStop: false });
    await command(orgId, "seed", { items: [item("first"), item("second")] });
    await command(orgId, "timer-start", { itemId: "first" }, "control");
    expect((await command(orgId, "remove-item", { id: "first" })).status).toBe(200);
    expect(await state(orgId)).toMatchObject({ timer: { playback: "stop", currentItemId: null }, items: [{ id: "second" }] });
    await command(orgId, "update-item", { id: "second", updates: { title: "Edited by another operator" } });
    await evictDurableObject(relayFor(orgId));
    expect((await command(orgId, "restore-item", { id: "first", item: { title: "Forged undo" } })).status).toBe(200);
    const restored = await state(orgId);
    expect(restored).toMatchObject({ timer: { playback: "stop", currentItemId: null }, items: [
      { id: "first", title: "first", status: "complete", actualStart: expect.any(String), actualEnd: expect.any(String) },
      { id: "second", title: "Edited by another operator" },
    ] });
    expect(restored).not.toHaveProperty("removedItems");
    const persisted = await env.DB.prepare("SELECT title, status FROM rundown_item WHERE orgId = ? AND serviceDate = ? AND itemId = ?")
      .bind(orgId, serviceDate, "first").first();
    expect(persisted).toMatchObject({ title: "first", status: "complete" });
    expect((await command(orgId, "restore-item", { id: "first" })).status).toBe(400);
    await command(orgId, "remove-item", { id: "first" });
    await command(orgId, "clear-all", {});
    expect((await command(orgId, "restore-item", { id: "first" })).status).toBe(400);
  });

  it("skips headings and completed rows, then stops at the end", async () => {
    const orgId = "relay-next-display-contract";
    await createOrg(orgId);
    const item = (id: string, overrides: Partial<RundownItem> = {}): RundownItem => ({
      id, title: id, type: "segment", duration: 60_000, notes: "", assignee: "", cue: "",
      status: "upcoming", sortOrder: 0, hardStop: false, ...overrides,
    });
    const items = [
      item("heading", { type: "header" }), item("a"),
      item("section", { type: "header" }), item("already-done", { status: "complete" }),
      item("b"), item("end-heading", { type: "header" }),
    ];
    expect((await command(orgId, "seed", { items })).status).toBe(200);
    let currentItemId: string | null = null;
    for (const expectedId of ["a", "b", null]) {
      expect(nextPlayableItem(items, currentItemId)?.id ?? null).toBe(expectedId);
      expect((await command(orgId, "timer-next", {}, "control")).status).toBe(200);
      expect(await state(orgId)).toMatchObject({ timer: {
        currentItemId: expectedId, playback: expectedId ? "play" : "stop",
      } });
      currentItemId = expectedId;
    }
  });
});
