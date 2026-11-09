import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
  review: vi.fn(),
  file: vi.fn(),
}));
vi.mock("@/lib/import-members", () => ({
  getCsvImportContext: api.read,
  importMembersCsv: api.write,
  reviewCsvImport: api.review,
}));
vi.mock("@/lib/csv-file", () => ({ readCrewCsvFile: api.file }));
import { useCsvImport, CsvImportError } from "../useCsvImport";
const scope = { orgId: "org", userId: "owner" };
const csv = "name,email\nJane,jane@import.invalid";
let client: QueryClient;
const flush = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
};
function mount(userId = scope.userId) {
  return renderHook(() => useCsvImport({ ...scope, userId }), {
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
  api.read.mockReset().mockImplementation(async ({ data }) => ({
    ...data,
    serverTime: Date.now(),
  }));
  api.write.mockReset().mockImplementation(async ({ data }) => ({
    requestId: data.requestId,
    outcome: "applied",
    summary: { imported: 1, skipped: 0, errors: [] },
  }));
  api.review.mockReset().mockImplementation(async ({ data }) => ({
    requestId: data.requestId,
    outcome: "cancelled",
  }));
  api.file.mockReset().mockResolvedValue(csv);
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.useRealTimers();
});
it("bounds access reads and retries without writing", async () => {
  api.read.mockImplementationOnce(() => new Promise(() => {}));
  const { result } = mount();
  await flush();
  expect(result.current.access.isError).toBe(false);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(8000);
  });
  await flush();
  expect(result.current.access.isError).toBe(true);
  expect(api.read.mock.calls[0][0].signal.aborted).toBe(true);
  await act(async () => {
    await result.current.access.refetch();
  });
  await flush();
  expect(result.current.access.isSuccess).toBe(true);
  expect(api.write).not.toHaveBeenCalled();
});
it("validates malformed CSV before creating an unresolved request", async () => {
  const { result } = mount();
  await flush();
  act(() => result.current.changeText("name\nJane"));
  await flush();
  await act(async () => {
    await result.current.send();
  });
  await flush();
  expect(result.current.validationError).toContain("email");
  expect(result.current.unresolved).toBe(false);
  expect(api.write).not.toHaveBeenCalled();
  act(() => result.current.changeText(csv));
  await flush();
  expect(result.current.validationError).toBeNull();
});
it("bounds one same-turn import and ignores its late acknowledgement", async () => {
  let complete: (value: unknown) => void = () => {};
  api.write.mockImplementationOnce(
    () =>
      new Promise((done) => {
        complete = done;
      }),
  );
  const { result } = mount();
  await flush();
  act(() => result.current.changeText(csv));
  await flush();
  act(() => {
    void result.current.send();
    void result.current.send();
  });
  await flush();
  expect(api.write).toHaveBeenCalledOnce();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10000);
  });
  await flush();
  expect(result.current.current?.error).toBeInstanceOf(CsvImportError);
  act(() => result.current.changeText("replacement"));
  await flush();
  expect(result.current.draft.csv).toBe(csv);
  await act(async () =>
    complete({
      requestId: api.write.mock.calls[0][0].data.requestId,
      outcome: "applied",
      summary: { imported: 1, skipped: 0, errors: [] },
    }),
  );
  await flush();
  expect(result.current.current?.status).toBe("error");
  expect(api.write.mock.calls[0][0].signal.aborted).toBe(true);
});
it("retains CSV, filename and exact request through navigation and keeps accounts separate", async () => {
  api.write.mockRejectedValueOnce(new Error("Response lost"));
  const first = mount();
  await flush();
  act(() => first.result.current.chooseFile(new File([csv], "crew.csv")));
  await flush();
  await act(async () => {
    await first.result.current.send();
  });
  await flush();
  const original = structuredClone(api.write.mock.calls[0][0].data);
  first.unmount();
  const other = mount("other");
  await flush();
  expect(other.result.current.current).toBeUndefined();
  expect(other.result.current.draft.csv).toBe("");
  other.unmount();
  const second = mount();
  await flush();
  expect(second.result.current.draft).toMatchObject({
    csv,
    fileName: "crew.csv",
  });
  await act(async () => {
    await second.result.current.recover();
  });
  await flush();
  expect(api.write.mock.calls[1][0].data).toEqual(original);
  expect(second.result.current.current?.result?.outcome).toBe("applied");
});
it("retries a failed review as a review and retains the editable draft after cancellation", async () => {
  api.write.mockRejectedValueOnce(new Error("Unconfirmed"));
  api.review.mockRejectedValueOnce(new Error("Review unconfirmed"));
  const { result } = mount();
  await flush();
  act(() => result.current.changeText(csv));
  await flush();
  await act(async () => {
    await result.current.send();
  });
  await flush();
  await act(async () => {
    await result.current.recover("review");
  });
  await flush();
  await act(async () => {
    await result.current.recover();
  });
  await flush();
  expect(api.review).toHaveBeenCalledTimes(2);
  expect(api.write).toHaveBeenCalledOnce();
  expect(api.review.mock.calls[1][0].data).toEqual(
    api.write.mock.calls[0][0].data,
  );
  expect(result.current.unresolved).toBe(true);
  act(() => result.current.dismiss());
  await flush();
  expect(result.current.unresolved).toBe(false);
  expect(result.current.draft.csv).toBe(csv);
});
it("preserves the previous draft on file failure and retries the chosen file", async () => {
  api.file.mockRejectedValueOnce(new Error("Unreadable file"));
  const { result } = mount();
  await flush();
  act(() =>
    result.current.changeText("name,email\nEarlier,earlier@import.invalid"),
  );
  await flush();
  const file = new File([csv], "crew.csv");
  act(() => result.current.chooseFile(file));
  await flush();
  expect(result.current.fileCurrent?.status).toBe("error");
  expect(result.current.draft.csv).toContain("Earlier");
  expect(result.current.draft.fileName).toBeNull();
  expect(result.current.canImport).toBe(false);
  act(() => result.current.chooseFile(file));
  await flush();
  expect(result.current.draft).toMatchObject({ csv, fileName: "crew.csv" });
});
it("blocks import and edits during a same-turn file read and ignores a cancelled read's late result", async () => {
  let complete: (value: string) => void = () => {};
  api.file.mockImplementationOnce(
    () =>
      new Promise((done) => {
        complete = done;
      }),
  );
  const { result } = mount();
  await flush();
  act(() => result.current.changeText(csv));
  await flush();
  act(() => {
    result.current.chooseFile(new File([csv], "held.csv"));
    void result.current.send();
    result.current.changeText("replacement");
  });
  await flush();
  expect(api.write).not.toHaveBeenCalled();
  expect(result.current.draft.csv).toBe(csv);
  act(() => result.current.clearFile());
  await flush();
  act(() => result.current.changeText("new draft"));
  await flush();
  await act(async () => complete(csv));
  await flush();
  expect(result.current.draft.csv).toBe("new draft");
  expect(api.file.mock.calls[0][1].aborted).toBe(true);
});
