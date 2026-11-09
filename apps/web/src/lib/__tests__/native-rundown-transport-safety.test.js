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
  listener: null,
  addEventListener: (_event, listener) => {
    appState.listener = listener;
    return { remove() { appState.listener = null; } };
  },
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
  appState.currentState = "active";
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


it("bounds stalled authentication and closes a late socket without replacing the new connection", async () => {
  let finish;
  authenticate.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const f = renderHook(() => useRundownRelay("org", "2026-11-08", "show"));
  await act(async () => vi.advanceTimersByTimeAsync(12001));
  expect(f.result.current.lastError).toMatch(/timed out/i);
  expect(f.result.current.hydrated).toBe(false);
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(authenticate).toHaveBeenCalledTimes(2);
  const current = sockets.at(-1);
  await act(async () => { current.open(); hydrate(current); });
  const late = new Socket();
  await act(async () => finish(late));
  expect(late.readyState).toBe(3);
  expect(f.result.current.status).toBe("connected");
});
it("bounds a socket that never opens", async () => {
  const f = renderHook(() => useRundownRelay("org", "2026-11-08", "show"));
  await act(async () => {});
  const socket = sockets[0];
  await act(async () => vi.advanceTimersByTimeAsync(12001));
  expect(socket.readyState).toBe(3);
  expect(f.result.current.lastError).toMatch(/timed out/i);
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(authenticate).toHaveBeenCalledTimes(2);
});
it("requires hydration before connected and bounds an open but silent socket", async () => {
  const f = renderHook(() => useRundownRelay("org", "2026-11-08", "show"));
  await act(async () => {});
  const socket = sockets[0];
  await act(async () => socket.open());
  expect(f.result.current.status).toBe("connecting");
  await act(async () => vi.advanceTimersByTimeAsync(12001));
  expect(f.result.current.hydrated).toBe(false);
  expect(f.result.current.lastError).toMatch(/timed out/i);
  expect(socket.readyState).toBe(3);
});
it("does not let a wrong-show snapshot satisfy the hydration deadline", async () => {
  const f = renderHook(() => useRundownRelay("org", "2026-11-08", "show"));
  await act(async () => {});
  const socket = sockets[0];
  await act(async () => {
    socket.open();
    socket.message({ type: "hydrate", state: { showId: "other", serviceDate: "2026-11-08", revision: 1, items: [], timer: {} } });
  });
  await act(async () => vi.advanceTimersByTimeAsync(12001));
  expect(f.result.current.hydrated).toBe(false);
  expect(socket.readyState).toBe(3);
});
it("does not mark malformed hydration live", async () => {
  const f = renderHook(() => useRundownRelay("org", "2026-11-08", "show"));
  await act(async () => {});
  await act(async () => { sockets[0].open(); sockets[0].message({ type: "hydrate", state: {} }); });
  expect(f.result.current.hydrated).toBe(false);
  expect(f.result.current.lastError).toMatch(/unreadable/i);
});
it("reconnects after an error even if the platform never dispatches close", async () => {
  const f = await fixture();
  f.socket.close = () => { f.socket.readyState = 2; };
  await act(async () => f.socket.onerror());
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(authenticate).toHaveBeenCalledTimes(2);
  expect(f.result.current.hydrated).toBe(false);
});
it("invalidates hydration as soon as the app backgrounds and reconnects on resume", async () => {
  const f = await fixture();
  f.socket.close = () => { f.socket.readyState = 2; };
  await act(async () => { appState.currentState = "background"; appState.listener("background"); });
  expect(f.result.current.hydrated).toBe(false);
  expect(f.result.current.status).toBe("offline");
  await act(async () => { appState.currentState = "active"; appState.listener("active"); });
  expect(authenticate).toHaveBeenCalledTimes(2);
});
it("clears a completed handshake deadline without dropping a healthy connection", async () => {
  const f = await fixture();
  await act(async () => vi.advanceTimersByTimeAsync(13000));
  expect(f.result.current.hydrated).toBe(true);
  expect(f.result.current.status).toBe("connected");
  expect(f.socket.readyState).toBe(1);
});


