import { rundownRelayKey } from "./rundown-relay-key";
import { timecodeTargetUrl } from "./timecode-target.server";
import { ShowDeletionBlockedError } from "./show-deletion-contract";
import { env } from "cloudflare:workers";
export type ShowDeletionTarget = {
  orgId: string;
  showId: string;
  serviceDate: string;
  nonce: string;
};
export type ShowDeletionRelays = {
  prepare(target: ShowDeletionTarget): Promise<void>;
  purge(target: ShowDeletionTarget): Promise<void>;
};

function rooms(target: ShowDeletionTarget) {
  return [
    {
      key: rundownRelayKey(
        target.orgId,
        target.serviceDate,
        target.serviceDate,
        target.showId,
      ),
      force: true,
    },
    { key: `${target.orgId}:${target.serviceDate}`, force: false },
    { key: target.orgId, force: false },
  ];
}
async function request(
  stub: { fetch(request: Request): Promise<Response> },
  url: URL,
  secret: string,
) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(
        "Show cleanup timed out. Retry deletion to continue.",
      );
      controller.abort(error);
      reject(error);
    }, 5_000);
  });
  const operation = async () => {
    const response = await stub.fetch(
      new Request(url, {
        method: "POST",
        signal: controller.signal,
        headers: { "x-showpilot-internal-secret": secret },
      }),
    );
    await response.body?.cancel();
    if (response.status === 409) throw new ShowDeletionBlockedError();
    if (!response.ok)
      throw new Error(
        "Could not finish show cleanup. Retry deletion to continue.",
      );
  };
  // A Durable Object request can outlive abort delivery. Bound the caller's
  // wait as well; the durable operation identity makes a later retry safe.
  try {
    await Promise.race([operation(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
function bindings() {
  if (!env.BETTER_AUTH_SECRET || !env.RUNDOWN_RELAY || !env.TIMECODE_RELAY)
    throw new Error("Show cleanup is temporarily unavailable.");
  return {
    secret: env.BETTER_AUTH_SECRET,
    rundown: env.RUNDOWN_RELAY,
    clock: env.TIMECODE_RELAY,
  };
}
async function rundownRequest(target: ShowDeletionTarget, path: string) {
  const binding = bindings();
  for (const room of rooms(target)) {
    const url = new URL(path, "https://rundown.internal");
    url.search = new URLSearchParams({
      orgId: target.orgId,
      showId: target.showId,
      serviceDate: target.serviceDate,
      nonce: target.nonce,
      ...(room.force ? { force: "1" } : {}),
    }).toString();
    await request(binding.rundown.getByName(room.key), url, binding.secret);
  }
}
export const showDeletionRelays: ShowDeletionRelays = {
  prepare: (target) =>
    rundownRequest(target, "/internal/prepare-show-deletion"),
  async purge(target) {
    // The database has already committed the irreversible deletion phase.
    // Retire automation before removing the stopped rundown's live state.
    const binding = bindings();
    const clockUrl = timecodeTargetUrl(target, "/internal/purge-show");
    await request(
      binding.clock.getByName(rooms(target)[0].key),
      clockUrl,
      binding.secret,
    );
    await rundownRequest(target, "/internal/purge-show");
  },
};
