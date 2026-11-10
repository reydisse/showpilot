import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { InvitationResponseCard } from "@/components/invitations/InvitationResponseCard";
import { getInvitationDetails } from "@/lib/session";

export const Route = createFileRoute("/invite/$invitationId")({
  loader: ({ params, abortController }) => getInvitationDetails({ data: params.invitationId, signal: abortController.signal }),
  component: InvitePage,
});

function InvitePage() {
  const initial = Route.useLoaderData();
  const { invitationId } = Route.useParams();
  const navigate = useNavigate();
  return <main className="flex min-h-dvh items-center justify-center bg-board-bg px-4 py-8 text-board-text">
    <div className="w-full max-w-lg">
      <p className="mb-6 text-center text-2xl font-bold"><span className="text-fire-500">Show</span>Pilot</p>
      <InvitationResponseCard key={invitationId} invitationId={invitationId} initial={initial} navigate={href => navigate({ href })} />
    </div>
  </main>;
}
