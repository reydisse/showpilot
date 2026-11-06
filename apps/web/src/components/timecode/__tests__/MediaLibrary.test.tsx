import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MediaLibrary } from "../MediaLibrary";
import type { MediaPage } from "@/lib/media-library";

const api = vi.hoisted(() => ({
  load: vi.fn(),
  upload: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("@/lib/media-library-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/media-library-client")>()),
  loadMediaPage: api.load,
  uploadMedia: api.upload,
  deleteMedia: api.remove,
}));
const asset = {
  id: "3bb956da-95aa-496d-aaad-ec42535f6408",
  name: "Opening sting.wav",
  mimeType: "audio/wav",
  size: 44144,
  uploadedAt: "2026-11-06T00:00:00.000Z",
  etag: '"fixture"',
} as const;
beforeEach(() => {
  vi.clearAllMocks();
  api.load.mockResolvedValue({ assets: [], cursor: null });
  api.upload.mockResolvedValue(asset);
  api.remove.mockResolvedValue(undefined);
});
afterEach(cleanup);

it("shows loading, error and retry without presenting a failed request as an empty library", async () => {
  let fail: (error: Error) => void = () => {};
  api.load.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
  );
  render(<MediaLibrary orgId="one" />);
  expect(screen.getByText("Loading media…")).toBeTruthy();
  expect(screen.queryByText("No media uploaded yet.")).toBeNull();
  await act(async () => fail(new Error("Library timed out")));
  expect(screen.getByRole("alert").textContent).toContain("Library timed out");
  expect(screen.queryByText("No media uploaded yet.")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry loading media" }));
  await screen.findByText("No media uploaded yet.");
  expect(api.load).toHaveBeenCalledTimes(2);
});

it("preserves the chosen file and upload id after failure, and waits for acknowledgement before clearing it", async () => {
  api.upload.mockRejectedValueOnce(new Error("Upload interrupted"));
  render(<MediaLibrary orgId="one" />);
  await screen.findByText("No media uploaded yet.");
  const file = new File(["RIFF1234WAVE123456789"], asset.name, {
    type: "audio/wav",
  });
  fireEvent.change(screen.getByLabelText("Media file"), {
    target: { files: [file] },
  });
  fireEvent.click(screen.getByRole("button", { name: "Upload media" }));
  await screen.findByText(/Upload interrupted/);
  const id = api.upload.mock.calls[0][1];
  expect(api.upload.mock.calls[0][2]).toBe(file);
  fireEvent.click(screen.getByRole("button", { name: "Upload media" }));
  await screen.findByRole("button", { name: `Preview ${asset.name}` });
  expect(api.upload.mock.calls[1][1]).toBe(id);
  expect(screen.getByRole("button", { name: "Upload media" })).toHaveProperty(
    "disabled",
    true,
  );
  expect(screen.queryByRole("alert")).toBeNull();
});

it("requires deletion confirmation, retains a failed deletion, and lets the operator retry", async () => {
  api.load.mockResolvedValue({ assets: [asset], cursor: null });
  api.remove.mockRejectedValueOnce(new Error("Storage offline"));
  render(<MediaLibrary orgId="one" />);
  fireEvent.click(
    await screen.findByRole("button", { name: `Delete ${asset.name}` }),
  );
  expect(screen.getByRole("dialog").textContent).toContain(
    "Cues using this file will fail",
  );
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(api.remove).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: `Delete ${asset.name}` }));
  fireEvent.click(screen.getByRole("button", { name: "Delete media" }));
  await screen.findByText(/Storage offline/);
  expect(
    screen.getByRole("button", { name: `Preview ${asset.name}` }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: `Delete ${asset.name}` }));
  fireEvent.click(screen.getByRole("button", { name: "Delete media" }));
  await screen.findByText("No media uploaded yet.");
  expect(api.remove).toHaveBeenCalledTimes(2);
});

it("opens a single manual preview, exposes decoding failure, and removes playback on close", async () => {
  api.load.mockResolvedValue({ assets: [asset], cursor: null });
  render(<MediaLibrary orgId="one" />);
  expect(document.querySelector("video")).toBeNull();
  fireEvent.click(
    await screen.findByRole("button", { name: `Preview ${asset.name}` }),
  );
  const video = screen.getByLabelText(`Media preview: ${asset.name}`);
  expect(video).toHaveProperty("autoplay", false);
  expect(video.getAttribute("src")).toContain(`/api/media/one/${asset.id}`);
  fireEvent.error(video);
  expect(screen.getByRole("alert").textContent).toContain(
    "could not load or decode",
  );
  fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
  expect(document.querySelector("video")).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: `Preview ${asset.name}` }),
  );
  expect(screen.queryByRole("alert")).toBeNull();
});

it("aborts obsolete organization reads and ignores their late completion", async () => {
  let finish: (page: MediaPage) => void = () => {};
  api.load.mockImplementationOnce(
    () =>
      new Promise<MediaPage>((resolve) => {
        finish = resolve;
      }),
  );
  const view = render(<MediaLibrary key="one" orgId="one" />);
  const oldSignal = api.load.mock.calls[0][2];
  view.rerender(<MediaLibrary key="two" orgId="two" />);
  await screen.findByText("No media uploaded yet.");
  await act(async () => finish({ assets: [asset], cursor: null }));
  expect(oldSignal.aborted).toBe(true);
  expect(screen.queryByText(asset.name)).toBeNull();
});

it("retains the first page when loading more fails and deduplicates a retried page", async () => {
  api.load
    .mockResolvedValueOnce({ assets: [asset], cursor: "page-two" })
    .mockRejectedValueOnce(new Error("Next page unavailable"))
    .mockResolvedValueOnce({
      assets: [
        asset,
        {
          ...asset,
          id: "24bd2094-9573-4c58-97d1-c2c19376e167",
          name: "Second.wav",
        },
      ],
      cursor: null,
    });
  render(<MediaLibrary orgId="one" />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Load more media" }),
  );
  await screen.findByText(/Next page unavailable/);
  expect(screen.getByText(asset.name)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Load more media" }));
  await screen.findByText("Second.wav");
  expect(screen.getAllByText(asset.name)).toHaveLength(1);
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Load more media" }),
    ).toBeNull(),
  );
});
