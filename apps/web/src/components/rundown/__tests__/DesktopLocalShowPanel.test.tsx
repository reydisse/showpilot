import type { ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { localShowFixture } from "@/test/local-show-fixture";
import { DesktopLocalShowPanel } from "../DesktopLocalShowPanel";
import { DesktopLocalShowNotice } from "@/components/layout/DesktopLocalShowNotice";

const mocks = vi.hoisted(() => ({
  native: vi.fn(),
  prepare: vi.fn(),
  open: vi.fn(),
  desktop: true,
}));
vi.mock("@/lib/desktop-runtime", () => ({
  invokeDesktopLocalShow: mocks.native,
  isDesktopRuntime: () => mocks.desktop,
  openDesktopLocalShow: mocks.open,
}));
vi.mock("@/lib/local-show", () => ({ prepareLocalShow: mocks.prepare }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    params,
    search,
  }: {
    children: ReactNode;
    params: { slug: string };
    search: { show: string; date: string };
  }) => (
    <a href={`/${params.slug}/rundown?show=${search.show}&date=${search.date}`}>
      {children}
    </a>
  ),
}));
const props = {
  orgId: "org-1",
  showId: "show-1",
  serviceDate: "2026-11-06",
  slug: "fixture",
  cloudRevision: 7,
  cloudReady: true,
  canControl: true,
  canPrepare: true,
};
let fixture: ReturnType<typeof localShowFixture>;
beforeEach(() => {
  fixture = localShowFixture();
  mocks.desktop = true;
  mocks.native.mockReset().mockImplementation(fixture.invoke);
  mocks.open.mockReset().mockResolvedValue(undefined);
  mocks.prepare.mockReset().mockImplementation(async ({ data }) =>
    fixture.prepare({
      ...fixture.preparation,
      ...data,
      baseRevision: data.expectedRevision,
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const button = (name: string) => screen.getByRole("button", { name });
async function approve(name: string) {
  fireEvent.click(
    within(await screen.findByRole("dialog")).getByRole("button", { name }),
  );
}

it("prepares the exact saved cloud revision for this native installation and verifies receipt", async () => {
  render(<DesktopLocalShowPanel {...props} />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Prepare this show" }),
  );
  await screen.findByText(/Saved on this computer/);
  expect(mocks.prepare).toHaveBeenCalledWith({
    data: expect.objectContaining({
      orgId: props.orgId,
      showId: props.showId,
      serviceDate: props.serviceDate,
      expectedRevision: 7,
      installationId: "installation-1",
      sessionId: expect.any(String),
    }),
  });
  expect(fixture.status().mode).toBe("prepared");
  fireEvent.click(button("Open local controls"));
  await waitFor(() => expect(mocks.open).toHaveBeenCalledOnce());
});
it("disables preparation before cloud hydration or without permissions", async () => {
  const ui = render(<DesktopLocalShowPanel {...props} cloudReady={false} />);
  expect(
    (
      await screen.findByRole("button", { name: "Prepare this show" })
    ).hasAttribute("disabled"),
  ).toBe(true);
  ui.rerender(<DesktopLocalShowPanel {...props} canPrepare={false} />);
  expect(button("Prepare this show").hasAttribute("disabled")).toBe(true);
  expect(mocks.prepare).not.toHaveBeenCalled();
});
it("keeps a conflict for review, allows a guarded retry, and requires discard confirmation", async () => {
  fixture.prepare();
  await fixture.finish();
  const fetcher = vi.fn(async () =>
    Response.json(
      { ...props, ok: false, revision: 11, reason: "revision-conflict" },
      { status: 409 },
    ),
  );
  vi.stubGlobal("fetch", fetcher);
  render(<DesktopLocalShowPanel {...props} cloudRevision={11} />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Review and retry saved sync" }),
  );
  expect(fetcher).not.toHaveBeenCalled();
  await approve("Sync timer progress");
  await screen.findByText(/Both versions are preserved/);
  expect(fixture.status().mode).toBe("finished");
  expect(fixture.outputCount()).toBe(1);
  fireEvent.click(button("Keep cloud and discard local record"));
  await approve("Cancel");
  expect(fixture.status().mode).toBe("finished");
  await waitFor(() =>
    expect(
      button("Keep cloud and discard local record").hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(button("Keep cloud and discard local record"));
  await approve("Discard local record");
  await screen.findByText(/Local record discarded/);
  expect(fixture.status().mode).toBe("empty");
});
it("rechecks current access after confirmation", async () => {
  fixture.prepare();
  await fixture.finish();
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const ui = render(<DesktopLocalShowPanel {...props} />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Review and sync" }),
  );
  await screen.findByRole("dialog");
  ui.rerender(<DesktopLocalShowPanel {...props} canControl={false} />);
  await approve("Sync timer progress");
  expect((await screen.findByRole("alert")).textContent).toContain("unlock");
  expect(fetcher).not.toHaveBeenCalled();
});
it("cannot discard a session that became active while confirmation was open", async () => {
  fixture.prepare();
  render(<DesktopLocalShowPanel {...props} />);
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Keep cloud and discard local record",
    }),
  );
  await screen.findByRole("dialog");
  await fixture.invoke({
    operation: "begin",
    sessionId: fixture.preparation.sessionId,
    confirmed: true,
  });
  await approve("Discard local record");
  expect((await screen.findByRole("alert")).textContent).toContain(
    "session changed",
  );
  expect(fixture.status().mode).toBe("active");
});
it("links a different show in this workspace without offering its sync or discard here", async () => {
  fixture.prepare({ ...fixture.preparation, showId: "other-show" });
  render(<DesktopLocalShowPanel {...props} />);
  expect(
    (
      await screen.findByRole("link", { name: "Review saved show's rundown" })
    ).getAttribute("href"),
  ).toBe("/fixture/rundown?show=other-show&date=2026-11-06");
  expect(
    screen.queryByRole("button", {
      name: "Keep cloud and discard local record",
    }),
  ).toBeNull();
});
it("does not expose another workspace's show details or review link", async () => {
  fixture.prepare();
  render(<DesktopLocalShowPanel {...props} orgId="other-org" />);
  await screen.findByText(/A different show is saved/);
  expect(screen.queryByText("Fixture service")).toBeNull();
  expect(screen.queryByRole("link")).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Download local record" }),
  ).toBeNull();
});
it("does not render or invoke the native engine in a browser", async () => {
  mocks.desktop = false;
  render(<DesktopLocalShowPanel {...props} />);
  await act(async () => {});
  expect(screen.queryByRole("region", { name: "Local show" })).toBeNull();
  expect(mocks.native).not.toHaveBeenCalled();
});
it("exports the public record without device credentials", async () => {
  fixture.prepare();
  await fixture.finish();
  let downloaded: Blob | undefined;
  vi.stubGlobal(
    "URL",
    Object.assign(URL, {
      createObjectURL: vi.fn((blob: Blob) => {
        downloaded = blob;
        return "blob:fixture";
      }),
      revokeObjectURL: vi.fn(),
    }),
  );
  const clicked = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => {});
  render(<DesktopLocalShowPanel {...props} />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Download local record" }),
  );
  await waitFor(() => expect(clicked).toHaveBeenCalledOnce());
  if (!downloaded) throw Error("Missing download");
  const blob = downloaded;
  const exported = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsText(blob);
  });
  expect(JSON.parse(exported)).toMatchObject({
    sessionId: "local-session",
    results: [{ result: "acknowledged" }],
  });
  expect(exported).not.toContain("fixture-private-password");
  expect(exported).not.toContain("127.0.0.1");
});

it("links saved progress from the Desktop toolbar only in its workspace", async () => {
  fixture.prepare();
  await fixture.finish();
  const ui = render(<DesktopLocalShowNotice orgId="org-1" slug="fixture" />);
  expect(
    (
      await screen.findByRole("link", { name: "Review saved local progress" })
    ).getAttribute("href"),
  ).toBe("/fixture/rundown?show=show-1&date=2026-11-06");
  ui.rerender(<DesktopLocalShowNotice orgId="other-org" slug="other" />);
  expect(screen.queryByRole("link")).toBeNull();
  expect(screen.getByRole("status").textContent).toContain(
    "Open its workspace",
  );
  expect(screen.queryByText("Fixture service")).toBeNull();
});
it("removes the saved-progress notice once the native sync receipt is present", async () => {
  fixture.prepare();
  await fixture.finish();
  await fixture.invoke({
    operation: "reconciled",
    sessionId: fixture.preparation.sessionId,
    expectedSequence: 3,
  });
  render(<DesktopLocalShowNotice orgId="org-1" slug="fixture" />);
  await act(async () => {});
  expect(screen.queryByRole("link")).toBeNull();
  expect(screen.queryByRole("status")).toBeNull();
});
