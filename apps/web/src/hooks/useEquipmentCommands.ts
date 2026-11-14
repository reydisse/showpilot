import { useState } from "react";
import {
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { z } from "zod";
import {
  commandEquipment,
  getEquipmentState,
  reviewEquipment,
} from "@/lib/equipment-commands";
import {
  equipmentCommandSchema,
  equipmentOperationSchema,
  equipmentOutcomeSchema,
  equipmentStateSchema,
  type EquipmentState,
} from "@/lib/equipment-command-contract";
import { withOperationTimeout } from "@/lib/operation-timeout";

type Item = EquipmentState["equipment"][number];
type Fields = Pick<
  Item,
  "name" | "category" | "status" | "location" | "serialNumber" | "notes"
>;
export const emptyEquipmentFields: Fields = {
  name: "",
  category: "audio",
  status: "operational",
  location: "",
  serialNumber: "",
  notes: "",
};
interface Drafts {
  addForm: Fields & { quantity: number };
  editingItem: Item | null;
  editForm: Fields;
}
const attemptSchema = z.object({
  command: equipmentCommandSchema,
  mode: z.enum(["write", "review"]),
  label: z.string(),
});
type Attempt = z.infer<typeof attemptSchema>;
export class EquipmentRequestError extends Error {
  readonly occurredAt = Date.now();
}
async function bounded<T>(
  run: (signal: AbortSignal) => Promise<T>,
  message: string,
  signal?: AbortSignal,
  ms = 10_000,
) {
  const controller = new AbortController(),
    abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  try {
    return await withOperationTimeout(run(controller.signal), ms, message);
  } catch (error) {
    throw new EquipmentRequestError(
      error instanceof Error ? error.message : message,
    );
  } finally {
    signal?.removeEventListener("abort", abort);
    controller.abort();
  }
}
export function useEquipmentCommands(initial: EquipmentState) {
  const client = useQueryClient(),
    scope = { orgId: initial.orgId, userId: initial.userId };
  const queryKey = ["equipment-state", scope.orgId, scope.userId],
    mutationKey = ["equipment-change", scope.orgId, scope.userId],
    draftKey = ["equipment-drafts", scope.orgId, scope.userId];
  const [validationError, setValidationError] = useState<string | null>(null);
  const drafts = useQuery<Drafts>({
    queryKey: draftKey,
    enabled: false,
    gcTime: Infinity,
    initialData: () => ({
      addForm: { ...emptyEquipmentFields, quantity: 1 },
      editingItem: null,
      editForm: emptyEquipmentFields,
    }),
  });
  const setDrafts = (patch: Partial<Drafts>) =>
    client.setQueryData<Drafts>(draftKey, (current) =>
      current ? { ...current, ...patch } : current,
    );
  const read = useQuery({
    queryKey,
    initialData: initial,
    retry: false,
    networkMode: "always",
    refetchOnWindowFocus: false,
    queryFn: ({ signal }) =>
      bounded(
        async (signal) => {
          const snapshot = equipmentStateSchema.parse(
            await getEquipmentState({ data: { orgId: scope.orgId }, signal }),
          );
          if (
            snapshot.userId !== scope.userId ||
            snapshot.orgId !== scope.orgId
          )
            throw new Error("Your account changed. Reopen Assets.");
          return snapshot;
        },
        "The inventory request timed out.",
        signal,
        8_000,
      ),
  });
  const cache = client.getMutationCache(),
    records = () => cache.findAll({ mutationKey, exact: true });
  const history = useMutationState({
    filters: { mutationKey, exact: true },
    select: (item) => {
      const attempt = attemptSchema.safeParse(item.state.variables),
        result = equipmentOutcomeSchema.safeParse(item.state.data);
      return {
        attempt: attempt.success ? attempt.data : null,
        result: result.success ? result.data : null,
        status: item.state.status,
        error: item.state.error,
      };
    },
  });
  const current = history.filter((item) => item.attempt).at(-1);
  const unresolved = () =>
    records().some((item) => {
      const result = equipmentOutcomeSchema.safeParse(item.state.data);
      return (
        item.state.status === "pending" ||
        item.state.status === "error" ||
        (result.success && result.data.outcome !== "applied")
      );
    });
  const mutation = useMutation({
    mutationKey,
    retry: false,
    networkMode: "always",
    gcTime: Infinity,
    mutationFn: (attempt: Attempt) =>
      bounded(async (signal) => {
        const result = equipmentOutcomeSchema.parse(
          await (
            attempt.mode === "review" ? reviewEquipment : commandEquipment
          )({ data: attempt.command, signal }),
        );
        if (result.requestId !== attempt.command.requestId)
          throw new Error("The original asset request was not acknowledged.");
        return result;
      }, "The asset request timed out. Its result is unconfirmed."),
    onMutate: () => {
      for (const item of records())
        if (item.state.status !== "pending") cache.remove(item);
    },
    onSuccess: (result, attempt) => {
      const op = attempt.command.operation,
        draft = client.getQueryData<Drafts>(draftKey);
      if (result.outcome === "applied" && draft) {
        if (op.kind === "create") {
          const parsed = equipmentOperationSchema.safeParse({
            kind: "create",
            fields: draft.addForm,
            quantity: draft.addForm.quantity,
          });
          if (
            parsed.success &&
            JSON.stringify(parsed.data) === JSON.stringify(op)
          )
            setDrafts({ addForm: { ...emptyEquipmentFields, quantity: 1 } });
        } else if (draft.editingItem?.id === op.id) {
          const expected = {
            ...draft.editingItem,
            ...(op.kind === "update" ? op.updates : {}),
          };
          const fields = [
            "name",
            "category",
            "status",
            "location",
            "serialNumber",
            "notes",
          ] as const;
          if (
            fields.every((field) => draft.editForm[field] === expected[field])
          )
            setDrafts({ editingItem: null });
        }
      }
      void client
        .cancelQueries({ queryKey })
        .then(() => client.invalidateQueries({ queryKey }));
    },
  });
  const send = async (operation: unknown, label: string) => {
    const state = client.getQueryState<EquipmentState>(queryKey);
    if (
      unresolved() ||
      state?.status !== "success" ||
      !state.data ||
      state.fetchStatus === "fetching"
    )
      return null;
    const parsed = equipmentOperationSchema.safeParse(operation);
    if (!parsed.success) {
      setValidationError(
        parsed.error.issues[0]?.message ?? "Review the asset details.",
      );
      return null;
    }
    setValidationError(null);
    try {
      return await mutation.mutateAsync({
        command: {
          ...scope,
          requestId: crypto.randomUUID(),
          expiresAt:
            state.data.serverTime +
            Math.max(0, Date.now() - state.dataUpdatedAt) +
            25_000,
          operation: parsed.data,
        },
        label,
        mode: "write",
      });
    } catch {
      return null;
    }
  };
  const recover = async (mode?: "review") => {
    if (
      !current?.attempt ||
      records().some((item) => item.state.status === "pending")
    )
      return null;
    try {
      return await mutation.mutateAsync({
        ...current.attempt,
        mode: mode ?? current.attempt.mode,
      });
    } catch {
      return null;
    }
  };
  const dismiss = () => {
    if (read.isError || read.isFetching) return;
    for (const item of records())
      if (item.state.status === "success") cache.remove(item);
  };
  return {
    read,
    current,
    send,
    recover,
    dismiss,
    draft: drafts.data,
    setDrafts,
    validationError,
    pending: history.some((item) => item.status === "pending"),
    unresolved: unresolved(),
    unavailable: read.isError || read.isFetching,
  };
}
export type EquipmentController = ReturnType<typeof useEquipmentCommands>;
