#!/usr/bin/env node

import { Bridge } from "./bridge.js";

const args = process.argv.slice(2);

function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

const url = getArg("url") ?? process.env.SHOWPILOT_BRIDGE_URL;
const key = getArg("key") ?? process.env.SHOWPILOT_BRIDGE_KEY;

if (!url) {
  console.error(`
  ShowPilot Bridge — Local Device Proxy Agent

  Usage:
    showpilot-bridge --url <ws-url> [--key <api-key>]

  Example:
    showpilot-bridge --url wss://showpilot.tech/api/bridge/my-org-id/ws --key abc123

  Environment variables:
    SHOWPILOT_BRIDGE_URL   WebSocket URL to connect to
    SHOWPILOT_BRIDGE_KEY   API key for authentication
  `);
  process.exit(1);
}

console.log(`
  ┌─────────────────────────────────┐
  │   ShowPilot Bridge v0.1.0       │
  │   Local Device Proxy Agent      │
  └─────────────────────────────────┘
`);

const bridge = new Bridge({ url, key, reconnect: true });

process.on("SIGINT", () => {
  console.log("\n[bridge] Shutting down...");
  bridge.stop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  bridge.stop();
  process.exit(0);
});

bridge.start();
