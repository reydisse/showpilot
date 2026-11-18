import { expect, it } from "vitest";
import { consumeSocketMessage, relaySocketCapReached } from "../socket-limits.server";

it("allows a sustained 10 Hz stream indefinitely", () => {
  const socket = {};
  for (let frame = 0; frame < 100000; frame++) expect(consumeSocketMessage(socket, frame * 100)).toBe(true);
});
it("allows a single 150-message burst", () => {
  const socket = {};
  for (let i = 0; i < 150; i++) expect(consumeSocketMessage(socket, 0)).toBe(true);
  expect(consumeSocketMessage(socket, 0)).toBe(false);
});
it("trips under a sustained 200 msg/s flood", () => {
  const socket = {};
  expect(Array.from({ length: 400 }, (_, i) => consumeSocketMessage(socket, i * 5))).toContain(false);
});
it("caps at exactly 200 sockets", () => {
  for (const count of [0, 199, 200, 201]) {
    expect(relaySocketCapReached({ getWebSockets: () => Array(count).fill({}) })).toBe(count >= 200);
  }
});
