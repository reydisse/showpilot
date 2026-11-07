import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { CalendarDays } from "lucide-react";
import { validatePlanningChatPass } from "@/lib/crew-chat-pass";
import { ChatInviteNotice, ChatInviteShell } from "@/components/chat/ChatInviteNotice";

export const Route = createFileRoute("/join/chat/planning/$token")({
  staleTime: 0,
  preloadStaleTime: 0,
  loader: async ({ params, abortController }) => {
    const pass = await validatePlanningChatPass({ data: params.token, signal: abortController.signal });
    abortController.signal.throwIfAborted();
    if (pass.status === "authorized") throw redirect({ to: "/$slug/chat", params: { slug: pass.orgSlug }, search: { room: "planning", message: undefined }, replace: true });
    return { pass, returnTo: `/join/chat/planning/${encodeURIComponent(params.token)}` };
  },
  component: PlanningChatInvitePage,
});

function PlanningChatInvitePage() {
  const { pass, returnTo } = Route.useLoaderData();
  if (pass.status === "signed-out") return <ChatInviteShell>
    <CalendarDays className="mx-auto h-10 w-10 text-fire-400" aria-hidden="true" />
    <h1 className="mt-4 text-xl font-semibold text-board-text">Join the Planning Room</h1>
    <p className="mt-2 text-sm leading-6 text-board-muted">Sign in with the ShowPilot account this link was shared with. We’ll return you to this invite.</p>
    <Link to="/login" search={{ returnTo }} className="mt-5 inline-flex min-h-11 items-center justify-center rounded-xl bg-fire-500 px-4 py-3 text-sm font-semibold text-black focus-visible:outline-2 focus-visible:outline-offset-2">Sign in to continue</Link>
  </ChatInviteShell>;
  return <ChatInviteNotice kind="planning" status={pass.status} />;
}
