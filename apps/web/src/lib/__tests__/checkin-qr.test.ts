import { describe, expect, it } from "vitest";
import { renderCheckInQr } from "../../routes/api/checkin-qr/$orgSlug";

describe("crew check-in QR", () => {
  it("renders a self-contained, accessible SVG for the canonical check-in URL", () => {
    const svg = renderCheckInQr("https://showpilot.tech/checkin/showpilot-qa");

    expect(svg).toMatch(/^<svg[^>]+>/);
    expect(svg).toContain("<title>Crew check-in QR code</title>");
    expect(svg).toContain('fill="#090909"');
    expect(svg).not.toContain("<script");
    expect(svg.length).toBeGreaterThan(1_000);
  });
});
