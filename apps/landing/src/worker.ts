const MANIFEST_KEY = "manifests/releases.json";
const MAX_MANIFEST_BYTES = 64 * 1024;
const DOWNLOAD_ID = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;
const OBJECT_KEY = /^releases\/[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,159}$/;
const RELEASE_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,39}$/;
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const ISO_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

type ReleaseStatus = "stable" | "beta";

const LANDING_RELEASE_TARGETS = {
  "desktop-macos-arm64": {
    kind: "artifact",
    product: "desktop",
    platform: "macOS",
    architecture: "Apple Silicon",
  },
  "desktop-macos-x64": {
    kind: "artifact",
    product: "desktop",
    platform: "macOS",
    architecture: "Intel",
  },
  "desktop-windows-x64": {
    kind: "artifact",
    product: "desktop",
    platform: "Windows",
    architecture: "x64",
  },
  "bridge-macos-arm64": {
    kind: "artifact",
    product: "bridge",
    platform: "macOS",
    architecture: "Apple Silicon",
  },
  "bridge-macos-x64": {
    kind: "artifact",
    product: "bridge",
    platform: "macOS",
    architecture: "Intel",
  },
  "bridge-windows-x64": {
    kind: "artifact",
    product: "bridge",
    platform: "Windows",
    architecture: "x64",
  },
  "mobile-ios": {
    kind: "store",
    product: "mobile",
    platform: "iOS",
    architecture: "Universal",
  },
  "mobile-android": {
    kind: "store",
    product: "mobile",
    platform: "Android",
    architecture: "Universal",
  },
} as const;

interface ReleaseEntryBase {
  id: string;
  product: "desktop" | "bridge" | "mobile";
  version: string;
  status: ReleaseStatus;
  platform: string;
  architecture: string;
  label: string;
}

export interface ArtifactReleaseEntry extends ReleaseEntryBase {
  kind: "artifact";
  key: string;
  fileName: string;
  size: number;
  sha256?: string;
  updaterSignature?: string;
}

type SignedUpdaterEntry = ArtifactReleaseEntry & { updaterSignature: string };

export interface StoreReleaseEntry extends ReleaseEntryBase {
  kind: "store";
  storeUrl: string;
}

export type ReleaseEntry = ArtifactReleaseEntry | StoreReleaseEntry;

interface ReleaseManifest {
  schemaVersion: 1;
  updatedAt: string;
  releases: ReleaseEntry[];
}

type ManifestState =
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "ready"; manifest: ReleaseManifest };

interface PublicReleaseEntry extends ReleaseEntryBase {
  kind: "artifact" | "store";
  downloadUrl: string;
  size?: number;
  sha256?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStoreUrl(value: unknown, platform: unknown): value is string {
  if (typeof value !== "string" || value.length > 500) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return false;
    if (platform === "iOS") return url.hostname === "apps.apple.com";
    if (platform === "Android") return url.hostname === "play.google.com";
    return false;
  } catch {
    return false;
  }
}

function isIsoUtcTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    ISO_UTC_TIMESTAMP.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function isReleaseEntry(value: unknown): value is ReleaseEntry {
  if (!isRecord(value)) return false;
  const validProduct =
    value.product === "desktop" ||
    value.product === "bridge" ||
    value.product === "mobile";
  const validStatus = value.status === "stable" || value.status === "beta";
  const validBase =
    typeof value.id === "string" &&
    DOWNLOAD_ID.test(value.id) &&
    validProduct &&
    typeof value.version === "string" &&
    RELEASE_VERSION.test(value.version) &&
    validStatus &&
    typeof value.platform === "string" &&
    value.platform.length > 0 &&
    value.platform.length <= 40 &&
    typeof value.architecture === "string" &&
    value.architecture.length > 0 &&
    value.architecture.length <= 40 &&
    typeof value.label === "string" &&
    value.label.length > 0 &&
    value.label.length <= 80;
  if (!validBase) return false;
  const landingTarget =
    LANDING_RELEASE_TARGETS[value.id as keyof typeof LANDING_RELEASE_TARGETS];
  if (
    landingTarget &&
    (value.kind !== landingTarget.kind ||
      value.product !== landingTarget.product ||
      value.platform !== landingTarget.platform ||
      value.architecture !== landingTarget.architecture)
  )
    return false;
  if (value.kind === "store") {
    return (
      value.product === "mobile" && isStoreUrl(value.storeUrl, value.platform)
    );
  }
  return (
    value.kind === "artifact" &&
    value.product !== "mobile" &&
    typeof value.key === "string" &&
    OBJECT_KEY.test(value.key) &&
    !value.key.includes("..") &&
    typeof value.fileName === "string" &&
    FILE_NAME.test(value.fileName) &&
    typeof value.size === "number" &&
    Number.isSafeInteger(value.size) &&
    value.size > 0 &&
    (value.sha256 === undefined ||
      (typeof value.sha256 === "string" &&
        /^[a-f0-9]{64}$/.test(value.sha256))) &&
    (value.updaterSignature === undefined ||
      ((value.product === "desktop" || value.product === "bridge") &&
        updaterTarget(value.platform, value.architecture) !== null &&
        typeof value.updaterSignature === "string" &&
        /^[A-Za-z0-9+/=]{40,512}$/.test(value.updaterSignature)))
  );
}