it("manual retry replaces a stalled handshake without waiting for its deadline", async () => {
  const f = renderHook(() => useRundownRelay("org", "2026-11-08", "show"));
  await act(async () => {});
  const first = sockets[0];
  await act(async () => f.result.current.retryConnection());
  expect(first.readyState).toBe(3);
  expect(authenticate).toHaveBeenCalledTimes(2);
  await act(async () => { sockets[1].open(); hydrate(sockets[1]); });
  expect(f.result.current.hydrated).toBe(true);
});
it("ignores a retired socket's late state after manual retry", async () => {
  const f = await fixture();
  await act(async () => f.result.current.retryConnection());
  await act(async () => { sockets[1].open(); hydrate(sockets[1], 9); });
  await act(async () => hydrate(f.socket, 100));
  expect(f.result.current.revision).toBe(9);
});
it("closes late authentication after unmount and clears the attempt deadline", async () => {
  let finish;
  authenticate.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const f = renderHook(() => useRundownRelay("org", "2026-11-08", "show"));
  await act(async () => {});
  f.unmount();
  const late = new Socket();
  await act(async () => finish(late));
  expect(late.readyState).toBe(3);
  await act(async () => vi.advanceTimersByTimeAsync(60000));
  expect(authenticate).toHaveBeenCalledTimes(1);
});


it("detects an open socket that stops replying after hydration", async () => {
  const f = await fixture();
  await act(async () => vi.advanceTimersByTimeAsync(20000));
  const ping = f.socket.sent.at(-1);
  expect(ping).toMatchObject({ type: "ping", id: expect.any(String) });
  await act(async () => vi.advanceTimersByTimeAsync(8001));
  expect(f.result.current.hydrated).toBe(false);
  expect(f.result.current.lastError).toMatch(/stopped responding/i);
  expect(f.socket.readyState).toBe(3);
});
it("accepts only the current heartbeat and cannot reuse an old reply", async () => {
  const f = await fixture();
  await act(async () => vi.advanceTimersByTimeAsync(20000));
  const first = f.socket.sent.at(-1);
  const pong = {type:"pong", id:first.id, showId:"show", serviceDate:"2026-11-08", revision:3};
  await act(async () => f.socket.message(pong));
  await act(async () => vi.advanceTimersByTimeAsync(20000));
  expect(f.socket.sent.at(-1).id).not.toBe(first.id);
  await act(async () => f.socket.message(pong));
  await act(async () => vi.advanceTimersByTimeAsync(8001));
  expect(f.result.current.hydrated).toBe(false);
});
it("reconnects if a heartbeat reveals a missed revision without applying a command", async () => {
  const f = await fixture();
  await act(async () => vi.advanceTimersByTimeAsync(20000));
  await act(async () => f.socket.message({type:"pong", id:f.socket.sent.at(-1).id, showId:"show", serviceDate:"2026-11-08", revision:4}));
  expect(f.result.current.hydrated).toBe(false);
  expect(f.result.current.revision).toBe(3);
  expect(f.result.current.lastError).toMatch(/missed|current state/i);
  expect(f.socket.sent.filter(message => message.type === "command")).toEqual([]);
});
it.each(["wrong-show", "wrong-date", "bad-revision"])("rejects a matching heartbeat with %s", async kind => {
  const f = await fixture();
  await act(async () => vi.advanceTimersByTimeAsync(20000));
  const pong = {type:"pong", id:f.socket.sent.at(-1).id, showId:"show", serviceDate:"2026-11-08", revision:3};
  if(kind === "wrong-show") pong.showId = "other";
  if(kind === "wrong-date") pong.serviceDate = "2026-11-09";
  if(kind === "bad-revision") pong.revision = "unknown";
  await act(async () => f.socket.message(pong));
  expect(f.result.current.hydrated).toBe(false);
});
it("keeps a healthy idle socket and tolerates a newer state arriving before its matching pong", async () => {
  const f = await fixture();
  await act(async () => vi.advanceTimersByTimeAsync(20000));
  const id = f.socket.sent.at(-1).id;
  await act(async () => { hydrate(f.socket,4); f.socket.message({type:"pong",id,showId:"show",serviceDate:"2026-11-08",revision:3}); });
  await act(async () => vi.advanceTimersByTimeAsync(8001));
  expect(f.result.current.hydrated).toBe(true);
  expect(f.result.current.revision).toBe(4);
  expect(f.socket.readyState).toBe(1);
});
it("clears an old heartbeat deadline when an operator retries the connection", async () => {
  const f = await fixture();
  await act(async () => vi.advanceTimersByTimeAsync(20000));
  await act(async () => f.result.current.retryConnection());
  const current = sockets.at(-1);
  await act(async () => { current.open(); hydrate(current); });
  await act(async () => vi.advanceTimersByTimeAsync(8001));
  expect(f.result.current.hydrated).toBe(true);
  expect(current.readyState).toBe(1);
});
