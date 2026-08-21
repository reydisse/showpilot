import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { CalendarDays, ShieldCheck, UserCheck } from "lucide-react";
import { validatePlanningChatPass } from "@/lib/crew-chat-pass";

export const Route = createFileRoute("/join/chat/planning/$token")({
  loader: async ({ params }) => ({ pass: await validatePlanningChatPass({ data: params.token }) }),
  component: PlanningChatInvitePage,
});

function PlanningChatInvitePage() {
  const { pass } = Route.useLoaderData();
  const navigate = useNavigate();

  useEffect(() => {
    if (!pass?.authorized) return;
    void navigate({ to: "/$slug/chat", params: { slug: pass.orgSlug }, search: { room: "planning", message: undefined }, replace: true });
  }, [navigate, pass]);

  if (!pass) return <InviteShell><ShieldCheck className="mx-auto h-10 w-10 text-board-muted" /><h1 className="mt-4 text-xl font-semibold text-board-text">This Planning invite has expired</h1><p className="mt-2 text-sm text-board-muted">Ask the person who shared it for a new link.</p><Link to="/login" className="mt-5 inline-block text-sm text-fire-400">Member sign in</Link></InviteShell>;

  if (!pass.signedIn) return <InviteShell><CalendarDays className="mx-auto h-10 w-10 text-fire-400" /><h1 className="mt-4 text-xl font-semibold text-board-text">Join the Planning Room</h1><p className="mt-2 text-sm leading-6 text-board-muted">Sign in with the ShowPilot account this link was shared with, then reopen the invite.</p><Link to="/login" className="mt-5 inline-flex rounded-xl bg-fire-500 px-4 py-3 text-sm font-semibold text-black">Sign in to continue</Link></InviteShell>;

  return <InviteShell><UserCheck className="mx-auto h-10 w-10 text-red-300" /><h1 className="mt-4 text-xl font-semibold text-board-text">This invite is for another member</h1><p className="mt-2 text-sm leading-6 text-board-muted">Ask the sender to create a Planning link for your ShowPilot account.</p><Link to="/" className="mt-5 inline-block text-sm text-fire-400">Return to ShowPilot</Link></InviteShell>;
}

function InviteShell({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-[100dvh] items-center justify-center bg-board-bg p-6"><div className="w-full max-w-sm rounded-2xl border border-board-border bg-board-card p-7 text-center shadow-2xl">{children}</div></div>;
}
