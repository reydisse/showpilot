import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, expect, it } from "vitest";
import { ProPresenterBridge } from "../protocols/propresenter.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function fixture(props: unknown, status = 204, apiPort?: number) {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    if (request.url === "/v1/props") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(props));
    } else {
      response.writeHead(status);
      response.end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing fixture port");
  const bridge = new ProPresenterBridge({
    host: "127.0.0.1",
    port: address.port,
    apiPort: apiPort ?? address.port,
    onSlideChange: () => {},
    onStatusChange: () => {},
  });
  cleanup.push(async () => {
    bridge.disconnect();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  return { requests, bridge };
}

it("uses real HTTP to resolve a name, clear the props layer, and trigger the resolved UUID", async () => {
  const test = await fixture([
    { id: { name: "Standby / cameras", uuid: "prop/uuid" } },
  ]);
  const result = await test.bridge.sendCommand(
    JSON.stringify({ action: "resolve-prop", propName: "Standby / cameras" }),
  );
  expect(result).toBe(JSON.stringify({ propUuid: "prop/uuid" }));
  await test.bridge.sendCommand("clear-props");
  await test.bridge.sendCommand(
    JSON.stringify({ action: "trigger-prop", propUuid: "prop/uuid" }),
  );
  expect(test.requests).toEqual([
    "/v1/props",
    "/v1/clear/layer/props",
    "/v1/prop/prop%2Fuuid/trigger",
  ]);
});

it.each([
  { props: [], error: "not found" },
  {
    props: [{ id: { name: "standby", uuid: "wrong-case" } }],
    error: "not found",
  },
  {
    props: [
      { id: { name: "Standby", uuid: "one" } },
      { id: { name: "Standby", uuid: "two" } },
    ],
    error: "Multiple",
  },
  { props: {}, error: "invalid props list" },
])(
  "rejects unusable names without changing an output: $error",
  async ({ props, error }) => {
    const test = await fixture(props);
    await expect(
      test.bridge.sendCommand(
        JSON.stringify({ action: "resolve-prop", propName: "Standby" }),
      ),
    ).rejects.toThrow(error);
    expect(test.requests).toEqual(["/v1/props"]);
  },
);

it.each([
  "clear-props",
  "previous",
  JSON.stringify({ action: "trigger-prop", propUuid: "one" }),
])("does not acknowledge a rejected REST command: %s", async (command) => {
  const test = await fixture([], 503);
  await expect(test.bridge.sendCommand(command)).rejects.toThrow(
    "failed (503)",
  );
  expect(test.requests.every((path) => !path.includes("clear/all"))).toBe(true);
});

it("rejects a prop trigger without a resolved identifier before any HTTP request", async () => {
  const test = await fixture([]);
  await expect(
    test.bridge.sendCommand(
      JSON.stringify({ action: "trigger-prop", propUuid: "" }),
    ),
  ).rejects.toThrow("UUID is required");
  expect(test.requests).toEqual([]);
});

it("uses the working API port discovered by the read-only prop lookup for subsequent output", async () => {
  const test = await fixture([{ id: { name: "Standby", uuid: "one" } }], 204, 1);
  await expect(test.bridge.sendCommand(JSON.stringify({ action: "resolve-prop", propName: "Standby" }))).resolves.toBe('{"propUuid":"one"}');
  await expect(test.bridge.sendCommand("clear-props")).resolves.toBeUndefined();
  expect(test.requests).toEqual(["/v1/props", "/v1/clear/layer/props"]);
});

it("never retries Previous against another endpoint after a lost HTTP response", async () => {
  const requests: string[] = [];
  const server = createServer((request) => {
    requests.push(request.url ?? "");
    request.socket.destroy(); // The simulated device acted but lost its reply.
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing fixture port");
  const bridge = new ProPresenterBridge({
    host: "127.0.0.1",
    port: address.port,
    apiPort: address.port,
    onSlideChange: () => {},
    onStatusChange: () => {},
  });
  cleanup.push(async () => {
    bridge.disconnect();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await expect(bridge.sendCommand("previous")).rejects.toThrow(
    "not acknowledged",
  );
  expect(requests).toEqual(["/v1/presentation/active/previous/trigger"]);
});
