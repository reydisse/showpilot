import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const vault = vi.hoisted(() => ({
  values: new Map<string, string>(),
  locked: false,
}));
vi.mock("../credential-store.js", () => ({
  readCredential: (id: string) => {
    if (vault.locked || !vault.values.has(id)) throw new Error("locked");
    return vault.values.get(id);
  },
  writeCredential: (id: string, value: string) => {
    if (vault.locked) throw new Error("locked");
    vault.values.set(id, value);
  },
  deleteCredential: (id: string) => vault.values.delete(id),
}));
import { LocalShowStore, LocalShowStoreError } from "../local-show-store.js";
const directories: string[] = [];
const fixture = () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "showpilot-local-store-"),
  );
  directories.push(directory);
  return { directory, file: path.join(directory, "local-show.json") };
};
beforeEach(() => {
  vault.values.clear();
  vault.locked = false;
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});
const record = {
  orgId: "fixture-org",
  showId: "fixture-show",
  deviceSettings: { password: "private-device-password" },
  operations: [{ action: "timer-next", at: 123 }],
};

it("persists a restartable encrypted show with a separate OS-protected key and private file permissions", () => {
  const { file } = fixture();
  const store = new LocalShowStore(file);
  expect(store.load()).toBeNull();
  store.save(record);
  const serialized = fs.readFileSync(file, "utf8");
  for (const secret of [
    record.orgId,
    record.showId,
    record.deviceSettings.password,
    "timer-next",
    ...vault.values.values(),
  ])
    expect(serialized).not.toContain(secret);
  if (process.platform !== "win32")
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  expect(new LocalShowStore(file).load()).toEqual(record);
  expect(vault.values.size).toBe(1);
  store.save({ ...record, operations: [] });
  expect(fs.readFileSync(file, "utf8")).not.toBe(serialized);
  expect(new LocalShowStore(file).load()).toEqual({
    ...record,
    operations: [],
  });
  expect(vault.values.size).toBe(1);
});

it("fails closed on a locked keychain, wrong key, modified ciphertext, or forged key reference", () => {
  const { file } = fixture();
  new LocalShowStore(file).save(record);
  const original = fs.readFileSync(file, "utf8");
  const saved = JSON.parse(original);
  vault.locked = true;
  expect(() => new LocalShowStore(file).load()).toThrow(
    /could not be verified/,
  );
  vault.locked = false;
  const key = vault.values.get(saved.keyReference)!;
  vault.values.set(saved.keyReference, Buffer.alloc(32).toString("base64"));
  expect(() => new LocalShowStore(file).load()).toThrow(
    /could not be verified/,
  );
  vault.values.set(saved.keyReference, key);
  for (const changed of [
    { ...saved, ciphertext: Buffer.alloc(32).toString("base64") },
    { ...saved, keyReference: "00000000-0000-0000-0000-000000000000" },
    { ...saved, tag: "invalid" },
  ]) {
    fs.writeFileSync(file, JSON.stringify(changed));
    expect(() => new LocalShowStore(file).load()).toThrow(
      /could not be verified/,
    );
  }
  fs.writeFileSync(file, original);
  expect(new LocalShowStore(file).load()).toEqual(record);
});

it("preserves the previous show when atomic replacement fails and leaves no temporary file", () => {
  const { file, directory } = fixture();
  const store = new LocalShowStore(file);
  store.save(record);
  const before = fs.readFileSync(file, "utf8");
  const rename = vi.spyOn(fs, "renameSync").mockImplementation(() => {
    throw new Error("disk unavailable");
  });
  expect(() => store.save({ ...record, operations: [] })).toThrow(
    /could not be saved securely/,
  );
  expect(fs.readFileSync(file, "utf8")).toBe(before);
  expect(fs.readdirSync(directory)).toEqual(["local-show.json"]);
  rename.mockRestore();
  expect(new LocalShowStore(file).load()).toEqual(record);
});

it("does not fall back to plaintext or leave a key when the first write fails", () => {
  const { file, directory } = fixture();
  vault.locked = true;
  expect(() => new LocalShowStore(file).save(record)).toThrow(
    /could not be saved securely/,
  );
  expect(fs.readdirSync(directory)).toEqual([]);
  vault.locked = false;
  vi.spyOn(fs, "renameSync").mockImplementation(() => {
    throw new Error("disk unavailable");
  });
  expect(() => new LocalShowStore(file).save(record)).toThrow(
    /could not be saved securely/,
  );
  expect(vault.values.size).toBe(0);
  expect(fs.readdirSync(directory)).toEqual([]);
});

it.skipIf(process.platform === "win32")(
  "reports a committed write when directory durability cannot be confirmed",
  () => {
    const { file } = fixture();
    const flush = fs.fsyncSync;
    vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      if (fs.fstatSync(fd).isDirectory())
        throw new Error("directory flush failed");
      flush(fd);
    });
    try {
      new LocalShowStore(file).save(record);
      throw new Error("Expected write error");
    } catch (error) {
      expect(error).toBeInstanceOf(LocalShowStoreError);
      expect(error).toMatchObject({ committed: true });
    }
    expect(vault.values.size).toBe(1);
    expect(new LocalShowStore(file).load()).toEqual(record);
  },
);
