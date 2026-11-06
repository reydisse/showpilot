// Built UI -> real Timecode/Bridge relays -> compiled ProPresenter adapter ->
// local HTTP simulator. No physical equipment or production data is accessed.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { ProPresenterBridge } from "../../bridge/dist/protocols/propresenter.js";
import { createBridgeSettingsRecipient } from "../../../packages/shared/src/bridge-settings.mjs";

const { WebSocket } = createRequire(
  new URL("../../bridge/package.json", import.meta.url),
)("ws");
const requests = [];
const http = createServer((request, response) => {
  requests.push({ path: request.url, at: Date.now() });
  if (request.url === "/v1/props") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify([
        { id: { name: "Standby cameras", uuid: "fixture-prop" } },
      ]),
    );
  } else if (
    [
      "/v1/clear/layer/props",
      "/v1/prop/fixture-prop/trigger",
      "/v1/presentation/active/previous/trigger",
    ].includes(request.url)
  ) {
    response.writeHead(204);
    response.end();
  } else {
    response.writeHead(404);
    response.end();
  }
});
http.listen(0, "127.0.0.1");
await once(http, "listening");
const port = http.address().port;
const target = `propresenter:127.0.0.1:${port}`;
const adapter = new ProPresenterBridge({
  host: "127.0.0.1",
  port,
  apiPort: port,
  onSlideChange: () => {},
  onStatusChange: () => {},
});
let bridge;
try {
  await withLocalSmokeFixture(
    async ({
      origin,
      orgId,
      browser,
      operatorEmail,
      operatorPassword,
      operatorCookie,
    }) => {
      const click = (name) =>
        browser("find", "role", "button", "click", "--name", name, "--exact");
      await browser("open", `${origin}/login`);
      await browser("fill", "#email", operatorEmail);
      await browser("fill", "#password", operatorPassword);
      await click("Sign in");
      await browser("wait", "--url", `**/${orgId}/**`);
      await browser("open", `${origin}/${orgId}/settings?section=api`);
      await browser(
        "fill",
        'input[placeholder="Main room computer"]',
        "Props simulator",
      );
      await click("Create key");
      await browser("wait", "text=Copy this key into the Bridge now.");
      const key = (
        await browser(
          "eval",
          "[...document.querySelectorAll('code')].map(el => el.textContent).find(text => /^sp_[a-f0-9]{64}$/.test(text))",
        )
      ).result;
      assert.match(key, /^sp_[a-f0-9]{64}$/);
      await click("Dismiss key");
      await browser(
        "find",
        "label",
        "Destination name",
        "fill",
        "Props simulator",
      );
      await browser("find", "label", "Host or IP address", "fill", "127.0.0.1");
      await browser("fill", 'input[placeholder="4455"]', String(port));
      await browser(
        "select",
        'section:has(h3:text-is("Approved Bridge destinations")) select',
        "propresenter",
      );
      await click("Approve destination");
      await browser(
        "wait",
        'button[aria-label="Remove approval for Props simulator"]',
      );
      const recipient = await createBridgeSettingsRecipient();
      bridge = new WebSocket(
        `${origin.replace("http:", "ws:")}/api/bridge/${orgId}/ws?role=bridge`,
        {
          headers: {
            "x-showpilot-api-key": key,
            "x-showpilot-bridge-policy": "3",
            "x-showpilot-settings-key": recipient.publicKey,
          },
        },
      );
      bridge.on("message", async (data) => {
        const message = JSON.parse(String(data));
        if (message.type === "bridge-role") {
          bridge.send(
            JSON.stringify({
              type: "bridge-role-applied",
              role: message.role,
              selectionId: message.selectionId,
            }),
          );
          bridge.send(
            JSON.stringify({ type: "device-status", target, connected: true }),
          );
        }
        if (message.type === "bridge-policy")
          bridge.send(
            JSON.stringify({
              type: "bridge-policy-applied",
              policyId: message.policyId,
            }),
          );
        if (message.type === "command") {
          try {
            assert.equal(message.target, target);
            assert.equal(message.protocol, "propresenter");
            const response = await adapter.sendCommand(message.command);
            bridge.send(
              JSON.stringify({
                type: "command-response",
                id: message.id,
                success: true,
                response,
              }),
            );
          } catch (error) {
            bridge.send(
              JSON.stringify({
                type: "command-response",
                id: message.id,
                success: false,
                error: error.message,
              }),
            );
          }
        }
      });
      await once(bridge, "open");
      const readEvents = async () => {
        const response = await fetch(
          `${origin}/api/timecode/${orgId}/events?showId=smoke-show`,
          { headers: { Cookie: operatorCookie } },
        );
        assert.equal(response.status, 200);
        return response.json();
      };
      const form = 'form:has(input[placeholder="00:05:00:00"])';
      await browser("open", `${origin}/${orgId}/timecode`);
      await browser("wait", "text=Start Internal Generator");
      for (const [action, label] of [
        ["pp-trigger-prop", "Trigger ProPresenter Prop"],
        ["pp-trigger-previous", "Previous ProPresenter Slide"],
        ["pp-clear-props", "Clear ProPresenter Props"],
      ]) {
        await browser(
          "fill",
          `${form} input[placeholder="00:05:00:00"]`,
          "00:01:00:00",
        );
        await browser("select", `${form} select`, action);
        if (action === "pp-trigger-prop") {
          await browser(
            "find",
            "label",
            "Prop name",
            "fill",
            "Standby cameras",
          );
          await browser("set", "viewport", "320", "780");
          await browser(
            "find",
            "label",
            "ProPresenter target (optional)",
            "fill",
            target,
          );
          await browser(
            "scrollintoview",
            `${form} input[placeholder^="propresenter:"]`,
          );
          assert.equal(
            (
              await browser(
                "eval",
                `document.querySelector(${JSON.stringify(form)}).scrollWidth <= document.querySelector(${JSON.stringify(form)}).clientWidth + 1`,
              )
            ).result,
            true,
          );
          await browser("screenshot", "/tmp/showpilot-props-320.png");
          await browser("set", "viewport", "1440", "900");
        }
        await click("Add Event");
        await browser(
          "wait",
          "--fn",
          `document.querySelector(${JSON.stringify(`${form} input[placeholder="00:05:00:00"]`)}).value === ''`,
        );
        await click(`Fire ${label}`);
        await browser(
          "wait",
          "--fn",
          `Array.from(document.querySelectorAll('button')).some(button => button.getAttribute('aria-label') === ${JSON.stringify(`Re-arm ${label}`)})`,
        );
        const event = (await readEvents()).find(
          (event) => event.action === action,
        );
        assert.equal(event.fired, true);
        assert.equal(event.executionStatus, "acknowledged");
      }
      assert.deepEqual(
        requests.map((request) => request.path),
        [
          "/v1/props",
          "/v1/clear/layer/props",
          "/v1/prop/fixture-prop/trigger",
          "/v1/presentation/active/previous/trigger",
          "/v1/clear/layer/props",
        ],
      );
      assert.ok(requests[2].at - requests[1].at >= 200);
      console.log(
        JSON.stringify({
          passed: true,
          commands: requests.map((request) => request.path),
          propDelayMs: requests[2].at - requests[1].at,
          screenshot: "/tmp/showpilot-props-320.png",
        }),
      );
    },
  );
} finally {
  bridge?.terminate();
  adapter.disconnect();
  http.closeAllConnections();
  await new Promise((resolve) => http.close(resolve));
}
