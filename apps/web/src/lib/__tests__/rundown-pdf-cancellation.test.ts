import { afterEach, expect, it, vi } from "vitest";
import { exportRundownPdf, type ExportReport } from "../rundown-export";
const mocks = vi.hoisted(() => ({ getBlob: vi.fn() }));
vi.mock("pdfmake/build/pdfmake.js", () => ({
  default: {
    addVirtualFileSystem: vi.fn(),
    createPdf: () => ({ getBlob: mocks.getBlob }),
  },
}));
vi.mock("pdfmake/build/vfs_fonts.js", () => ({ default: {} }));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  mocks.getBlob.mockReset();
});
const report: ExportReport = {
  generatedAt: "2026-11-07T12:00:00Z",
  serviceDate: "2026-11-07",
  organization: { id: "org", name: "Fixture", slug: "fixture" },
  summary: {
    totalItems: 0,
    completedItems: 0,
    plannedDurationMs: 0,
    elapsedMs: 0,
  },
  rundown: { items: [], stageMessage: "" },
  incidents: [],
};
it("does not download a PDF whose generation finishes after cancellation", async () => {
  let finish!: (blob: Blob) => void;
  mocks.getBlob.mockImplementation(
    () =>
      new Promise<Blob>((resolve) => {
        finish = resolve;
      }),
  );
  const createObjectURL = vi.fn();
  vi.stubGlobal("URL", { createObjectURL, revokeObjectURL: vi.fn() });
  const controller = new AbortController(),
    promise = exportRundownPdf(report, controller.signal);
  const rejection = expect(promise).rejects.toMatchObject({
    name: "AbortError",
  });
  await vi.waitFor(() => expect(mocks.getBlob).toHaveBeenCalledOnce());
  controller.abort();
  finish(new Blob(["pdf"], { type: "application/pdf" }));
  await rejection;
  expect(createObjectURL).not.toHaveBeenCalled();
});
it("downloads the completed PDF with its show report filename", async () => {
  vi.useFakeTimers();
  const blob = new Blob(["pdf"], { type: "application/pdf" });
  mocks.getBlob.mockResolvedValue(blob);
  const createObjectURL = vi.fn(() => "blob:report");
  vi.stubGlobal("URL", { createObjectURL, revokeObjectURL: vi.fn() });
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe("fixture-2026-11-07-report.pdf");
    });
  await exportRundownPdf(report);
  expect(createObjectURL).toHaveBeenCalledWith(blob);
  expect(click).toHaveBeenCalledOnce();
  await vi.runAllTimersAsync();
});
