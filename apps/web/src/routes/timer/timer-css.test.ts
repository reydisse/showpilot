import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("disables warning flashes while retaining steady overtime styling", () => {
  const source = readFileSync(`${process.cwd()}/src/routes/timer/$orgSlug.tsx`, "utf8");
  const css = source.split('const TIMER_CSS = `')[1].split('`;')[0];
  const reduced = css.split("@media (prefers-reduced-motion: reduce)")[1];
  const disabled = reduced.split("animation: none;")[0];
  for (const name of ["phase-danger", "phase-overtime", "bg-overtime", "glow-overtime", "message-bar"]) {
    expect(disabled).toContain(`.${name}`);
  }
  expect(reduced).toContain(".bg-overtime { background-color: #1a0000; }");
  expect(reduced).toContain(".glow-overtime { text-shadow: 0 0 20px rgba(239, 68, 68, 0.3); }");
  expect(reduced).not.toContain("progress-sweep");
  expect(reduced).not.toContain("lyrics-in");
});
