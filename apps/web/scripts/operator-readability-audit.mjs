import assert from "node:assert/strict";

// Measure the built UI, including inherited opacity and translucent backgrounds.
// Disabled controls are exempt from contrast, but still need readable type sizes.
export async function assertOperatorReadability(browser, selector) {
  const result = (await browser("eval", `(${audit.toString()})(${JSON.stringify(selector)})`)).result;
  assert.ok(result.textCount > 0, `No operator text found in ${selector}`);
  assert.ok(result.mutedCount > 0, `No muted text checked in ${selector}`);
  assert.deepEqual(result.failures, [], JSON.stringify(result, null, 2));
  return result;
}

function audit(selector) {
  const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const rgba = color => {
    ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data; return [r, g, b, a / 255];
  };
  const blend = (fg, bg) => [...fg.slice(0, 3).map((v, i) => v * fg[3] + bg[i] * (1 - fg[3])), 1];
  const luminance = rgb => rgb.slice(0, 3).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
  const muted = rgba(getComputedStyle(document.documentElement).getPropertyValue("--board-muted"));
  let textCount = 0, mutedCount = 0, minimumContrast = Infinity;
  const failures = [];
  for (const root of document.querySelectorAll(selector)) {
    for (const el of [root, ...root.querySelectorAll("*")]) {
      if (!(el instanceof HTMLElement) || ![...el.childNodes].some(n => n.nodeType === Node.TEXT_NODE && n.textContent.trim())) continue;
      const box = el.getBoundingClientRect(); const css = getComputedStyle(el);
      if (!box.width || !box.height || css.visibility !== "visible" || el.closest('.sr-only,[aria-hidden="true"]')) continue;
      const label = el.textContent.trim().slice(0, 90);
      textCount++;
      if (parseFloat(css.fontSize) < 12) failures.push({ label, fontSize: css.fontSize });
      const fg = rgba(css.color);
      if (!fg.slice(0, 3).every((v, i) => Math.abs(v - muted[i]) <= 1) || el.closest(':disabled,[aria-disabled="true"]')) continue;
      mutedCount++;
      const ancestry = []; for (let node = el; node; node = node.parentElement) ancestry.unshift(node);
      let bg = [0, 0, 0, 1], opacity = 1;
      for (const node of ancestry) { const style = getComputedStyle(node); bg = blend(rgba(style.backgroundColor), bg); opacity *= Number(style.opacity); }
      fg[3] *= opacity;
      const a = luminance(blend(fg, bg)), b = luminance(bg);
      const contrast = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
      minimumContrast = Math.min(minimumContrast, contrast);
      if (contrast < 4.5) failures.push({ label, contrast, color: css.color, opacity });
    }
  }
  return { textCount, mutedCount, minimumContrast, failures };
}
