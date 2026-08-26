import { describe, expect, it } from "vitest";
import worker, {
  bridgeUpdaterManifest,
  desktopUpdaterManifest,
  parseReleaseManifest,
  publicManifest,
} from "./worker";

const validEntry = {
  id: "desktop-macos-arm64",
  kind: "artifact",
  product: "desktop",
  version: "0.1.0-beta.1",
  status: "beta",
  platform: "macOS",
  architecture: "Apple Silicon",
  label: "macOS · Apple Silicon",
  key: "releases/desktop/0.1.0-beta.1/ShowPilot-Desktop-arm64.zip",
  fileName: "ShowPilot-Desktop-arm64.zip",
  size: 29_138_349,
  sha256: "a".repeat(64),
} as const;

const storeEntry = {
  id: "mobile-ios",
  kind: "store",
  product: "mobile",
  version: "1.0.0",
  status: "stable",
  platform: "iOS",
  architecture: "Universal",
  label: "Download on the App Store",
  storeUrl: "https://apps.apple.com/app/showpilot/id1234567890",
} as const;

const updaterEntry = {
  ...validEntry,
  id: "desktop-update-macos-arm64",
  version: "0.1.0",
  status: "stable",
  key: "releases/desktop/0.1.0/ShowPilot-Desktop_0.1.0_aarch64.app.tar.gz",
  fileName: "ShowPilot-Desktop_0.1.0_aarch64.app.tar.gz",
  updaterSignature: "A".repeat(88),
} as const;

const bridgeUpdaterEntry = {
  ...updaterEntry,
  id: "bridge-update-macos-arm64",
  product: "bridge",
  version: "0.1.7",
  key: "releases/bridge/0.1.7/ShowPilot-Bridge_0.1.7_aarch64.app.tar.gz",
  fileName: "ShowPilot-Bridge_0.1.7_aarch64.app.tar.gz",
  updaterSignature: "B".repeat(88),
} as const;

function fakeEnvironment(releases: unknown[]) {
  const manifest = {
    schemaVersion: 1,
    updatedAt: "2026-08-22T17:00:00.000Z",
    releases,
  };
  const bytes = new TextEncoder().encode("showpilot-artifact");
  const object = (range?: R2Range) => {
    const body =
      range &&
      "offset" in range &&
      typeof range.offset === "number" &&
      "length" in range &&
      typeof range.length === "number"
        ? bytes.slice(range.offset, range.offset + range.length)
        : bytes;
    return {
      body: new Blob([body]).stream(),
      size: bytes.byteLength,
      httpEtag: '"artifact-etag"',
      range,
      writeHttpMetadata(headers: Headers) {
        headers.set("Content-Type", "application/octet-stream");
      },
    };
  };
  const bucket = {
    async head(key: string) {
      if (key === "manifests/releases.json")
        return { size: JSON.stringify(manifest).length };
      if (
        key === validEntry.key ||
        key === updaterEntry.key ||
        key === bridgeUpdaterEntry.key
      )
        return object();
      return null;
    },
    async get(key: string, options?: { range?: Headers }) {
      if (key === "manifests/releases.json")
        return { json: async () => manifest };
      if (
        key === validEntry.key ||
        key === updaterEntry.key ||
        key === bridgeUpdaterEntry.key
      ) {
        return options?.range ? object({ offset: 2, length: 4 }) : object();
      }
      return null;
    },
  } as unknown as R2Bucket;
  return {
    DOWNLOADS: bucket,
    ASSETS: {
      fetch: async () => new Response("landing"),
    } as unknown as Fetcher,
  } as Env;
}

function validManifest(releases: unknown[]) {
  const manifest = parseReleaseManifest({
    schemaVersion: 1,
    updatedAt: "2026-08-22T17:00:00.000Z",
    releases,
  });
  expect(manifest).not.toBeNull();
  if (!manifest) throw new Error("Expected a valid release manifest");
  return manifest;
}

function incomingRequest(url: string): Parameters<typeof worker.fetch>[0] {
  return new Request(url) as Parameters<typeof worker.fetch>[0];
}

