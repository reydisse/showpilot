import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const sourceRoot = fileURLToPath(new URL("../src/lib/", import.meta.url));
const webRoot = fileURLToPath(new URL("../", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

function typeScriptFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return typeScriptFiles(path);
    return entry.isFile() && path.endsWith(".ts") ? [path] : [];
  });
}

test("every operational notification declares a preference category", () => {
  const missing = [];
  for (const path of typeScriptFiles(sourceRoot)) {
    if (path.includes(`${join("lib", "__tests__")}`)) continue;
    const source = readFileSync(path, "utf8");
    let cursor = 0;
    while ((cursor = source.indexOf("notifyOperationalEvent({", cursor)) >= 0) {
      const call = source.slice(cursor, cursor + 900);
      if (!/\bcategory:\s*["'](?:schedule|incidents|chat|reports|system)["']/.test(call)) {
        missing.push(relative(sourceRoot, path));
      }
      cursor += "notifyOperationalEvent({".length;
    }
  }
  assert.deepEqual(missing, []);
});

test("notification writes cannot bypass preference enforcement", () => {
  const bypasses = typeScriptFiles(sourceRoot)
    .filter((path) => !path.endsWith("operational-notifications.server.ts"))
    .filter((path) => /INSERT\s+INTO\s+notification\s*[\n(]/i.test(readFileSync(path, "utf8")))
    .map((path) => relative(sourceRoot, path));
  assert.deepEqual(bypasses, []);
});

test("the in-app inbox is unconditional and only device alerts are configurable", () => {
  const preferenceBoundaryFiles = [
    join(repositoryRoot, "packages/shared/src/types/notifications.ts"),
    join(webRoot, "prisma/schema.prisma"),
    join(webRoot, "prisma/migrations/0038_notification_preferences.sql"),
    join(sourceRoot, "notification-preferences.server.ts"),
    join(sourceRoot, "operational-notifications.server.ts"),
    join(sourceRoot, "personal-notifications.ts"),
    join(sourceRoot, "mobile-api.server.ts"),
  ];

  for (const path of preferenceBoundaryFiles) {
    const source = readFileSync(path, "utf8");
    assert.doesNotMatch(source, /\binAppVisible\b|\binApp\s*:/, relative(repositoryRoot, path));
  }

  const sharedPreference = readFileSync(preferenceBoundaryFiles[0], "utf8");
  assert.match(sharedPreference, /\bdeviceAlerts:\s*boolean\b/);
  assert.doesNotMatch(sharedPreference, /\bdevice:\s*boolean\b/);
});
