import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("saved rundown templates are individually queryable rows, not a shared JSON index", async () => {
  const [rundown, inventory, mobile] = await Promise.all([
    readFile(new URL("../src/lib/rundown.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/show-inventory.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/mobile-api.server.ts", import.meta.url), "utf8"),
  ]);

  assert.match(rundown, /key: \{ startsWith: "rundown-saved:" \}/);
  assert.doesNotMatch(rundown, /rundown-saved-index/);
  assert.match(inventory, /key: \{ startsWith: SAVED_TEMPLATE_PREFIX \}/);
  assert.doesNotMatch(inventory, /rundown-saved-index/);
  assert.match(mobile, /key LIKE 'rundown-saved:%'/);
  assert.doesNotMatch(mobile, /rundown-saved-index/);
});
