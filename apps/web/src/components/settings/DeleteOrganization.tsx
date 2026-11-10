import { useState } from "react";
import {
  useMutation,
  useMutationState,
  useQueryClient,
} from "@tanstack/react-query";
import { deleteOrganization } from "@/lib/org-deletion";
import {
  organizationDeletionSchema,
  organizationDeletionResultSchema,
  type OrganizationDeletion,
} from "@/lib/organization-deletion-contract";
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

export function DeleteOrganization({
  orgId,
  orgName,
  userId,
  disabled = false,
  onDeleted,
}: {
  orgId: string;
  orgName: string;
  userId: string;
  disabled?: boolean;
  onDeleted: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const client = useQueryClient();
  const mutationKey = ["delete-organization", orgId, userId];
  const history = useMutationState({
    filters: { mutationKey, exact: true },
    select: (mutation) => {
      const command = organizationDeletionSchema.safeParse(
        mutation.state.variables,
      );
      const result = organizationDeletionResultSchema.safeParse(
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
      latest.status === "error")
      ? latest.command
      : null;
  const mutation = useMutation({
    mutationKey,
    gcTime: Infinity,
    retry: false,
    networkMode: "always",
    mutationFn: async (command: OrganizationDeletion) => {
      const controller = new AbortController();
      try {
        return organizationDeletionResultSchema.parse(
          await withOperationTimeout(
            deleteOrganization({ data: command, signal: controller.signal }),
            20_000,
            "Deletion was not confirmed. Some cleanup may already be complete. Retry to finish or confirm the deletion.",
          ),
        );
      } finally {
        controller.abort();
      }
    },
    onSuccess: () => withOperationTimeout(
      Promise.resolve().then(onDeleted),
      5_000,
      "The organization was deleted, but navigation did not finish. Retry to continue.",
    ),
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
      aria-label="Delete organization"
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
              Delete organization
            </p>
            <p className="text-xs text-board-muted">
              Permanently remove this organization and its shared data.
            </p>
          </div>
          <DialogTrigger asChild>
            <Button
              type="button"
              variant="outline"
              className="min-h-11 text-red-300"
              disabled={disabled || Boolean(unfinished)}
            >
              Delete organization
            </Button>
          </DialogTrigger>
        </div>
        <DialogContent
          showCloseButton={false}
          className="max-h-[90dvh] grid-cols-[minmax(0,1fr)] overflow-y-auto bg-board-card text-board-text"
        >
          <DialogHeader>
            <DialogTitle>Delete this organization?</DialogTitle>
            <DialogDescription>
              This permanently deletes {orgName}, its shared data and uploaded files
              for everyone, and cancels its ShowPilot subscription. This cannot be
              undone. Your account and other organizations are kept. Only the owner
              can delete an organization, with a sign-in from the last 30 minutes.
            </DialogDescription>
          </DialogHeader>
          <label className="min-w-0 space-y-2 text-sm">
            Type the organization name:{" "}
            <strong className="break-words">{orgName}</strong>
            <input
              aria-label="Organization name to delete organization"
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
              className="h-auto min-h-11 min-w-0 whitespace-normal"
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
              className="h-auto min-h-11 min-w-0 whitespace-normal"
              disabled={name !== orgName || pending}
              onClick={() => {
                if (name !== orgName || unfinished) return;
                mutation.mutate({
                  orgId,
                  confirmName: name,
                });
                setOpen(false);
                setName("");
              }}
            >
              Permanently delete organization
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      {pending ? (
        <p role="status" className="text-sm text-board-muted">
          Deleting organization… Waiting for confirmation.
        </p>
      ) : null}
      {unfinished && !pending ? (
        <div role="alert" className="space-y-2 text-sm text-amber-200">
          <p>
            {latest?.error instanceof Error
              ? latest.error.message
              : "Organization deletion was not confirmed."}{" "}
            Retry continues cleanup for this organization. It does not affect your account or other organizations.
          </p>
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
            className="h-auto min-h-11 min-w-0 whitespace-normal"
            onClick={() => mutation.mutate(unfinished)}
          >
            Retry organization deletion
          </Button>
        </div>
      ) : null}
      {!unfinished && latest?.result ? (
        <p role="status" className="text-sm text-board-muted">
          Organization deletion confirmed. Leaving this organization…
        </p>
      ) : null}
    </section>
  );
}
