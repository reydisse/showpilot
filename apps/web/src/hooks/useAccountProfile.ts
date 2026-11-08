import {
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import {
  profileResultSchema,
  profileStateSchema,
  type ProfileState,
} from "@/lib/account-profile-contract";
import { runRouteLoad } from "@/lib/route-load-deadlines";
import {
  prepareProfilePhoto,
  PhotoPreparationError,
} from "@/lib/profile-photo";

type Request = { userId: string; requestId: string; expectedRevision: number };
type Command = Request &
  (
    | { kind: "name"; name: string }
    | { kind: "photo-selection"; file: File }
    | { kind: "photo"; blob: Blob }
  );
type Attempt =
  | { kind: "pending"; command: Command }
  | {
      kind: "failed";
      command: Command;
      at: number;
      message: string;
      preparing: boolean;
    }
  | { kind: "resolved"; outcome: "applied" }
  | { kind: "resolved"; outcome: "conflict" | "superseded"; command: Command };
const profileKey = (userId: string) => ["account-profile", userId];
const attemptKey = (userId: string) => ["account-profile-attempt", userId];
const draftKey = (userId: string) => ["account-profile-name-draft", userId];

async function execute(client: QueryClient, initial: Command) {
  const key = attemptKey(initial.userId),
    queries = { queryKey: profileKey(initial.userId), exact: true };
  if (client.getQueryData<Attempt | null>(key)?.kind === "pending") return;
  let command = initial;
  client.setQueryData<Attempt>(key, () => ({ kind: "pending", command }));
  try {
    await client.cancelQueries(queries);
    const result = await runRouteLoad(
      async (controller) => {
        if (command.kind === "photo-selection") {
          const blob = await prepareProfilePhoto(
            command.file,
            controller.signal,
          );
          controller.signal.throwIfAborted();
          command = {
            userId: command.userId,
            requestId: command.requestId,
            expectedRevision: command.expectedRevision,
            kind: "photo",
            blob,
          };
          client.setQueryData<Attempt>(key, () => ({
            kind: "pending",
            command,
          }));
        }
        const response =
          command.kind === "name"
            ? await fetch("/api/user/profile", {
                method: "POST",
                signal: controller.signal,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(command),
              })
            : await (() => {
                const form = new FormData();
                form.set("userId", command.userId);
                form.set("requestId", command.requestId);
                form.set("expectedRevision", String(command.expectedRevision));
                form.set("file", command.blob, "avatar.jpg");
                return fetch("/api/user/profile/photo", {
                  method: "POST",
                  signal: controller.signal,
                  body: form,
                });
              })();
        const body: unknown = await response.json();
        controller.signal.throwIfAborted();
        if (!response.ok) throw new Error("Profile save was not confirmed.");
        const result = profileResultSchema.parse(body);
        if (
          result.requestId !== command.requestId ||
          result.state.userId !== command.userId
        )
          throw new Error(
            "Profile acknowledgement did not match this account change.",
          );
        return result;
      },
      undefined,
      8_000,
    );
    await client.cancelQueries(queries);
    client.setQueryData<ProfileState>(queries.queryKey, (current) =>
      current && current.revision > result.state.revision
        ? current
        : result.state,
    );
    if (
      command.kind === "name" &&
      result.outcome === "applied" &&
      client.getQueryData<string | null>(draftKey(command.userId))?.trim() ===
        command.name
    )
      client.setQueryData(draftKey(command.userId), null);
    client.setQueryData<Attempt>(key, () =>
      result.outcome === "applied"
        ? { kind: "resolved", outcome: "applied" }
        : { kind: "resolved", outcome: result.outcome, command },
    );
    void client.invalidateQueries(queries);
  } catch (error) {
    const preparing = command.kind === "photo-selection";
    client.setQueryData<Attempt>(key, () => ({
      kind: "failed",
      command,
      at: Date.now(),
      preparing,
      message: preparing
        ? error instanceof PhotoPreparationError
          ? error.message
          : "Photo could not be prepared. Retry or choose another photo."
        : "Profile save was not confirmed and may have saved. Retry confirms the same change without replacing a newer profile.",
    }));
  }
}

export function useAccountProfile(userId: string) {
  const client = useQueryClient();
  const { data: nameDraft = null } = useQuery<string | null>({
    queryKey: draftKey(userId),
    queryFn: () => null,
    initialData: null,
    enabled: false,
    gcTime: Infinity,
  });
  const { data: attempt = null } = useQuery<Attempt | null>({
    queryKey: attemptKey(userId),
    queryFn: () => null,
    initialData: null,
    enabled: false,
    gcTime: Infinity,
  });
  const pending = attempt?.kind === "pending";
  const profile = useQuery({
    queryKey: profileKey(userId),
    retry: false,
    networkMode: "always",
    enabled: !pending,
    refetchOnMount: false,
    queryFn: ({ signal }) =>
      runRouteLoad(
        async (controller) => {
          const response = await fetch("/api/user/profile", {
            signal: controller.signal,
          });
          if (!response.ok)
            throw new Error("Saved profile could not be checked.");
          const state = profileStateSchema.parse(await response.json());
          if (state.userId !== userId)
            throw new Error("Your account changed. Reopen your profile.");
          return state;
        },
        signal,
        8_000,
      ),
  });
  const readFailed =
    profile.isError ||
    (profile.isFetching && profile.errorUpdatedAt > profile.dataUpdatedAt);
  const locked =
    pending ||
    (attempt?.kind === "failed" && !attempt.preparing) ||
    !profile.data ||
    readFailed ||
    profile.isFetching;
  const start = (
    change:
      | { kind: "name"; name: string }
      | { kind: "photo-selection"; file: File },
  ) => {
    if (locked || !profile.data) return;
    void execute(client, {
      ...change,
      userId,
      requestId: crypto.randomUUID(),
      expectedRevision: profile.data.revision,
    });
  };
  return {
    profile,
    attempt,
    readFailed,
    pending,
    locked,
    nameDraft,
    setNameDraft: (name: string) => client.setQueryData(draftKey(userId), name),
    applySelectedPhoto: () => {
      if (
        !locked &&
        profile.data &&
        attempt?.kind === "resolved" &&
        attempt.outcome !== "applied" &&
        attempt.command.kind === "photo"
      )
        void execute(client, {
          ...attempt.command,
          requestId: crypto.randomUUID(),
          expectedRevision: profile.data.revision,
        });
    },
    saveName: (name: string) => start({ kind: "name", name }),
    selectPhoto: (file: File) => start({ kind: "photo-selection", file }),
    retry: () => {
      if (attempt?.kind === "failed") void execute(client, attempt.command);
    },
  };
}
