import {
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useState, useSyncExternalStore } from "react";
import { writeKioskTeam, type AdminTeam } from "@/lib/kiosk-admin";
import {
  kioskTeamCommandSchema,
  kioskTeamResultSchema,
  type KioskTeamCommand,
} from "@/lib/kiosk-team-contract";
import { withOperationTimeout } from "@/lib/operation-timeout";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { Button } from "@/components/ui/button";
const COLORS = [
  ["Cyan", "#22d3ee"],
  ["Blue", "#3b82f6"],
  ["Purple", "#8b5cf6"],
  ["Pink", "#ec4899"],
  ["Red", "#f43f5e"],
  ["Amber", "#f59e0b"],
  ["Green", "#10b981"],
  ["Slate", "#64748b"],
] as const;
type Draft = { name: string; color: string };
type EditorState = {
  create: Draft;
  editing: (Draft & { id: string; revision: number }) | null;
  people: Record<string, string>;
};
const initial = (): EditorState => ({
  create: { name: "", color: COLORS[0][1] },
  editing: null,
  people: {},
});
const inputClass =
  "min-h-11 w-full min-w-0 rounded-lg border border-board-border bg-board-bg px-3 text-sm text-board-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fire-500";
function ColorPicker({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <fieldset disabled={disabled}>
      <legend className="mb-1 text-xs text-board-muted">{label}</legend>
      <div className="flex flex-wrap gap-1">
        {COLORS.map(([name, color]) => (
          <Button
            key={color}
            type="button"
            variant="outline"
            className="h-11 w-11 p-0"
            aria-label={name}
            aria-pressed={value === color}
            onClick={() => onChange(color)}
          >
            <span
              aria-hidden
              className={`h-5 w-5 rounded-full ${value === color ? "ring-2 ring-white ring-offset-2 ring-offset-board-bg" : ""}`}
              style={{ background: color }}
            />
          </Button>
        ))}
      </div>
    </fieldset>
  );
}
export function KioskTeamEditor({
  orgId,
  userId,
  teams,
  members,
  onChange,
  readFailed = false,
}: {
  orgId: string;
  userId: string;
  teams: AdminTeam[];
  members: { id: string; name: string; image: string | null }[];
  onChange: () => void;
  readFailed?: boolean;
}) {
  const client = useQueryClient();
  const draftKey = ["kiosk-team-editor", orgId, userId],
    mutationKey = ["kiosk-team-command", orgId, userId];
  const { data: storedDraft } = useQuery({
    queryKey: draftKey,
    queryFn: initial,
    initialData: initial,
    enabled: false,
    gcTime: Infinity,
  });
  // Subscribe synchronously for controlled inputs and acknowledgements from a
  // command that started in a previous editor mount.
  const subscribe = useCallback(
    (changed: () => void) => client.getQueryCache().subscribe(changed),
    [client],
  );
  const draft = useSyncExternalStore(
    subscribe,
    () => client.getQueryData<EditorState>(draftKey) ?? storedDraft,
    () => storedDraft,
  );
  const edit = (update: (previous: EditorState) => EditorState) =>
    client.setQueryData<EditorState>(draftKey, (previous) =>
      update(previous ?? initial()),
    );
  const { confirm, ConfirmDialogEl } = useConfirmDialog();
  const [confirming, setConfirming] = useState(false);
  const history = useMutationState({
    filters: { mutationKey, exact: true },
    select: (mutation) => {
      const command = kioskTeamCommandSchema.safeParse(
          mutation.state.variables,
        ),
        result = kioskTeamResultSchema.safeParse(mutation.state.data);
      return {
        status: mutation.state.status,
        command: command.success ? command.data : null,
        result: result.success ? result.data : null,
        error: mutation.state.error,
        at: mutation.state.submittedAt,
      };
    },
  });
  const latest = history.at(-1),
    pending = latest?.status === "pending";
  const unfinished =
    latest?.command && (pending || latest.status === "error")
      ? latest.command
      : null;
  const locked = Boolean(unfinished) || confirming;
  const disabled = locked || readFailed;
  const mutation = useMutation({
    mutationKey,
    retry: false,
    networkMode: "always",
    gcTime: Infinity,
    mutationFn: async (command: KioskTeamCommand) => {
      const controller = new AbortController();
      try {
        return kioskTeamResultSchema.parse(
          await withOperationTimeout(
            writeKioskTeam({ data: command, signal: controller.signal }),
            10_000,
            "Team command was not confirmed. Retry the same command to recover its result.",
          ),
        );
      } finally {
        controller.abort();
      }
    },
    onSuccess: (result, command) => {
      if (result.outcome === "applied")
        edit((previous) => ({
          ...previous,
          create:
            command.action === "create" ? initial().create : previous.create,
          editing:
            (command.action === "update" || command.action === "delete") &&
            previous.editing?.id === command.id
              ? null
              : previous.editing,
          people:
            command.action === "set-member"
              ? { ...previous.people, [command.id]: "" }
              : previous.people,
        }));
      onChange();
    },
    onSettled: () => {
      for (const old of client
        .getMutationCache()
        .findAll({ mutationKey, exact: true }))
        if (old.state.status !== "pending")
          client.getMutationCache().remove(old);
    },
  });
  const send = (command: KioskTeamCommand) => {
    if (!disabled)
      mutation.mutate(
        command.action === "create" || command.action === "update"
          ? {
              ...command,
              name: command.name.trim(),
              color: command.color.trim(),
            }
          : command,
      );
  };
  const scope = () => ({ orgId, requestId: crypto.randomUUID() });
  const guarded = async (
    command: KioskTeamCommand,
    title: string,
    description: string,
    label: string,
  ) => {
    if (disabled) return;
    setConfirming(true);
    const accepted = await confirm({
      title,
      description,
      confirmLabel: label,
      variant: "warning",
    });
    setConfirming(false);
    if (accepted) mutation.mutate(command);
  };
  const discard = async () => {
    if (locked) return;
    if (
      await confirm({
        title: "Discard team edits?",
        description: "Your unsaved name and color changes will be discarded.",
        confirmLabel: "Discard edits",
        variant: "warning",
      })
    )
      edit((previous) => ({ ...previous, editing: null }));
  };
  return (
    <section aria-label="Kiosk org chart" className="space-y-4">
      {ConfirmDialogEl}
      {pending ? (
        <p role="status" className="text-sm text-board-muted">
          Waiting for the team command to be confirmed…
        </p>
      ) : null}
      {unfinished && !pending ? (
        <div role="alert" className="space-y-2 text-sm text-amber-200">
          <p>
            {latest?.error instanceof Error
              ? latest.error.message
              : "Team command was not confirmed."}{" "}
            Your draft is retained.
          </p>
          <p>
            Last attempt{" "}
            <time dateTime={new Date(latest?.at ?? 0).toISOString()}>
              {new Date(latest?.at ?? 0).toLocaleTimeString()}
            </time>
          </p>
          <Button
            className="min-h-11 h-auto whitespace-normal"
            variant="outline"
            onClick={() => mutation.mutate(unfinished)}
          >
            Retry team command
          </Button>
        </div>
      ) : null}
      {!unfinished && latest?.result ? (
        <p
          role={latest.result.outcome === "conflict" ? "alert" : "status"}
          className="text-sm text-board-muted"
        >
          {latest.result.outcome === "conflict"
            ? "The team or organization membership changed after you reviewed it. Your command was not applied. Review the current team before trying again."
            : "The original team command was saved. The list shows the latest confirmed teams."}
        </p>
      ) : null}
      <form
        aria-label="New kiosk team"
        className="space-y-3 rounded-xl border border-board-border bg-board-card p-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (draft.create.name.trim())
            send({ ...scope(), action: "create", ...draft.create });
        }}
      >
        <label className="block space-y-1 text-sm text-board-text">
          <span>New team name</span>
          <input
            className={inputClass}
            maxLength={200}
            required
            placeholder="New team name (e.g. Audio)"
            value={draft.create.name}
            disabled={disabled}
            onChange={(e) =>
              edit((previous) => ({
                ...previous,
                create: { ...previous.create, name: e.target.value },
              }))
            }
          />
        </label>
        <ColorPicker
          label="New team color"
          value={draft.create.color}
          disabled={disabled}
          onChange={(color) =>
            edit((previous) => ({
              ...previous,
              create: { ...previous.create, color },
            }))
          }
        />
        <Button
          type="submit"
          className="min-h-11"
          disabled={disabled || !draft.create.name.trim()}
        >
          Add Team
        </Button>
      </form>
      {!teams.length ? (
        <p className="py-6 text-center text-sm text-board-muted">
          No teams yet. Add one above to build the org chart.
        </p>
      ) : (
        teams.map((team) => {
          const editing = draft.editing?.id === team.id ? draft.editing : null,
            available = members.filter(
              (person) => !team.members.some((m) => m.userId === person.id),
            );
          const selected = draft.people[team.id] ?? "",
            lead = team.members.find((person) => person.role === "lead");
          return (
            <article
              key={team.id}
              aria-label={`${team.name} team`}
              className="min-w-0 space-y-3 rounded-xl border border-board-border bg-board-card p-4"
              style={{ borderLeft: `3px solid ${team.color}` }}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="min-w-0 break-words text-sm font-semibold text-board-text">
                  {team.name}
                </h3>
                <div className="flex flex-wrap gap-2">
                  <Button
                    className="min-h-11"
                    variant="outline"
                    disabled={disabled || Boolean(draft.editing)}
                    onClick={() =>
                      edit((previous) => ({
                        ...previous,
                        editing: {
                          id: team.id,
                          name: team.name,
                          color: team.color,
                          revision: team.revision,
                        },
                      }))
                    }
                  >
                    Edit team
                  </Button>
                  <Button
                    className="min-h-11"
                    variant="outline"
                    title="Delete team"
                    disabled={disabled}
                    onClick={() =>
                      void guarded(
                        {
                          ...scope(),
                          action: "delete",
                          id: team.id,
                          revision: team.revision,
                        },
                        `Delete ${team.name}?`,
                        "This removes the kiosk team and its org-chart membership. Organization accounts and on-duty assignments are kept.",
                        "Delete team",
                      )
                    }
                  >
                    Delete team
                  </Button>
                </div>
              </div>
              {editing ? (
                <form
                  aria-label={`Edit ${team.name}`}
                  className="space-y-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    send({ ...scope(), action: "update", ...editing });
                  }}
                >
                  <label className="block space-y-1 text-sm text-board-text">
                    <span>Team name</span>
                    <input
                      className={inputClass}
                      maxLength={200}
                      required
                      value={editing.name}
                      disabled={disabled}
                      onChange={(e) =>
                        edit((previous) => ({
                          ...previous,
                          editing: { ...editing, name: e.target.value },
                        }))
                      }
                    />
                  </label>
                  <ColorPicker
                    label="Team color"
                    value={editing.color}
                    disabled={disabled}
                    onChange={(color) =>
                      edit((previous) => ({
                        ...previous,
                        editing: { ...editing, color },
                      }))
                    }
                  />
                  {editing.revision !== team.revision ? (
                    <div
                      role="alert"
                      className="space-y-2 text-sm text-amber-200"
                    >
                      <p>
                        This team changed while you were editing. Your draft is
                        kept. Review the current name, color and membership
                        above before applying it.
                      </p>
                      <Button
                        type="button"
                        variant="outline"
                        className="min-h-11 h-auto whitespace-normal"
                        disabled={disabled}
                        onClick={async () => {
                          if (
                            await confirm({
                              title: "Apply draft to the current team?",
                              description: `Keep your draft name and color, using the latest ${team.name} team revision.`,
                              confirmLabel: "Use reviewed team",
                              variant: "warning",
                            })
                          )
                            edit((previous) => ({
                              ...previous,
                              editing: { ...editing, revision: team.revision },
                            }));
                        }}
                      >
                        Review latest team
                      </Button>
                    </div>
                  ) : null}
                  <div className="flex flex-wrap gap-2">
                    <Button
                      className="min-h-11"
                      type="submit"
                      disabled={
                        disabled ||
                        editing.revision !== team.revision ||
                        !editing.name.trim()
                      }
                    >
                      Save team
                    </Button>
                    <Button
                      className="min-h-11"
                      variant="outline"
                      type="button"
                      disabled={locked}
                      onClick={() => void discard()}
                    >
                      Cancel edits
                    </Button>
                  </div>
                </form>
              ) : null}
              <ul className="space-y-2">
                {team.members.map((person) => (
                  <li
                    key={person.userId}
                    className="flex flex-col gap-2 rounded-lg bg-board-bg p-2 sm:flex-row sm:flex-wrap sm:items-center"
                  >
                    <span className="w-full min-w-0 break-words text-sm text-board-text sm:w-auto sm:min-w-32 sm:flex-1">
                      {person.name}
                      {person.role === "lead" ? " · Lead" : ""}
                    </span>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        className="min-h-11 h-auto whitespace-normal"
                        variant="outline"
                        disabled={disabled}
                        onClick={() =>
                          void guarded(
                            {
                              ...scope(),
                              action: "set-member",
                              id: team.id,
                              revision: team.revision,
                              userId: person.userId,
                              role: person.role === "lead" ? "member" : "lead",
                            },
                            person.role === "lead"
                              ? `Remove ${person.name} as lead?`
                              : `Make ${person.name} lead?`,
                            person.role === "lead"
                              ? "They remain a member of this kiosk team."
                              : lead
                                ? `${lead.name} will become a member. The team has one lead.`
                                : "This makes them the kiosk team lead.",
                            person.role === "lead"
                              ? "Make member"
                              : "Make lead",
                          )
                        }
                      >
                        {person.role === "lead" ? "Make member" : "Make lead"}
                      </Button>
                      <Button
                        className="min-h-11 h-auto whitespace-normal"
                        variant="outline"
                        disabled={disabled}
                        aria-label={`Remove ${person.name} from kiosk team`}
                        onClick={() =>
                          void guarded(
                            {
                              ...scope(),
                              action: "remove-member",
                              id: team.id,
                              revision: team.revision,
                              userId: person.userId,
                            },
                            `Remove ${person.name}?`,
                            `Remove them from ${team.name} on the kiosk org chart. Their organization account is kept.`,
                            "Remove member",
                          )
                        }
                      >
                        Remove
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
              {available.length ? (
                <form
                  className="flex flex-col gap-2 sm:flex-row sm:items-end"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (selected)
                      send({
                        ...scope(),
                        action: "set-member",
                        id: team.id,
                        revision: team.revision,
                        userId: selected,
                        role: "member",
                      });
                  }}
                >
                  <label className="min-w-0 flex-1 space-y-1 text-sm text-board-text">
                    <span>Add member to {team.name}</span>
                    <select
                      className={inputClass}
                      disabled={disabled}
                      value={selected}
                      onChange={(e) =>
                        edit((previous) => ({
                          ...previous,
                          people: {
                            ...previous.people,
                            [team.id]: e.target.value,
                          },
                        }))
                      }
                    >
                      <option value="">Choose a person</option>
                      {available.map((person) => (
                        <option key={person.id} value={person.id}>
                          {person.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <Button
                    type="submit"
                    className="min-h-11"
                    disabled={
                      disabled ||
                      !available.some((person) => person.id === selected)
                    }
                  >
                    Add member
                  </Button>
                </form>
              ) : null}
            </article>
          );
        })
      )}
    </section>
  );
}
