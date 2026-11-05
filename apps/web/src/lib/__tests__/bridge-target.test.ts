import { describe, expect, it } from "vitest";
import { normalizeBridgeHost, parseBridgeEndpoint, resolveBridgeEndpoints } from "../bridge-target";

describe("Bridge destination boundaries", () => {
  it.each([
    [" OBS.LOCAL. ", "obs.local"], ["192.168.1.20", "192.168.1.20"],
    ["[2001:DB8::1]", "[2001:db8::1]"], ["localhost", "localhost"],
  ])("normalizes host %s", (input, expected) => expect(normalizeBridgeHost(input)).toBe(expected));
  it.each(["", "https://venue.local", "venue.local:4455", "user:password@host", "host/path", "host?token=secret", "host#secret", "*.local", "host\\path", "bad host", "%68ost", "-host", "host..local", "a".repeat(64) + ".local", "::1"])("rejects ambiguous or credential-bearing host %s", value => {
    expect(() => normalizeBridgeHost(value)).toThrow("valid Bridge host");
  });
  it.each([0, -1, 65536, 1.5, "1e3", "4455junk", null, true])("rejects invalid port %s", port => {
    expect(() => parseBridgeEndpoint({ host: "venue.local", port, protocol: "obs" })).toThrow();
  });
  it("enumerates both ProPresenter destinations, with the same API fallback as the native engine", () => {
    const connect = { type: "connect-device", protocol: "propresenter", target: "propresenter:Venue.local:50001", settings: { password: "private" } };
    expect(resolveBridgeEndpoints(connect)).toEqual([
      { host: "venue.local", port: 50001, protocol: "propresenter" },
      { host: "venue.local", port: 1025, protocol: "propresenter" },
    ]);
    expect(resolveBridgeEndpoints({ ...connect, settings: { apiPort: 50001 } })).toHaveLength(1);
    expect(resolveBridgeEndpoints({ ...connect, settings: { api_port: "6000" } })[1].port).toBe(6000);
  });
  it("does not trust a host or port override in connection settings", () => {
    const connect = { type: "connect-device", protocol: "obs", target: "venue.local:4455" };
    for (const settings of [{ host: "other.local" }, { port: 4456 }, { host: "other.local", port: 4455 }]) {
      expect(() => resolveBridgeEndpoints({ ...connect, settings })).toThrow("cannot override");
    }
    expect(resolveBridgeEndpoints({ ...connect, settings: { host: "VENUE.LOCAL.", port: "4455", password: "private" } })).toEqual([{ host: "venue.local", port: 4455, protocol: "obs" }]);
  });
  it("resolves HTTP origins and paths without accepting URL credentials or command authority replacement", () => {
    const input = { type: "command", protocol: "http-command", target: "https://venue.local/base", command: "GET /state" };
    expect(resolveBridgeEndpoints(input)).toEqual([{ host: "venue.local", port: 443, protocol: "http-command" }]);
    expect(resolveBridgeEndpoints({ ...input, target: "venue.local:8088", command: "POST /api/ {\"token\":\"private\"}" })[0].port).toBe(8088);
    for (const target of ["https://user:private@venue.local", "https://venue.local?token=private", "https://venue.local#private"]) {
      expect(() => resolveBridgeEndpoints({ ...input, target })).toThrow("valid Bridge host");
    }
    for (const command of ["GET @other.local/path", "GET http://other.local/path", "GET /\\other.local", "GET /state\r\nHost: other.local"]) {
      expect(() => resolveBridgeEndpoints({ ...input, command })).toThrow("cannot override");
    }
  });
  it("models WOL's actual broadcast destination rather than treating its label as a host", () => {
    expect(resolveBridgeEndpoints({ type: "command", protocol: "wol", target: "wol", command: "AA:BB:CC:DD:EE:FF" })).toEqual([{ host: "255.255.255.255", port: 9, protocol: "wol" }]);
  });
  it.each([undefined, {}, { type: "ping" }, { type: "command", protocol: "made-up", target: "host:1" }, { type: "command", protocol: "tcp-command", target: "host:1", settings: [] }])("rejects an unsupported request without echoing its payload", input => {
    expect(() => resolveBridgeEndpoints(input)).toThrow("Enter a valid Bridge host, port and protocol.");
  });
});
