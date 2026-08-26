import { describe, expect, it } from "vitest";
import { getPortableAvatarUrl, getSquareAvatarGeometry } from "../avatar-image";

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

describe("portable avatar URLs", () => {
  it("removes stale local origins from ShowPilot-managed avatars", () => {
    expect(
      getPortableAvatarUrl("http://127.0.0.1:3010/api/user/avatar/user-1.jpg?v=123"),
    ).toBe("/api/user/avatar/user-1.jpg?v=123");
  });

  it("keeps managed paths and external HTTPS avatars usable", () => {
    expect(getPortableAvatarUrl("/api/user/avatar/user-1.jpg?v=123")).toBe(
      "/api/user/avatar/user-1.jpg?v=123",
    );
    expect(getPortableAvatarUrl("https://images.example.com/avatar.jpg")).toBe(
      "https://images.example.com/avatar.jpg",
    );
  });

  it("rejects empty, unsupported, and unrelated relative values", () => {
    expect(getPortableAvatarUrl(" ")).toBeNull();
    expect(getPortableAvatarUrl("javascript:alert(1)")).toBeNull();
    expect(getPortableAvatarUrl("http://images.example.com/avatar.jpg")).toBeNull();
    expect(getPortableAvatarUrl("/uploads/avatar.jpg")).toBeNull();
  });
});
