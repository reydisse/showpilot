// Chrome without Playwright's forced-focus emulation, for real background-tab
// rehearsals. A temporary profile and process are always removed on completion.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function poll(check, description, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${description}`);
}

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("Chrome connection timed out"));
    }, 5_000);
    socket.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error("Chrome connection failed"));
    };
  });
  let id = 0;
  const pending = new Map();
  const listeners = new Set();
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.method) {
      for (const listener of listeners) listener(message);
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  };
  socket.onclose = () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("Chrome disconnected"));
    }
    pending.clear();
  };
  return {
    close: () => socket.close(),
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    send: (method, params = {}) =>
      new Promise((resolve, reject) => {
        const requestId = ++id;
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error(`Chrome command timed out: ${method}`));
        }, 5_000);
        pending.set(requestId, { resolve, reject, timer });
        socket.send(JSON.stringify({ id: requestId, method, params }));
      }),
  };
}

export async function withRealBrowser({ origin, cookie }, check) {
  assert.match(
    origin,
    /^http:\/\/127\.0\.0\.1:\d+$/,
    "Only a disposable local server is allowed",
  );
  // Other installations can provide their Chrome/Chromium executable explicitly.
  const executable =
    process.env.SHOWPILOT_CHROME_EXECUTABLE ??
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  await access(executable);
  const profile = await mkdtemp(join(tmpdir(), "showpilot-clock-chrome-"));
  const chrome = spawn(
    executable,
    [
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  let launchError;
  chrome.on("error", (error) => {
    launchError = error;
  });
  const exited = new Promise((resolve) => {
    chrome.once("exit", resolve);
    chrome.once("error", resolve);
  });
  let browser, page;
  try {
    const endpoint = await poll(async () => {
      if (launchError) throw launchError;
      if (chrome.exitCode !== null)
        throw new Error("Disposable Chrome exited during startup");
      try {
        return await readFile(join(profile, "DevToolsActivePort"), "utf8");
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
    }, "Chrome debugging endpoint");
    const [port, path] = endpoint.trim().split("\n");
    browser = await connect(`ws://127.0.0.1:${port}${path}`);
    const targets = await (
      await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(5_000),
      })
    ).json();
    const target = targets.find((target) => target.type === "page");
    assert.ok(target);
    page = await connect(target.webSocketDebuggerUrl);
    for (const entry of cookie ? cookie.split(";") : []) {
      const index = entry.indexOf("=");
      assert.ok(index > 0);
      const result = await page.send("Network.setCookie", {
        name: entry.slice(0, index).trim(),
        value: entry.slice(index + 1).trim(),
        url: origin,
        httpOnly: true,
      });
      assert.equal(result.success, true);
    }
    const evaluate = async (expression) => {
      const result = await page.send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails)
        throw new Error(
          result.exceptionDetails.exception?.description ??
            "Browser evaluation failed",
        );
      return result.result.value;
    };
    await check({
      evaluate,
      page: page.send,
      onPageEvent: page.onEvent,
      browser: browser.send,
      targetId: target.id,
    });
  } finally {
    page?.close();
    browser?.close();
    chrome.kill("SIGTERM");
    let deadline;
    await Promise.race([
      exited,
      new Promise((resolve) => {
        deadline = setTimeout(() => {
          chrome.kill("SIGKILL");
          resolve();
        }, 5_000);
      }),
    ]);
    clearTimeout(deadline);
    await exited;
    await rm(profile, { recursive: true, force: true, maxRetries: 3 });
  }
}
