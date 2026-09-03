import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const relaySourceUrl = new URL("../src/durable-objects/RundownRelay.ts", import.meta.url);

test("keeps rundown state changes out of chat transports", async () => {
  const source = await readFile(relaySourceUrl, "utf8");

  assert.doesNotMatch(source, /CHAT_RELAY/);
  assert.doesNotMatch(source, /sendAutomationChatMessage/);
  assert.doesNotMatch(source, /Show is live|Now live:/);
});
