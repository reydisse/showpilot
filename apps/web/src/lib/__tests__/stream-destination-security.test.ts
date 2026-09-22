import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteStreamDestinationForOrg,
  disconnectAllForOrg,
  connectDestinationsForOrg,
  normalizeCfOutputStatus,
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

  it("selects a destination without creating a provider output", async () => {
    const fixture = prismaFixture({
      destination: { id: "dest-1", orgId: "org-1", rtmpUrl: "rtmps://example.com/live", streamKey: "secret", cfOutputId: "", liveInputId: "" },
    });
    mocks.getPrisma.mockReturnValue(fixture.client);
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await setStreamDestinationEnabledForOrg("org-1", "dest-1", true);
    expect(fixture.update).toHaveBeenCalledWith({
      where: { id: "dest-1" },
      data: { enabled: true },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
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

  it("attempts every Stop All destination and reports independent outcomes", async () => {
    const update = vi.fn().mockResolvedValue({});
    mocks.getPrisma.mockReturnValue({
      streamDestination: {
        findMany: vi.fn().mockResolvedValue([
          { id: "dest-a", name: "A", orgId: "org-1", cfOutputId: "out-a", liveInputId: "input-a" },
          { id: "dest-b", name: "B", orgId: "org-1", cfOutputId: "out-b", liveInputId: "input-b" },
        ]),
        update,
      },
      liveInput: {
        findFirst: vi.fn().mockImplementation(({ where }: { where: { id: string } }) => Promise.resolve({
          id: where.id,
          cfInputId: `cf-${where.id}`,
        })),
      },
    });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("provider unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const results = await disconnectAllForOrg("org-1");
    expect(results).toEqual([
      expect.objectContaining({ id: "dest-a", success: false }),
      { id: "dest-b", success: true },
    ]);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({
      where: { id: "dest-b" },
      data: { cfOutputId: "", liveInputId: "" },
    });
  });

  it("claims a destination before provider creation so concurrent Go Live creates one output", async () => {
    let storedOutputId = "";
    const destination = {
      id: "dest-1",
      orgId: "org-1",
      name: "YouTube",
      platform: "youtube",
      rtmpUrl: "rtmps://example.com/live",
      streamKey: "secret",
      enabled: true,
      cfOutputId: "",
      liveInputId: "",
      createdAt: new Date(),
    };
    const updateMany = vi.fn().mockImplementation(({ where, data }: {
      where: { cfOutputId: string };
      data: { cfOutputId: string };
    }) => {
      if (where.cfOutputId !== storedOutputId) return Promise.resolve({ count: 0 });
      storedOutputId = data.cfOutputId;
      return Promise.resolve({ count: 1 });
    });
    mocks.getPrisma.mockReturnValue({
      liveInput: { findFirst: vi.fn().mockResolvedValue({ id: "input-1", cfInputId: "cf-input-1" }) },
      streamDestination: {
        findMany: vi.fn().mockResolvedValue([destination]),
        updateMany,
      },
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      if (!init?.method) return new Response(JSON.stringify({ result: [] }));
      if (init.method === "POST") return new Response(JSON.stringify({ result: { uid: "cf-output-1" } }));
      return new Response(JSON.stringify({ success: true }));
    });

    const [first, second] = await Promise.all([
      connectDestinationsForOrg("org-1", "input-1"),
      connectDestinationsForOrg("org-1", "input-1"),
    ]);

    expect([...first, ...second].filter((result) => result.success)).toHaveLength(1);
    expect([...first, ...second].filter((result) => !result.success)).toHaveLength(1);
    expect(fetchSpy.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(storedOutputId).toBe("cf-output-1");
  });

  it("treats an already-absent provider output as a converged deletion", async () => {
    const fixture = prismaFixture({
      destination: { id: "dest-1", orgId: "org-1", rtmpUrl: "rtmps://example.com/live", streamKey: "secret", cfOutputId: "gone", liveInputId: "input-1" },
      liveInput: { id: "input-1", cfInputId: "cf-input-1" },
    });
    mocks.getPrisma.mockReturnValue(fixture.client);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 404 }));

    await setStreamDestinationEnabledForOrg("org-1", "dest-1", false);
    expect(fixture.update).toHaveBeenCalledWith({
      where: { id: "dest-1" },
      data: { enabled: false, cfOutputId: "", liveInputId: "" },
    });
  });

  it("fails closed when Cloudflare refuses live-input deletion", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ errors: [{ message: "live input still active" }] }), { status: 409 }));
    await expect(deleteCfLiveInput("cf-input-1")).rejects.toThrow("live input still active");
  });
});
