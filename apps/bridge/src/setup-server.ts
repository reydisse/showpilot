import fs from "fs";
import http from "http";
import path from "path";
import { randomUUID } from "crypto";
import { deleteCredential, readCredential, writeCredential } from "./credential-store.js";
import { credentialFreeUrl } from "./transport-url.js";

export interface BridgeConfig {
  site: string;
  org: string;
  key?: string;
  url?: string;
  propresenterHost?: string;
  propresenterPort?: number;
  propresenterPassword?: string;
  propresenterApiPort?: number;
}

export interface SetupState {
  config: BridgeConfig | null;
  bridgeRunning: boolean;
  bridgeStatus: string;
  debug?: Record<string, unknown>;
}

const CONFIG_FILES = ["showpilot-bridge.config.json", "bridge.config.json"];
const CREDENTIAL_FORMAT = "showpilot-bridge-v1";
const CONFIG_ERROR = "Unable to read or save Bridge configuration.";

function savedCredentials(value: Record<string, unknown>): Pick<BridgeConfig, "key" | "propresenterPassword"> {
  if (value.credentialFormat !== undefined) {
    if (value.credentialFormat !== CREDENTIAL_FORMAT || typeof value.credentialReference !== "string"
      || "key" in value || "propresenterPassword" in value) throw new Error(CONFIG_ERROR);
    const payload = readCredential(value.credentialReference);
    let stored: unknown;
    try { stored = JSON.parse(payload); }
    catch { throw new Error(CONFIG_ERROR); }
    if (!stored || typeof stored !== "object" || Array.isArray(stored)
      || !("key" in stored) || typeof stored.key !== "string" || !stored.key.startsWith("sp_") || stored.key.length > 256
      || Object.keys(stored).some(key => key !== "key" && key !== "propresenterPassword")) throw new Error(CONFIG_ERROR);
    const password = "propresenterPassword" in stored ? stored.propresenterPassword : undefined;
    if (password !== undefined && password !== null && typeof password !== "string") throw new Error(CONFIG_ERROR);
    return { key: stored.key, propresenterPassword: password ?? undefined };
  }
  const key = typeof value.key === "string" && value.key
    ? value.key : typeof value.credentialReference === "string" ? readCredential(value.credentialReference) : undefined;
  const password = value.propresenterPassword;
  if (password !== undefined && password !== null && typeof password !== "string") throw new Error(CONFIG_ERROR);
  return { key, propresenterPassword: password ?? undefined };
}

export function validateBridgeConfig(config: BridgeConfig): string | null {
  const normalizedSite = config.site.startsWith("http://") || config.site.startsWith("https://")
    ? config.site
    : `https://${config.site}`;
  let siteUrl: URL;
  try {
    siteUrl = new URL(normalizedSite);
  } catch {
    return "Enter a valid ShowPilot site URL";
  }
  const localDevelopment = siteUrl.protocol === "http:"
    && (siteUrl.hostname === "localhost" || siteUrl.hostname === "127.0.0.1")
    && Boolean(siteUrl.port);
  if ((siteUrl.protocol !== "https:" && !localDevelopment) || siteUrl.username || siteUrl.password) {
    return "The ShowPilot site must use HTTPS or an explicit localhost development port";
  }

  const org = config.org.trim();
  if (
    !org
    || org.length > 64
    || !/^[A-Za-z0-9-]+$/.test(org)
  ) {
    return "Enter a valid organization slug";
  }

  const key = config.key?.trim();
  if (!key || !key.startsWith("sp_") || key.length > 256) {
    return "Enter the Bridge API key from ShowPilot Settings";
  }

  for (const port of [config.propresenterPort, config.propresenterApiPort]) {
    if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65_535)) {
      return "ProPresenter ports must be between 1 and 65535";
    }
  }
  return null;
}

export function loadConfigFile(directory = process.cwd()): BridgeConfig | null {
  let selected: BridgeConfig | null = null;
  for (const file of CONFIG_FILES) {
    const fullPath = path.join(directory, file);
    if (!fs.existsSync(fullPath)) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(fs.readFileSync(fullPath, "utf8")); }
    catch { continue; }
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const value: Record<string, unknown> = { ...parsed };
      if (typeof value.site === "string" && typeof value.org === "string") {
        const config = {
          site: value.site,
          org: value.org,
          ...savedCredentials(value),
          url: typeof value.url === "string" ? credentialFreeUrl(value.url).toString() : undefined,
          propresenterHost: typeof value.propresenterHost === "string" ? value.propresenterHost : undefined,
          propresenterPort: typeof value.propresenterPort === "number" ? value.propresenterPort : undefined,
          propresenterApiPort: typeof value.propresenterApiPort === "number" ? value.propresenterApiPort : undefined,
        };
        if (!validateBridgeConfig(config)) {
          if (value.credentialFormat === undefined) saveConfigAtPath(config, fullPath);
          if (process.platform !== "win32") fs.chmodSync(fullPath, 0o600);
          selected ??= config;
        }
      }
    }
  }
  return selected;
}

