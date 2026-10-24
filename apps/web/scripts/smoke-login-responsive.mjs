// Run against a local preview or deployed app with agent-browser installed:
// node apps/web/scripts/smoke-login-responsive.mjs http://127.0.0.1:3112
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const origin = process.argv[2] ?? "http://127.0.0.1:3000";
const session = `showpilot-responsive-${process.pid}`;
function browser(...args) {
  const response = JSON.parse(execFileSync("agent-browser", ["--session", session, "--json", ...args], { encoding: "utf8" }));
  assert.equal(response.success, true, response.error);
  return response.data;
}

const viewports = [[320, 568], [390, 844], [768, 1024], [900, 900], [901, 900], [1024, 768], [1280, 600], [1440, 900], [1920, 1080], [2560, 1440], [3440, 1440], [844, 390]];
try {
  for (const signup of [false, true]) {
    browser("open", `${origin}/login${signup ? "?signup=1" : ""}`);
    browser("wait", ".signin-shell input");
    for (const [width, height] of viewports) {
      browser("set", "viewport", String(width), String(height));
      const { result } = browser("eval", `(() => {
        const shell = document.querySelector('.signin-shell');
        const form = document.querySelector('.form-wrap');
        const header = document.querySelector('.wordmark');
        const fields = [...shell.querySelectorAll('input, .submit')];
        const rect = form.getBoundingClientRect();
        const motifSizes = ['rhythm', 'afterglow', 'in-sync'].map(design => {
          shell.dataset.design = design;
          const art = shell.querySelector('.art').getBoundingClientRect();
          return { width: art.width, height: art.height };
        });
        shell.dataset.design = 'rhythm';
        return {
          overflow: document.documentElement.scrollWidth > innerWidth + 1,
          shellWidth: shell.getBoundingClientRect().width,
          formWidth: rect.width,
          left: rect.left, right: rect.right,
          headerOverlap: rect.top < header.getBoundingClientRect().bottom,
          inputSize: parseFloat(getComputedStyle(fields[0]).fontSize),
          controlsFit: fields.every(el => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 1 && r.height >= 44; }),
          hasName: Boolean(document.querySelector('#name')),
          motifSizes
        };
      })()`);
      const label = `${signup ? "Sign-up" : "Sign-in"} ${width}×${height}`;
      assert.equal(result.overflow, false, `${label}: horizontal overflow`);
      assert.equal(result.shellWidth, width, `${label}: page does not fill viewport`);
      assert.ok(result.left >= 16 && result.right <= width - 16, `${label}: missing form gutters`);
      assert.equal(result.headerOverlap, false, `${label}: form overlaps logo`);
      assert.ok(result.inputSize >= 16 && result.controlsFit, `${label}: unreadable or clipped controls`);
      assert.equal(result.hasName, signup, `${label}: wrong form mode`);
      if (width >= 1920) assert.ok(result.formWidth >= 460, `${label}: desktop form failed to scale`);
      if (width <= 900) assert.ok(result.motifSizes.every(size => size.width <= 110 && size.height <= 85), `${label}: seasonal artwork covers the form`);
      console.log(`${label}: passed`);
    }
    browser("click", '[aria-label="Show password"]');
    assert.equal(browser("eval", 'document.querySelector("#password").type').result, "text");
    browser("click", '[aria-label="Hide password"]');
    assert.equal(browser("eval", 'document.querySelector("#password").type').result, "password");
  }
} finally {
  browser("close");
}
