import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CrewResponseRecovery } from "./CrewResponseRecovery";
import {
  useCrewResponseWork,
  type CrewPortalAssignment,
} from "@/hooks/useCrewResponseWork";
import type {
  CrewResponseCommand,
  CrewResponseResult,
} from "@/lib/crew-response-contract";
const selected: CrewPortalAssignment = {
  id: "assignment",
  revision: "revision",
  showId: "show",
  serviceDate: "2099-01-01",
  role: "Audio",
  status: "assigned",
  notes: "Bring headset",
  responseNote: "",
  callTime: "",
  invitedAt: null,
  respondedAt: null,
  responseVersion: "[1]",
  serviceName: "Sunday",
  scheduledStartTime: null,
  effectiveCallTime: null,
  location: "Main",
  responseWindow: { status: "open", closesAt: "2099-01-02T00:00:00.000Z" },
};
const reply = (
  command: CrewResponseCommand,
  outcome: CrewResponseResult["outcome"] = "applied",
) => ({
  requestId: command.requestId,
  assignmentId: command.assignmentId,
  outcome,
});
const clients: QueryClient[] = [];
function setup(
  send = vi.fn(
    async (
      command: CrewResponseCommand,
      _review: boolean,
      _signal: AbortSignal,
    ): Promise<unknown> => reply(command),
  ),
  refresh = async (_signal: AbortSignal) => {},
) {
  const client = new QueryClient();
  clients.push(client);
  function App({ latest = selected }: { latest?: CrewPortalAssignment }) {
    const work = useCrewResponseWork("a".repeat(43), { send, refresh }),
      entry = work.entries.assignment;
    return (
      <>
        <button onClick={() => work.decline(selected)}>Decline</button>
        {entry ? (
          <>
            <label>
              Note
              <textarea
                value={entry.reason}
                readOnly={!!entry.attempt}
                onChange={(event) =>
                  work.setReason(selected.id, event.target.value)
                }
              />
            </label>
            <button
              disabled={!!entry.attempt}
              onClick={() => work.submit(selected, "declined")}
            >
              Send decline
            </button>
            <CrewResponseRecovery entry={entry} latest={latest} work={work} />
          </>
        ) : null}
      </>
    );
  }
  const view = render(<App />, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  return { view, App, send };
}
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
});
const click = (name: string) =>
  fireEvent.click(screen.getByRole("button", { name }));
it("requires explicit discard and Keep preserves the note", () => {
  const { send } = setup();
  click("Decline");
  fireEvent.change(screen.getByLabelText("Note"), {
    target: { value: "Away" },
  });
  click("Discard response draft…");
  click("Keep draft");
  expect((screen.getByLabelText("Note") as HTMLTextAreaElement).value).toBe(
    "Away",
  );
  click("Discard response draft…");
  click("Discard draft");
  expect(screen.queryByLabelText("Note")).toBeNull();
  expect(send).not.toHaveBeenCalled();
});
it("shows retry and review for an unknown result without permitting discard", async () => {
  setup(
    vi.fn(async () => {
      throw new Error("Lost reply");
    }),
  );
  click("Decline");
  click("Send decline");
  await screen.findByRole("button", { name: "Retry original response" });
  expect(
    screen.getByRole("button", { name: "Review original response" }),
  ).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Discard response draft…" }),
  ).toBeNull();
  expect((screen.getByLabelText("Note") as HTMLTextAreaElement).readOnly).toBe(
    true,
  );
});
it("keeps a confirmed result visible through refresh failure", async () => {
  const refresh = vi
    .fn()
    .mockRejectedValueOnce(new Error("Read failed"))
    .mockResolvedValue(undefined);
  const { send } = setup(undefined, refresh);
  click("Decline");
  click("Send decline");
  await screen.findByText("Your response was saved.");
  await screen.findByRole("button", { name: "Refresh assignments only" });
  click("Refresh assignments only");
  await screen.findByRole("button", { name: "Finish response" });
  expect(send).toHaveBeenCalledTimes(1);
});
it("freezes the current-details confirmation while the underlying selection changes", async () => {
  const { view, App, send } = setup(
    vi.fn(async (command) => reply(command, "conflict")),
  );
  click("Decline");
  fireEvent.change(screen.getByLabelText("Note"), {
    target: { value: "Keep this" },
  });
  click("Send decline");
  await screen.findByText(/Your original response was not applied/);
  const reviewed = { ...selected, revision: "second", role: "Camera" };
  view.rerender(<App latest={reviewed} />);
  click("Review current assignment…");
  view.rerender(
    <App latest={{ ...selected, revision: "third", role: "Lighting" }} />,
  );
  expect(screen.getByText(/Use the current details for Camera/)).toBeTruthy();
  click("Use current assignment");
  expect((screen.getByLabelText("Note") as HTMLTextAreaElement).value).toBe(
    "Keep this",
  );
  click("Send decline");
  await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
  expect(send.mock.calls[1][0].expectedRevision).toBe("second");
});