export function parseReleaseManifest(value: unknown): ReleaseManifest | null {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !isIsoUtcTimestamp(value.updatedAt) ||
    !Array.isArray(value.releases)
  )
    return null;
  if (value.releases.length > 20 || !value.releases.every(isReleaseEntry))
    return null;
  const ids = new Set(value.releases.map((entry) => entry.id));
  if (ids.size !== value.releases.length) return null;
  for (const product of ["desktop", "bridge"] as const) {
    const updaterEntries = value.releases.filter(
      (entry): entry is SignedUpdaterEntry =>
        entry.kind === "artifact" &&
        entry.product === product &&
        typeof entry.updaterSignature === "string",
    );
    if (updaterEntries.some((entry) => !SEMVER.test(entry.version)))
      return null;
    if (new Set(updaterEntries.map((entry) => entry.version)).size > 1)
      return null;
    const targets = updaterEntries.map((entry) =>
      updaterTarget(entry.platform, entry.architecture),
    );
    if (new Set(targets).size !== targets.length) return null;
  }
  return {
    schemaVersion: 1,
    updatedAt: value.updatedAt,
    releases: value.releases,
  };
}

async function loadManifestState(bucket: R2Bucket): Promise<ManifestState> {
  const metadata = await bucket.head(MANIFEST_KEY);
  if (!metadata) return { kind: "missing" };
  if (metadata.size > MAX_MANIFEST_BYTES) return { kind: "invalid" };
  const object = await bucket.get(MANIFEST_KEY);
  if (!object) return { kind: "invalid" };
  try {
    const manifest = parseReleaseManifest(await object.json<unknown>());
    return manifest ? { kind: "ready", manifest } : { kind: "invalid" };
  } catch {
    return { kind: "invalid" };
  }
}

