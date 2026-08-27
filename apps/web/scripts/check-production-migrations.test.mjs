import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { auditMigrationManifest } from "./check-production-migrations.mjs";

const migrations = [
  "0001_init.sql",
  "0002_members.sql",
  "0003_notifications.sql",
];

test("accepts an exact ordered production manifest", () => {
  const result = auditMigrationManifest(
    migrations,
    "# production\n0001_init.sql\n0002_members.sql\n0003_notifications.sql\n",
  );
  assert.deepEqual(result, { applied: migrations, pending: [] });
});

test("reports only the unapplied suffix", () => {
  const result = auditMigrationManifest(migrations, "0001_init.sql\n");
  assert.deepEqual(result, {
    applied: ["0001_init.sql"],
    pending: ["0002_members.sql", "0003_notifications.sql"],
  });
});

test("rejects a gap or out-of-order manifest entry", () => {
  assert.throws(
    () =>
      auditMigrationManifest(
        migrations,
        "0001_init.sql\n0003_notifications.sql\n",
      ),
    /expected 0002_members\.sql at position 2/i,
  );
});

test("rejects duplicate manifest entries", () => {
  assert.throws(
    () => auditMigrationManifest(migrations, "0001_init.sql\n0001_init.sql\n"),
    /duplicate entry 0001_init\.sql/i,
  );
});

test("rejects a manifest entry with no matching migration file", () => {
  assert.throws(
    () =>
      auditMigrationManifest(
        migrations,
        `${migrations.join("\n")}\n0004_unknown.sql\n`,
      ),
    /unknown migration 0004_unknown\.sql/i,
  );
});

test("rejects non-contiguous migration files", () => {
  assert.throws(
    () =>
      auditMigrationManifest(
        ["0001_init.sql", "0003_notifications.sql"],
        "0001_init.sql\n",
      ),
    /expected migration 0002/i,
  );
});

test("fresh streaming schema includes Stream Connect output ownership", async () => {
  const migration = await readFile(new URL("../prisma/migrations/0002_streaming_graphics.sql", import.meta.url), "utf8");
  assert.match(migration, /"cfOutputId" TEXT NOT NULL DEFAULT ''/);
  assert.match(migration, /"liveInputId" TEXT NOT NULL DEFAULT ''/);
});
