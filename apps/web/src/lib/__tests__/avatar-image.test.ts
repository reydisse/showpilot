import { describe, expect, it } from "vitest";
import { getSquareAvatarGeometry } from "../avatar-image";

describe("avatar image geometry", () => {
  it("center-crops a landscape image before scaling the full crop", () => {
    expect(getSquareAvatarGeometry(4000, 2000, 256)).toEqual({
      sourceX: 1000,
      sourceY: 0,
      sourceSize: 2000,
      outputSize: 256,
    });
  });

  it("center-crops a portrait image and never upscales a small image", () => {
    expect(getSquareAvatarGeometry(180, 320, 256)).toEqual({
      sourceX: 0,
      sourceY: 70,
      sourceSize: 180,
      outputSize: 180,
    });
  });

  it("rejects invalid dimensions at the file boundary", () => {
    expect(() => getSquareAvatarGeometry(0, 320, 256)).toThrow("positive numbers");
  });
});
