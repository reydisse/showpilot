import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const vault = vi.hoisted(() => ({ entries: new Map<string, string>(), fail: false }));
vi.mock("@napi-rs/keyring", () => ({ Entry: class {
  constructor(_service: string, private reference: string) {}
  getPassword() { if (vault.fail) throw new Error("fixture failure"); return vault.entries.get(this.reference) ?? null; }
  setPassword(secret: string) { if (vault.fail) throw new Error("fixture failure"); vault.entries.set(this.reference, secret); }
  deleteCredential() { vault.entries.delete(this.reference); }
} }));
import {
  isTrustedSetupOrigin,
  loadConfigFile,
  saveConfigFile,
  validateBridgeConfig,
  publicBridgeConfig,
  startSetupServer,
  type BridgeConfig,
} from "../setup-server.js";

const temporaryDirectories: string[] = [];
beforeEach(() => { vault.entries.clear(); vault.fail = false; });

function validConfig(): BridgeConfig {
  return {
    site: "https://showpilot.tech",
    org: "faithfire-production",
    key: "sp_test_secret",
    propresenterHost: "192.168.1.20",
    propresenterPort: 50_001,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("Bridge setup boundary", () => {
  it("accepts production HTTPS and explicit localhost development sites", () => {
    expect(validateBridgeConfig(validConfig())).toBeNull();
    expect(validateBridgeConfig({
      ...validConfig(),
      site: "http://localhost:3001",
      org: "test-peeps",
    })).toBeNull();
  });

  it("rejects insecure sites, invalid slugs, missing keys, and invalid ports", () => {
    expect(validateBridgeConfig({ ...validConfig(), site: "http://showpilot.tech" })).toMatch(/HTTPS/);
    expect(validateBridgeConfig({ ...validConfig(), org: "../faithfire" })).toMatch(/organization slug/);
    expect(validateBridgeConfig({ ...validConfig(), key: "" })).toMatch(/API key/);
    expect(validateBridgeConfig({ ...validConfig(), propresenterPort: 70_000 })).toMatch(/65535/);
  });

  it("accepts saves only from the local setup page", () => {
    expect(isTrustedSetupOrigin("http://localhost:9450", 9450)).toBe(true);
    expect(isTrustedSetupOrigin("http://127.0.0.1:9450", 9450)).toBe(true);
    expect(isTrustedSetupOrigin("https://attacker.example", 9450)).toBe(false);
    expect(isTrustedSetupOrigin(undefined, 9450)).toBe(false);
  });

  it("atomically persists a validated config with private Unix permissions", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "showpilot-bridge-config-"));
    temporaryDirectories.push(directory);

    saveConfigFile(validConfig(), directory);

    expect(loadConfigFile(directory)).toEqual(validConfig());
    const stored = fs.readFileSync(path.join(directory, "showpilot-bridge.config.json"), "utf8");
    expect(stored).not.toContain("sp_test_secret");
    expect(stored).not.toContain('"key"');
    expect(vault.entries.size).toBe(1);
    saveConfigFile({ ...validConfig(), key: "sp_replacement" }, directory);
    expect(vault.entries.size).toBe(1);
    expect(loadConfigFile(directory)?.key).toBe("sp_replacement");
    if (process.platform !== "win32") {
      const mode = fs.statSync(path.join(directory, "showpilot-bridge.config.json")).mode & 0o777;
      expect(mode).toBe(0o600);
    }
    expect(fs.readdirSync(directory)).toEqual(["showpilot-bridge.config.json"]);
  });

  it("refuses to persist invalid config", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "showpilot-bridge-config-"));
    temporaryDirectories.push(directory);

    expect(() => saveConfigFile({ ...validConfig(), key: "wrong" }, directory)).toThrow(/API key/);
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it("repairs permissions on a valid legacy config when it is loaded", () => {
    if (process.platform === "win32") return;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "showpilot-bridge-config-"));
    temporaryDirectories.push(directory);
    const configPath = path.join(directory, "showpilot-bridge.config.json");
    fs.writeFileSync(configPath, JSON.stringify(validConfig()), { mode: 0o644 });

    expect(loadConfigFile(directory)).toEqual(validConfig());
    expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(configPath, "utf8")).not.toContain("sp_test_secret");
  });

  it("preserves a legacy config when secure storage fails instead of silently saving plaintext", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "showpilot-bridge-config-"));
    temporaryDirectories.push(directory);
    const configPath = path.join(directory, "showpilot-bridge.config.json");
    const original = JSON.stringify(validConfig()); fs.writeFileSync(configPath, original);
    vault.fail = true;
    expect(() => loadConfigFile(directory)).toThrow("Secure credential storage");
    expect(() => saveConfigFile(validConfig(), directory)).toThrow("Secure credential storage");
    expect(fs.readFileSync(configPath, "utf8")).toBe(original);
    expect(fs.readdirSync(directory)).toEqual(["showpilot-bridge.config.json"]);
  });

  it("migrates both supported legacy files even when the primary file is already valid", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "showpilot-bridge-config-"));
    temporaryDirectories.push(directory);
    for (const name of ["showpilot-bridge.config.json", "bridge.config.json"]) fs.writeFileSync(path.join(directory, name), JSON.stringify(validConfig()));
    expect(loadConfigFile(directory)).toEqual(validConfig());
    for (const name of fs.readdirSync(directory)) expect(fs.readFileSync(path.join(directory, name), "utf8")).not.toContain("sp_test_secret");
    expect(vault.entries.size).toBe(2);
    loadConfigFile(directory);
    expect(vault.entries.size).toBe(2);
  });

  it("removes old credential-bearing URLs from stored config and setup responses", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "showpilot-bridge-config-"));
    temporaryDirectories.push(directory);
    const config = { ...validConfig(), url: "wss://app.example/api/bridge/org/ws?key=sp_test_secret&authBridgeKey=sp_test_secret" };
    saveConfigFile(config, directory);
    expect(fs.readFileSync(path.join(directory, "showpilot-bridge.config.json"), "utf8")).not.toContain("sp_test_secret");
    expect(publicBridgeConfig(config)?.url).toBe("wss://app.example/api/bridge/org/ws");
    expect(loadConfigFile(directory)?.url).toBe("wss://app.example/api/bridge/org/ws");
  });

  it("never returns the saved credential through the local setup HTML or status API", async () => {
    const config = { ...validConfig(), propresenterPassword: "stage-fixture-secret" };
    expect(publicBridgeConfig(config)).not.toHaveProperty("key");
    const server = startSetupServer(0, () => ({ config, bridgeRunning: true, bridgeStatus: "running" }), () => {});
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server address");
    try {
      for (const suffix of ["/", "/status"]) {
        const response = await fetch(`http://127.0.0.1:${address.port}${suffix}`);
        expect(response.status).toBe(200);
        const content = await response.text();
        expect(content).not.toContain(config.key);
        expect(content).not.toContain(config.propresenterPassword);
      }
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});
