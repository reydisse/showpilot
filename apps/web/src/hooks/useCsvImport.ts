import { useEffect, useRef, useState } from "react";
import {
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { z } from "zod";
import {
  getCsvImportContext,
  importMembersCsv,
  reviewCsvImport,
} from "@/lib/import-members";
import {
  parseCrewImport,
  csvImportCommandSchema,
  csvImportContextSchema,
  csvImportResultSchema,
  type CsvImportScope,
} from "@/lib/csv-import-contract";
import { readCrewCsvFile } from "@/lib/csv-file";
import { withOperationTimeout } from "@/lib/operation-timeout";
interface Draft {
  csv: string;
  fileName: string | null;
  version: number;
}
const attemptSchema = z.object({
  command: csvImportCommandSchema,
  mode: z.enum(["write", "review"]),
  fileName: z.string().nullable(),
});
type Attempt = z.infer<typeof attemptSchema>;
interface FileAttempt {
  file: File;
  requestId: string;
  version: number;
}
function fileAttempt(value: unknown): value is FileAttempt {
  return (
    typeof value === "object" &&
    value !== null &&
    "file" in value &&
    value.file instanceof File &&
    "requestId" in value &&
    typeof value.requestId === "string" &&
    "version" in value &&
    typeof value.version === "number"
  );
}
export class CsvImportError extends Error {
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
    throw new CsvImportError(error instanceof Error ? error.message : message);
  } finally {
    signal?.removeEventListener("abort", abort);
    controller.abort();
  }
}
export function useCsvImport(scope: CsvImportScope) {
  const [validationError, setValidationError] = useState<string | null>(null);
  const client = useQueryClient(),
    contextKey = ["csv-import-context", scope.orgId, scope.userId],
    draftKey = ["csv-import-draft", scope.orgId, scope.userId],
    mutationKey = ["csv-import-command", scope.orgId, scope.userId],
    fileKey = ["csv-import-file", scope.orgId, scope.userId];
  const cache = client.getMutationCache(),
    records = () => cache.findAll({ mutationKey, exact: true }),
    fileRecords = () => cache.findAll({ mutationKey: fileKey, exact: true });
  const draft = useQuery<Draft>({
    queryKey: draftKey,
    queryFn: () =>
      client.getQueryData<Draft>(draftKey) ?? {
        csv: "",
        fileName: null,
        version: 0,
      },
    enabled: false,
    gcTime: Infinity,
    initialData: () => ({ csv: "", fileName: null, version: 0 }),
  });
  const access = useQuery({
    queryKey: contextKey,
    retry: false,
    networkMode: "always",
    refetchOnWindowFocus: false,
    queryFn: ({ signal }) =>
      bounded(
        async (signal) => {
          const result = csvImportContextSchema.parse(
            await getCsvImportContext({ data: scope, signal }),
          );
          if (result.orgId !== scope.orgId || result.userId !== scope.userId)
            throw new Error("Your account changed. Reopen the importer.");
          return result;
        },
        "Checking import access timed out.",
        signal,
        8_000,
      ),
  });
  const history = useMutationState({
      filters: { mutationKey, exact: true },
      select: (item) => {
        const attempt = attemptSchema.safeParse(item.state.variables),
          result = csvImportResultSchema.safeParse(item.state.data);
        return {
          attempt: attempt.success ? attempt.data : null,
          result: result.success ? result.data : null,
          status: item.state.status,
          error: item.state.error,
        };
      },
    }),
    current = history.filter((item) => item.attempt).at(-1);
  const unresolved = () =>
    records().some((item) => {
      const result = csvImportResultSchema.safeParse(item.state.data);
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
        const result = csvImportResultSchema.parse(
          await (
            attempt.mode === "review" ? reviewCsvImport : importMembersCsv
          )({ data: attempt.command, signal }),
        );
        if (result.requestId !== attempt.command.requestId)
          throw new Error("The original CSV import was not acknowledged.");
        return result;
      }, "The import request timed out. Its result is unconfirmed."),
    onMutate: () => {
      for (const item of records())
        if (item.state.status !== "pending") cache.remove(item);
    },
  });
  const fileController = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      fileController.current?.abort();
    },
    [scope.orgId, scope.userId],
  );
  const fileHistory = useMutationState({
    filters: { mutationKey: fileKey, exact: true },
    select: (item) => ({
      attempt: fileAttempt(item.state.variables) ? item.state.variables : null,
      status: item.state.status,
      error: item.state.error,
    }),
  });
  const fileCurrent = fileHistory.filter((item) => item.attempt).at(-1),
    fileBusy = fileHistory.some((item) => item.status === "pending");
  const readingFile = () =>
    fileRecords().some((item) => item.state.status === "pending");
  const fileMutation = useMutation({
    mutationKey: fileKey,
    retry: false,
    networkMode: "always",
    gcTime: Infinity,
    mutationFn: async (attempt: FileAttempt) => {
      const controller = new AbortController();
      fileController.current = controller;
      try {
        return await readCrewCsvFile(attempt.file, controller.signal);
      } catch (error) {
        throw new CsvImportError(
          error instanceof Error
            ? error.message
            : "The file could not be read.",
        );
      } finally {
        if (fileController.current === controller)
          fileController.current = null;
      }
    },
    onMutate: () => {
      for (const item of fileRecords())
        if (item.state.status !== "pending") cache.remove(item);
    },
    onSuccess: (csv, attempt) => {
      if (
        !fileRecords().some(
          (item) =>
            fileAttempt(item.state.variables) &&
            item.state.variables.requestId === attempt.requestId,
        )
      )
        return;
      client.setQueryData<Draft>(draftKey, (previous) =>
        previous && previous.version === attempt.version
          ? { csv, fileName: attempt.file.name, version: previous.version + 1 }
          : previous,
      );
    },
  });
  const clearConfirmed = () => {
    for (const item of records())
      if (item.state.status === "success") cache.remove(item);
  };
  const clearFile = () => {
    for (const item of fileRecords()) cache.remove(item);
    fileController.current?.abort();
  };
  const changeText = (csv: string) => {
    if (unresolved() || readingFile()) return;
    setValidationError(null);
    clearConfirmed();
    clearFile();
    client.setQueryData<Draft>(draftKey, (previous) =>
      previous
        ? { csv, fileName: null, version: previous.version + 1 }
        : previous,
    );
  };
  const chooseFile = (file: File) => {
    if (
      unresolved() ||
      fileRecords().some((item) => item.state.status === "pending")
    )
      return;
    const current = client.getQueryData<Draft>(draftKey);
    if (!current) return;
    setValidationError(null);
    clearConfirmed();
    fileMutation.mutate({
      file,
      requestId: crypto.randomUUID(),
      version: current.version,
    });
  };
  const send = async () => {
    const context =
        client.getQueryState<z.infer<typeof csvImportContextSchema>>(
          contextKey,
        ),
      value = client.getQueryData<Draft>(draftKey);
    if (
      unresolved() ||
      fileRecords().some(
        (item) =>
          item.state.status === "pending" || item.state.status === "error",
      ) ||
      context?.status !== "success" ||
      context.fetchStatus === "fetching" ||
      !context.data ||
      !value?.csv.trim()
    )
      return null;
    try {
      parseCrewImport(value.csv);
    } catch (error) {
      setValidationError(
        error instanceof Error
          ? error.message
          : "Review the CSV before importing.",
      );
      return null;
    }
    setValidationError(null);
    const command = {
      ...scope,
      requestId: crypto.randomUUID(),
      expiresAt:
        context.data.serverTime +
        Math.max(0, Date.now() - context.dataUpdatedAt) +
        25_000,
      csv: value.csv,
    };
    try {
      return await mutation.mutateAsync({
        command,
        mode: "write",
        fileName: value.fileName,
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
  return {
    access,
    validationError,
    draft: draft.data,
    current,
    fileCurrent,
    fileBusy,
    chooseFile,
    clearFile,
    changeText,
    send,
    recover,
    dismiss: clearConfirmed,
    pending: history.some((item) => item.status === "pending"),
    unresolved: unresolved(),
    canImport:
      access.isSuccess &&
      !access.isFetching &&
      !unresolved() &&
      !fileBusy &&
      fileCurrent?.status !== "error" &&
      Boolean(draft.data.csv.trim()),
  };
}
