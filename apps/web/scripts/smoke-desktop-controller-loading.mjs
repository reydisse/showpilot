// Built app and disposable auth/D1. Only the native IPC transport is simulated.
import assert from "node:assert/strict";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { poll, withRealBrowser } from "./real-browser-fixture.mjs";

await withLocalSmokeFixture(async ({ origin, orgId, operatorCookie }) => {
  for (const native of [false, true]) {
    await withRealBrowser({ origin, cookie: operatorCookie }, async ({ page, evaluate, onPageEvent }) => {
      const requests = [];
      const errors = [];
      onPageEvent(({ method, params }) => {
        if (method === "Network.requestWillBeSent") requests.push(params.request.url);
        if (method === "Runtime.exceptionThrown") errors.push(params.exceptionDetails);
        if (method === "Runtime.consoleAPICalled" && params.type === "error") errors.push(params.args);
      });
      await page("Page.enable");
      await page("Network.enable");
      await page("Runtime.enable");
      if (native) {
        await page("Page.addScriptToEvaluateOnNewDocument", { source: `
          window.nativeCalls = [];
          const invoke = async (command, args) => {
            window.nativeCalls.push({command, args});
            if (command === 'bridge_status') return {
              configured: false, secureCredentials: true, localDevicesEnabled: false,
              running: false, connection: 'offline', pid: null, logs: [], lastError: null
            };
            if (command === 'plugin:notification|register_listener') return;
            throw new Error('Unexpected native command: ' + command);
          };
          let callbackId = 0;
          window.__TAURI__ = {core: {invoke}};
          window.__TAURI_INTERNALS__ = {
            invoke, transformCallback: () => ++callbackId, unregisterCallback: () => {},
            metadata: {currentWindow: {label: 'main'}, currentWebview: {label: 'main'}}
          };
        ` });
      }
      await page("Page.navigate", { url: `${origin}/${orgId}/board` });
      await poll(() => evaluate(`location.pathname === '/${orgId}/board' &&
        [...document.querySelectorAll('button')].some(node => Object.keys(node).some(key => key.startsWith('__reactProps$')))`), "built board hydration");
      if (native) {
        await poll(() => evaluate(`window.nativeCalls.some(call => call.command === 'bridge_status') &&
          window.nativeCalls.some(call => call.command === 'plugin:notification|register_listener' && call.args.event === 'actionPerformed') &&
          Object.keys(localStorage).some(key => key.startsWith('showpilot.desktop-notifications.v1:'))`), "native bridge bootstrap and notification polling/listener");
      }
      for (const name of ["DesktopBridgeController", "DesktopNotificationController"]) {
        assert.equal(requests.some(url => new URL(url).pathname.includes(`/assets/${name}-`)), native,
          `${name} must only download in a native session`);
      }
      assert.deepEqual(errors, [], "no runtime or hydration errors");
      console.log(JSON.stringify({ native, controllersDownloaded: native, hydrated: true, nativeBootstrapAndNotifications: native ? "passed" : "not loaded" }));
    });
  }
});
