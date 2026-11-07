import { useEffect, useRef, useState } from "react";
import { useDeviceTimeZone } from "@/hooks/useDeviceTimeZone";
import { authClient } from "@/lib/auth-client";
import { acceptInvitation, rejectInvitation, getInvitationDetails, setActiveOrg } from "@/lib/session";
import { verificationHref } from "@/lib/auth-navigation";
import { withOperationTimeout } from "@/lib/operation-timeout";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import type { InvitationView } from "@/lib/invitation-view";

type Action = "accept" | "decline";
type Operation = Action | "read" | "open" | "signout";
type State = { status: "idle" } | { status: "busy"; operation: Operation }
  | { status: "failed"; operation: Operation; message: string; at: number };
const button = "inline-flex min-h-11 items-center justify-center rounded-xl border border-board-border px-4 py-3 text-sm font-medium focus-visible:outline-2 disabled:opacity-50";
const retryLabels: Record<Operation, string> = { accept: "Retry acceptance", decline: "Retry decline", read: "Retry status check", open: "Retry opening workspace", signout: "Retry sign out" };

export function InvitationResponseCard({ invitationId, initial, navigate }: {
  invitationId: string;
  initial: InvitationView;
  navigate: (href: string) => Promise<void>;
}) {
  const timeZone = useDeviceTimeZone();
  const [view, setView] = useState(initial);
  const [state, setState] = useState<State>({ status: "idle" });
  const [intent, setIntent] = useState<Action | null>(null);
  const active = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const { confirm, ConfirmDialogEl } = useConfirmDialog();
  const returnTo = `/invite/${encodeURIComponent(invitationId)}`;
  const login = `/login?${new URLSearchParams({ returnTo })}`;
  const busy = state.status === "busy";
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; active.current?.abort(); active.current = null; };
  }, []);
  useEffect(() => {
    if (view.status !== "pending") return;
    const remaining = view.invitation.expiresAt - Date.now();
    if (remaining <= 0) { setView({ ...view, status: "expired" }); return; }
    const timer = setTimeout(() => setView(current => current === view
      ? { ...view, status: Date.now() >= view.invitation.expiresAt ? "expired" : "pending" } : current), Math.min(remaining, 2_147_483_647));
    return () => clearTimeout(timer);
  }, [view]);

  const run = async (operation: Operation) => {
    if (active.current || !mounted.current) return;
    const controller = new AbortController(); active.current = controller;
    const current = () => mounted.current && active.current === controller && !controller.signal.aborted;
    setState({ status: "busy", operation });
    if (operation === "accept" || operation === "decline") setIntent(operation);
    try {
      const work = async () => {
        if (operation === "signout") {
          const result = await authClient.signOut({ fetchOptions: { signal: controller.signal } });
          if (result.error) throw new Error("Could not confirm sign out. Try again.");
          if (current()) await navigate(login);
          return;
        }
        const latest = await getInvitationDetails({ data: invitationId, signal: controller.signal });
        if (!current()) return;
        setView(latest);
        if (operation === "read") {
          if (latest.status !== "pending") setIntent(null);
          return;
        }
        if (operation === "open") {
          if (latest.status !== "accepted") return;
          await setActiveOrg({ data: latest.invitation.organization.id, signal: controller.signal });
          if (current()) await navigate(`/${encodeURIComponent(latest.invitation.organization.slug)}`);
          return;
        }
        if (latest.status === "accepted" || latest.status === "declined") { setIntent(null); return; }
        if (latest.status !== "pending") return;
        const options = { data: invitationId, signal: controller.signal };
        const saved = operation === "accept" ? await acceptInvitation(options) : await rejectInvitation(options);
        if (!current()) return;
        setIntent(null);
        setView({ ...latest, status: saved.invitation.status === "accepted" ? "accepted" : "declined" });
      };
      await withOperationTimeout(work(), 10_000, operation === "read" ? "Could not check the invitation in time. Retry the status check."
        : "The result is unconfirmed. Check the invitation status or retry the same action.");
      if (current()) setState({ status: "idle" });
    } catch (error) {
      if (current()) setState({ status: "failed", operation, message: error instanceof Error ? error.message : "The result is unconfirmed. Check the invitation status.", at: Date.now() });
    } finally {
      controller.abort(); if (active.current === controller) active.current = null;
    }
  };
  const decline = async () => {
    const accepted = await confirm({ title: "Decline this invitation?", description: "You will need a new invitation if you decide to join later. Existing workspace memberships are unchanged.", confirmLabel: "Decline invitation" });
    if (accepted && mounted.current) void run("decline");
  };
  const chooseAgain = async () => {
    const accepted = await confirm({ title: "Choose another response?", description: "The earlier request may still finish. The first response saved by the server wins; choosing again does not cancel it.", confirmLabel: "Choose another response" });
    if (accepted && mounted.current && !active.current) { setIntent(null); setState({ status: "idle" }); }
  };
  const heading = view.status === "signed-out" ? "Sign in to view your invitation"
    : view.status === "unverified" ? "Verify your email to respond"
      : view.status === "wrong-account" ? "This invitation is for another account"
        : view.status === "unavailable" ? "Invitation unavailable"
          : view.status === "accepted" ? "Invitation accepted"
            : view.status === "declined" ? "Invitation declined"
              : view.status === "expired" ? "Invitation expired"
                : view.status === "canceled" ? "Invitation canceled"
                  : view.status === "access-removed" ? "Workspace access has changed"
                    : `Join ${view.invitation.organization.name}`;
  return <>
    <section className="min-w-0 space-y-4 rounded-2xl border border-board-border bg-board-card p-5 text-board-text sm:p-6">
      <h1 className="break-words text-xl font-semibold">{heading}</h1>
      {"invitation" in view && <p className="break-words text-sm text-board-muted">{view.invitation.organization.name} · {view.invitation.role}</p>}
      {"email" in view && <p className="break-words text-sm text-board-muted">Signed in as {view.email}</p>}
      {view.status === "signed-out" && <>
        <p className="text-sm text-board-muted">Use the email address the invitation was sent to. You can review it before joining.</p>
        <div className="flex flex-wrap gap-2"><a href={login} className={`${button} bg-fire-500 text-black`}>Sign in</a><a href={`${login}&signup=1`} className={button}>Create account</a></div>
      </>}
      {view.status === "unverified" && <a className={button} href={verificationHref(returnTo)}>Verify email</a>}
      {view.status === "wrong-account" && !(state.status === "failed" && state.operation === "signout") && <button type="button" className={button} disabled={busy} onClick={() => void run("signout")}>Use another account</button>}
      {view.status === "pending" && <>
        <p className="text-sm text-board-muted">Expires {new Date(view.invitation.expiresAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone })}.</p>
        {!intent && <div className="flex flex-wrap gap-2">
          <button type="button" className={`${button} bg-fire-500 text-black`} disabled={busy} onClick={() => void run("accept")}>Accept &amp; Join</button>
          <button type="button" className={button} disabled={busy} onClick={() => void decline()}>Decline</button>
        </div>}
        {intent && !busy && <>
          <p className="text-sm text-board-muted">Your earlier response may still finish. Retry repeats the same decision.</p>
          <button type="button" className={button} onClick={() => void chooseAgain()}>Choose another response</button>
          {state.status !== "failed" && <button type="button" className={button} onClick={() => void run(intent)}>{retryLabels[intent]}</button>}
        </>}
      </>}
      {view.status === "accepted" && !(state.status === "failed" && state.operation === "open") && <button type="button" className={`${button} bg-fire-500 text-black`} disabled={busy} onClick={() => void run("open")}>Open workspace</button>}
      {(view.status === "expired" || view.status === "canceled" || view.status === "access-removed") && <p className="text-sm text-board-muted">Ask a workspace administrator for a new invitation. This link cannot grant access.</p>}
      {view.status === "unavailable" && <p className="text-sm text-board-muted">The link is invalid or its invitation or workspace was removed.</p>}
      {view.status === "declined" && <p role="status" className="text-sm">Your decline was saved. You have not joined through this invitation.</p>}
      {busy && <p role="status" className="text-sm">{state.operation === "read" ? "Checking invitation…" : state.operation === "open" ? "Opening workspace…" : state.operation === "signout" ? "Signing out…" : "Saving your response…"}</p>}
      {state.status === "failed" && <div role="alert" className="space-y-2 text-sm text-red-300">
        <p>{state.message}</p><p className="text-xs">Last attempt: {new Date(state.at).toLocaleTimeString()}</p>
        <button type="button" className={button} onClick={() => void run(state.operation)}>{retryLabels[state.operation]}</button>
      </div>}
      {view.status !== "signed-out" && <button type="button" className={button} disabled={busy} onClick={() => void run("read")}>Check invitation status</button>}
      <a href="/" className={`${button} ml-2`}>Back to ShowPilot</a>
    </section>
    {ConfirmDialogEl}
  </>;
}
