import { afterEach, expect, it, vi } from "vitest";
import { QueryClient, onlineManager } from "@tanstack/react-query";
import {
  crewCommandSchema,
  crewMutationOptions,
  prepareCrewPhoto,
} from "../../../../mobile/src/lib/crew-recovery.ts";
import { createLocalRequestUuid } from "../../../../mobile/src/lib/request-id.ts";
afterEach(() => {
  onlineManager.setOnline(true);
  vi.useRealTimers();
});
it.each(["create", "update", "delete"])(
  "retains the exact failed native crew %s across screens and isolates accounts",
  async (kind) => {
    const client = new QueryClient();
    const key = ["crew-profile-command", "org", "user"];
    const command = crewCommandSchema.parse({
      kind,
      orgId: "org",
      requestId: createLocalRequestUuid(),
      id: "crew",
      expectedRevision: 3,
      memberId: "CAM42",
      name: "Camera",
      role: "Camera",
      email: "",
      photoUrl: "",
    });
    const requests = [];
    let confirmed = 0;
    const options = crewMutationOptions({
      key,
      client,
      execute: async (input) => {
        requests.push(input);
        if (requests.length === 1) throw new Error("Reply lost");
        return { ok: true, kind, id: "crew", requestId: input.requestId };
      },
      confirmed: () => {
        confirmed++;
      },
    });
    try {
      await expect(
        client.getMutationCache().build(client, options).execute(command),
      ).rejects.toThrow("Reply lost");
      const reopened = client
        .getMutationCache()
        .findAll({ mutationKey: key, exact: true })
        .at(-1);
      expect(reopened.state.status).toBe("error");
      await client
        .getMutationCache()
        .build(client, options)
        .execute(crewCommandSchema.parse(reopened.state.variables));
      expect(requests).toEqual([command, command]);
      expect(confirmed).toBe(1);
      expect(
        client.getMutationCache().findAll({ mutationKey: key, exact: true }),
      ).toHaveLength(1);
      expect(
        client
          .getMutationCache()
          .findAll({
            mutationKey: ["crew-profile-command", "org", "different-user"],
            exact: true,
          }),
      ).toHaveLength(0);
    } finally {
      client.clear();
    }
  },
);
it("reports an offline native request instead of indefinitely pausing it", async () => {
  const client = new QueryClient();
  onlineManager.setOnline(false);
  const command = {
    kind: "delete",
    orgId: "org",
    id: "crew",
    expectedRevision: 0,
    requestId: createLocalRequestUuid(),
  };
  const options = crewMutationOptions({
    key: ["offline-crew"],
    client,
    execute: async () => {
      throw new Error("Offline");
    },
    confirmed: () => {
      throw new Error("Must not confirm");
    },
  });
  try {
    const mutation = client.getMutationCache().build(client, options);
    await expect(mutation.execute(command)).rejects.toThrow("Offline");
    expect(mutation.state.isPaused).toBe(false);
    expect(mutation.state.variables).toEqual(command);
  } finally {
    client.clear();
  }
});
it("bounds native photo work that never settles", async () => {
  vi.useFakeTimers();
  const result = expect(
    prepareCrewPhoto(() => new Promise(() => {})),
  ).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(10_000);
  await result;
  expect(vi.getTimerCount()).toBe(0);
});
