import { useEffect, useState, type ReactNode } from "react";
import { ensureDisplaySession } from "@/lib/display-access";
import type { DisplaySurface } from "@/lib/display-access.server";

export function DisplayAccessGate(props: { orgSlug: string; surface: DisplaySurface; children: ReactNode }) {
  return <DisplaySession key={`${props.orgSlug}:${props.surface}`} {...props} />;
}

function DisplaySession({ orgSlug, surface, children }: { orgSlug: string; surface: DisplaySurface; children: ReactNode }) {
  const [state, setState] = useState<"checking" | "authorized" | "denied" | "error">("checking");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    let pending = false;
    let expiresAt = 0;
    const url = new URL(window.location.href);
    let token = url.searchParams.get("displayPass") ?? url.searchParams.get("kioskToken") ?? undefined;
    const check = async () => {
      if (pending) return;
      pending = true;
      try {
        const result = await ensureDisplaySession({ data: { orgSlug, surface, token } });
        if (!active) return;
        if (!result.authorized) { setState("denied"); return; }
        expiresAt = result.expiresAt;
        setState("authorized");
        if (token) {
          token = undefined;
          url.searchParams.delete("displayPass"); url.searchParams.delete("kioskToken");
          window.history.replaceState(window.history.state, "", url);
        }
      } catch {
        // Temporary connection loss may hold the display only until its pass expires.
        if (active && Date.now() >= expiresAt) setState("error");
      } finally { pending = false; }
    };
    void check();
    const interval = window.setInterval(() => { if (Date.now() >= expiresAt) setState("checking"); void check(); }, 30_000);
    return () => { active = false; window.clearInterval(interval); };
  }, [orgSlug, surface, attempt]);
  if (state === "authorized") return children;
  return <main className="flex min-h-screen items-center justify-center bg-black p-6 text-white">
    <div className="max-w-md space-y-4 text-center">
      <p role={state === "checking" ? "status" : "alert"}>{state === "checking" ? "Checking display access…" : state === "denied" ? "This display needs a valid link. Sign in or ask an operator for a new display link." : "Display access could not be checked. Reconnect and try again."}</p>
      {state !== "checking" && <button type="button" className="min-h-11 rounded border border-white/30 px-4" onClick={() => setAttempt((value) => value + 1)}>Try again</button>}
    </div>
  </main>;
}