function baseHeaders(): Headers {
  return new Headers({
    "Cache-Control": "public, max-age=60, stale-while-revalidate=300",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
}

function jsonError(message: string, status: number): Response {
  const headers = baseHeaders();
  if (status >= 500) headers.set("Cache-Control", "no-store");
  return Response.json({ error: message }, { status, headers });
}

/** Browser navigation needs recovery even when scripts or the manifest fail.
 * Keep API/updater callers on JSON, and never interpolate request/manifest data. */
function downloadError(request: Request, message: string, status: number): Response {
  const response = jsonError(message, status);
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Vary", "Accept");
  if (request.method === "HEAD") return new Response(null, { status, headers: response.headers });
  if (new URL(request.url).pathname === "/downloads/manifest.json" || !request.headers.get("Accept")?.includes("text/html")) return response;
  const unavailable = status === 404;
  const title = unavailable ? "Download unavailable" : "Could not check this download";
  const description = unavailable
    ? "This build is not available from this link. You can check again, choose another download, or use ShowPilot in your browser."
    : "The download service did not respond successfully. Try again, or use ShowPilot in your browser while we recover.";
  const headers = response.headers;
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Content-Security-Policy", "default-src 'none'; style-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  headers.set("X-Frame-Options", "DENY");
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${title} | ShowPilot</title><link rel="stylesheet" href="/landing.css"></head>
    <body><main class="download-notice"><a class="download-notice-brand" href="/">ShowPilot</a><h1>${title}</h1><p>${description}</p>
    <div class="download-notice-actions"><a class="button primary" href="">Try again</a><a class="button outline" href="/#downloads">View downloads</a><a class="button outline" href="https://app.showpilot.tech">Open web app</a></div></main></body></html>`, { status, headers });
}

async function boundedDownloadResponse(request: Request, env: Env): Promise<Response> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      handleDownloads(request, env),
      new Promise<Response>(resolve => { timer = setTimeout(() => resolve(downloadError(request, "Downloads are temporarily unavailable", 503)), 8_000); }),
    ]);
  } finally { clearTimeout(timer); }
}

export function publicManifest(manifest: ReleaseManifest): {
  schemaVersion: 1;
  updatedAt: string;
  releases: PublicReleaseEntry[];
} {
  return {
    schemaVersion: 1,
    updatedAt: manifest.updatedAt,
    releases: manifest.releases.map((entry) =>
      entry.kind === "store"
        ? {
            id: entry.id,
            product: entry.product,
            version: entry.version,
            status: entry.status,
            platform: entry.platform,
            architecture: entry.architecture,
            label: entry.label,
            kind: entry.kind,
            downloadUrl: entry.storeUrl,
          }
        : {
            id: entry.id,
            product: entry.product,
            version: entry.version,
            status: entry.status,
            platform: entry.platform,
            architecture: entry.architecture,
            label: entry.label,
            kind: entry.kind,
            size: entry.size,
            sha256: entry.sha256,
            downloadUrl: `/downloads/${entry.id}`,
          },
    ),
  };
}

function resolvedByteRange(
  range: R2Range | undefined,
  objectSize: number,
): { start: number; length: number } | null {
  if (!range) return null;
  if ("suffix" in range && typeof range.suffix === "number") {
    return {
      start: Math.max(0, objectSize - range.suffix),
      length: Math.min(range.suffix, objectSize),
    };
  }
  const start =
    "offset" in range && typeof range.offset === "number" ? range.offset : 0;
  const length =
    "length" in range && typeof range.length === "number"
      ? range.length
      : objectSize - start;
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(length) ||
    start < 0 ||
    length <= 0
  )
    return null;
  return { start, length };
}

function rangeHeaders(object: R2Object, includeRange = true): Headers {
  const headers = baseHeaders();
  object.writeHttpMetadata(headers);
  headers.set("Accept-Ranges", "bytes");
  headers.set("ETag", object.httpEtag);
  // The ID URL follows the current manifest; it is not a versioned object URL.
  headers.set("Cache-Control", "no-store");

  const range = includeRange
    ? resolvedByteRange(object.range, object.size)
    : null;
  if (!range) {
    headers.set("Content-Length", String(object.size));
    return headers;
  }

  headers.set("Content-Length", String(range.length));
  headers.set(
    "Content-Range",
    `bytes ${range.start}-${range.start + range.length - 1}/${object.size}`,
  );
  return headers;
}

async function serveDownload(
  request: Request,
  env: Env,
  id: string,
): Promise<Response> {
  if (!DOWNLOAD_ID.test(id)) return downloadError(request, "Download not found", 404);
  const state = await loadManifestState(env.DOWNLOADS);
  if (state.kind === "invalid") return downloadError(request, "Downloads are temporarily unavailable", 503);
  if (state.kind === "missing") return downloadError(request, "Download not found", 404);
  const release = state.manifest.releases.find((entry) => entry.id === id);
  if (!release) return downloadError(request, "Download not found", 404);
  if (release.kind === "store") {
    const headers = baseHeaders();
    headers.set("Cache-Control", "no-store");
    headers.set("Location", release.storeUrl);
    return new Response(null, { status: 302, headers });
  }

  if (request.method === "HEAD") {
    const object = await env.DOWNLOADS.head(release.key);
    if (!object) return downloadError(request, "Download not found", 404);
    const headers = downloadHeaders(object, release.fileName, false);
    return new Response(null, { status: 200, headers });
  }

  const hasRangeRequest = request.headers.has("Range");
  const object = await env.DOWNLOADS.get(
    release.key,
    hasRangeRequest ? { range: request.headers } : undefined,
  );
  if (!object) return downloadError(request, "Download not found", 404);
  const headers = downloadHeaders(object, release.fileName, hasRangeRequest);
  const partial =
    hasRangeRequest && resolvedByteRange(object.range, object.size) !== null;
  return new Response(object.body, { status: partial ? 206 : 200, headers });
}

function downloadHeaders(
  object: R2Object,
  fileName: string,
  includeRange = true,
): Headers {
  const headers = rangeHeaders(object, includeRange);
  headers.set(
    "Content-Disposition",
    `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
  );
  headers.set(
    "Content-Type",
    headers.get("Content-Type") ?? "application/octet-stream",
  );
  return headers;
}

function updaterTarget(
  platform: unknown,
  architecture: unknown,
): string | null {
  if (platform === "macOS" && architecture === "Apple Silicon")
    return "darwin-aarch64";
  if (platform === "macOS" && architecture === "Intel") return "darwin-x86_64";
  if (platform === "Windows" && architecture === "x64") return "windows-x86_64";
  if (platform === "Linux" && architecture === "x64") return "linux-x86_64";
  return null;
}

function nativeUpdaterManifest(
  manifest: ReleaseManifest,
  product: "desktop" | "bridge",
  origin: string,
): Record<string, unknown> | null {
  const updaterEntries = manifest.releases.filter(
    (entry): entry is SignedUpdaterEntry =>
      entry.kind === "artifact" &&
      entry.product === product &&
      entry.status === "stable" &&
      typeof entry.updaterSignature === "string",
  );
  const version = updaterEntries[0]?.version;
  if (!version) return null;

  const platforms: Record<string, { signature: string; url: string }> = {};
  for (const entry of updaterEntries) {
    const target = updaterTarget(entry.platform, entry.architecture);
    if (!target || platforms[target]) continue;
    platforms[target] = {
      signature: entry.updaterSignature,
      url: `${origin}/downloads/${entry.id}`,
    };
  }
  if (Object.keys(platforms).length === 0) return null;
  return {
    version,
    notes:
      product === "desktop"
        ? "ShowPilot Desktop stability and device-control update."
        : "ShowPilot Bridge connectivity and device-control update.",
    pub_date: manifest.updatedAt,
    platforms,
  };
}

export function desktopUpdaterManifest(
  manifest: ReleaseManifest,
  origin: string,
): Record<string, unknown> | null {
  return nativeUpdaterManifest(manifest, "desktop", origin);
}

export function bridgeUpdaterManifest(
  manifest: ReleaseManifest,
  origin: string,
): Record<string, unknown> | null {
  return nativeUpdaterManifest(manifest, "bridge", origin);
}

async function serveNativeUpdater(
  request: Request,
  env: Env,
  product: "desktop" | "bridge",
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  const state = await loadManifestState(env.DOWNLOADS);
  if (state.kind === "invalid")
    return jsonError("Updates are temporarily unavailable", 503);
  if (state.kind === "missing")
    return new Response(null, {
      status: 204,
      headers: { "Cache-Control": "no-store" },
    });
  const payload = nativeUpdaterManifest(
    state.manifest,
    product,
    new URL(request.url).origin,
  );
  if (!payload)
    return new Response(null, {
      status: 204,
      headers: { "Cache-Control": "no-store" },
    });
  const headers = baseHeaders();
  headers.set(
    "Cache-Control",
    "public, max-age=300, stale-while-revalidate=300",
  );
  return request.method === "HEAD"
    ? new Response(null, { status: 200, headers })
    : Response.json(payload, { headers });
}

async function handleDownloads(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
  }

  const url = new URL(request.url);
  if (url.pathname === "/downloads" || url.pathname === "/downloads/") {
    return Response.redirect(`${url.origin}/#downloads`, 302);
  }
  if (url.pathname === "/downloads/manifest.json") {
    const state = await loadManifestState(env.DOWNLOADS);
    if (state.kind === "invalid") {
      return jsonError("Downloads are temporarily unavailable", 503);
    }
    if (state.kind === "missing") {
      const headers = baseHeaders();
      headers.set("Cache-Control", "no-store");
      return Response.json(
        { schemaVersion: 1, updatedAt: null, releases: [] },
        { headers },
      );
    }
    return Response.json(publicManifest(state.manifest), {
      headers: baseHeaders(),
    });
  }

  let id: string;
  try {
    id = decodeURIComponent(url.pathname.slice("/downloads/".length));
  } catch {
    return downloadError(request, "Download not found", 404);
  }
  return serveDownload(request, env, id);
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const updaterProduct =
      url.pathname === "/updates/desktop/latest.json"
        ? "desktop"
        : url.pathname === "/updates/bridge/latest.json"
          ? "bridge"
          : null;
    if (
      url.pathname === "/downloads" ||
      url.pathname.startsWith("/downloads/") ||
      updaterProduct
    ) {
      try {
        if (updaterProduct) {
          return await serveNativeUpdater(request, env, updaterProduct);
        }
        return await boundedDownloadResponse(request, env);
      } catch (error) {
        console.error(
          JSON.stringify({
            message: "download request failed",
            path: url.pathname,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        return updaterProduct ? jsonError("Downloads are temporarily unavailable", 503) : downloadError(request, "Downloads are temporarily unavailable", 503);
      }
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
