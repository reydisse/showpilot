import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EquipmentState } from "@/lib/equipment-command-contract";
const api = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
  review: vi.fn(),
}));
vi.mock("@/lib/equipment-commands", () => ({
  getEquipmentState: api.read,
  commandEquipment: api.write,
  reviewEquipment: api.review,
}));
import {
  useEquipmentCommands,
  emptyEquipmentFields,
  EquipmentRequestError,
} from "../useEquipmentCommands";
let client: QueryClient, initial: EquipmentState;
const create = {
  kind: "create",
  quantity: 1,
  fields: { ...emptyEquipmentFields, name: "Fixture microphone" },
};
const flush = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
};
function mount(state = initial) {
  return renderHook(() => useEquipmentCommands(state), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false, gcTime: Infinity },
    },
  });
  initial = {
    orgId: "org",
    userId: "owner",
    serverTime: Date.now(),
    canManage: true,
    equipment: [{ id: "asset", ...create.fields, revision: 0 }],
  };
  api.read.mockReset().mockImplementation(async () => structuredClone(initial));
  api.write
    .mockReset()
    .mockImplementation(async ({ data }) => ({
      requestId: data.requestId,
      outcome: "applied",
      ids: ["asset"],
    }));
  api.review
    .mockReset()
    .mockImplementation(async ({ data }) => ({
      requestId: data.requestId,
      outcome: "cancelled",
      ids: [],
    }));
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.useRealTimers();
});
it("bounds a stalled read, retains confirmed inventory and retries only the read", async () => {
  api.read.mockImplementationOnce(() => new Promise(() => {}));
  const { result } = mount();
  await flush();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(8_000);
  });
  await flush();
  expect(result.current.read.isError).toBe(true);
  expect(result.current.read.data.equipment).toHaveLength(1);
  expect(api.read.mock.calls[0][0].signal.aborted).toBe(true);
  await act(async () => {
    await result.current.read.refetch();
  });
  await flush();
  expect(result.current.read.isError).toBe(false);
  expect(api.write).not.toHaveBeenCalled();
});
it("sends one request for same-turn clicks and ignores a late reply after timeout", async () => {
  let complete: (value: unknown) => void = () => {};
  api.write.mockImplementationOnce(
    () =>
      new Promise((done) => {
        complete = done;
      }),
  );
  const { result } = mount();
  await flush();
  act(() => {
    void result.current.send(create, "Create");
    void result.current.send(create, "Create");
  });
  await flush();
  expect(api.write).toHaveBeenCalledOnce();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  await flush();
  expect(result.current.current?.status).toBe("error");
  expect(result.current.current?.error).toBeInstanceOf(EquipmentRequestError);
  expect(result.current.unresolved).toBe(true);
  expect(api.write.mock.calls[0][0].signal.aborted).toBe(true);
  await act(async () =>
    complete({
      requestId: api.write.mock.calls[0][0].data.requestId,
      outcome: "applied",
      ids: ["asset"],
    }),
  );
  await flush();
  expect(result.current.current?.status).toBe("error");
});
it("retains the exact request and create draft across navigation then recovers once", async () => {
  api.write.mockRejectedValueOnce(new Error("Reply lost"));
  const first = mount();
  await flush();
  act(() =>
    first.result.current.setDrafts({
      addForm: { ...create.fields, quantity: 1 },
    }),
  );
  await flush();
  await act(async () => {
    await first.result.current.send(create, "Create microphone");
  });
  await flush();
  const original = structuredClone(api.write.mock.calls[0][0].data);
  first.unmount();
  const second = mount();
  await flush();
  expect(second.result.current.draft.addForm.name).toBe("Fixture microphone");
  expect(second.result.current.unresolved).toBe(true);
  await act(async () => {
    await second.result.current.recover();
  });
  await flush();
  expect(api.write.mock.calls[1][0].data).toEqual(original);
  expect(second.result.current.unresolved).toBe(false);
  expect(second.result.current.draft.addForm.name).toBe("");
});
it("does not replay a confirmed write when its inventory refresh fails", async () => {
  const { result } = mount();
  await flush();
  api.read.mockRejectedValueOnce(new Error("Read failed"));
  await act(async () => {
    await result.current.send(create, "Create");
  });
  await flush();
  expect(result.current.current?.result?.outcome).toBe("applied");
  expect(result.current.read.isError).toBe(true);
  await act(async () => {
    await result.current.read.refetch();
  });
  await flush();
  expect(api.write).toHaveBeenCalledOnce();
  expect(result.current.read.isError).toBe(false);
});
it("reviews the same request and preserves the draft until the operator continues", async () => {
  api.write.mockRejectedValueOnce(new Error("Unconfirmed"));
  const { result } = mount();
  await flush();
  act(() =>
    result.current.setDrafts({ addForm: { ...create.fields, quantity: 1 } }),
  );
  await flush();
  await act(async () => {
    await result.current.send(create, "Create");
  });
  await flush();
  await act(async () => {
    await result.current.recover("review");
  });
  await flush();
  expect(api.review.mock.calls[0][0].data).toEqual(
    api.write.mock.calls[0][0].data,
  );
  expect(result.current.unresolved).toBe(true);
  expect(result.current.draft.addForm.name).toBe("Fixture microphone");
  act(() => result.current.dismiss());
  await flush();
  expect(result.current.unresolved).toBe(false);
  expect(result.current.draft.addForm.name).toBe("Fixture microphone");
});
it("rejects an unrelated acknowledgement and an inventory reply for another account", async () => {
  const { result } = mount();
  await flush();
  api.write.mockResolvedValueOnce({
    requestId: crypto.randomUUID(),
    outcome: "applied",
    ids: ["asset"],
  });
  await act(async () => {
    await result.current.send(create, "Create");
  });
  await flush();
  expect(result.current.current?.status).toBe("error");
  api.read.mockResolvedValueOnce({ ...initial, userId: "other" });
  await act(async () => {
    await result.current.read.refetch();
  });
  await flush();
  expect(result.current.read.isError).toBe(true);
  expect(result.current.read.data.userId).toBe("owner");
});
it("preserves a newer draft when an earlier create is acknowledged", async () => {
  let complete: (value: unknown) => void = () => {};
  api.write.mockImplementationOnce(
    () =>
      new Promise((done) => {
        complete = done;
      }),
  );
  const { result } = mount();
  await flush();
  act(() =>
    result.current.setDrafts({ addForm: { ...create.fields, quantity: 1 } }),
  );
  await flush();
  act(() => {
    void result.current.send(create, "Create");
  });
  await flush();
  act(() =>
    result.current.setDrafts({
      addForm: { ...create.fields, name: "Newer draft", quantity: 1 },
    }),
  );
  await act(async () =>
    complete({
      requestId: api.write.mock.calls[0][0].data.requestId,
      outcome: "applied",
      ids: ["asset"],
    }),
  );
  await flush();
  expect(result.current.draft.addForm.name).toBe("Newer draft");
});
it("keeps recovery and drafts isolated between accounts", async () => {
  api.write.mockRejectedValueOnce(new Error("Reply lost"));
  const first = mount();
  await flush();
  act(() =>
    first.result.current.setDrafts({
      addForm: { ...create.fields, quantity: 1 },
    }),
  );
  await flush();
  await act(async () => {
    await first.result.current.send(create, "Create");
  });
  await flush();
  first.unmount();
  const other = { ...initial, userId: "other" };
  api.read.mockResolvedValue(other);
  const second = mount(other);
  await flush();
  expect(second.result.current.current).toBeUndefined();
  expect(second.result.current.draft.addForm.name).toBe("");
});
