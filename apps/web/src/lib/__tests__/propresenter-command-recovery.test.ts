import { expect, it, vi } from "vitest";
import { ProPresenterCommandRecovery } from "../propresenter-command-recovery.server";
import { SerialCommandExecutor } from "../serial-command-executor";
const command = {
  orgId: "org",
  userId: "user",
  showId: "show",
  requestId: "a31b4d77-7f9b-40cd-9119-4794980c0551",
  command: "next" as const,
};
const claim = {
  orgId: "org",
  userId: "user",
  sessionId: "session",
  rundownPin: null,
};
function setup() {
  let now = 1000;
  const records = new Map<string, unknown>();
  const store = {
    get: async <T>(key: string) => records.get(key) as T | undefined,
    put: async <T>(key: string, value: T) => {
      records.set(key, structuredClone(value));
    },
  };
  const queue = new SerialCommandExecutor();
  const context = vi.fn(async () => ({
    installationId: "bridge",
    fingerprint: "settings",
    target: "pp",
  }));
  const dispatch = vi.fn(async () => ({
    result: Promise.resolve({ success: true }),
  }));
  const ports = {
    queue: <T>(work: () => Promise<T>) => queue.run(work),
    context,
    dispatch,
  };
  const create = () => new ProPresenterCommandRecovery(store, ports, () => now);
  return {
    recovery: create(),
    create,
    records,
    context,
    dispatch,
    time: (value: number) => {
      now = value;
    },
  };
}
it("checks a lost reply across controller recreation without sending another Next", async () => {
  const f = setup();
  expect((await f.recovery.prepare(command, claim)).status).toBe("prepared");
  expect((await f.recovery.execute(command, claim)).status).toBe("confirmed");
  f.recovery = f.create();
  expect((await f.recovery.check(command, claim)).status).toBe("confirmed");
  expect((await f.recovery.prepare(command, claim)).status).toBe("confirmed");
  expect((await f.recovery.execute(command, claim)).status).toBe("confirmed");
  expect(f.dispatch).toHaveBeenCalledTimes(3);
});
it("rejects changed payloads and missing preparations", async () => {
  const f = setup();
  await expect(f.recovery.execute(command, claim)).rejects.toThrow("Prepare");
  expect((await f.recovery.check(command, claim)).status).toBe("rejected");
  await f.recovery.prepare(command, claim);
  await expect(
    f.recovery.execute({ ...command, command: "clear" }, claim),
  ).rejects.toThrow("original");
  expect(f.dispatch).toHaveBeenCalledTimes(2);
});
it.each(["installationId", "fingerprint", "target"])(
  "rejects a changed %s instead of rebasing the original command",
  async (field) => {
    const f = setup();
    await f.recovery.prepare(command, claim);
    f.context.mockResolvedValue({
      installationId: "bridge",
      fingerprint: "settings",
      target: "pp",
      [field]: "changed",
    });
    expect((await f.recovery.execute(command, claim)).status).toBe("rejected");
    expect(f.dispatch).toHaveBeenCalledTimes(2);
  },
);
it("rejects expiry and revoked authority without executing", async () => {
  const f = setup();
  await f.recovery.prepare(command, claim);
  f.time(6000);
  expect((await f.recovery.execute(command, claim)).status).toBe("rejected");
  expect(f.dispatch).toHaveBeenCalledTimes(2);
  const g = setup();
  await g.recovery.prepare(command, claim);
  g.context.mockRejectedValue(new Error("revoked"));
  expect((await g.recovery.execute(command, claim)).status).toBe("rejected");
  expect(g.dispatch).toHaveBeenCalledTimes(2);
});
it("keeps a lost device reply uncertain and never redispatches", async () => {
  const f = setup();
  await f.recovery.prepare(command, claim);
  f.dispatch.mockResolvedValue({ result: Promise.resolve({ success: false }) });
  expect((await f.recovery.execute(command, claim)).status).toBe("uncertain");
  expect((await f.create().execute(command, claim)).status).toBe("uncertain");
  expect(f.dispatch).toHaveBeenCalledTimes(3);
});
it("claims concurrent execution before dispatch and survives a crash during the send", async () => {
  const f = setup();
  await f.recovery.prepare(command, claim);
  let resolve!: (value: { success: boolean }) => void;
  f.dispatch.mockImplementation(async () => ({
    result: new Promise((done) => {
      resolve = done;
    }),
  }));
  const first = f.recovery.execute(command, claim);
  await vi.waitFor(() => expect(f.dispatch).toHaveBeenCalledTimes(3));
  expect((await f.create().execute(command, claim)).status).toBe("sending");
  f.time(14000);
  expect((await f.create().check(command, claim)).status).toBe("uncertain");
  expect(f.dispatch).toHaveBeenCalledTimes(3);
  resolve({ success: true });
  expect((await first).status).toBe("confirmed");
});
it("does not make a relative command when connecting or preparing fails", async () => {
  const f = setup();
  f.dispatch.mockResolvedValue({ result: Promise.resolve({ success: false }) });
  expect((await f.recovery.prepare(command, claim)).status).toBe("rejected");
  expect(f.dispatch).toHaveBeenCalledTimes(1);
  expect((await f.recovery.execute(command, claim)).status).toBe("rejected");
});

it("reports a late preparation as expired, never ready to execute", async () => {
  const f = setup();
  let resolve!: (value: { success: boolean }) => void;
  f.dispatch.mockImplementationOnce(async () => ({
    result: Promise.resolve({ success: true }),
  }));
  f.dispatch.mockImplementationOnce(async () => ({
    result: new Promise((done) => {
      resolve = done;
    }),
  }));
  const preparation = f.recovery.prepare(command, claim);
  await vi.waitFor(() => expect(f.dispatch).toHaveBeenCalledTimes(2));
  f.time(6001);
  resolve({ success: true });
  expect(await preparation).toMatchObject({
    status: "rejected",
    message: expect.stringContaining("expired"),
  });
  expect((await f.recovery.execute(command, claim)).status).toBe("rejected");
  expect(f.dispatch).toHaveBeenCalledTimes(2);
});
