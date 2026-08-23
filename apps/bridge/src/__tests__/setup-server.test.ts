import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isTrustedSetupOrigin,
  loadConfigFile,
  saveConfigFile,
  validateBridgeConfig,
  type BridgeConfig,
} from "../setup-server.js";

const temporaryDirectories: string[] = [];

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
  });
});
