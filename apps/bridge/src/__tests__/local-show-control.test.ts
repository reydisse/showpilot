import { afterEach, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import {
  parseLocalShowRequest,
  startLocalShowControl,
} from "../local-show-control.js";
import { LocalShowError } from "../local-show-model.js";
const servers: Awaited<ReturnType<typeof startLocalShowControl>>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

it("accepts native authenticated requests on loopback and rejects browser origins and unknown credentials", async () => {
  const token = randomBytes(32).toString("hex");
  const handler = vi.fn(async () => ({
    mode: "prepared",
    sessionId: "fixture",
  }));
  const server = await startLocalShowControl(token, handler);
  servers.push(server);
  const url = `http://127.0.0.1:${server.port}/local-show`;
  for (const headers of [
    {},
    { authorization: "Bearer wrong" },
    { authorization: `Bearer ${token}`, origin: "https://app.showpilot.tech" },
    { authorization: `Bearer ${token}`, origin: "http://127.0.0.1" },
  ]) {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ operation: "status" }),
    });
    expect(response.status).toBe(401);
    await response.arrayBuffer();
  }
  expect(handler).not.toHaveBeenCalled();
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ operation: "status" }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    ok: true,
    result: { mode: "prepared", sessionId: "fixture" },
  });
  expect(handler).toHaveBeenCalledExactlyOnceWith({ operation: "status" });
});

it("validates fixed operation fields and never accepts a caller-supplied device command", () => {
  const base = {
    sessionId: "fixture",
    requestId: "request-1",
    expectedSequence: 2,
  };
  expect(
    parseLocalShowRequest({
      ...base,
      operation: "device",
      actionId: "cue-1",
      target: "unapproved",
      command: "POWER ON",
    }),
  ).toEqual({ ...base, operation: "device", actionId: "cue-1" });
  expect(
    parseLocalShowRequest({
      ...base,
      operation: "device",
      target: "unapproved",
      command: "POWER ON",
    }),
  ).toBeNull();
  expect(
    parseLocalShowRequest({
      ...base,
      operation: "transport",
      action: "timer-adjust",
      payload: { deltaMs: 1000 },
    }),
  ).toEqual({
    ...base,
    operation: "transport",
    command: { type: "timer-adjust", deltaMs: 1000 },
  });
  for (const value of [
    { ...base, operation: "arbitrary" },
    { ...base, operation: "begin" },
    { ...base, operation: "discard", confirmed: false },
    { ...base, operation: "finish", expectedSequence: -1 },
    { ...base, operation: "transport", action: "clear-all" },
  ])
    expect(parseLocalShowRequest(value)).toBeNull();
});

it("limits request size and hides unexpected adapter errors", async () => {
  const token = randomBytes(32).toString("hex");
  const handler = vi.fn(async () => {
    throw new Error("password=private-fixture-password");
  });
  const server = await startLocalShowControl(token, handler);
  servers.push(server);
  const request = (body: string) =>
    fetch(`http://127.0.0.1:${server.port}/local-show`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body,
    });
  const large = await request(
    JSON.stringify({ operation: "status", padding: "x".repeat(65536) }),
  );
  expect(large.status).toBe(413);
  await large.arrayBuffer();
  expect(handler).not.toHaveBeenCalled();
  const invalid = await request("not json");
  expect(invalid.status).toBe(400);
  await invalid.arrayBuffer();
  const failed = await request(JSON.stringify({ operation: "status" }));
  expect(failed.status).toBe(500);
  expect(await failed.text()).not.toContain("private-fixture-password");
});

it("bounds concurrent work even when a native client disconnects before completion", async () => {
  const token = randomBytes(32).toString("hex");
  const completions: Array<() => void> = [];
  const handler = vi.fn(
    () => new Promise<void>((resolve) => completions.push(resolve)),
  );
  const server = await startLocalShowControl(token, handler);
  servers.push(server);
  const request = (signal?: AbortSignal) =>
    fetch(`http://127.0.0.1:${server.port}/local-show`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: '{"operation":"status"}',
      signal,
    });
  const abort = new AbortController();
  const requests = Array.from({ length: 8 }, () =>
    request(abort.signal).catch(() => null),
  );
  try {
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(8));
    abort.abort();
    await Promise.all(requests);
    const busy = await request();
    expect(busy.status).toBe(503);
    await busy.arrayBuffer();
    expect(handler).toHaveBeenCalledTimes(8);
  } finally {
    completions.forEach((resolve) => resolve());
  }
});

it("returns actionable operator errors without exposing unexpected adapter exceptions", async () => {
  const token = randomBytes(32).toString("hex");
  const server = await startLocalShowControl(token, async () => {
    throw new LocalShowError(
      "The prepared show changed. Refresh before continuing.",
    );
  });
  servers.push(server);
  const response = await fetch(`http://127.0.0.1:${server.port}/local-show`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: '{"operation":"status"}',
  });
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    ok: false,
    error: "The prepared show changed. Refresh before continuing.",
  });
});

it("reserves timer and status capacity when every equipment slot is waiting", async () => {
  const token = randomBytes(32).toString("hex");
  const completions: Array<() => void> = [];
  const server = await startLocalShowControl(token, (request) =>
    request.operation === "device"
      ? new Promise<void>((resolve) => completions.push(resolve))
      : Promise.resolve({ operation: request.operation }),
  );
  servers.push(server);
  const request = (body: unknown) =>
    fetch(`http://127.0.0.1:${server.port}/local-show`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  const action = {
    operation: "device",
    sessionId: "fixture",
    requestId: "action",
    actionId: "cue",
    expectedSequence: 0,
  };
  const pending = Array.from({ length: 8 }, () => request(action));
  try {
    await vi.waitFor(() => expect(completions).toHaveLength(8));
    const blocked = await request(action);
    expect(blocked.status).toBe(503);
    await blocked.arrayBuffer();
    for (const body of [
      { operation: "status" },
      {
        operation: "transport",
        sessionId: "fixture",
        requestId: "next",
        expectedSequence: 0,
        action: "timer-next",
      },
    ]) {
      const response = await request(body);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        result: { operation: body.operation },
      });
    }
  } finally {
    completions.forEach((resolve) => resolve());
    await Promise.all(
      pending.map(async (response) => (await response).arrayBuffer()),
    );
  }
});
