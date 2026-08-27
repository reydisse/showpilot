import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const migrationPattern = /^(\d{4})_[A-Za-z0-9][A-Za-z0-9_.-]*\.sql$/;
const webRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

export function auditMigrationManifest(migrations, manifestText) {
  if (migrations.length === 0)
    throw new Error("No numbered D1 migrations were found.");

  migrations.forEach((name, index) => {
    const match = migrationPattern.exec(name);
    const expectedNumber = index + 1;
    if (!match || Number(match[1]) !== expectedNumber) {
      throw new Error(
        `Expected migration ${String(expectedNumber).padStart(4, "0")}, found ${name}.`,
      );
    }
  });

  const applied = manifestText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  const duplicate = applied.find(
    (name, index) => applied.indexOf(name) !== index,
  );
  if (duplicate)
    throw new Error(
      `Production migration manifest contains duplicate entry ${duplicate}.`,
    );

  applied.forEach((name, index) => {
    const expected = migrations[index];
    if (!migrationPattern.test(name)) {
      throw new Error(
        `Production migration manifest contains invalid entry ${name}.`,
      );
    }
    if (!expected) {
      throw new Error(
        `Production migration manifest references unknown migration ${name}.`,
      );
    }
    if (name !== expected) {
      throw new Error(
        `Production migration manifest expected ${expected} at position ${index + 1}, found ${name}.`,
      );
    }
  });

  return { applied, pending: migrations.slice(applied.length) };
}

export function readMigrationState(migrationDirectory) {
  const migrations = readdirSync(migrationDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && migrationPattern.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const manifestText = readFileSync(
    resolve(migrationDirectory, "applied-remote.txt"),
    "utf8",
  );
  return auditMigrationManifest(migrations, manifestText);
}

function run() {
  const args = process.argv.slice(2);
  const allowPending = args.includes("--allow-pending");
  const unknownArgs = args.filter((arg) => arg !== "--allow-pending");
  if (unknownArgs.length > 0)
    throw new Error(`Unknown argument(s): ${unknownArgs.join(", ")}.`);

  const migrationDirectory = resolve(webRoot, "prisma", "migrations");
  const { applied, pending } = readMigrationState(migrationDirectory);
  if (pending.length === 0) {
    process.stdout.write(
      `Production migration manifest is current (${applied.length} migrations).\n`,
    );
    return;
  }

  process.stdout.write(
    `Production migration manifest has ${pending.length} pending migration(s):\n`,
  );
  for (const name of pending) process.stdout.write(`  ${name}\n`);
  if (allowPending) return;

  process.stderr.write(
    "\nApply each file in order using the protected procedure in DEPLOY.md, then record it only after its postcondition passes.\n",
  );
  process.exitCode = 1;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) run();