export function saveConfigFile(config: BridgeConfig, directory = process.cwd()): void {
  saveConfigAtPath(config, path.join(directory, CONFIG_FILES[0]));
}

function saveConfigAtPath(config: BridgeConfig, fullPath: string): void {
  const validationError = validateBridgeConfig(config);
  if (validationError) throw new Error(validationError);
  if (!config.key) throw new Error("A Bridge installation key is required");
  let oldReference: string | undefined;
  try {
    const previous: unknown = JSON.parse(fs.readFileSync(fullPath, "utf8"));
    if (previous && typeof previous === "object" && "credentialReference" in previous && typeof previous.credentialReference === "string") oldReference = previous.credentialReference;
  } catch { /* A new or malformed config has no credential to retire. */ }
  const credentialReference = randomUUID();
  writeCredential(credentialReference, JSON.stringify({ key: config.key, propresenterPassword: config.propresenterPassword }));
  const { key: _key, propresenterPassword: _password, ...publicConfig } = config;
  if (publicConfig.url) publicConfig.url = credentialFreeUrl(publicConfig.url).toString();
  const temporaryPath = `${fullPath}.${process.pid}.${randomUUID()}.tmp`;
  let committed = false;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify({ ...publicConfig, credentialReference, credentialFormat: CREDENTIAL_FORMAT }, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(temporaryPath, fullPath);
    committed = true;
    if (process.platform !== "win32") fs.chmodSync(fullPath, 0o600);
    if (oldReference) deleteCredential(oldReference);
  } finally {
    if (!committed) deleteCredential(credentialReference);
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
}

export function publicBridgeConfig(config: BridgeConfig | null) {
  if (!config) return null;
  const { key: _key, propresenterPassword: _password, ...visible } = config;
  if (visible.url) visible.url = credentialFreeUrl(visible.url).toString();
  return visible;
}

export function isTrustedSetupOrigin(origin: string | undefined, port: number): boolean {
  return origin === `http://localhost:${port}` || origin === `http://127.0.0.1:${port}`;
}

function toBridgeUrl(siteUrl: string, org: string): string {
  const url = credentialFreeUrl(siteUrl.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:"));
  // Accept either a slug or a path-like value from setup fields. A leading
  // slash otherwise creates `/api/bridge//org/ws`, which Cloudflare rejects
  // before the BridgeRelay can authenticate the socket.
  const normalizedOrg = org.trim().replace(/^\/+|\/+$/g, "");
  url.pathname = `/api/bridge/${normalizedOrg}/ws`;
  url.searchParams.delete("role");
  url.searchParams.delete("key");
  return url.toString();
}

export async function resolveBridgeUrl(site: string, org: string): Promise<string> {
  const normalized = site.startsWith("http://") || site.startsWith("https://") ? site : `https://${site}`;

  try {
    const response = await fetch(normalized, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(3000),
    });
    if (response.url) {
      return toBridgeUrl(response.url, org);
    }
  } catch {
    // Fall back to the site URL directly if we can't resolve redirects.
  }

  return toBridgeUrl(normalized, org);
}

export function startSetupServer(
  port: number,
  getState: () => SetupState,
  onSave: (config: BridgeConfig) => Promise<void> | void
): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "POST" && url.pathname === "/save") {
      if (!isTrustedSetupOrigin(req.headers.origin, port)) {
        res.writeHead(403, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
        res.end("Open the local Bridge setup page before saving settings");
        return;
      }
      const body = await readBody(req);
      const form = new URLSearchParams(body);
      const config: BridgeConfig = {
        site: (form.get("site") || "").trim(),
        org: (form.get("org") || "").trim().replace(/^\/+|\/+$/g, ""),
        key: (form.get("key") || "").trim() || undefined,
        propresenterHost: (form.get("propresenterHost") || "").trim() || undefined,
        propresenterPassword: (form.get("propresenterPassword") || "").trim() || undefined,
      };
      const saved = getState().config;
      if (!config.key && saved?.site.replace(/\/+$/, "") === config.site.replace(/\/+$/, "") && saved.org === config.org) {
        config.key = saved.key;
      }
      if (!config.propresenterPassword && saved?.site === config.site && saved.org === config.org && saved.propresenterHost === config.propresenterHost) {
        config.propresenterPassword = saved.propresenterPassword;
      }

      const propresenterPort = Number.parseInt((form.get("propresenterPort") || "").trim(), 10);
      if (Number.isInteger(propresenterPort) && propresenterPort > 0 && propresenterPort <= 65_535) {
        config.propresenterPort = propresenterPort;
      }

      const propresenterApiPort = Number.parseInt((form.get("propresenterApiPort") || "").trim(), 10);
      if (Number.isInteger(propresenterApiPort) && propresenterApiPort > 0 && propresenterApiPort <= 65_535) {
        config.propresenterApiPort = propresenterApiPort;
      }

      const validationError = validateBridgeConfig(config);
      if (validationError) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end(validationError);
        return;
      }

      try {
        config.url = await resolveBridgeUrl(config.site, config.org);
        saveConfigFile(config);
        await onSave(config);
      } catch {
        res.writeHead(503, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
        res.end("Could not save or start the Bridge. Unlock your system keychain and try again.");
        return;
      }
      res.writeHead(303, { Location: "/?saved=1" });
      res.end();
      return;
    }

    if (req.method === "GET" && url.pathname === "/status") {
      const state = getState();
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ ...state, config: publicBridgeConfig(state.config) }));
      return;
    }

    const state = getState();
    const config = publicBridgeConfig(state.config);
    const message = url.searchParams.get("saved")
      ? "Saved. The bridge is restarting with your settings."
      : state.bridgeRunning
        ? "Bridge is running. You can edit settings below if needed."
        : "Enter your ShowPilot site and org to start.";

    const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ShowPilot Bridge</title>
    <style>
      body{margin:0;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial;background:#0b0b0b;color:#f3f4f6}
      .wrap{max-width:760px;margin:0 auto;padding:32px 20px 48px}
      .card{background:#121212;border:1px solid #262626;border-radius:16px;padding:20px;margin-top:18px}
      h1{margin:0 0 8px;font-size:28px}
      p{color:#b4b4b4;line-height:1.5}
      label{display:block;margin:14px 0 6px;font-size:13px;color:#d1d5db}
      input{width:100%;box-sizing:border-box;background:#0f0f0f;border:1px solid #2c2c2c;color:#fff;border-radius:12px;padding:12px 14px;font-size:15px}
      button{margin-top:18px;background:#ef4444;border:0;color:#fff;border-radius:12px;padding:12px 16px;font-weight:700;font-size:15px;cursor:pointer}
      button:hover{background:#dc2626}
      .status{display:inline-block;padding:6px 10px;border-radius:999px;background:#1f2937;color:#d1d5db;font-size:12px;margin-bottom:10px}
      .grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
      .muted{color:#9ca3af;font-size:13px}
      .success{color:#86efac}
      @media (max-width:640px){.grid{grid-template-columns:1fr}}
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="status">${state.bridgeRunning ? "Connected" : "Waiting"}</div>
      <h1>ShowPilot Bridge</h1>
      <p>${message}</p>
      <div class="card">
        <form method="post" action="/save">
          <div class="grid">
            <div>
              <label for="site">ShowPilot site</label>
              <input id="site" name="site" placeholder="https://showpilot.tech" value="${escapeHtml(config?.site ?? "")}" />
            </div>
            <div>
              <label for="org">Org slug</label>
              <input id="org" name="org" placeholder="faithfire-production" value="${escapeHtml(config?.org ?? "")}" />
            </div>
          </div>
          <label for="key">API key</label>
          <input id="key" name="key" type="password" autocomplete="off" placeholder="${config ? "Leave blank to keep the saved key" : "sp_..."}" />
          <div class="muted" style="margin-top:18px">ProPresenter</div>
          <p class="muted">Optional. If set, the bridge connects to ProPresenter automatically.</p>
          <label for="propresenterHost">ProPresenter host</label>
          <input id="propresenterHost" name="propresenterHost" placeholder="192.168.2.48" value="${escapeHtml(config?.propresenterHost ?? "")}" />
          <div class="grid">
            <div>
              <label for="propresenterPort">Stage port</label>
              <input id="propresenterPort" name="propresenterPort" placeholder="50001" value="${escapeHtml(config?.propresenterPort ? String(config.propresenterPort) : "")}" />
            </div>
            <div>
              <label for="propresenterApiPort">API port</label>
              <input id="propresenterApiPort" name="propresenterApiPort" placeholder="1025" value="${escapeHtml(config?.propresenterApiPort ? String(config.propresenterApiPort) : "")}" />
            </div>
          </div>
          <label for="propresenterPassword">Stage app password</label>
          <input id="propresenterPassword" name="propresenterPassword" type="password" autocomplete="off" placeholder="Leave blank to keep the saved password" />
          <button type="submit">Start Bridge</button>
        </form>
      </div>
      <div class="card">
        <div class="muted">Current bridge URL</div>
        <div style="word-break:break-all;margin-top:6px">${escapeHtml(config?.url ?? "not configured")}</div>
      </div>
    </div>
  </body>
</html>`;

    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    });
    res.end(html);
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`[UI] Bridge dashboard at http://localhost:${port}`);
  });

  return server;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
