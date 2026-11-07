import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  normalizeCfOutputStatus,
  redactStreamDestination,
} from "../stream-destinations";
import { deleteCfLiveInput, redactLiveInput } from "../stream";

const mocks = vi.hoisted(() => ({
  getPrisma: vi.fn(),
}));

vi.mock("../db", () => ({ getPrisma: mocks.getPrisma }));
vi.mock("../org-access", () => ({ assertOrgPermission: vi.fn() }));
vi.mock("cloudflare:workers", () => ({
  env: {
    CLOUDFLARE_ACCOUNT_ID: "account-1",
    CLOUDFLARE_STREAM_API_TOKEN: "test-token",
  },
}));

describe("stream destination security", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.getPrisma.mockReset();
  });

  it("turns stored credentials into write-only metadata", () => {
    const result = redactStreamDestination({ id: "dest-1", name: "YouTube", streamKey: "provider-secret" });
    expect(result).toEqual({ id: "dest-1", name: "YouTube", hasStreamKey: true });
    expect(result).not.toHaveProperty("streamKey");
  });

  it("reports only the provider output state Cloudflare documents", () => {
    expect(normalizeCfOutputStatus({ enabled: true })).toEqual({ status: "enabled" });
    expect(normalizeCfOutputStatus({ enabled: false })).toEqual({ status: "disabled" });
    expect(normalizeCfOutputStatus(undefined)).toEqual({ status: "missing" });
  });

  it("keeps ingest keys out of read-only stream-health payloads", () => {
    const result = redactLiveInput({ id: "input-1", name: "Main", rtmpKey: "encoder-secret" });
    expect(result).toEqual({ id: "input-1", name: "Main", hasRtmpKey: true });
    expect(result).not.toHaveProperty("rtmpKey");
    expect(redactLiveInput({ id: "input-1", rtmpKey: "encoder-secret" }, true)).toHaveProperty("rtmpKey", "encoder-secret");
  });

  it("fails closed when Cloudflare refuses live-input deletion", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ errors: [{ message: "live input still active" }] }), { status: 409 }));
    await expect(deleteCfLiveInput("cf-input-1")).rejects.toThrow("The streaming provider did not confirm this request");
  });
});
