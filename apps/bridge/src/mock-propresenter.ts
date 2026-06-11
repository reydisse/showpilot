#!/usr/bin/env node

import http from "node:http";
import { WebSocketServer, type WebSocket } from "ws";

type Slide = {
  text: string;
  notes?: string;
  presentationName?: string;
  isScripture?: boolean;
};

const stagePort = Number.parseInt(process.env.MOCK_PP_STAGE_PORT || "50001", 10);
const apiPort = Number.parseInt(process.env.MOCK_PP_API_PORT || "1025", 10);

const slides: Slide[] = [
  {
    text: "Welcome to ShowPilot\nMock ProPresenter Slide 1",
    presentationName: "Mock Deck",
  },
  {
    text: "Song Verse 1\nYou are faithful through the ages",
    presentationName: "Mock Deck",
  },
  {
    text: "Hebrews 10:25\nDo not give up meeting together...",
    presentationName: "Scripture",
    isScripture: true,
  },
];

let currentIndex = 0;
let currentSlide: Slide | null = slides[0];
const stageClients = new Set<WebSocket>();

function getSlidePayload() {
  if (!currentSlide) return null;
  return {
    text: currentSlide.text,
    notes: currentSlide.notes || "",
    presentation_name: currentSlide.presentationName || "",
    current_index: currentIndex,
    scripture: Boolean(currentSlide.isScripture),
  };
}

function broadcastCurrentSlide() {
  const payload = currentSlide
    ? JSON.stringify({
        acn: "sd",
        text: currentSlide.text,
        notes: currentSlide.notes || "",
        pn: currentSlide.presentationName || "",
        scripture: Boolean(currentSlide.isScripture),
      })
    : JSON.stringify({ acn: "sd" });

  for (const ws of stageClients) {
    if (ws.readyState === ws.OPEN) {
      ws.send(payload);
    }
  }
}

function setSlide(index: number) {
  currentIndex = Math.max(0, Math.min(index, slides.length - 1));
  currentSlide = slides[currentIndex] ?? null;
  broadcastCurrentSlide();
}

function clearSlide() {
  currentSlide = null;
  broadcastCurrentSlide();
}

async function glitchNext() {
  clearSlide();
  await new Promise((resolve) => setTimeout(resolve, 150));
  setSlide((currentIndex + 1) % slides.length);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const apiServer = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || `127.0.0.1:${apiPort}`}`);
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  if (req.method === "GET" && url.pathname === "/v1/stage/current_slide") {
    json(200, getSlidePayload() || {});
    return;
  }

  if (req.method === "GET" && url.pathname === "/v1/status/slide") {
    json(200, { current_slide_text: currentSlide?.text || "" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/v1/presentation/active") {
    json(200, getSlidePayload() || {});
    return;
  }

  if (req.method === "GET" && url.pathname === "/v1/presentation/slide_index") {
    json(200, { current_index: currentSlide ? currentIndex : -1 });
    return;
  }

  if (req.method === "GET" && url.pathname === "/v1/trigger/next") {
    setSlide((currentIndex + 1) % slides.length);
    json(200, { ok: true, currentIndex });
    return;
  }

  if (req.method === "GET" && url.pathname === "/v1/trigger/previous") {
    setSlide((currentIndex - 1 + slides.length) % slides.length);
    json(200, { ok: true, currentIndex });
    return;
  }

  if (
    (req.method === "GET" || req.method === "DELETE") &&
    (url.pathname === "/v1/clear/layer/slide" || url.pathname === "/v1/clear/slide" || url.pathname === "/v1/clear/all")
  ) {
    clearSlide();
    json(200, { ok: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/mock/state") {
    json(200, {
      currentIndex,
      currentSlide,
      slideCount: slides.length,
      stagePort,
      apiPort,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/mock/slide") {
    const body = JSON.parse((await readBody(req)) || "{}") as Partial<Slide>;
    currentSlide = {
      text: body.text || "Custom Mock Slide",
      notes: body.notes || "",
      presentationName: body.presentationName || "Custom",
      isScripture: Boolean(body.isScripture),
    };
    broadcastCurrentSlide();
    json(200, { ok: true, currentSlide });
    return;
  }

  if (req.method === "POST" && url.pathname === "/mock/clear") {
    clearSlide();
    json(200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/mock/glitch-next") {
    await glitchNext();
    json(200, { ok: true, currentIndex, currentSlide });
    return;
  }

  json(404, { error: "Not found" });
});

const stageServer = http.createServer();
const wss = new WebSocketServer({ server: stageServer, path: "/stagedisplay" });

wss.on("connection", (ws) => {
  stageClients.add(ws);

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (msg.acn === "ath") {
        ws.send(JSON.stringify({ acn: "ath", ath: true }));
        if (currentSlide) {
          ws.send(
            JSON.stringify({
              acn: "sd",
              text: currentSlide.text,
              notes: currentSlide.notes || "",
              pn: currentSlide.presentationName || "",
              scripture: Boolean(currentSlide.isScripture),
            }),
          );
        }
      }
    } catch {
      // Ignore non-JSON messages.
    }
  });

  ws.on("close", () => {
    stageClients.delete(ws);
  });
});

apiServer.listen(apiPort, () => {
  console.log(`[mock-pp] REST API on http://127.0.0.1:${apiPort}`);
});

stageServer.listen(stagePort, () => {
  console.log(`[mock-pp] Stage WebSocket on ws://127.0.0.1:${stagePort}/stagedisplay`);
  console.log(`[mock-pp] Control endpoints:`);
  console.log(`  GET  /v1/trigger/next`);
  console.log(`  GET  /v1/trigger/previous`);
  console.log(`  POST /mock/clear`);
  console.log(`  POST /mock/glitch-next`);
});
