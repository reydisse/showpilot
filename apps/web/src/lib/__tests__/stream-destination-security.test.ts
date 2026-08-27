import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteStreamDestinationForOrg,
  redactStreamDestination,
  setStreamDestinationEnabledForOrg,
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

function prismaFixture(input: {
  destination?: { id: string; orgId: string; rtmpUrl: string; streamKey: string; cfOutputId: string; liveInputId: string } | null;
  liveInput?: { id: string; cfInputId: string } | null;
}) {
  const update = vi.fn().mockResolvedValue({ id: input.destination?.id });
  const remove = vi.fn().mockResolvedValue({ id: input.destination?.id });
  return {
    client: {
      streamDestination: {
        findFirst: vi.fn().mockResolvedValue(input.destination ?? null),
        update,
        delete: remove,
      },
      liveInput: { findFirst: vi.fn().mockResolvedValue(input.liveInput ?? null) },
    },
    update,
    remove,
  };
}

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

  it("keeps ingest keys out of read-only stream-health payloads", () => {
    const result = redactLiveInput({ id: "input-1", name: "Main", rtmpKey: "encoder-secret" });
    expect(result).toEqual({ id: "input-1", name: "Main", hasRtmpKey: true });
    expect(result).not.toHaveProperty("rtmpKey");
    expect(redactLiveInput({ id: "input-1", rtmpKey: "encoder-secret" }, true)).toHaveProperty("rtmpKey", "encoder-secret");
  });

  it("does not claim a destination is enabled without a provider live input", async () => {
    const fixture = prismaFixture({
      destination: { id: "dest-1", orgId: "org-1", rtmpUrl: "rtmps://example.com/live", streamKey: "secret", cfOutputId: "", liveInputId: "" },
    });
    mocks.getPrisma.mockReturnValue(fixture.client);

    await expect(setStreamDestinationEnabledForOrg("org-1", "dest-1", true))
      .rejects.toThrow("Configure a live input");
    expect(fixture.update).not.toHaveBeenCalled();
  });

  it("stores provider ownership only after Cloudflare creates the output", async () => {
    const fixture = prismaFixture({
      destination: { id: "dest-1", orgId: "org-1", rtmpUrl: "rtmps://example.com/live", streamKey: "secret", cfOutputId: "", liveInputId: "" },
      liveInput: { id: "input-1", cfInputId: "cf-input-1" },
    });
    mocks.getPrisma.mockReturnValue(fixture.client);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ result: { uid: "cf-output-1" } })));

    await setStreamDestinationEnabledForOrg("org-1", "dest-1", true);
    expect(fixture.update).toHaveBeenCalledWith({
      where: { id: "dest-1" },
      data: { enabled: true, cfOutputId: "cf-output-1", liveInputId: "input-1" },
    });
  });

  it("keeps the database row when Cloudflare refuses output deletion", async () => {
    const fixture = prismaFixture({
      destination: { id: "dest-1", orgId: "org-1", rtmpUrl: "rtmps://example.com/live", streamKey: "secret", cfOutputId: "cf-output-1", liveInputId: "input-1" },
      liveInput: { id: "input-1", cfInputId: "cf-input-1" },
    });
    mocks.getPrisma.mockReturnValue(fixture.client);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ errors: [{ message: "provider denied deletion" }] }), { status: 502 }));

    await expect(deleteStreamDestinationForOrg("org-1", "dest-1"))
      .rejects.toThrow("provider denied deletion");
    expect(fixture.remove).not.toHaveBeenCalled();
  });

  it("fails closed when Cloudflare refuses live-input deletion", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ errors: [{ message: "live input still active" }] }), { status: 409 }));
    await expect(deleteCfLiveInput("cf-input-1")).rejects.toThrow("live input still active");
  });
});
