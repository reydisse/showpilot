import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import * as React from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as rundownState from "../../../../mobile/src/lib/rundown-state.ts";

const sockets = [];
class Socket {
  readyState = 0;
  sent = [];
  send(value) {
    this.sent.push(JSON.parse(value));
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  message(value) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
}
const appState = {
  currentState: "active",
  addEventListener: () => ({ remove() {} }),
};
const authenticate = vi.fn(async () => {
  const socket = new Socket();
  sockets.push(socket);
  return socket;
});
const modules = {
  react: React,
  "react-native": { AppState: appState },
  "@/lib/auth-transport": { createAuthenticatedWebSocket: authenticate },
  "@/lib/env": { SHOWPILOT_URL: "https://native.test" },
  "@/lib/rundown-state": rundownState,
};
const code = ts.transpileModule(
  readFileSync(
    resolve(process.cwd(), "../mobile/src/hooks/use-rundown-relay.ts"),
    "utf8",
  ),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  },
).outputText;
const exported = {};
new Function("require", "exports", code)((name) => {
  if (!(name in modules)) throw new Error(`Missing native module ${name}`);
  return modules[name];
}, exported);
const { useRundownRelay } = exported;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  vi.stubGlobal("WebSocket", { OPEN: 1, CONNECTING: 0 });
  sockets.length = 0;
  authenticate.mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function hydrate(socket, revision = 3, clockOffset = 90_000) {
  socket.message({
    type: "hydrate",
    state: {
      initialized: true,
      showId: "show",
      serviceDate: "2026-11-08",
      revision,
      items: [],
      timer: {
        playback: "stop",
        currentItemId: null,
        elapsed: 0,
        startedAt: null,
        pausedAt: null,
        mode: "count-down",
        serverTime: Date.now() + clockOffset,
      },
    },
  });
}
async function fixture() {
  const view = renderHook(() => useRundownRelay("org", "2026-11-08", "show"));
  await act(async () => {});
  const socket = sockets[0];
  await act(async () => {
    socket.open();
    hydrate(socket);
  });
  return { ...view, socket };
}
it("sends a five-second transport expiry in the relay clock", async () => {
  const f = await fixture();
  await act(async () => f.result.current.sendCommand("timer-next"));
  expect(f.socket.sent[0]).toMatchObject({
    action: "timer-next",
    expectedRevision: 3,
    expiresAt: 1_095_000,
  });
});
it("marks disconnected state unhydrated immediately", async () => {
  const f = await fixture();
  await act(async () => f.socket.close());
  expect(f.result.current.hydrated).toBe(false);
  expect(f.result.current.status).not.toBe("connected");
});
it("does not erase a command rejection when the next state snapshot arrives", async () => {
  const f = await fixture();
  await act(async () => f.result.current.sendCommand("timer-next"));
  const id = f.socket.sent[0].id;
  await act(async () =>
    f.socket.message({
      type: "command-result",
      id,
      accepted: false,
      reason: "revision-conflict",
      revision: 4,
    }),
  );
  expect(f.result.current.lastError).toMatch(/review/i);
  await act(async () => hydrate(f.socket, 4));
  expect(f.result.current.lastError).toMatch(/review/i);
});
it("does not replay an old Next after reconnecting beyond its transport window", async () => {
  const f = await fixture();
  await act(async () => f.result.current.sendCommand("timer-next"));
  await act(async () => f.socket.close());
  await act(async () => vi.advanceTimersByTimeAsync(6000));
  const replacement = sockets.at(-1);
  expect(replacement).not.toBe(f.socket);
  await act(async () => {
    replacement.open();
    hydrate(replacement, 3);
  });
  expect(
    replacement.sent.filter((command) => command.action === "timer-next"),
  ).toEqual([]);
  expect(f.result.current.lastError).toMatch(/expired|not.*retried/i);
});

it("keeps the reviewed revision of a queued transport after an earlier command advances", async () => {
  const f = await fixture();
  await act(async () => {
    f.result.current.sendCommand("timer-next");
    f.result.current.sendCommand("timer-next");
  });
  const first = f.socket.sent[0];
  expect(f.result.current.unconfirmedCount).toBe(2);
  await act(async () => {
    hydrate(f.socket, 4);
    f.socket.message({
      type: "command-result",
      id: first.id,
      accepted: true,
      revision: 4,
    });
  });
  expect(f.socket.sent[1]).toMatchObject({
    action: "timer-next",
    expectedRevision: 3,
  });
  expect(f.result.current.unconfirmedCount).toBe(1);
});
it("blocks new transport while disconnected instead of queuing a late action", async () => {
  const f = await fixture();
  await act(async () => f.socket.close());
  let result;
  await act(async () => {
    result = f.result.current.sendCommand("timer-start", { itemId: "cue" });
  });
  expect(result).toBe("blocked");
  expect(f.result.current.unconfirmedCount).toBe(0);
  expect(f.result.current.lastError).toMatch(/not sent/i);
});
it("retains a request when its acknowledgement is malformed", async () => {
  const f = await fixture();
  await act(async () => f.result.current.sendCommand("timer-next"));
  const first = f.socket.sent[0];
  await act(async () =>
    f.socket.message({ type: "command-result", id: first.id, revision: 4 }),
  );
  expect(f.result.current.unconfirmedCount).toBe(1);
  expect(f.result.current.lastError).toMatch(/unreadable/);
});
it("does not extend the original transport deadline after a new clock sample on reconnect", async () => {
  const f = await fixture();
  await act(async () => f.result.current.sendCommand("timer-next"));
  const first = f.socket.sent[0];
  await act(async () => f.socket.close());
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  const replacement = sockets.at(-1);
  await act(async () => {
    replacement.open();
    hydrate(replacement, 3, 120_000);
  });
  expect(replacement.sent[0]).toEqual(first);
});

it("marks a socket error unavailable before a delayed close event", async () => {
  const f = await fixture();
  f.socket.close = () => {
    f.socket.readyState = 2;
  };
  await act(async () => f.socket.onerror());
  expect(f.result.current.hydrated).toBe(false);
  expect(f.result.current.status).toBe("reconnecting");
});
it("an uncertain transport timeout is visible and cannot retry an expired action", async () => {
  const f = await fixture();
  await act(async () => f.result.current.sendCommand("timer-next"));
  await act(async () => vi.advanceTimersByTimeAsync(8001));
  expect(f.result.current.hydrated).toBe(false);
  expect(f.result.current.unconfirmedCount).toBe(0);
  expect(f.result.current.lastError).toMatch(/may have completed/);
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  const replacement = sockets.at(-1);
  await act(async () => {
    replacement.open();
    hydrate(replacement);
  });
  expect(replacement.sent).toEqual([]);
  expect(f.result.current.lastError).toMatch(/may have completed/);
  await act(async () => f.result.current.dismissCommandError());
  expect(f.result.current.lastError).toBeNull();
});
