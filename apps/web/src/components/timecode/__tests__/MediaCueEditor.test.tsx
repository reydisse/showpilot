import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AutomationEventEditor } from "../AutomationEventEditor";
import { MediaOutputPanel } from "../MediaOutputPanel";
import type { NewAutomationEvent } from "@/hooks/useTimecode";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const format = { frameRate: 30, dropFrame: "ndf" } as const;
const asset = {
  id: "90f9f5ae-6213-4dd5-b39e-174b44ff7907",
  name: "Bumper.wav",
  size: 500,
  mimeType: "audio/wav",
  etag: '"fixture"',
  uploadedAt: "2026-11-06T00:00:00.000Z",
};

it("saves the selected file version and volume, and retains them after a failed save", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ assets: [asset], cursor: null })),
  );
  const save = vi.fn(async (_event: NewAutomationEvent) => {
    throw new Error("Save not confirmed");
  });
  render(
    <AutomationEventEditor
      orgId="org"
      connected
      format={format}
      onAdd={save}
    />,
  );
  fireEvent.change(screen.getByPlaceholderText("00:05:00:00"), {
    target: { value: "00:00:10:00" },
  });
  fireEvent.change(screen.getByRole("combobox"), {
    target: { value: "media-play" },
  });
  expect(screen.getByRole("button", { name: "Add Event" })).toHaveProperty(
    "disabled",
    true,
  );
  await screen.findByRole("option", { name: asset.name });
  fireEvent.change(screen.getByLabelText("Media clip"), {
    target: { value: asset.id },
  });
  fireEvent.change(screen.getByLabelText("Media output name"), {
    target: { value: "  Lobby  " },
  });
  fireEvent.change(screen.getByLabelText("Media volume (%)"), {
    target: { value: "60" },
  });
  expect(document.querySelector("textarea")).toBeNull();
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Add Event" })),
  );
  expect(save.mock.calls[0][0]).toMatchObject({
    action: "media-play",
    payload: {
      output: "Lobby",
      mediaId: asset.id,
      etag: asset.etag,
      volume: 0.6,
    },
  });
  expect(screen.getByRole("alert").textContent).toBe("Save not confirmed");
  expect(screen.getByLabelText("Media clip")).toHaveProperty("value", asset.id);
  expect(screen.getByLabelText("Media volume (%)")).toHaveProperty(
    "value",
    "60",
  );
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Add Event" })),
  );
  expect(save.mock.calls[1][0].id).toBe(save.mock.calls[0][0].id);
  fireEvent.change(screen.getByLabelText("Media volume (%)"), {
    target: { value: "101" },
  });
  expect(screen.getByRole("button", { name: "Add Event" })).toHaveProperty(
    "disabled",
    true,
  );
});

it("offers retry after a media list failure and removes stale asset selection on refresh", async () => {
  const fetch = vi
    .fn()
    .mockRejectedValueOnce(new Error("Offline"))
    .mockResolvedValueOnce(Response.json({ assets: [asset], cursor: null }))
    .mockResolvedValueOnce(Response.json({ assets: [], cursor: null }));
  vi.stubGlobal("fetch", fetch);
  render(
    <AutomationEventEditor
      orgId="org"
      connected
      format={format}
      onAdd={async () => {}}
    />,
  );
  fireEvent.change(screen.getByRole("combobox"), {
    target: { value: "media-play" },
  });
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Refresh media clips" }));
  await screen.findByRole("option", { name: asset.name });
  fireEvent.change(screen.getByLabelText("Media clip"), {
    target: { value: asset.id },
  });
  fireEvent.click(screen.getByRole("button", { name: "Refresh media clips" }));
  await screen.findByText(/Upload a clip in the Media library/);
  expect(screen.getByLabelText("Media clip")).toHaveProperty("value", "");
  expect(screen.getByRole("button", { name: "Add Event" })).toHaveProperty(
    "disabled",
    true,
  );
});

it("saves Stop without carrying stale action JSON or requiring a file", async () => {
  const save = vi.fn(async (_event: NewAutomationEvent) => {});
  render(<AutomationEventEditor connected format={format} onAdd={save} />);
  fireEvent.change(screen.getByPlaceholderText("00:05:00:00"), {
    target: { value: "00:00:10:00" },
  });
  fireEvent.change(screen.getByRole("combobox"), {
    target: { value: "media-stop" },
  });
  expect(screen.queryByLabelText("Media clip")).toBeNull();
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Add Event" })),
  );
  expect(save.mock.calls[0][0]).toMatchObject({
    action: "media-stop",
    payload: { output: "Program" },
  });
});

it("pins the output link to the selected show and labels disconnected reports as unconfirmed", () => {
  render(
    <MediaOutputPanel
      orgSlug="org"
      showId="show-2"
      connected={false}
      outputs={[
        {
          name: "Program",
          status: "playing",
          mediaName: "Bumper.wav",
          error: null,
        },
      ]}
    />,
  );
  const link = screen.getByRole("link", { name: "Open media output" });
  expect(link.getAttribute("href")).toBe(
    "/media/org?showId=show-2&output=Program",
  );
  expect(screen.getByRole("status").textContent).toContain("unconfirmed");
  expect(screen.getByText(/Last reported playing/)).toBeTruthy();
});
