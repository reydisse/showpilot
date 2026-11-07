import { useState } from "react";
import {
  useMutation,
  useMutationState,
  useQueryClient,
} from "@tanstack/react-query";
import { clearChatHistory } from "@/lib/chat";
import {
  chatHistoryClearSchema,
  chatHistoryClearResultSchema,
  type ChatHistoryClear,
} from "@/lib/chat-history-clear-contract";
import { withOperationTimeout } from "@/lib/operation-timeout";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

export function ClearChatHistory({
  orgId,
  orgName,
  userId,
  disabled = false,
}: {
  orgId: string;
  orgName: string;
  userId: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const client = useQueryClient();
  const mutationKey = ["clear-chat-history", orgId, userId];
  const history = useMutationState({
    filters: { mutationKey, exact: true },
    select: (mutation) => {
      const command = chatHistoryClearSchema.safeParse(
        mutation.state.variables,
      );
      const result = chatHistoryClearResultSchema.safeParse(
        mutation.state.data,
      );
      return {
        status: mutation.state.status,
        command: command.success ? command.data : null,
        result: result.success ? result.data : null,
        error: mutation.state.error,
        at: mutation.state.submittedAt,
      };
    },
  });
  const latest = history.at(-1);
  const pending = latest?.status === "pending";
  const unfinished =
    latest?.command &&
    (latest.status === "pending" ||
      latest.status === "error" ||
      latest.result?.rooms.some((room) => !room.cleared))
      ? latest.command
      : null;
  const mutation = useMutation({
    mutationKey,
    gcTime: Infinity,
    retry: false,
    networkMode: "always",
    mutationFn: async (command: ChatHistoryClear) => {
      const controller = new AbortController();
      try {
        return chatHistoryClearResultSchema.parse(
          await withOperationTimeout(
            clearChatHistory({ data: command, signal: controller.signal }),
            10_000,
            "The clear request was not fully confirmed. Retry the same request to finish it.",
          ),
        );
      } finally {
        controller.abort();
      }
    },
    onSettled: () => {
      for (const item of client
        .getMutationCache()
        .findAll({ mutationKey, exact: true }))
        if (item.state.status !== "pending")
          client.getMutationCache().remove(item);
    },
  });
  return (
    <section
      aria-label="Clear chat history"
      className="space-y-3 rounded-xl border border-red-500/20 bg-red-500/5 p-4"
    >
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setName("");
        }}
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium text-board-text">
              Clear chat history
            </p>
            <p className="text-xs text-board-muted">
              Remove message history from all ShowPilot chat rooms.
            </p>
          </div>
          <DialogTrigger asChild>
            <Button
              type="button"
              variant="outline"
              className="min-h-11 text-red-300"
              disabled={disabled || Boolean(unfinished)}
            >
              Clear chat history
            </Button>
          </DialogTrigger>
        </div>
        <DialogContent
          showCloseButton={false}
          className="max-h-[90dvh] overflow-y-auto bg-board-card text-board-text"
        >
          <DialogHeader>
            <DialogTitle>Clear all chat history?</DialogTitle>
            <DialogDescription>
              This permanently removes message history from Production,
              Planning, and direct conversations in {orgName}. Uploaded files
              and connected chat services are unchanged. New messages sent after
              this request are kept.
            </DialogDescription>
          </DialogHeader>
          <label className="space-y-2 text-sm">
            Type the organization name:{" "}
            <strong className="break-words">{orgName}</strong>
            <input
              aria-label="Organization name to clear chat"
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoComplete="off"
              className="mt-2 min-h-11 w-full rounded-lg border border-board-border bg-board-bg px-3 focus-visible:outline-2 focus-visible:outline-fire-500"
            />
          </label>
          <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={() => {
                setOpen(false);
                setName("");
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              className="min-h-11"
              disabled={name !== orgName || pending}
              onClick={() => {
                if (name !== orgName || unfinished) return;
                mutation.mutate({
                  orgId,
                  confirmName: name,
                  requestId: crypto.randomUUID(),
                });
                setOpen(false);
                setName("");
              }}
            >
              Permanently clear chat history
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      {pending ? (
        <p role="status" className="text-sm text-board-muted">
          Clearing chat history… Waiting for each room to confirm.
        </p>
      ) : null}
      {unfinished && !pending ? (
        <div role="alert" className="space-y-2 text-sm text-amber-200">
          <p>
            {latest?.error instanceof Error
              ? latest.error.message
              : "Some chat rooms have not confirmed the clear."}{" "}
            Retry continues the same request and keeps newer messages.
          </p>
          {latest?.result ? (
            <p>
              {latest.result.rooms.filter((room) => room.cleared).length} of{" "}
              {latest.result.rooms.length} rooms confirmed.
            </p>
          ) : null}
          {latest ? (
            <p>
              Last attempt{" "}
              <time dateTime={new Date(latest.at).toISOString()}>
                {new Date(latest.at).toLocaleTimeString()}
              </time>
            </p>
          ) : null}
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={() => mutation.mutate(unfinished)}
          >
            Retry clearing chat history
          </Button>
        </div>
      ) : null}
      {!unfinished && latest?.result ? (
        <p role="status" className="text-sm text-board-muted">
          Chat history cleared. All {latest.result.rooms.length} rooms
          confirmed. Newer messages are kept.
        </p>
      ) : null}
    </section>
  );
}
