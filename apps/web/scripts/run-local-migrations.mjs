#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrationDirectory = join(webRoot, "prisma", "migrations");
const databaseName = "showpilot-db";
const historyTable = "_showpilot_local_migration";
const migrationNamePattern = /^(\d{4})_[A-Za-z0-9][A-Za-z0-9_.-]*\.sql$/;

function usageError(message) {
  throw new Error(`${message}\nUsage: pnpm db:migrate:local [--persist-to <directory>]`);
}

function parseArguments(arguments_) {
  const normalizedArguments = arguments_[0] === "--" ? arguments_.slice(1) : arguments_;
  if (normalizedArguments.length === 0) return { persistTo: null };
  if (
    normalizedArguments.length !== 2 ||
    normalizedArguments[0] !== "--persist-to" ||
    !normalizedArguments[1]
  ) {
    usageError("Only an optional local Wrangler state directory is accepted.");
  }
  return { persistTo: resolve(process.cwd(), normalizedArguments[1]) };
}

function runWrangler(arguments_, persistTo) {
  const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const persistArguments = persistTo ? ["--persist-to", persistTo] : [];
  const result = spawnSync(
    command,
    ["exec", "wrangler", "d1", "execute", databaseName, "--local", ...persistArguments, ...arguments_, "--json"],
    { cwd: webRoot, encoding: "utf8" },
  );

  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(detail || `Wrangler exited with status ${String(result.status)}`);
  }
  return result.stdout;
}

function queryLocalDatabase(sql, persistTo) {
  const output = runWrangler(["--command", sql], persistTo);
  let payload;
  try {
    payload = JSON.parse(output);
  } catch {
    throw new Error(`Wrangler returned invalid JSON:\n${output}`);
  }
  if (!Array.isArray(payload) || !payload[0] || !Array.isArray(payload[0].results)) {
    throw new Error("Wrangler returned an unexpected D1 result shape.");
  }
  return payload[0].results;
}

async function numberedMigrations() {
  const entries = await readdir(migrationDirectory, { withFileTypes: true });
  const migrations = entries
    .filter((entry) => entry.isFile() && migrationNamePattern.test(entry.name))
    .map((entry) => entry.name)
    .sort();

  if (migrations.length === 0) throw new Error("No numbered D1 migrations were found.");
  migrations.forEach((name, index) => {
    const match = migrationNamePattern.exec(name);
    const migrationNumber = match ? Number(match[1]) : Number.NaN;
    const expectedNumber = index + 1;
    if (migrationNumber !== expectedNumber) {
      throw new Error(`Expected migration ${String(expectedNumber).padStart(4, "0")}, found ${name}.`);
    }
  });
  return migrations;
}

async function main() {
  const { persistTo } = parseArguments(process.argv.slice(2));
  const migrations = await numberedMigrations();
  const historyExists = queryLocalDatabase(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${historyTable}'`,
    persistTo,
  ).length > 0;

  if (!historyExists) {
    const appSchemaExists = queryLocalDatabase(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user'",
      persistTo,
    ).length > 0;
    if (appSchemaExists) {
      throw new Error(
        "This local D1 database already has ShowPilot tables but no migration history. " +
        "Keep using explicit `wrangler d1 execute --local --file=...` commands for that database, " +
        "or point --persist-to at a fresh local state directory.",
      );
    }
    queryLocalDatabase(
      `CREATE TABLE "${historyTable}" ("name" TEXT NOT NULL PRIMARY KEY, "appliedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
      persistTo,
    );
  }

  const appliedRows = queryLocalDatabase(`SELECT name FROM "${historyTable}" ORDER BY name`, persistTo);
  const applied = new Set(
    appliedRows.map((row) => {
      if (!row || typeof row.name !== "string") throw new Error("Local migration history contains an invalid row.");
      return row.name;
    }),
  );
  const unknownMigration = [...applied].find((name) => !migrations.includes(name));
  if (unknownMigration) throw new Error(`Local migration history references missing file ${unknownMigration}.`);

  const temporaryDirectory = await mkdtemp(join(tmpdir(), "showpilot-local-migrations-"));
  let appliedNow = 0;
  try {
    for (const migration of migrations) {
      if (applied.has(migration)) continue;
      const sql = await readFile(join(migrationDirectory, migration), "utf8");
      const composedMigration = `${sql.trim()}\n\nINSERT INTO "${historyTable}" ("name") VALUES ('${migration}');\n`;
      const temporaryFile = join(temporaryDirectory, migration);
      await writeFile(temporaryFile, composedMigration, "utf8");
      process.stdout.write(`Applying ${migration}... `);
      runWrangler(["--file", temporaryFile], persistTo);
      process.stdout.write("done\n");
      appliedNow += 1;
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }

  const finalRows = queryLocalDatabase(`SELECT name FROM "${historyTable}" ORDER BY name`, persistTo);
  if (finalRows.length !== migrations.length) {
    throw new Error(`Expected ${migrations.length} recorded migrations, found ${finalRows.length}.`);
  }
  process.stdout.write(
    appliedNow === 0
      ? `Local D1 is current (${migrations.length} migrations).\n`
      : `Local D1 is current (${migrations.length} migrations, ${appliedNow} applied).\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
