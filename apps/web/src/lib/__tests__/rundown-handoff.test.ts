import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handOffRundownCommands, readRundownHandoffs, dismissRundownHandoff, subscribeRundownHandoffs } from "../rundown-handoff";
import type { RundownHandoffCommand } from "../rundown-handoff";

let orgId: string;
const command = (id: string): RundownHandoffCommand => ({ id, action: "update-meta", payload: { serviceName: "Private show name" }, queuedAt: Date.now() });
const transfer = (commands = [command("first"), command("second")]) => handOffRundownCommands({ orgId, serviceDate: "2026-11-06", showId: "show-1", view: "rundown", revision: 4, serverClockOffset: 100_000, commands });

describe("rundown navigation handoff", () => {
  beforeEach(() => { orgId = crypto.randomUUID(); sessionStorage.clear(); });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

  it("keeps original IDs/revisions, advances only after acknowledgement, and stores no payload", async () => {
    let acknowledge: (response: Response) => void = () => { throw new Error("request missing"); };
    const fetchMock = vi.fn<typeof fetch>().mockImplementationOnce(() => new Promise(resolve => { acknowledge = resolve; }))
      .mockResolvedValueOnce(Response.json({ ok: true, revision: 6 }));
    vi.stubGlobal("fetch", fetchMock);
    const listener = vi.fn(); const unsubscribe = subscribeRundownHandoffs(listener);
    const first = { ...command("first"), expectedRevision: 3 };
    const done = transfer([first, command("second")]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(readRundownHandoffs(orgId)).toMatchObject([{ kind: "pending", count: 2 }]);
    const stored = sessionStorage.getItem(`showpilot:rundown-handoff:${orgId}`);
    expect(stored).not.toContain("Private show name");
    expect(stored).not.toContain("update-meta");
    const pending = readRundownHandoffs(orgId)[0];
    dismissRundownHandoff(orgId, pending.id);
    expect(readRundownHandoffs(orgId)).toHaveLength(1);
    acknowledge(Response.json({ ok: true, duplicate: true, revision: 5 }));
    await done;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({ id: "first", expectedRevision: 3 });
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toMatchObject({ id: "second", expectedRevision: 5 });
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ keepalive: true, credentials: "same-origin" });
    expect(String(fetchMock.mock.calls[0][0])).toContain(`/api/rundown/${orgId}/command?serviceDate=2026-11-06&showId=show-1`);
    expect(readRundownHandoffs(orgId)).toEqual([]);
    expect(sessionStorage.getItem(`showpilot:rundown-handoff:${orgId}`)).toBeNull();
    expect(listener).toHaveBeenCalled(); unsubscribe();
  });

  it.each([401, 409, 500])("stops the sequence on HTTP %s and retains an org-scoped review notice", async status => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: false, reason: "revision-conflict", revision: 99 }, { status }));
    vi.stubGlobal("fetch", fetchMock);
    await transfer();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(readRundownHandoffs(orgId)).toMatchObject([{ kind: "failed", reason: "rejected", count: 2, showId: "show-1", serviceDate: "2026-11-06", occurredAt: expect.any(Number) }]);
    expect(readRundownHandoffs("another-org")).toEqual([]);
    const id = readRundownHandoffs(orgId)[0].id;
    dismissRundownHandoff("another-org", id);
    expect(readRundownHandoffs(orgId)).toHaveLength(1);
    dismissRundownHandoff(orgId, id);
    expect(readRundownHandoffs(orgId)).toEqual([]);
  });

  it.each(['{broken', '{"ok":false,"revision":5}', '{"revision":5}', '{"ok":true,"revision":-1}'])("requires an explicit valid acknowledgement: %s", async body => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
    vi.stubGlobal("fetch", fetchMock);
    await transfer();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(readRundownHandoffs(orgId)).toMatchObject([{ kind: "failed", reason: "unconfirmed", count: 2 }]);
  });

  it("counts only remaining changes after a partially successful sequence", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ ok: true, revision: 5 }))
      .mockRejectedValueOnce(new Error("network lost"));
    vi.stubGlobal("fetch", fetchMock);
    await transfer([command("first"), command("second"), command("third")]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(readRundownHandoffs(orgId)).toMatchObject([{ kind: "failed", reason: "unconfirmed", count: 2 }]);
  });

  it("bounds response-body confirmation and ignores a late acknowledgement", async () => {
    vi.useFakeTimers();
    const schedule = vi.spyOn(globalThis, "setTimeout");
    const cancel = vi.spyOn(globalThis, "clearTimeout");
    let finishBody: (data: unknown) => void = () => { throw new Error("body not read"); };
    const response = Response.json({});
    vi.spyOn(response, "json").mockImplementation(() => new Promise(resolve => { finishBody = resolve; }));
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetchMock);
    const done = transfer();
    await vi.advanceTimersByTimeAsync(8000); await done;
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(readRundownHandoffs(orgId)).toMatchObject([{ kind: "failed", reason: "unconfirmed", count: 2 }]);
    finishBody({ ok: true, revision: 5 }); await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(readRundownHandoffs(orgId)[0].kind).toBe("failed");
    const deadlineIndex = schedule.mock.calls.findIndex(([, delay]) => delay === 8000);
    expect(deadlineIndex).toBeGreaterThanOrEqual(0);
    expect(cancel).toHaveBeenCalledWith(schedule.mock.results[deadlineIndex].value);
  });

  it.each([{ offset: null, age: 0 }, { offset: 100_000, age: 6000 }])("does not send unsafe live transport or following edits: %j", async ({ offset, age }) => {
    const fetchMock = vi.fn<typeof fetch>(); vi.stubGlobal("fetch", fetchMock);
    await handOffRundownCommands({ orgId, view: "rundown", revision: 4, serverClockOffset: offset,
      commands: [{ ...command("next"), action: "timer-next", queuedAt: Date.now() - age }, command("later")] });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readRundownHandoffs(orgId)).toMatchObject([{ kind: "failed", reason: "expired", count: 2 }]);
  });

  it("preserves the original live deadline in the relay clock", async () => {
    vi.spyOn(Date, "now").mockReturnValue(100_000);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true, revision: 5 }));
    vi.stubGlobal("fetch", fetchMock);
    await transfer([{ ...command("next"), action: "timer-next" }]);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({ id: "next", expectedRevision: 4, expiresAt: 205_000 });
  });

  it("restores an interrupted document as unconfirmed without restoring commands", () => {
    sessionStorage.setItem(`showpilot:rundown-handoff:${orgId}`, JSON.stringify([{ id: "old", kind: "pending", count: 3, occurredAt: 123, showId: "old-show", payload: "must not restore" }]));
    expect(readRundownHandoffs(orgId)).toEqual([{ id: "old", kind: "failed", reason: "interrupted", count: 3, occurredAt: 123, showId: "old-show" }]);
  });

  it("keeps an older failure visible when a later batch succeeds", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(Response.json({ ok: true, revision: 6 }));
    vi.stubGlobal("fetch", fetchMock);
    await transfer([command("first")]);
    const first = readRundownHandoffs(orgId)[0];
    await transfer([command("later")]);
    expect(readRundownHandoffs(orgId)).toEqual([first]);
  });

  it("keeps the warning in memory when browser storage is disabled", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("disabled"); });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(new Error("offline")));
    await transfer();
    expect(readRundownHandoffs(orgId)).toMatchObject([{ kind: "failed", count: 2 }]);
  });

  it("keeps independent notices when two pages hand off concurrently", async () => {
    let rejectFirst: (error: Error) => void = () => { throw new Error("request missing"); };
    const fetchMock = vi.fn<typeof fetch>().mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFirst = reject; }))
      .mockResolvedValueOnce(Response.json({ ok: true, revision: 7 }));
    vi.stubGlobal("fetch", fetchMock);
    const first = transfer([command("first")]);
    const firstId = readRundownHandoffs(orgId)[0].id;
    await transfer([command("other")]);
    expect(readRundownHandoffs(orgId)).toMatchObject([{ id: firstId, kind: "pending", count: 1 }]);
    rejectFirst(new Error("lost response")); await first;
    expect(readRundownHandoffs(orgId)).toMatchObject([{ id: firstId, kind: "failed", count: 1 }]);
  });

});
