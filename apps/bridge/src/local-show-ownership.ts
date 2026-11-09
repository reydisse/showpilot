import fs from "node:fs";
import path from "node:path";

const BUSY_MESSAGE =
  "Another local device engine still owns this computer's local show. Wait for it to exit before starting a replacement.";
class OwnershipBusy extends Error {
  constructor() {
    super(BUSY_MESSAGE);
  }
}
const claimedFiles = new Set<string>();

interface OwnershipDatabase {
  exec(sql: string): unknown;
  close(): void;
}
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object";
const isDatabase = (value: unknown): value is OwnershipDatabase =>
  record(value) &&
  typeof value.exec === "function" &&
  typeof value.close === "function";

async function openOwnershipDatabase(file: string): Promise<OwnershipDatabase> {
  // Keep runtime-specific builtins out of the opposite runtime's static resolver.
  // Packaged engines include bun:sqlite, including Windows Bun 1.1.21. Node 24
  // supplies node:sqlite for development. Standalone mode never imports either.
  const bun = Boolean(process.versions.bun);
  const moduleName = bun ? "bun:sqlite" : "node:sqlite";
  const runtime: unknown = await import(/* @vite-ignore */ moduleName);
  const constructor = record(runtime)
    ? runtime[bun ? "Database" : "DatabaseSync"]
    : null;
  if (typeof constructor !== "function")
    throw new Error("Unsupported SQLite runtime");
  const database: unknown = Reflect.construct(constructor, [file]);
  if (!isDatabase(database)) throw new Error("Unsupported SQLite connection");
  return database;
}
function busy(error: unknown): boolean {
  return (
    error instanceof OwnershipBusy ||
    (record(error) &&
      (error.code === "SQLITE_BUSY" ||
        error.code === "SQLITE_LOCKED" ||
        error.errcode === 5 ||
        error.errcode === 6 ||
        error.errno === 5 ||
        error.errno === 6))
  );
}

/** Acquire before reading any local journal or opening device/cloud connections.
 * The engine, rather than its GUI parent, holds this transaction until exit.
 * SQLite's OS locks survive a parent crash and release when this process dies.
 * This file contains no show data. Never unlink it to recover a busy lock.
 */
export async function acquireLocalShowOwnership(
  directory: string,
): Promise<void> {
  if (!path.isAbsolute(directory))
    throw new Error(
      "Local show ownership requires an absolute storage directory.",
    );
  let database: OwnershipDatabase | undefined;
  let claimedFile: string | undefined;
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(fs.realpathSync(directory), "owner.sqlite");
    // Opening/closing a second raw descriptor can release this process's POSIX
    // SQLite locks. Reject same-process reentry before touching the lock file.
    if (claimedFiles.has(file)) throw new OwnershipBusy();
    claimedFiles.add(file);
    claimedFile = file;
    try {
      fs.closeSync(fs.openSync(file, "ax", 0o600));
    } catch (error) {
      if (!record(error) || error.code !== "EEXIST") throw error;
    }
    // SQLite can report BUSY to both contenders while an empty file is being
    // initialized. Release partial locks before a bounded, staggered retry.
    // An established owner retains its exclusive transaction throughout.
    for (let attempt = 0; ; attempt++) {
      try {
        database = await openOwnershipDatabase(file);
        database.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;");
        break;
      } catch (error) {
        if (!busy(error) || attempt >= 4) throw error;
        database?.close();
        database = undefined;
        await new Promise(resolve => setTimeout(resolve, 10 + Math.floor(Math.random() * 20)));
      }
    }
  } catch (error) {
    // No ownership was granted, so this connection must not retain a partial lock.
    if (database) database.close();
    if (claimedFile) claimedFiles.delete(claimedFile);
    throw new Error(
      busy(error)
        ? BUSY_MESSAGE
        : "Local show ownership could not be secured. Check local storage access and update the device engine before retrying.",
    );
  }
  const owned = database;
  // Retain a strong reference for the entire engine lifetime. Normal app shutdown
  // stops the Bridge before process.exit; abrupt termination releases OS locks.
  process.once("exit", () => owned.close());
}
