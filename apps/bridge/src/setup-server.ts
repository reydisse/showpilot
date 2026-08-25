import fs from "fs";
import http from "http";
import path from "path";
import { randomUUID } from "crypto";

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
  for (const file of CONFIG_FILES) {
    const fullPath = path.join(directory, file);
    if (!fs.existsSync(fullPath)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(fullPath, "utf8")) as Partial<BridgeConfig>;
      if (parsed.site && parsed.org) {
        const config = {
          site: parsed.site,
          org: parsed.org,
          key: parsed.key,
          url: parsed.url,
          propresenterHost: parsed.propresenterHost,
          propresenterPort: parsed.propresenterPort,
          propresenterPassword: parsed.propresenterPassword,
          propresenterApiPort: parsed.propresenterApiPort,
        };
        if (!validateBridgeConfig(config)) {
          if (process.platform !== "win32") fs.chmodSync(fullPath, 0o600);
          return config;
        }
      }
    } catch {
      // Ignore malformed config and fall through to setup UI
    }
  }

  return null;
}

export function saveConfigFile(config: BridgeConfig, directory = process.cwd()): void {
  const validationError = validateBridgeConfig(config);
  if (validationError) throw new Error(validationError);

  const fullPath = path.join(directory, CONFIG_FILES[0]);
  const temporaryPath = `${fullPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(temporaryPath, fullPath);
    if (process.platform !== "win32") fs.chmodSync(fullPath, 0o600);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
}

export function isTrustedSetupOrigin(origin: string | undefined, port: number): boolean {
  return origin === `http://localhost:${port}` || origin === `http://127.0.0.1:${port}`;
}

function toBridgeUrl(siteUrl: string, org: string): string {
  const url = new URL(siteUrl.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:"));
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

      config.url = await resolveBridgeUrl(config.site, config.org);
      saveConfigFile(config);
      await onSave(config);
      res.writeHead(303, { Location: "/?saved=1" });
      res.end();
      return;
    }

    if (req.method === "GET" && url.pathname === "/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(getState()));
      return;
    }

    const state = getState();
    const config = state.config;
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
          <input id="key" name="key" type="password" autocomplete="off" placeholder="sp_..." value="${escapeHtml(config?.key ?? "")}" />
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
          <input id="propresenterPassword" name="propresenterPassword" type="password" autocomplete="off" placeholder="Password from PP" value="${escapeHtml(config?.propresenterPassword ?? "")}" />
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
