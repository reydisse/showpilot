import fs from "fs";
import http from "http";
import path from "path";

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
}

const CONFIG_FILES = ["showpilot-bridge.config.json", "bridge.config.json"];

export function loadConfigFile(): BridgeConfig | null {
  for (const file of CONFIG_FILES) {
    const fullPath = path.join(process.cwd(), file);
    if (!fs.existsSync(fullPath)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(fullPath, "utf8")) as Partial<BridgeConfig>;
      if (parsed.site && parsed.org) {
        return {
          site: parsed.site,
          org: parsed.org,
          key: parsed.key,
          url: parsed.url,
          propresenterHost: parsed.propresenterHost,
          propresenterPort: parsed.propresenterPort,
          propresenterPassword: parsed.propresenterPassword,
          propresenterApiPort: parsed.propresenterApiPort,
        };
      }
    } catch {
      // Ignore malformed config and fall through to setup UI
    }
  }

  return null;
}

export function saveConfigFile(config: BridgeConfig): void {
  const fullPath = path.join(process.cwd(), CONFIG_FILES[0]);
  fs.writeFileSync(fullPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export function buildBridgeUrl(site: string, org: string): string {
  const normalized = site.startsWith("http://") || site.startsWith("https://") ? site : `https://${site}`;
  const url = new URL(normalized.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:"));
  url.pathname = `/api/bridge/${org}/ws`;
  url.searchParams.delete("role");
  url.searchParams.delete("key");
  return url.toString();
}

export function startSetupServer(
  port: number,
  getState: () => SetupState,
  onSave: (config: BridgeConfig) => Promise<void> | void
): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "POST" && url.pathname === "/save") {
      const body = await readBody(req);
      const form = new URLSearchParams(body);
      const config: BridgeConfig = {
        site: (form.get("site") || "").trim(),
        org: (form.get("org") || "").trim(),
        key: (form.get("key") || "").trim() || undefined,
        propresenterHost: (form.get("propresenterHost") || "").trim() || undefined,
        propresenterPassword: (form.get("propresenterPassword") || "").trim() || undefined,
      };

      const propresenterPort = Number.parseInt((form.get("propresenterPort") || "").trim(), 10);
      if (Number.isFinite(propresenterPort) && propresenterPort > 0) {
        config.propresenterPort = propresenterPort;
      }

      const propresenterApiPort = Number.parseInt((form.get("propresenterApiPort") || "").trim(), 10);
      if (Number.isFinite(propresenterApiPort) && propresenterApiPort > 0) {
        config.propresenterApiPort = propresenterApiPort;
      }

      if (!config.site || !config.org) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Site and org are required");
        return;
      }

      config.url = buildBridgeUrl(config.site, config.org);
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
          <input id="key" name="key" placeholder="sp_..." value="${escapeHtml(config?.key ?? "")}" />
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
          <input id="propresenterPassword" name="propresenterPassword" placeholder="Password from PP" value="${escapeHtml(config?.propresenterPassword ?? "")}" />
          <button type="submit">Start Bridge</button>
        </form>
      </div>
      <div class="card">
        <div class="muted">Current bridge URL</div>
        <div style="word-break:break-all;margin-top:6px">${escapeHtml(config?.url ?? (config ? buildBridgeUrl(config.site, config.org) : "not configured"))}</div>
      </div>
    </div>
  </body>
</html>`;

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
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
