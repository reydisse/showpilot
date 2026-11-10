import { Link } from "@tanstack/react-router";
import { ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";

type Failure = "invalid" | "expired" | "unavailable" | "wrong-account" | "access-removed";
export function ChatInviteShell({ children }: { children: ReactNode }) {
  return <main className="flex min-h-dvh items-center justify-center bg-board-bg p-4 sm:p-6"><div className="w-full max-w-sm rounded-2xl border border-board-border bg-board-card p-6 text-center shadow-2xl sm:p-7">{children}</div></main>;
}
export function ChatInviteNotice({ kind, status }: { kind: "planning" | "crew"; status: Failure }) {
  const label = kind === "planning" ? "Planning invite" : "crew pass";
  const message = (() => {
    switch (status) {
      case "invalid": return { title: `This ${label} is invalid`, detail: "The link is incomplete or could not be verified. Ask the sender for a new link." };
      case "expired": return { title: `This ${label} has expired`, detail: "Its access period has ended. Ask the sender for a new link." };
      case "unavailable": return { title: `This ${label} is no longer available`, detail: "The workspace for this link is no longer available. Contact the sender." };
      case "wrong-account": return { title: "This invite is for another member", detail: "You’re signed in with a different account. Ask the sender for an invite for this account, or sign out and use the invited account." };
      case "access-removed": return { title: "Your Planning access has changed", detail: "You no longer have chat access in this workspace. Contact a workspace administrator." };
      default: { const exhaustive: never = status; return exhaustive; }
    }
  })();
  return <ChatInviteShell><ShieldCheck className="mx-auto h-10 w-10 text-board-muted" aria-hidden="true" />
    <h1 className="mt-4 text-xl font-semibold text-board-text">{message.title}</h1>
    <p className="mt-2 text-sm leading-6 text-board-muted">{message.detail}</p>
    <Link to="/" className="mt-5 inline-flex min-h-11 items-center justify-center rounded-lg px-4 py-2 text-sm text-fire-400 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2">Return to ShowPilot</Link>
  </ChatInviteShell>;
}
