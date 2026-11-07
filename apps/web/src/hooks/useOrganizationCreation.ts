import { useEffect, useRef, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { organizationCreationAckSchema, organizationCreationSnapshotSchema, type OrganizationCreationSnapshot } from "@/lib/organization-creation-contract";

/** Stop waiting even when a transport ignores abort; late results cannot continue setup. */
export function runCreationRequest<T>(operation: (signal: AbortSignal) => Promise<T>, parent: AbortSignal): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel = () => {};
  const interrupted = new Promise<never>((_, reject) => {
    const stop = () => { controller.abort(); reject(new Error("Setup request was not confirmed.")); };
    cancel = stop;
    timer = setTimeout(stop, 10_000);
    if (parent.aborted) stop(); else parent.addEventListener("abort", cancel, { once: true });
  });
  const result = Promise.resolve().then(() => { controller.signal.throwIfAborted(); return operation(controller.signal); });
  return Promise.race([result, interrupted]).finally(() => { clearTimeout(timer); parent.removeEventListener("abort", cancel); });
}

class CreationFailure extends Error {}

type Command = { name: string; slug: string; requestId: string };
export function useOrganizationCreation(initialRequestId: string | undefined, prepare: (requestId: string) => Promise<void>) {
  const [snapshot, setSnapshot] = useState<OrganizationCreationSnapshot | null>(null);
  const [pending, setPending] = useState<Command | null>(null);
  const [busy, setBusy] = useState(Boolean(initialRequestId));
  const [failure, setFailure] = useState<{ message: string; occurredAt: number } | null>(null);
  const requestId = useRef(initialRequestId);
  const command = useRef<Command | null>(null);
  const flight = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const run = async (attempt: Command | null) => {
    if (flight.current || !mounted.current || !requestId.current) return null;
    const id = requestId.current;
    const controller = new AbortController(); flight.current = controller;
    setBusy(true); setFailure(null);
    if (attempt) setSnapshot(null);
    try {
      const next = await runCreationRequest(async signal => {
        if (!attempt) {
          const response = await authClient.$fetch<unknown>(`/organization/creation-result?requestId=${encodeURIComponent(id)}`, { method: "GET", signal, retry: 0 });
          if (response.error) throw new CreationFailure("Could not check the saved workspace. Try Check saved workspace again.");
          return organizationCreationSnapshotSchema.parse(response.data);
        }
        // Save only the opaque recovery ID in the URL before sending any write.
        await prepare(id);
        signal.throwIfAborted();
        const response = await authClient.organization.create({ name: attempt.name, slug: attempt.slug, keepCurrentActiveOrganization: true,
          fetchOptions: { signal, retry: 0, headers: { "Idempotency-Key": id, "X-ShowPilot-Setup": "1" } },
        });
        signal.throwIfAborted();
        if (response.error) {
          // These responses prove this request did not commit. Permit corrected input.
          if (["INVALID_ORGANIZATION", "ORGANIZATION_ALREADY_EXISTS", "INVALID_CREATION_REQUEST"].includes(response.error.code ?? "")) {
            command.current = null; setPending(null);
            throw new CreationFailure(response.error.message ?? "Check your organization name and workspace address.");
          }
          throw new CreationFailure("Organization creation was not confirmed. It may have saved. Check the saved workspace or retry the same request.");
        }
        const saved = organizationCreationAckSchema.parse(response.data);
        if (saved.creationRequestId !== id) throw new Error("Creation acknowledgement did not match this request.");
        return { requestId: id, status: "saved", organization: { id: saved.id, name: saved.name, slug: saved.slug } } satisfies OrganizationCreationSnapshot;
      }, controller.signal);
      if (!mounted.current || flight.current !== controller || controller.signal.aborted) return null;
      if (next.requestId !== id) throw new Error("The saved result belongs to another request. Check again.");
      setSnapshot(next);
      return next.status === "saved" ? next.organization : null;
    } catch (error) {
      if (mounted.current && flight.current === controller) setFailure({ occurredAt: Date.now(), message: error instanceof CreationFailure ? error.message : "Organization creation was not confirmed. It may have saved. Check the saved workspace before continuing." });
      return null;
    } finally {
      if (flight.current === controller) { flight.current = null; if (mounted.current) setBusy(false); }
    }
  };
  const check = () => run(null);
  useEffect(() => {
    mounted.current = true;
    if (initialRequestId) void check();
    return () => { mounted.current = false; flight.current?.abort(); flight.current = null; };
    // A refresh checks its receipt. Updating the URL in this mount must not replay or interrupt a write.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const create = (name: string, slug: string) => {
    if (flight.current || !mounted.current) return Promise.resolve(null);
    if (!requestId.current) requestId.current = crypto.randomUUID();
    if (!command.current) { command.current = { requestId: requestId.current, name, slug }; setPending(command.current); }
    return run(command.current);
  };
  const edit = () => {
    if (flight.current || snapshot?.status !== "empty") return;
    command.current = null; setPending(null); setFailure(null);
  };
  return { snapshot, pending, busy, failure, check, create, edit, hasRequest: Boolean(requestId.current) };
}
