import { useEffect, useState, type ReactNode } from "react";
import { ensureDisplaySession } from "@/lib/display-access";
import type { DisplaySurface } from "@/lib/display-access.server";

type DisplayState =
  | { status: "checking" | "authorized" | "denied" | "not-found" }
  | { status: "error"; occurredAt: number };
interface AccessRequest {
  controller: AbortController;
  deadline?: ReturnType<typeof setTimeout>;
}

export function DisplayAccessGate(props: {
  orgSlug: string;
  surface: DisplaySurface;
  children: ReactNode;
}) {
  if (!props.orgSlug.length || props.orgSlug.length > 128)
    return <MissingDisplay />;
  return (
    <DisplaySession key={`${props.orgSlug}:${props.surface}`} {...props} />
  );
}

function DisplaySession({
  orgSlug,
  surface,
  children,
}: {
  orgSlug: string;
  surface: DisplaySurface;
  children: ReactNode;
}) {
  const [state, setState] = useState<DisplayState>({ status: "checking" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    let pending: AccessRequest | undefined;
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    let expiresAt = 0;
    const url = new URL(window.location.href);
    let token =
      url.searchParams.get("displayPass") ??
      url.searchParams.get("kioskToken") ??
      undefined;
    setState({ status: "checking" });
    const clearExpiry = () => {
      clearTimeout(expiryTimer);
      expiryTimer = undefined;
    };
    const check = async () => {
      if (!active || pending) return;
      const request: AccessRequest = { controller: new AbortController() };
      pending = request;
      try {
        const result = await Promise.race([
          ensureDisplaySession({
            data: { orgSlug, surface, token },
            signal: request.controller.signal,
          }),
          new Promise<never>((_resolve, reject) => {
            request.deadline = setTimeout(() => {
              request.controller.abort();
              reject(new Error("Display access confirmation timed out"));
            }, 8_000);
          }),
        ]);
        if (!active || pending !== request) return;
        if (!result.authorized && result.reason === "not-found") {
          expiresAt = 0;
          clearExpiry();
          clearInterval(interval);
          setState({ status: "not-found" });
          return;
        }
        if (
          !result.authorized ||
          !Number.isFinite(result.expiresAt) ||
          result.expiresAt <= Date.now()
        ) {
          expiresAt = 0;
          clearExpiry();
          setState({ status: "denied" });
          return;
        }
        expiresAt = result.expiresAt;
        clearExpiry();
        // A stalled renewal must not extend access to the next poll or response.
        expiryTimer = setTimeout(() => {
          if (!active) return;
          setState({ status: "error", occurredAt: Date.now() });
          void check();
        }, expiresAt - Date.now());
        setState({ status: "authorized" });
        if (token) {
          token = undefined;
          url.searchParams.delete("displayPass");
          url.searchParams.delete("kioskToken");
          window.history.replaceState(window.history.state, "", url);
        }
      } catch {
        // Keep a confirmed display mounted through temporary renewal failures,
        // but never beyond the last confirmed pass's actual expiry.
        if (active && pending === request && Date.now() >= expiresAt)
          setState({ status: "error", occurredAt: Date.now() });
      } finally {
        clearTimeout(request.deadline);
        if (pending === request) pending = undefined;
      }
    };
    const interval = setInterval(() => {
      void check();
    }, 30_000);
    void check();
    return () => {
      active = false;
      clearInterval(interval);
      clearExpiry();
      const request = pending;
      pending = undefined;
      clearTimeout(request?.deadline);
      request?.controller.abort();
    };
  }, [orgSlug, surface, attempt]);
  if (state.status === "authorized") return children;
  if (state.status === "not-found")
    return <MissingDisplay retry={() => setAttempt((value) => value + 1)} />;
  return (
    <main className="flex min-h-screen items-center justify-center bg-black p-6 text-white">
      <div className="max-w-md space-y-4 text-center">
        <p role={state.status === "checking" ? "status" : "alert"}>
          {state.status === "checking"
            ? "Checking display access…"
            : state.status === "denied"
              ? "This display needs a valid link. Sign in or ask an operator for a new display link."
              : "Display access could not be checked. Reconnect and try again."}
        </p>
        {state.status === "error" && (
          <p className="text-sm text-white/70">
            Last checked{" "}
            <time dateTime={new Date(state.occurredAt).toISOString()}>
              {new Date(state.occurredAt).toLocaleTimeString()}
            </time>
          </p>
        )}
        {state.status !== "checking" && (
          <button
            type="button"
            className="min-h-11 rounded border border-white/30 px-4 outline-none focus-visible:ring-2 focus-visible:ring-white"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Try again
          </button>
        )}
      </div>
    </main>
  );
}

function MissingDisplay({ retry }: { retry?: () => void }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-black p-6 text-white">
      <div className="max-w-md space-y-4 text-center">
        <div role="alert">
          <h1 className="text-xl font-semibold">Organization not found</h1>
          <p className="mt-2">
            Check the display address or ask your team for a new link.
          </p>
        </div>
        {retry && (
          <button
            type="button"
            className="min-h-11 rounded border border-white/30 px-4 outline-none focus-visible:ring-2 focus-visible:ring-white"
            onClick={retry}
          >
            Try again
          </button>
        )}
        <a
          className="flex min-h-11 items-center justify-center rounded underline outline-none focus-visible:ring-2 focus-visible:ring-white"
          href="/"
        >
          Go to ShowPilot
        </a>
      </div>
    </main>
  );
}
