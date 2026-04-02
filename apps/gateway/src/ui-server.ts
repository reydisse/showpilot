/**
 * Bridge Status & Config UI
 *
 * Minimal HTTP server for the local bridge config page.
 * Runs on the bridge machine (e.g., http://localhost:9450).
 * Serves status info and handles device configuration via REST API.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { BridgeConfig, DeviceConfig } from "./config.js";
import { getConfig, saveConfig } from "./config.js";
import type { CloudLinkStatus } from "./cloud-link.js";
import type { PPStatus } from "./devices/propresenter.js";

interface DeviceStatus {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  status: PPStatus;
  currentSlide?: string | null;
}

interface BridgeStatus {
  cloud: CloudLinkStatus;
  orgSlug: string;
  devices: DeviceStatus[];
  uptime: number;
}

type StatusGetter = () => BridgeStatus;
type DeviceAdder = (device: DeviceConfig) => void;
type DeviceRemover = (id: string) => void;
type DeviceToggler = (id: string, enabled: boolean) => void;
type Reconnecter = () => void;

interface UIServerDeps {
  getStatus: StatusGetter;
  addDevice: DeviceAdder;
  removeDevice: DeviceRemover;
  toggleDevice: DeviceToggler;
  reconnect: Reconnecter;
}

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

export function startUIServer(port: number, deps: UIServerDeps): void {
  const startTime = Date.now();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${port}`);

    // CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }

    // API Routes
    if (url.pathname === "/api/status" && req.method === "GET") {
      return json(res, deps.getStatus());
    }

    if (url.pathname === "/api/config" && req.method === "GET") {
      const config = getConfig();
      // Don't expose the API key
      return json(res, { ...config, apiKey: config.apiKey ? "***" : "" });
    }

    if (url.pathname === "/api/config" && req.method === "PUT") {
      try {
        const body = JSON.parse(await readBody(req));
        const current = getConfig();
        const updated: BridgeConfig = {
          cloudUrl: body.cloudUrl ?? current.cloudUrl,
          orgSlug: body.orgSlug ?? current.orgSlug,
          apiKey: body.apiKey === "***" ? current.apiKey : (body.apiKey ?? current.apiKey),
          uiPort: body.uiPort ?? current.uiPort,
          devices: current.devices, // devices managed separately
        };
        saveConfig(updated);
        deps.reconnect();
        return json(res, { ok: true });
      } catch {
        return json(res, { error: "Invalid config" }, 400);
      }
    }

    if (url.pathname === "/api/devices" && req.method === "POST") {
      try {
        const body = JSON.parse(await readBody(req)) as Partial<DeviceConfig>;
        const device: DeviceConfig = {
          id: body.id || crypto.randomUUID(),
          type: body.type || "propresenter",
          name: body.name || "ProPresenter",
          enabled: body.enabled ?? true,
          host: body.host || "127.0.0.1",
          port: body.port || 50001,
          password: body.password,
          apiPort: body.apiPort || 1025,
          allowControl: body.allowControl ?? false,
        };
        deps.addDevice(device);
        return json(res, { ok: true, device });
      } catch {
        return json(res, { error: "Invalid device" }, 400);
      }
    }

    if (url.pathname.startsWith("/api/devices/") && req.method === "DELETE") {
      const id = url.pathname.split("/api/devices/")[1];
      if (id) {
        deps.removeDevice(id);
        return json(res, { ok: true });
      }
      return json(res, { error: "Missing device id" }, 400);
    }

    if (url.pathname.startsWith("/api/devices/") && req.method === "PUT") {
      try {
        const id = url.pathname.split("/api/devices/")[1];
        const body = JSON.parse(await readBody(req));
        if (id && typeof body.enabled === "boolean") {
          deps.toggleDevice(id, body.enabled);
          return json(res, { ok: true });
        }
        return json(res, { error: "Invalid request" }, 400);
      } catch {
        return json(res, { error: "Invalid body" }, 400);
      }
    }

    if (url.pathname === "/api/reconnect" && req.method === "POST") {
      deps.reconnect();
      return json(res, { ok: true });
    }

    // Serve the UI page — read from disk every time, never cached
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const __dir = dirname(fileURLToPath(import.meta.url));
      const html = readFileSync(resolve(__dir, "dashboard.html"), "utf-8");
      res.writeHead(200, {
        "Content-Type": "text/html",
        "Cache-Control": "no-store, no-cache, must-revalidate",
        "Pragma": "no-cache",
        "Expires": "0",
      });
      res.end(html);
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  server.listen(port, () => {
    console.log(`[UI] Bridge dashboard at http://localhost:${port}`);
  });
}

// ─── Legacy inline HTML removed — now served from dashboard.html ──

const _UNUSED = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ShowPilot Bridge</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, 'Segoe UI', sans-serif; background: #0d0d0d; color: #e5e5e5; padding: 2rem; }
  h1 { font-size: 1.5rem; font-weight: 600; margin-bottom: 0.25rem; }
  .subtitle { color: #888; font-size: 0.85rem; margin-bottom: 2rem; }
  .card { background: #1a1a1a; border: 1px solid #333; border-radius: 0.75rem; padding: 1.25rem; margin-bottom: 1rem; }
  .card h2 { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.08em; color: #888; margin-bottom: 0.75rem; }
  .status-row { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.5rem; }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .dot.connected { background: #22c55e; }
  .dot.connecting { background: #f59e0b; animation: pulse 1s infinite; }
  .dot.disconnected { background: #666; }
  .dot.error { background: #ef4444; }
  .label { font-size: 0.9rem; }
  .value { color: #888; font-size: 0.8rem; margin-left: auto; }
  .device-list { display: flex; flex-direction: column; gap: 0.75rem; }
  .device { display: flex; align-items: center; gap: 0.75rem; padding: 0.75rem; background: #222; border-radius: 0.5rem; }
  .device .name { font-weight: 500; }
  .device .meta { color: #888; font-size: 0.8rem; }
  .device .slide { color: #f59e0b; font-size: 0.75rem; margin-top: 0.25rem; max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  button { padding: 0.5rem 1rem; border-radius: 0.5rem; border: 1px solid #444; background: #222; color: #e5e5e5; cursor: pointer; font-size: 0.8rem; }
  button:hover { background: #333; }
  button.primary { background: #f59e0b; color: #000; border-color: #f59e0b; }
  button.danger { background: #7f1d1d; border-color: #991b1b; }
  .form-row { display: flex; gap: 0.5rem; margin-bottom: 0.5rem; align-items: center; }
  .form-row label { font-size: 0.8rem; color: #888; min-width: 80px; }
  input, select { padding: 0.4rem 0.6rem; border-radius: 0.375rem; border: 1px solid #444; background: #111; color: #e5e5e5; font-size: 0.85rem; flex: 1; }
  .actions { display: flex; gap: 0.5rem; margin-top: 1rem; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
  .empty { color: #555; font-size: 0.85rem; text-align: center; padding: 1rem; }
</style>
</head>
<body>
<h1>ShowPilot Bridge</h1>
<p class="subtitle">Local device gateway — connects your production hardware to ShowPilot cloud</p>

<!-- All forms are static HTML — JS never replaces them -->
<div class="card">
  <h2>Cloud Connection</h2>
  <div class="status-row">
    <span class="dot disconnected" id="cloudDot"></span>
    <span class="label" id="cloudLabel">disconnected</span>
    <span class="value" id="cloudOrg">Not configured</span>
  </div>
  <div class="form-row"><label>Cloud URL</label><input id="cloudUrl" value="" placeholder="https://showpilot.tech" /></div>
  <div class="form-row"><label>Org Slug</label><input id="orgSlug" value="" placeholder="faithfire-production" /></div>
  <div class="form-row"><label>API Key</label><input id="apiKey" value="" type="password" placeholder="(optional)" /></div>
  <div class="actions">
    <button class="primary" onclick="saveCloud()">Save &amp; Reconnect</button>
    <span id="saveMsg" style="font-size:0.8rem;color:#22c55e;display:none">Saved!</span>
  </div>
</div>

<div class="card">
  <h2>Devices</h2>
  <div class="device-list" id="deviceList">
    <div class="empty">No devices configured. Add a ProPresenter connection below.</div>
  </div>
</div>

<div class="card">
  <h2>Add Device</h2>
  <div class="form-row"><label>Name</label><input id="devName" value="ProPresenter" /></div>
  <div class="form-row"><label>Type</label><select id="devType"><option value="propresenter">ProPresenter</option></select></div>
  <div class="form-row"><label>Host</label><input id="devHost" value="127.0.0.1" placeholder="IP address" /></div>
  <div class="form-row"><label>WS Port</label><input id="devPort" value="50001" type="number" /></div>
  <div class="form-row"><label>API Port</label><input id="devApiPort" value="1025" type="number" /></div>
  <div class="form-row"><label>Password</label><input id="devPassword" type="password" placeholder="Stage display password" /></div>
  <div class="form-row" style="margin-top:0.5rem">
    <label></label>
    <label style="display:flex;align-items:center;gap:0.5rem;min-width:0;flex:1;cursor:pointer">
      <input type="checkbox" id="devAllowControl" /> Allow sending cues to this device
    </label>
  </div>
  <div class="actions">
    <button class="primary" onclick="addDevice()">Add Device</button>
  </div>
</div>

<div class="card" style="opacity:0.6">
  <h2>Uptime</h2>
  <p style="font-size:0.85rem;color:#888" id="uptimeLabel">0 minutes</p>
</div>

<script>
// Load saved config into form fields ONCE on page load
fetch('/api/config').then(r => r.json()).then(config => {
  document.getElementById('cloudUrl').value = config.cloudUrl || '';
  document.getElementById('orgSlug').value = config.orgSlug || '';
  document.getElementById('apiKey').value = config.apiKey || '';
});

// Poll status only — NEVER touches form inputs
function pollStatus() {
  fetch('/api/status').then(r => r.json()).then(s => {
    document.getElementById('cloudDot').className = 'dot ' + s.cloud;
    document.getElementById('cloudLabel').textContent = s.cloud;
    document.getElementById('cloudOrg').textContent = s.orgSlug || 'Not configured';
    document.getElementById('uptimeLabel').textContent = Math.floor(s.uptime / 60000) + ' minutes';

    var dl = document.getElementById('deviceList');
    if (s.devices.length === 0) {
      dl.innerHTML = '<div class="empty">No devices configured. Add a ProPresenter connection below.</div>';
    } else {
      dl.innerHTML = s.devices.map(function(d) {
        return '<div class="device">'
          + '<span class="dot ' + d.status + '"></span>'
          + '<div><div class="name">' + d.name + '</div>'
          + '<div class="meta">' + d.type + ' — ' + (d.enabled ? 'Enabled' : 'Disabled') + '</div>'
          + (d.currentSlide ? '<div class="slide">' + d.currentSlide + '</div>' : '')
          + '</div>'
          + '<div style="margin-left:auto;display:flex;gap:0.5rem;">'
          + '<button onclick="toggleDevice(\\'' + d.id + '\\',' + !d.enabled + ')">' + (d.enabled ? 'Disable' : 'Enable') + '</button>'
          + '<button class="danger" onclick="removeDevice(\\'' + d.id + '\\')">Remove</button>'
          + '</div></div>';
      }).join('');
    }
  }).catch(function() {});
}

function saveCloud() {
  fetch('/api/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cloudUrl: document.getElementById('cloudUrl').value,
      orgSlug: document.getElementById('orgSlug').value,
      apiKey: document.getElementById('apiKey').value,
    }),
  }).then(function() {
    var msg = document.getElementById('saveMsg');
    msg.style.display = 'inline';
    setTimeout(function() { msg.style.display = 'none'; }, 2000);
    pollStatus();
  });
}

function addDevice() {
  fetch('/api/devices', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: document.getElementById('devName').value,
      type: document.getElementById('devType').value,
      host: document.getElementById('devHost').value,
      port: parseInt(document.getElementById('devPort').value),
      apiPort: parseInt(document.getElementById('devApiPort').value),
      password: document.getElementById('devPassword').value,
      allowControl: document.getElementById('devAllowControl').checked,
    }),
  }).then(function() { pollStatus(); });
}

function removeDevice(id) {
  if (!confirm('Remove this device?')) return;
  fetch('/api/devices/' + id, { method: 'DELETE' }).then(function() { pollStatus(); });
}

function toggleDevice(id, enabled) {
  fetch('/api/devices/' + id, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: enabled }),
  }).then(function() { pollStatus(); });
}

pollStatus();
</script>
</body>
</html>`;
