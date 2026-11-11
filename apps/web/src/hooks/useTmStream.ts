import {
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { getTmStreamState, writeTmStream } from "@/lib/tm-stream";
import {
  tmStreamResultSchema,
  tmStreamReviewSchema,
  tmStreamSnapshotSchema,
  type TmStreamReview,
  type TmStreamSnapshot,
} from "@/lib/tm-stream-contract";
import { withOperationTimeout } from "@/lib/operation-timeout";
export function useTmStream(orgId: string, userId: string) {
  const client = useQueryClient(),
    queryKey = ["tm-stream-state", orgId, userId],
    mutationKey = ["tm-stream-command", orgId, userId];
  const read = useQuery<TmStreamSnapshot>({
    queryKey,
    retry: false,
    networkMode: "always",
    refetchInterval: (query) =>
      query.state.status === "error" ||
      query.state.data?.destinations.some(
        (destination) => destination.status === "unknown",
      )
        ? false
        : 5_000,
    queryFn: async ({ signal }) => {
      const controller = new AbortController(),
        abort = () => controller.abort(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      try {
        return tmStreamSnapshotSchema.parse(
          await withOperationTimeout(
            getTmStreamState({ data: { orgId }, signal: controller.signal }),
            8_000,
            "Streaming feedback was not confirmed. Retry to check current outputs.",
          ),
        );
      } finally {
        signal.removeEventListener("abort", abort);
        controller.abort();
      }
    },
  });
  const history = useMutationState({
    filters: { mutationKey, exact: true },
    select: (mutation) => {
      const review = tmStreamReviewSchema.safeParse(mutation.state.variables),
        result = tmStreamResultSchema.safeParse(mutation.state.data);
      return {
        review: review.success ? review.data : null,
        result: result.success ? result.data : null,
        status: mutation.state.status,
        error: mutation.state.error,
        at: mutation.state.submittedAt,
      };
    },
  });
  const latest = history.at(-1),
    pending = latest?.status === "pending",
    unfinished =
      latest?.review &&
      (pending ||
        latest.status === "error" ||
        latest.result?.notificationError ||
        latest.result?.results.some((result) => !result.success))
        ? latest.review
        : null;
  const mutation = useMutation({
    mutationKey,
    retry: false,
    networkMode: "always",
    gcTime: Infinity,
    mutationFn: async (review: TmStreamReview) => {
      const controller = new AbortController();
      try {
        return tmStreamResultSchema.parse(
          await withOperationTimeout(
            writeTmStream({ data: review.command, signal: controller.signal }),
            10_000,
            "Streaming command was not confirmed. Retry the original request, or Stop its destinations before starting again.",
          ),
        );
      } finally {
        controller.abort();
      }
    },
    onMutate: () => {
      // Retain pending handlers: Stop can overtake Go Live, whose late reply
      // must never become the latest command or erase Stop's feedback.
      for (const old of client
        .getMutationCache()
        .findAll({ mutationKey, exact: true }))
        if (old.state.status !== "pending")
          client.getMutationCache().remove(old);
    },
    onSettled: () => {
      void client
        .cancelQueries({ queryKey })
        .then(() => client.invalidateQueries({ queryKey }));
    },
  });
  const latestCached = () =>
    client.getMutationCache().findAll({ mutationKey, exact: true }).at(-1);
  return {
    read,
    latest,
    pending,
    unfinished,
    send: (review: TmStreamReview) => {
      const previous = latestCached(),
        parsed = tmStreamReviewSchema.safeParse(previous?.state.variables);
      if (review.command.action === "stream-stop") {
        if (
          previous?.state.status === "pending" &&
          parsed.success &&
          parsed.data.command.action === "stream-stop"
        )
          return;
        if (unfinished?.command.action === "stream-stop") return;
      } else if (
        previous?.state.status === "pending" ||
        unfinished ||
        read.isError
      )
        return;
      mutation.mutate(review);
    },
    retry: () => {
      if (unfinished && latestCached()?.state.status !== "pending")
        mutation.mutate(unfinished);
    },
  };
}
