import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { localShowFixture } from "@/test/local-show-fixture";
import {
  parseLocalRundownJournal,
  reconcileLocalRundown,
} from "@showpilot/shared/local-rundown";
import {
  discardDesktopLocalShow,
  matchesLocalShow,
  parseDesktopLocalShowStatus,
  readDesktopLocalShow,
  syncDesktopLocalShow,
} from "../desktop-local-show";

const native = vi.hoisted(() => vi.fn());
vi.mock("../desktop-runtime", () => ({ invokeDesktopLocalShow: native }));
let fixture: ReturnType<typeof localShowFixture>;
const target = { orgId: "org-1", showId: "show-1", serviceDate: "2026-11-06" };
beforeEach(() => {
  fixture = localShowFixture();
  native.mockReset().mockImplementation(fixture.invoke);
});
afterEach(() => vi.unstubAllGlobals());
async function finished() {
  fixture.prepare();
  await fixture.finish();
  const status = await readDesktopLocalShow();
  if (!matchesLocalShow(status, target)) throw Error("Expected fixture show");
  return status;
}
it("reads the real manager's finished public journal and strips unknown fields", async () => {
  const status = await finished();
  expect(status.mode).toBe("finished");
  expect(status.sequence).toBe(3);
  expect(status.timer.currentItemId).toBe("second");
  expect(status.results).toHaveLength(1);
  expect(JSON.stringify(status)).not.toContain("fixture-private-password");
  const contaminated = {
    ...status,
    secret: "private",
    actions: status.actions.map((a) => ({
      ...a,
      settings: { secret: "private" },
    })),
    journal: {
      ...status.journal,
      operations: [
        {
          at: status.journal?.startedAt,
          action: "timer-start",
          payload: { itemId: "first", secret: "private" },
        },
      ],
    },
  };
  expect(
    JSON.stringify(parseDesktopLocalShowStatus(contaminated)),
  ).not.toContain("private");
});
it("rejects mismatched, unfinished, and device-containing journals", async () => {
  const status = await finished();
  expect(() =>
    parseDesktopLocalShowStatus({ ...status, orgId: "other-org" }),
  ).toThrow(/does not match/);
  expect(() =>
    parseDesktopLocalShowStatus({ ...status, journal: null }),
  ).toThrow(/incomplete/);
  expect(() =>
    parseDesktopLocalShowStatus({
      ...status,
      journal: {
        ...status.journal,
        operations: [
          { at: status.journal?.startedAt, action: "device", payload: {} },
        ],
      },
    }),
  ).toThrow(/does not match/);
});
it("posts the original revision and timer-only wire journal, then records the local receipt", async () => {
  const status = await finished();
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      id: "local:local-session",
      expectedRevision: 7,
      action: "reconcile-local",
    });
    const journal = parseLocalRundownJournal(body.payload, Date.now());
    if (!journal) throw Error("Invalid wire journal");
    const result = reconcileLocalRundown(
      fixture.preparation,
      { ...target, revision: 7 },
      journal,
    );
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.state.timer).toMatchObject({
        currentItemId: "second",
        playback: "pause",
      });
    return Response.json({ ...target, ok: true, revision: 8 });
  });
  vi.stubGlobal("fetch", fetcher);
  expect(await syncDesktopLocalShow(status, target)).toMatchObject({
    kind: "synced",
    revision: 8,
    status: { mode: "reconciled" },
  });
  expect(fetcher.mock.calls[0][0]).toContain(
    "/api/rundown/org-1/command?showId=show-1&serviceDate=2026-11-06",
  );
  expect(fetcher.mock.calls[0][1].credentials).toBe("same-origin");
  expect(fixture.outputCount()).toBe(1);
});
it("keeps both records on a cloud revision conflict", async () => {
  const status = await finished();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json(
        { ...target, ok: false, revision: 12, reason: "revision-conflict" },
        { status: 409 },
      ),
    ),
  );
  native.mockClear();
  expect(await syncDesktopLocalShow(status, target)).toEqual({
    kind: "conflict",
    revision: 12,
  });
  expect(native).not.toHaveBeenCalled();
  expect(fixture.status().mode).toBe("finished");
  expect(fixture.outputCount()).toBe(1);
});
it("retries the same session after a lost reply without replaying a device", async () => {
  const status = await finished();
  const fetcher = vi
    .fn()
    .mockRejectedValueOnce(new Error("reply lost"))
    .mockResolvedValueOnce(
      Response.json({ ...target, ok: true, duplicate: true, revision: 10 }),
    );
  vi.stubGlobal("fetch", fetcher);
  await expect(syncDesktopLocalShow(status, target)).rejects.toThrow(
    /same session/,
  );
  expect(fixture.status().mode).toBe("finished");
  await syncDesktopLocalShow(status, target);
  expect(fetcher.mock.calls[0][1].body).toBe(fetcher.mock.calls[1][1].body);
  expect(fixture.outputCount()).toBe(1);
});
it("reports a lost local receipt truthfully and safely confirms it on retry", async () => {
  const status = await finished();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({ ...target, ok: true, duplicate: true, revision: 9 }),
    ),
  );
  native.mockRejectedValueOnce(new Error("IPC lost"));
  await expect(syncDesktopLocalShow(status, target)).rejects.toThrow(
    /cloud accepted/,
  );
  expect(fixture.status().mode).toBe("finished");
  await syncDesktopLocalShow(status, target);
  expect(fixture.status().mode).toBe("reconciled");
  expect(fixture.outputCount()).toBe(1);
});
it.each([401, 403, 500])("preserves the journal on HTTP %s", async (code) => {
  const status = await finished();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({ ...target, ok: false, revision: 7 }, { status: code }),
    ),
  );
  await expect(syncDesktopLocalShow(status, target)).rejects.toThrow();
  expect(fixture.status().mode).toBe("finished");
});
it("rejects another show's request and response", async () => {
  const status = await finished();
  const fetcher = vi.fn(async () =>
    Response.json({ ...target, showId: "other-show", ok: true, revision: 8 }),
  );
  vi.stubGlobal("fetch", fetcher);
  await expect(
    syncDesktopLocalShow(status, { ...target, orgId: "other-org" }),
  ).rejects.toThrow(/saved show/);
  expect(fetcher).not.toHaveBeenCalled();
  await expect(syncDesktopLocalShow(status, target)).rejects.toThrow(
    /did not confirm/,
  );
  expect(fixture.status().mode).toBe("finished");
});
it("discards a finished journal only with the native confirmation contract", async () => {
  const status = await finished();
  expect(await discardDesktopLocalShow(status)).toMatchObject({
    mode: "empty",
  });
  expect(native).toHaveBeenLastCalledWith({
    operation: "discard",
    sessionId: status.sessionId,
    confirmed: true,
  });
});
