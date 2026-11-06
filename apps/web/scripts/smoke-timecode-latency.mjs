// Saved-device UI -> D1 -> authoritative cue timing, using disposable local
// data and no connected equipment. Build the web app before running this file.
import assert from "node:assert/strict";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";

await withLocalSmokeFixture(
  async ({
    origin,
    orgId,
    browser,
    operatorCookie,
    operatorEmail,
    operatorPassword,
    queryFixture,
  }) => {
    await browser("open", `${origin}/login`);
    await browser("fill", "#email", operatorEmail);
    await browser("fill", "#password", operatorPassword);
    await browser(
      "find",
      "role",
      "button",
      "click",
      "--name",
      "Sign in",
      "--exact",
    );
    await browser("wait", "--url", `**/${orgId}/**`);
    await browser("open", `${origin}/${orgId}/dashboard/devices`);
    await browser("click", 'button:text-is("Add Device") >> nth=0');
    await browser("select", "#device-adapter", "atem");
    await browser("fill", "#device-name", "Latency fixture ATEM");
    await browser("fill", "#device-field-host", "192.0.2.10");
    await browser("fill", "#device-latency", "200");
    await browser("click", "form button[type=submit]");
    await browser("wait", "text=Configuration & device details");
    const rows = await queryFixture(
      `SELECT id, latencyMs FROM device WHERE orgId = '${orgId}' AND name = 'Latency fixture ATEM'`,
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].latencyMs, 200);
    const deviceId = rows[0].id;

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
    await browser(
      "fill",
      `${form} input[placeholder="00:05:00:00"]`,
      "00:01:00:00",
    );
    await browser("select", `${form} select >> nth=0`, "device-action");
    await browser("find", "label", "Cue lead (ms)", "fill", "100");
    await browser("find", "label", "Tolerance (frames)", "fill", "0");
    await browser("wait", "--fn", `Array.from(document.querySelectorAll('option')).some(option => option.value === ${JSON.stringify(deviceId)})`);
    await browser("select", `${form} select >> nth=1`, deviceId);
    await browser("select", `${form} select >> nth=2`, "set_program_input");
    const parameterId = (await browser("eval", `Array.from(document.querySelectorAll(${JSON.stringify(`${form} label`)})).find(label => label.textContent.trim() === 'Input').htmlFor`)).result;
    await browser("fill", `[id=${JSON.stringify(parameterId)}]`, "3");
    await browser("set", "viewport", "320", "780");
    await browser("scrollintoview", `[id=${JSON.stringify(parameterId)}]`);
    assert.equal((await browser("eval", `document.querySelector(${JSON.stringify(form)}).scrollWidth <= document.querySelector(${JSON.stringify(form)}).clientWidth + 1`)).result, true);
    await browser("screenshot", "/tmp/showpilot-device-cue-fields-320.png");
    await browser("set", "viewport", "1440", "900");
    await browser(
      "find",
      "role",
      "button",
      "click",
      "--name",
      "Add Event",
      "--exact",
    );
    await browser(
      "wait",
      "--fn",
      `document.querySelector(${JSON.stringify(`${form} input[placeholder="00:05:00:00"]`)}).value === ''`,
    );
    assert.equal((await readEvents())[0].leadMs, 100);

    const checkStart = async (button, latencyMs, dispatchFrame) => {
      await browser(
        "find",
        "role",
        "button",
        "click",
        "--name",
        button,
        "--exact",
      );
      await browser("wait", "text=Stop Generator");
      const events = await readEvents();
      await browser(
        "find",
        "role",
        "button",
        "click",
        "--name",
        "Stop Generator",
        "--exact",
      );
      await browser("wait", "text=Resume Internal Generator");
      assert.equal(events.length, 1);
      assert.equal(events[0].deviceLatencyMs, latencyMs);
      assert.equal(events[0].dispatchFrame, dispatchFrame);
      assert.equal(events[0].triggerFrame, 1800);
      assert.equal(events[0].fired, false);
    };
    await checkStart("Start Internal Generator", 200, 1791);
    await browser("wait", "text=Send 00:00:59:21");

    await browser("open", `${origin}/${orgId}/dashboard/devices`);
    await browser(
      "click",
      'summary:has-text("Configuration & device details")',
    );
    await browser(
      "find",
      "role",
      "button",
      "click",
      "--name",
      "Edit configuration",
      "--exact",
    );
    await browser("fill", "#device-latency", "400");
    await browser("set", "viewport", "320", "780");
    assert.equal(
      (
        await browser(
          "eval",
          "document.querySelector('#device-latency').closest('form').scrollWidth <= document.querySelector('#device-latency').closest('form').clientWidth + 1",
        )
      ).result,
      true,
    );
    await browser("screenshot", "/tmp/showpilot-device-latency-320.png");
    await browser(
      "find",
      "role",
      "button",
      "click",
      "--name",
      "Update",
      "--exact",
    );
    await browser(
      "wait",
      "--fn",
      "document.querySelector('#device-latency') === null",
    );
    assert.equal(
      (await readEvents())[0].deviceLatencyMs,
      200,
      "Editing the device moved an existing cue before source restart",
    );
    await browser("open", `${origin}/${orgId}/timecode`);
    await checkStart("Resume Internal Generator", 400, 1785);
    await browser("wait", "text=Send 00:00:59:15");
    await browser("scrollintoview", `${form} input[type=number] >> nth=0`);
    assert.equal(
      (
        await browser(
          "eval",
          `(() => { const form = document.querySelector(${JSON.stringify(form)}); return form.scrollWidth <= form.clientWidth + 1; })()`,
        )
      ).result,
      true,
    );
    await browser("screenshot", "/tmp/showpilot-cue-latency-320.png");
    console.log(
      JSON.stringify(
        {
          login: "passed",
          deviceLatencySaved: "passed",
          cueLeadSaved: "passed",
          capturedAtStart: "passed",
          nominalCueUnchanged: "passed",
          nextStartRefresh: "passed",
          deviceForm320px: "passed",
          equipmentCommands: "none",
        },
        null,
        2,
      ),
    );
  },
  { paidPlan: true },
);
