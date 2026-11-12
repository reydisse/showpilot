import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ShowInventoryEditor } from "../ShowInventoryEditor";
const rpc = vi.hoisted(() => ({ mutate: vi.fn() }));
vi.mock("@/lib/show-inventory", () => ({
  mutateShowInventory: rpc.mutate,
  reviewShowInventory: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const item = {
  id: "item",
  name: "Reusable show",
  description: "",
  location: "",
  defaultStartTime: null,
  sourceTemplateId: null,
  itemCount: 0,
  archivedAt: null,
  updatedAt: "2026-01-01T00:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
};
function setup(canManage = true) {
  const client = new QueryClient();
  const props = {
    orgId: "org",
    userId: "user",
    inventory: [item],
    archivedInventory: [
      { ...item, id: "archived", archivedAt: item.updatedAt },
    ],
    savedTemplates: [{ id: "source", name: "Saved rundown", itemCount: 1 }],
    canManage,
    onUse: vi.fn(),
    onChanged: vi.fn(async () => {}),
  };
  const draw = (sources = props.savedTemplates) => (
    <QueryClientProvider client={client}>
      <ShowInventoryEditor {...props} savedTemplates={sources} />
    </QueryClientProvider>
  );
  return { ...render(draw()), draw, props };
}
it("requires an explicit archive confirmation with its scope and keeps cancellation write-free", async () => {
  rpc.mutate.mockImplementation(async ({ data }) => ({
    requestId: data.requestId,
    id: data.operation.id,
    outcome: "applied",
    item: null,
  }));
  setup();
  fireEvent.click(
    screen.getByRole("button", { name: "Archive Reusable show" }),
  );
  expect(screen.getByText(/Scheduled shows are unchanged/)).toBeTruthy();
  expect(rpc.mutate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(rpc.mutate).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "Archive Reusable show" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Archive show" }));
  await waitFor(() => expect(rpc.mutate).toHaveBeenCalledTimes(1));
  expect(rpc.mutate.mock.calls[0][0].data.operation).toMatchObject({
    id: "item",
    archived: true,
    expectedUpdatedAt: item.updatedAt,
  });
});
it("preserves an unavailable source and requires an explicit replacement", () => {
  const view = setup();
  fireEvent.change(screen.getByLabelText("Show name"), {
    target: { value: "Draft" },
  });
  fireEvent.change(screen.getByLabelText("Rundown source (optional)"), {
    target: { value: "source" },
  });
  view.rerender(view.draw([]));
  expect(screen.getByLabelText("Rundown source (optional)")).toHaveProperty(
    "value",
    "source",
  );
  expect(screen.getByRole("alert").textContent).toContain("unavailable");
  expect(
    (
      screen.getByRole("button", {
        name: "Add to inventory",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  fireEvent.change(screen.getByLabelText("Rundown source (optional)"), {
    target: { value: "" },
  });
  expect(
    (
      screen.getByRole("button", {
        name: "Add to inventory",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
  expect(rpc.mutate).not.toHaveBeenCalled();
});
it("view-only members have no creation, archive, or restore controls", () => {
  setup(false);
  expect(
    screen.queryByRole("button", { name: /Archive|Restore|Add to inventory/ }),
  ).toBeNull();
  expect(
    screen.getByRole("button", { name: "Use Reusable show" }),
  ).toBeTruthy();
});
