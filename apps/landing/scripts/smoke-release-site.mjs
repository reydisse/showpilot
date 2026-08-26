const DEFAULT_ORIGIN = "https://www.showpilot.tech";
const MAX_ATTEMPTS = 6;
const RETRY_DELAY_MS = 2_000;

function releaseOrigin(value) {
  const url = new URL(value || DEFAULT_ORIGIN);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error("Release smoke origin must use HTTPS or an explicit local HTTP host");
  }
  return url.origin;
}

function validateLanding(response, body, origin) {
  if (response.url !== `${origin}/`) throw new Error(`Landing redirected to ${response.url}`);
  if (!response.headers.get("content-type")?.includes("text/html")) {
    throw new Error("Landing did not return HTML");
  }
  const requiredMarkers = [
    'id="downloads"',
    'data-download-id="desktop-macos-arm64"',
    'data-download-id="bridge-macos-arm64"',
    'data-download-id="mobile-ios"',
    'data-download-id="mobile-android"',
    'href="https://showpilot.tech/login"',
    'href="https://showpilot.tech/login?signup=1"',
    'href="https://showpilot.tech/terms"',
    'href="https://showpilot.tech/privacy"',
    'href="mailto:support@showpilot.tech"',
  ];
  const missing = requiredMarkers.filter((marker) => !body.includes(marker));
  if (missing.length > 0) throw new Error(`Landing is missing release markers: ${missing.join(", ")}`);
  if (body.includes("{{") || body.includes("github.com")) {
    throw new Error("Landing exposes an unresolved template token or private repository link");
  }
}

function validateManifest(response, body) {
  if (!response.headers.get("content-type")?.includes("application/json")) {
    throw new Error("Release manifest did not return JSON");
  }
  const manifest = JSON.parse(body);
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.releases)) {
    throw new Error("Release manifest has an invalid public shape");
  }
  for (const release of manifest.releases) {
    if (typeof release?.id !== "string" || typeof release?.downloadUrl !== "string") {
      throw new Error("Release manifest contains an invalid public entry");
    }
  }
}

async function fetchUntilValid(url, validate) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { "Cache-Control": "no-cache", Accept: "*/*" },
        redirect: "follow",
      });
      const body = await response.text();
      if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
      validate(response, body);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Could not verify ${url}`);
}

async function main() {
  const requestedOrigin = process.argv.slice(2).find((argument) => argument !== "--");
  const origin = releaseOrigin(requestedOrigin);
  await fetchUntilValid(`${origin}/`, (response, body) => validateLanding(response, body, origin));
  await fetchUntilValid(`${origin}/downloads/manifest.json`, validateManifest);
  console.log(`Landing release smoke passed: ${origin}`);
}

try {
  await main();
} catch (error) {
  console.error(`Landing release smoke failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
