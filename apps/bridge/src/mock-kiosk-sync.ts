#!/usr/bin/env node

import http from "node:http";
import WebSocket from "ws";

type PPSlide = {
  text: string;
  notes: string;
  presentationName: string;
  isScripture: boolean;
  updatedAt: number;
} | null;

const appUrl = process.env.MOCK_APP_URL || "http://127.0.0.1:3000";
const orgSlug = process.env.MOCK_ORG_SLUG || "test-peeps";
const apiKey = process.env.MOCK_API_KEY || "mock-key";
const controlPort = Number.parseInt(process.env.MOCK_KIOSK_SYNC_PORT || "9460", 10);
const clearDelayMs = 700;

let enabled = false;
let currentPreview: PPSlide = null;
let clearTimer: ReturnType<typeof setTimeout> | null = null;
let ws: WebSocket | null = null;

function protocolFor(baseUrl: string) {
  return baseUrl.startsWith("https://") ? "wss" : "ws";
}

async function sendKioskSlide(slide: PPSlide) {
  const response = await fetch(`${appUrl}/api/rundown/${orgSlug}/command`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-showpilot-api-key": apiKey,
    },
    body: JSON.stringify({
      action: "pp-slide",
      payload: { slide },
    }),
  });

  if (!response.ok) {
    throw new Error(`Relay command failed: ${response.status}`);
  }
}

function clearPendingTimer() {
  if (clearTimer) {
    clearTimeout(clearTimer);
    clearTimer = null;
  }
}

async function applyPreview(preview: PPSlide) {
  currentPreview = preview;
  clearPendingTimer();

  if (!enabled) {
    return;
  }

  if (preview?.text) {
    await sendKioskSlide(preview);
    return;
  }

  clearTimer = setTimeout(() => {
    void sendKioskSlide(null).catch((err) => {
      console.error("[mock-kiosk-sync] delayed clear failed:", err);
    });
    clearTimer = null;
  }, clearDelayMs);
}

async function setEnabled(next: boolean) {
  enabled = next;
  clearPendingTimer();

  if (!enabled) {
    await sendKioskSlide(null);
    return;
  }

  if (currentPreview?.text) {
    await sendKioskSlide(currentPreview);
  }
}

function connect() {
  const wsUrl = `${protocolFor(appUrl)}://${new URL(appUrl).host}/api/rundown/${orgSlug}/ws`;
  ws = new WebSocket(wsUrl);

  ws.on("open", () => {
    console.log(`[mock-kiosk-sync] connected to ${wsUrl}`);
  });

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString()) as {
        type: string;
        state?: { ppPreviewSlide?: PPSlide };
      };
      if ((msg.type === "hydrate" || msg.type === "state") && msg.state?.ppPreviewSlide !== undefined) {
        void applyPreview(msg.state.ppPreviewSlide);
      }
    } catch {
      // Ignore malformed payloads.
    }
  });

  ws.on("close", () => {
    console.log("[mock-kiosk-sync] relay disconnected; reconnecting in 1s");
    ws = null;
    setTimeout(connect, 1000);
  });

  ws.on("error", () => {
    // close handler will reconnect.
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${controlPort}`);
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  if (req.method === "GET" && url.pathname === "/status") {
    json(200, { enabled, currentPreview, clearDelayMs, orgSlug, appUrl });
    return;
  }

  if (req.method === "POST" && url.pathname === "/on") {
    try {
      await setEnabled(true);
      json(200, { ok: true, enabled: true });
    } catch (err) {
      json(500, { ok: false, error: String(err) });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/off") {
    try {
      await setEnabled(false);
      json(200, { ok: true, enabled: false });
    } catch (err) {
      json(500, { ok: false, error: String(err) });
    }
    return;
  }

  json(404, { error: "Not found" });
});

server.listen(controlPort, () => {
  console.log(`[mock-kiosk-sync] control on http://127.0.0.1:${controlPort}`);
  console.log(`[mock-kiosk-sync] POST /on  -> mirror preview to kiosk`);
  console.log(`[mock-kiosk-sync] POST /off -> force kiosk back to timer`);
});

connect();
