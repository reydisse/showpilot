import { z } from "zod";
const identity = { orgId: z.string().min(1), requestId: z.uuid() };
const profile = {
  memberId: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .transform((value) => value.toUpperCase()),
  name: z.string().trim().min(1).max(200),
  role: z.string().trim().min(1).max(100),
  email: z.union([z.literal(""), z.email().max(254)]),
  photoUrl: z.string().max(2_100_000),
};
export const crewCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("create"), ...identity, ...profile }),
  z.object({
    kind: z.literal("update"),
    ...identity,
    ...profile,
    id: z.string(),
    expectedRevision: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal("delete"),
    ...identity,
    id: z.string(),
    expectedRevision: z.number().int().nonnegative(),
  }),
]);
export type CrewCommand = z.infer<typeof crewCommandSchema>;
export const crewReceiptSchema = z.object({
  ok: z.literal(true),
  id: z.string(),
  requestId: z.uuid(),
  kind: z.enum(["create", "update", "delete"]),
});
export type CrewReceipt = z.infer<typeof crewReceiptSchema>;

/** Failed requests survive screen navigation in the signed-in session cache. */
export function crewMutationOptions(input: {
  key: readonly unknown[];
  client: import("@tanstack/react-query").QueryClient;
  execute: (command: CrewCommand) => Promise<CrewReceipt>;
  confirmed: (result: CrewReceipt) => void;
}) {
  return {
    mutationKey: input.key,
    gcTime: Infinity,
    networkMode: "always" as const,
    mutationFn: input.execute,
    onSuccess: input.confirmed,
    onSettled: () => {
      const cache = input.client.getMutationCache();
      for (const old of cache.findAll({
        mutationKey: input.key,
        exact: true,
      })) {
        if (old.state.status !== "pending") cache.remove(old);
      }
    },
  };
}

export async function prepareCrewPhoto(
  work: () => Promise<string>,
): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                "Photo preparation timed out. Choose a smaller photo and retry.",
              ),
            ),
          10_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
