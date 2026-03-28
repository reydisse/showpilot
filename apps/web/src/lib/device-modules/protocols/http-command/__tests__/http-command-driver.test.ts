import { describe, it, expect, vi, beforeEach } from "vitest";
import { HttpCommandDriver } from "../http-command-driver";

const fetchSpy = vi.fn();
globalThis.fetch = fetchSpy;

function mockOk(body = "OK") {
  fetchSpy.mockResolvedValue({ ok: true, text: () => Promise.resolve(body) });
}

function mockFail(status = 500) {
  fetchSpy.mockResolvedValue({ ok: false, status, text: () => Promise.resolve("Error") });
}

describe("HttpCommandDriver", () => {
  let driver: HttpCommandDriver;

  beforeEach(() => {
    fetchSpy.mockReset();
    driver = new HttpCommandDriver();
  });

  describe("connection", () => {
    it("connects by pinging base URL", async () => {
      mockOk();
      await driver.connect({ host: "192.168.1.50", port: 8080 });
      expect(fetchSpy).toHaveBeenCalledWith("http://192.168.1.50:8080/", expect.anything());
      expect(driver.isConnected()).toBe(true);
    });

    it("connects with custom base path", async () => {
      mockOk();
      await driver.connect({ host: "192.168.1.50", port: 8080, basePath: "/api/v1" });
      expect(fetchSpy).toHaveBeenCalledWith("http://192.168.1.50:8080/api/v1", expect.anything());
    });

    it("fails if ping returns non-ok", async () => {
      mockFail(404);
      await expect(driver.connect({ host: "192.168.1.50" })).rejects.toThrow();
    });

    it("uses default port 80", async () => {
      mockOk();
      await driver.connect({ host: "192.168.1.50" });
      expect(fetchSpy).toHaveBeenCalledWith("http://192.168.1.50:80/", expect.anything());
    });

    it("disconnects", async () => {
      mockOk();
      await driver.connect({ host: "192.168.1.50" });
      driver.disconnect();
      expect(driver.isConnected()).toBe(false);
    });
  });

  describe("sendCommand", () => {
    beforeEach(async () => {
      mockOk();
      await driver.connect({ host: "192.168.1.50", port: 8080 });
    });

    it("sends GET request for GET commands", async () => {
      mockOk("result");
      const result = await driver.sendCommand("GET /power/status");
      expect(fetchSpy).toHaveBeenLastCalledWith(
        "http://192.168.1.50:8080/power/status",
        expect.objectContaining({ method: "GET" })
      );
      expect(result).toBe("result");
    });

    it("sends POST request with body", async () => {
      mockOk();
      await driver.sendCommand('POST /api/command {"action":"power_on"}');
      expect(fetchSpy).toHaveBeenLastCalledWith(
        "http://192.168.1.50:8080/api/command",
        expect.objectContaining({
          method: "POST",
          body: '{"action":"power_on"}',
        })
      );
    });

    it("defaults to GET if no method prefix", async () => {
      mockOk("data");
      const result = await driver.sendCommand("/status");
      expect(fetchSpy).toHaveBeenLastCalledWith(
        "http://192.168.1.50:8080/status",
        expect.objectContaining({ method: "GET" })
      );
      expect(result).toBe("data");
    });

    it("includes auth header if token provided", async () => {
      mockOk();
      driver.disconnect();
      mockOk();
      await driver.connect({ host: "192.168.1.50", port: 8080, authToken: "secret123" });
      mockOk();
      await driver.sendCommand("GET /status");
      expect(fetchSpy).toHaveBeenLastCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: "Bearer secret123" }),
        })
      );
    });
  });

  describe("metadata", () => {
    it("is browser-direct HTTP", () => {
      expect(driver.protocolId).toBe("http-command");
      expect(driver.transport).toBe("http");
      expect(driver.connectivity).toBe("browser-direct");
    });

    it("has config fields for host, port, basePath, authToken", () => {
      const keys = driver.baseConfigFields.map((f) => f.key);
      expect(keys).toContain("host");
      expect(keys).toContain("port");
      expect(keys).toContain("basePath");
      expect(keys).toContain("authToken");
    });
  });
});
