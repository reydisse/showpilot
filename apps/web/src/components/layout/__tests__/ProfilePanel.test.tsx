import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProfilePanel } from "../ProfileModal";
import { profileNameCommandSchema } from "@/lib/account-profile-contract";

const api = vi.hoisted(() => ({
  read: vi.fn(),
  post: vi.fn(),
  prepare: vi.fn(),
  reset: vi.fn(),
  navigate: vi.fn(),
  updated: vi.fn(),
}));
vi.mock("@/lib/profile-photo", () => ({
  prepareProfilePhoto: api.prepare,
  PhotoPreparationError: class extends Error {},
}));
vi.mock("@/lib/auth-client", () => ({
  authClient: { requestPasswordReset: api.reset },
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => api.navigate }));
const state = { userId: "user-1", name: "Fixture", image: null, revision: 1 };
const user = {
  id: "user-1",
  name: "Fixture",
  email: "fixture@example.test",
  emailVerified: true,
};
const clients: QueryClient[] = [];
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
function mount() {
  const client = new QueryClient();
  clients.push(client);
  const ui = (id: string | null) => (
    <QueryClientProvider client={client}>
      {id ? (
        <ProfilePanel
          key={id}
          user={{ ...user, id }}
          role="owner"
          orgName="Fixture workspace"
          onUserUpdated={api.updated}
        />
      ) : null}
    </QueryClientProvider>
  );
  const view = render(ui(user.id));
  return { client, show: (id: string | null) => view.rerender(ui(id)) };
}
async function tick(ms = 30) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
function nameAt(index: number) {
  const body = api.post.mock.calls[index]?.[1]?.body;
  if (typeof body !== "string") throw new Error("Expected name request");
  return profileNameCommandSchema.parse(JSON.parse(body));
}
function save(name: string) {
  fireEvent.change(screen.getByLabelText("Display Name"), {
    target: { value: name },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
}
beforeEach(() => {
  vi.useFakeTimers();
  HTMLElement.prototype.scrollIntoView = vi.fn();
  api.read.mockImplementation(async () => Response.json(state));
  api.reset.mockResolvedValue({ data: { status: true }, error: null });
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) =>
      init?.method === "POST" ? api.post(url, init) : api.read(url, init),
    ),
  );
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("bounds the initial read without claiming saved and retains the draft through Retry", async () => {
  const held = deferred<Response>();
  api.read.mockReturnValueOnce(held.promise);
  mount();
  fireEvent.change(screen.getByLabelText("Display Name"), {
    target: { value: "Draft during read" },
  });
  expect(screen.queryByText("Saved")).toBeNull();
  await tick(8_100);
  expect(
    screen.getByRole("button", { name: "Retry profile check" }),
  ).toBeTruthy();
  expect(api.read.mock.calls[0][1].signal.aborted).toBe(true);
  held.resolve(Response.json({ ...state, name: "Late name" }));
  await tick();
  expect(screen.getByDisplayValue("Draft during read")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry profile check" }));
  await tick();
  expect(screen.getByDisplayValue("Draft during read")).toBeTruthy();
  expect(api.post).not.toHaveBeenCalled();
});

it("retains an uncertain name across panel closure and retries the exact request without replacing a newer profile", async () => {
  const held = deferred<Response>();
  api.post.mockReturnValueOnce(held.promise);
  const view = mount();
  await tick();
  save("My draft");
  await tick();
  const original = nameAt(0);
  view.show(null);
  await tick(8_100);
  view.show(user.id);
  await tick();
  expect(screen.getByDisplayValue("My draft")).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Retry profile save" }),
  ).toBeTruthy();
  held.resolve(
    Response.json({
      requestId: original.requestId,
      outcome: "applied",
      state: { ...state, name: "My draft", revision: 2 },
    }),
  );
  await tick();
  expect(
    screen.getByRole("button", { name: "Retry profile save" }),
  ).toBeTruthy();
  api.read.mockImplementation(async () =>
    Response.json({ ...state, name: "Newer profile", revision: 3 }),
  );
  api.post.mockResolvedValueOnce(
    Response.json({
      requestId: original.requestId,
      outcome: "superseded",
      state: { ...state, name: "Newer profile", revision: 3 },
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry profile save" }));
  await tick();
  expect(nameAt(1)).toEqual(original);
  expect(screen.getByText(/The newer profile was kept/)).toBeTruthy();
  expect(screen.getByText("Saved name: Newer profile")).toBeTruthy();
  expect(screen.getByDisplayValue("My draft")).toBeTruthy();
  expect(api.updated).toHaveBeenLastCalledWith({
    name: "Newer profile",
    image: "",
  });
});

it("does not claim that an empty name draft is saved", async () => {
  mount();
  await tick();
  fireEvent.change(screen.getByLabelText("Display Name"), {
    target: { value: "   " },
  });
  await tick();
  expect(screen.queryByText("Saved")).toBeNull();
  expect(screen.getByRole("button", { name: "Save changes" }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByText("Enter a display name.")).toBeTruthy();
});

it("does not clear typing that changed while the earlier name was saving", async () => {
  const held = deferred<Response>();
  api.post.mockReturnValueOnce(held.promise);
  mount();
  await tick();
  save("Submitted draft");
  await tick();
  fireEvent.change(screen.getByLabelText("Display Name"), {
    target: { value: "Next draft" },
  });
  api.read.mockImplementation(async () =>
    Response.json({ ...state, name: "Submitted draft", revision: 2 }),
  );
  held.resolve(
    Response.json({
      requestId: nameAt(0).requestId,
      outcome: "applied",
      state: { ...state, name: "Submitted draft", revision: 2 },
    }),
  );
  await tick();
  expect(screen.getByDisplayValue("Next draft")).toBeTruthy();
  expect(screen.queryByText("Saved")).toBeNull();
});

it("retries only the refresh after an acknowledged name save", async () => {
  api.post.mockImplementation(async (_url, init) => {
    const command = profileNameCommandSchema.parse(JSON.parse(init.body));
    api.read.mockRejectedValue(new Error("offline"));
    return Response.json({
      requestId: command.requestId,
      outcome: "applied",
      state: { ...state, name: command.name, revision: 2 },
    });
  });
  mount();
  await tick();
  save("Saved draft");
  await tick();
  expect(
    screen.getByRole("button", { name: "Retry profile check" }),
  ).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Retry profile save" }),
  ).toBeNull();
  api.read.mockImplementation(async () =>
    Response.json({ ...state, name: "Saved draft", revision: 2 }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry profile check" }));
  await tick();
  expect(api.post).toHaveBeenCalledTimes(1);
  expect(screen.getByText("Saved")).toBeTruthy();
});

it("retains the prepared photo and request across retries without re-encoding it", async () => {
  const blob = new Blob(["prepared-photo"], { type: "image/jpeg" });
  api.prepare.mockResolvedValue(blob);
  api.post.mockRejectedValueOnce(new Error("lost reply"));
  const view = mount();
  await tick();
  const input = document.querySelector("input[type=file]");
  if (!input) throw new Error("Missing photo input");
  fireEvent.change(input, {
    target: {
      files: [new File(["source"], "source.png", { type: "image/png" })],
    },
  });
  await tick();
  const first = api.post.mock.calls[0][1].body;
  expect(first).toBeInstanceOf(FormData);
  view.show(null);
  view.show(user.id);
  await tick();
  const image = `/api/user/avatar/user-1/${"a".repeat(64)}.jpg`;
  api.read.mockImplementation(async () =>
    Response.json({ ...state, image, revision: 2 }),
  );
  api.post.mockResolvedValueOnce(
    Response.json({
      requestId: first.get("requestId"),
      outcome: "applied",
      state: { ...state, image, revision: 2 },
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry profile save" }));
  await tick();
  const retry = api.post.mock.calls[1][1].body;
  expect(retry.get("requestId")).toBe(first.get("requestId"));
  expect(retry.get("expectedRevision")).toBe(first.get("expectedRevision"));
  expect(retry.get("file").size).toBe(blob.size);
  expect(api.prepare).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("img").getAttribute("src")).toBe(image);
});

it("never uploads a photo after preparation times out", async () => {
  const held = deferred<Blob>();
  api.prepare.mockReturnValueOnce(held.promise);
  mount();
  await tick();
  const input = document.querySelector("input[type=file]");
  if (!input) throw new Error("Missing photo input");
  fireEvent.change(input, {
    target: {
      files: [new File(["source"], "source.png", { type: "image/png" })],
    },
  });
  await tick(8_100);
  expect(
    screen.getByRole("button", { name: "Retry photo preparation" }),
  ).toBeTruthy();
  held.resolve(new Blob(["late"], { type: "image/jpeg" }));
  await tick();
  expect(api.post).not.toHaveBeenCalled();
});

it("retains uncertain reset-email recovery and its cooldown when the profile closes", async () => {
  const held = deferred<unknown>();
  api.reset.mockReturnValueOnce(held.promise);
  const view = mount();
  await tick();
  fireEvent.click(screen.getByRole("button", { name: "Reset password" }));
  await tick(8_100);
  expect(screen.getByText(/It may arrive/)).toBeTruthy();
  held.resolve({ data: { status: true }, error: null });
  await tick();
  expect(
    screen.queryByRole("button", { name: "Reset link requested" }),
  ).toBeNull();
  view.show(null);
  view.show(user.id);
  await tick();
  expect(
    screen
      .getByRole("button", { name: "Retry reset email" })
      .hasAttribute("disabled"),
  ).toBe(true);
  await tick(52_000);
  fireEvent.click(screen.getByRole("button", { name: "Retry reset email" }));
  await tick();
  expect(api.reset).toHaveBeenCalledTimes(2);
  expect(
    screen.getByRole("button", { name: "Reset link requested" }),
  ).toBeTruthy();
});

it("keeps a conflicted photo available for explicit application against the new revision", async () => {
  const blob = new Blob(["selected"], { type: "image/jpeg" });
  api.prepare.mockResolvedValue(blob);
  api.post.mockImplementationOnce(async (_url, init) => {
    api.read.mockImplementation(async () =>
      Response.json({ ...state, name: "Newer profile", revision: 3 }),
    );
    return Response.json({
      requestId: init.body.get("requestId"),
      outcome: "conflict",
      state: { ...state, name: "Newer profile", revision: 3 },
    });
  });
  const view = mount();
  await tick();
  const input = document.querySelector("input[type=file]");
  if (!input) throw new Error("Missing photo input");
  fireEvent.change(input, {
    target: {
      files: [new File(["source"], "source.png", { type: "image/png" })],
    },
  });
  await tick();
  const first = api.post.mock.calls[0][1].body;
  view.show(null);
  view.show(user.id);
  await tick();
  expect(
    screen.getByRole("button", { name: "Use selected photo" }),
  ).toBeTruthy();
  api.post.mockImplementationOnce(async (_url, init) => {
    const current = {
      ...state,
      name: "Newer profile",
      image: `/api/user/avatar/user-1/${"b".repeat(64)}.jpg`,
      revision: 4,
    };
    api.read.mockImplementation(async () => Response.json(current));
    return Response.json({
      requestId: init.body.get("requestId"),
      outcome: "applied",
      state: current,
    });
  });
  fireEvent.click(screen.getByRole("button", { name: "Use selected photo" }));
  await tick();
  const second = api.post.mock.calls[1][1].body;
  expect(second.get("requestId")).not.toBe(first.get("requestId"));
  expect(second.get("expectedRevision")).toBe("3");
  expect(api.prepare).toHaveBeenCalledTimes(1);
  expect(api.updated).toHaveBeenLastCalledWith({
    name: "Newer profile",
    image: `/api/user/avatar/user-1/${"b".repeat(64)}.jpg`,
  });
});