describe("parseReleaseManifest", () => {
  it("accepts a bounded release manifest", () => {
    const result = parseReleaseManifest({
      schemaVersion: 1,
      updatedAt: "2026-08-22T17:00:00.000Z",
      releases: [validEntry],
    });

    expect(result?.releases[0]?.id).toBe("desktop-macos-arm64");
  });

  it("rejects duplicate download ids", () => {
    const result = parseReleaseManifest({
      schemaVersion: 1,
      updatedAt: "2026-08-22T17:00:00.000Z",
      releases: [validEntry, { ...validEntry }],
    });

    expect(result).toBeNull();
  });

  it("rejects invalid timestamps and non-SemVer updater versions", () => {
    expect(
      parseReleaseManifest({
        schemaVersion: 1,
        updatedAt: "next Tuesday",
        releases: [validEntry],
      }),
    ).toBeNull();
    expect(
      parseReleaseManifest({
        schemaVersion: 1,
        updatedAt: "2026-08-22T17:00:00.000Z",
        releases: [{ ...updaterEntry, version: "latest" }],
      }),
    ).toBeNull();
  });

  it("rejects object-key traversal", () => {
    const result = parseReleaseManifest({
      schemaVersion: 1,
      updatedAt: "2026-08-22T17:00:00.000Z",
      releases: [{ ...validEntry, key: "releases/desktop/../../private.txt" }],
    });

    expect(result).toBeNull();
  });

  it("accepts allowlisted native store releases", () => {
    const result = parseReleaseManifest({
      schemaVersion: 1,
      updatedAt: "2026-08-22T17:00:00.000Z",
      releases: [storeEntry],
    });

    expect(result?.releases[0]?.kind).toBe("store");
  });

  it("rejects untrusted and mismatched store links", () => {
    const base = {
      id: "mobile-ios",
      kind: "store",
      product: "mobile",
      version: "1.0.0",
      status: "stable",
      platform: "iOS",
      architecture: "Universal",
      label: "Download on the App Store",
    };
    expect(
      parseReleaseManifest({
        schemaVersion: 1,
        updatedAt: "2026-08-22T17:00:00.000Z",
        releases: [{ ...base, storeUrl: "https://evil.example/app" }],
      }),
    ).toBeNull();
    expect(
      parseReleaseManifest({
        schemaVersion: 1,
        updatedAt: "2026-08-22T17:00:00.000Z",
        releases: [
          {
            ...base,
            platform: "Android",
            storeUrl: "https://apps.apple.com/app/showpilot/id1234567890",
          },
        ],
      }),
    ).toBeNull();
  });

  it("rejects landing ids whose product or platform metadata drift", () => {
    expect(
      parseReleaseManifest({
        schemaVersion: 1,
        updatedAt: "2026-08-22T17:00:00.000Z",
        releases: [{ ...validEntry, product: "bridge" }],
      }),
    ).toBeNull();
    expect(
      parseReleaseManifest({
        schemaVersion: 1,
        updatedAt: "2026-08-22T17:00:00.000Z",
        releases: [{ ...storeEntry, platform: "Android" }],
      }),
    ).toBeNull();
  });

  it("accepts one signed desktop updater version and rejects mixed versions", () => {
    expect(
      parseReleaseManifest({
        schemaVersion: 1,
        updatedAt: "2026-08-22T17:00:00.000Z",
        releases: [validEntry, updaterEntry],
      }),
    ).not.toBeNull();
    expect(
      parseReleaseManifest({
        schemaVersion: 1,
        updatedAt: "2026-08-22T17:00:00.000Z",
        releases: [
          updaterEntry,
          { ...updaterEntry, id: "desktop-update-macos-x64", version: "0.2.0" },
        ],
      }),
    ).toBeNull();
    expect(
      parseReleaseManifest({
        schemaVersion: 1,
        updatedAt: "2026-08-22T17:00:00.000Z",
        releases: [{ ...updaterEntry, updaterSignature: "not a signature" }],
      }),
    ).toBeNull();
  });

  it("keeps Desktop and Bridge updater versions independent and rejects duplicate targets", () => {
    expect(
      parseReleaseManifest({
        schemaVersion: 1,
        updatedAt: "2026-08-22T17:00:00.000Z",
        releases: [updaterEntry, bridgeUpdaterEntry],
      }),
    ).not.toBeNull();
    expect(
      parseReleaseManifest({
        schemaVersion: 1,
        updatedAt: "2026-08-22T17:00:00.000Z",
        releases: [
          bridgeUpdaterEntry,
          { ...bridgeUpdaterEntry, id: "bridge-update-macos-arm64-copy" },
        ],
      }),
    ).toBeNull();
  });

  it("never exposes private R2 keys or artifact file names", () => {
    const published = publicManifest(validManifest([validEntry]));
    expect(published.releases[0]).toMatchObject({
      downloadUrl: "/downloads/desktop-macos-arm64",
      size: validEntry.size,
    });
    expect(published.releases[0]).not.toHaveProperty("key");
    expect(published.releases[0]).not.toHaveProperty("fileName");
  });

  it("publishes a safe HTTP manifest and official store destination", async () => {
    const response = await worker.fetch(
      incomingRequest("https://www.showpilot.tech/downloads/manifest.json"),
      fakeEnvironment([validEntry, storeEntry]),
    );
    const payload = (await response.json()) as {
      releases: Array<Record<string, unknown>>;
    };
    expect(response.status).toBe(200);
    expect(payload.releases).toContainEqual(
      expect.objectContaining({
        id: "mobile-ios",
        downloadUrl: storeEntry.storeUrl,
      }),
    );
    expect(JSON.stringify(payload)).not.toContain(validEntry.key);
    expect(JSON.stringify(payload)).not.toContain(validEntry.fileName);
  });

  it("streams approved artifacts with attachment and range-capable headers", async () => {
    const response = await worker.fetch(
      incomingRequest(
        "https://www.showpilot.tech/downloads/desktop-macos-arm64",
      ),
      fakeEnvironment([validEntry]),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Accept-Ranges")).toBe("bytes");
    expect(response.headers.get("Content-Disposition")).toContain(
      encodeURIComponent(validEntry.fileName),
    );
    expect(await response.text()).toBe("showpilot-artifact");
  });

  it("supports installer HEAD checks and resumable byte ranges", async () => {
    const env = fakeEnvironment([validEntry]);
    const headResponse = await worker.fetch(
      new Request("https://www.showpilot.tech/downloads/desktop-macos-arm64", {
        method: "HEAD",
      }) as Parameters<typeof worker.fetch>[0],
      env,
    );
    expect(headResponse.status).toBe(200);
    expect(headResponse.headers.get("Content-Length")).toBe(
      String(new TextEncoder().encode("showpilot-artifact").byteLength),
    );
    expect(await headResponse.text()).toBe("");

    const rangeResponse = await worker.fetch(
      new Request("https://www.showpilot.tech/downloads/desktop-macos-arm64", {
        headers: { Range: "bytes=2-5" },
      }) as Parameters<typeof worker.fetch>[0],
      env,
    );
    expect(rangeResponse.status).toBe(206);
    expect(rangeResponse.headers.get("Content-Length")).toBe("4");
    expect(rangeResponse.headers.get("Content-Range")).toBe("bytes 2-5/18");
    expect(await rangeResponse.text()).toBe("owpi");
  });

  it("returns a clean 404 for malformed encoded download ids", async () => {
    const response = await worker.fetch(
      incomingRequest("https://www.showpilot.tech/downloads/%E0%A4%A"),
      fakeEnvironment([validEntry]),
    );
    expect(response.status).toBe(404);
  });

  it("does not proxy store entries through the artifact route", async () => {
    const response = await worker.fetch(
      incomingRequest("https://www.showpilot.tech/downloads/mobile-ios"),
      fakeEnvironment([storeEntry]),
    );
    expect(response.status).toBe(404);
  });

  it("treats a missing manifest as an unpublished release without console-failing the landing page", async () => {
    const response = await worker.fetch(
      incomingRequest("https://www.showpilot.tech/downloads/manifest.json"),
      fakeEnvironment([]),
    );
    expect(response.status).toBe(200);

    const missing = {
      DOWNLOADS: { head: async () => null } as unknown as R2Bucket,
      ASSETS: {
        fetch: async () => new Response("landing"),
      } as unknown as Fetcher,
    } as Env;
    const unpublished = await worker.fetch(
      incomingRequest("https://www.showpilot.tech/downloads/manifest.json"),
      missing,
    );
    expect(unpublished.status).toBe(200);
    expect(unpublished.headers.get("Cache-Control")).toBe("no-store");
    await expect(unpublished.json()).resolves.toEqual({
      schemaVersion: 1,
      updatedAt: null,
      releases: [],
    });
  });

  it("fails closed when a manifest exists but is invalid", async () => {
    const invalid = {
      DOWNLOADS: {
        head: async () => ({ size: 10 }),
        get: async () => ({
          json: async () => ({ schemaVersion: 1, releases: "broken" }),
        }),
      } as unknown as R2Bucket,
      ASSETS: {
        fetch: async () => new Response("landing"),
      } as unknown as Fetcher,
    } as Env;

    const response = await worker.fetch(
      incomingRequest("https://www.showpilot.tech/downloads/manifest.json"),
      invalid,
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("serves a Tauri updater manifest without exposing private object keys", async () => {
    const parsed = validManifest([updaterEntry]);
    expect(
      desktopUpdaterManifest(parsed, "https://www.showpilot.tech"),
    ).toMatchObject({
      version: "0.1.0",
      platforms: {
        "darwin-aarch64": {
          signature: updaterEntry.updaterSignature,
          url: "https://www.showpilot.tech/downloads/desktop-update-macos-arm64",
        },
      },
    });

    const response = await worker.fetch(
      incomingRequest("https://www.showpilot.tech/updates/desktop/latest.json"),
      fakeEnvironment([updaterEntry]),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("max-age=300");
    const text = await response.text();
    expect(text).not.toContain(updaterEntry.key);
    expect(text).toContain("desktop-update-macos-arm64");
  });

  it("returns no update before a signed stable updater artifact is published", async () => {
    const response = await worker.fetch(
      incomingRequest("https://www.showpilot.tech/updates/desktop/latest.json"),
      fakeEnvironment([validEntry]),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("returns no update when releases have not been published yet", async () => {
    const missing = {
      DOWNLOADS: { head: async () => null } as unknown as R2Bucket,
      ASSETS: {
        fetch: async () => new Response("landing"),
      } as unknown as Fetcher,
    } as Env;
    const response = await worker.fetch(
      incomingRequest("https://www.showpilot.tech/updates/desktop/latest.json"),
      missing,
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("redirects the direct downloads route to the download center", async () => {
    const response = await worker.fetch(
      incomingRequest("https://www.showpilot.tech/downloads"),
      fakeEnvironment([]),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      "https://www.showpilot.tech/#downloads",
    );
  });

  it("serves Bridge updates only from the Bridge updater endpoint", async () => {
    const parsed = validManifest([updaterEntry, bridgeUpdaterEntry]);
    expect(
      bridgeUpdaterManifest(parsed, "https://www.showpilot.tech"),
    ).toMatchObject({
      version: "0.1.7",
      platforms: {
        "darwin-aarch64": {
          signature: bridgeUpdaterEntry.updaterSignature,
          url: "https://www.showpilot.tech/downloads/bridge-update-macos-arm64",
        },
      },
    });

    const response = await worker.fetch(
      incomingRequest("https://www.showpilot.tech/updates/bridge/latest.json"),
      fakeEnvironment([updaterEntry, bridgeUpdaterEntry]),
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      version: string;
      platforms: Record<string, { url: string }>;
    };
    expect(payload.version).toBe("0.1.7");
    expect(JSON.stringify(payload)).toContain("bridge-update-macos-arm64");
    expect(JSON.stringify(payload)).not.toContain("desktop-update-macos-arm64");
  });
});
