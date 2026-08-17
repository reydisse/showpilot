import {
  createFileRoute,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { useMemo, useState } from "react";
import {
  CalendarDays,
  Check,
  Clock3,
  LockKeyhole,
  MapPin,
  UserRound,
  X,
} from "lucide-react";
import {
  getCrewSchedulePortal,
  respondToCrewScheduleInvite,
} from "@/lib/crew-schedule";
import { orgTerms } from "@/lib/org-terminology";

export const Route = createFileRoute("/crew/schedule/$token")({
  validateSearch: (search: Record<string, unknown>) => ({
    assignment:
      typeof search.assignment === "string" ? search.assignment : undefined,
  }),
  // Every assignment needed by this portal is loaded once. Switching between
  // them is local state reflected in the URL, not a route reload.
  loaderDeps: () => ({}),
  loader: ({ params }) =>
    getCrewSchedulePortal({ data: { token: params.token } }),
  component: CrewSchedulePortal,
});

function formatDate(value: string) {
  return new Date(`${value}T12:00:00`).toLocaleDateString([], {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}
function formatTime(value: string | null) {
  return value
    ? new Date(value).toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
      })
    : "Time to be confirmed";
}

function CrewSchedulePortal() {
  const data = Route.useLoaderData();
  const { token } = Route.useParams();
  const { assignment: requestedId } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const selected = useMemo(
    () =>
      data.assignments.find((assignment) => assignment.id === requestedId) ??
      data.assignments[0] ??
      null,
    [data.assignments, requestedId],
  );
  const respond = async (response: "confirmed" | "declined") => {
    if (!selected) return;
    setBusy(true);
    try {
      await respondToCrewScheduleInvite({
        data: {
          token,
          assignmentId: selected.id,
          response,
          reason: response === "declined" ? reason : "",
        },
      });
      setDeclining(false);
      await router.invalidate();
    } finally {
      setBusy(false);
    }
  };

  if (!selected)
    return (
      <PortalShell>
        <div className="py-20 text-center">
          <CalendarDays className="mx-auto h-10 w-10 text-zinc-600" />
          <h1 className="mt-5 text-2xl font-semibold">
            No upcoming assignments
          </h1>
          <p className="mt-2 text-sm text-zinc-400">
            You’re all clear, {data.crewName}.
          </p>
        </div>
      </PortalShell>
    );
  const confirmed = selected.status === "confirmed";
  const declined = selected.status === "declined";
  const terms = orgTerms(data.terminologyProfile);

  return (
    <PortalShell>
      <header className="border-b border-board-border pb-7 text-center">
        <p className="text-sm text-board-muted">{data.orgName}</p>
        <div className="mx-auto mt-5 flex h-14 w-14 items-center justify-center rounded-full border border-fire-500/30 bg-fire-500/10 text-fire-500">
          {confirmed ? (
            <Check className="h-6 w-6" />
          ) : declined ? (
            <X className="h-6 w-6" />
          ) : (
            <CalendarDays className="h-6 w-6" />
          )}
        </div>
        <h1 className="mt-5 text-3xl font-semibold tracking-tight text-board-text sm:text-4xl">
          {confirmed
            ? "You’re scheduled"
            : declined
              ? "Response received"
              : `Can you ${terms.participate}?`}
        </h1>
        <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-board-muted">
          {confirmed
            ? "Thanks! You’re all set for this assignment."
            : declined
              ? "Thanks for letting the team know."
              : `Hi ${data.crewName}, please respond to this ${terms.event} request.`}
        </p>
      </header>
      <section className="divide-y divide-board-border">
        <Detail
          icon={CalendarDays}
          label={selected.serviceName}
          value={formatDate(selected.serviceDate)}
        />
        <Detail
          icon={Clock3}
          label="Call time"
          value={formatTime(selected.scheduledStartTime)}
        />
        {selected.location ? (
          <Detail icon={MapPin} label="Location" value={selected.location} />
        ) : null}
        <Detail icon={UserRound} label="Your role" value={selected.role} />
        {selected.notes ? (
          <Detail
            icon={UserRound}
            label="Manager note"
            value={selected.notes}
          />
        ) : null}
      </section>
      {!confirmed && !declined ? (
        <section className="space-y-3 pt-6">
          {declining ? (
            <div className="space-y-3">
              <label className="block text-xs text-board-muted">
                Optional note
                <textarea
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  rows={3}
                  maxLength={500}
                  placeholder={`Let the team know why you can’t ${terms.participate}`}
                  className="mt-2 w-full resize-none rounded-xl border border-board-border bg-board-card p-3 text-sm text-board-text outline-none focus:border-fire-500/60"
                />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <button
                  onClick={() => setDeclining(false)}
                  className="rounded-xl border border-board-border px-4 py-3 text-sm font-medium text-board-text"
                >
                  Back
                </button>
                <button
                  disabled={busy}
                  onClick={() => void respond("declined")}
                  className="rounded-xl bg-red-500 px-4 py-3 text-sm font-semibold text-white disabled:opacity-50"
                >
                  Send decline
                </button>
              </div>
            </div>
          ) : (
            <>
              <button
                disabled={busy}
                onClick={() => void respond("confirmed")}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-fire-500 px-5 py-4 text-base font-semibold text-black disabled:opacity-50"
              >
                <Check className="h-5 w-5" />
                Accept assignment
              </button>
              <button
                disabled={busy}
                onClick={() => setDeclining(true)}
                className="flex w-full items-center justify-center gap-2 rounded-xl border border-board-border px-5 py-4 text-base font-medium text-board-text disabled:opacity-50"
              >
                <X className="h-5 w-5" />
                I’m not available
              </button>
            </>
          )}
        </section>
      ) : null}
      <a
        href={`/api/crew/schedule/${token}/calendar?assignment=${encodeURIComponent(selected.id)}`}
        className="mt-4 flex w-full items-center justify-center gap-2 border-y border-board-border py-4 text-sm font-medium text-board-text"
      >
        <CalendarDays className="h-4 w-4 text-fire-500" />
        Add to calendar
      </a>
      {data.assignments.filter(
        (assignment) =>
          assignment.id !== selected.id &&
          assignment.serviceDate >= data.today &&
          assignment.status !== "declined",
      ).length ? (
        <section className="pt-7">
          <h2 className="text-sm font-semibold text-board-text">
            Your other upcoming assignments
          </h2>
          <div className="mt-3 divide-y divide-board-border border-y border-board-border">
            {data.assignments
              .filter(
                (assignment) =>
                  assignment.id !== selected.id &&
                  assignment.serviceDate >= data.today &&
                  assignment.status !== "declined",
              )
              .slice(0, 4)
              .map((assignment) => (
                <button
                  key={assignment.id}
                  onClick={() =>
                    void navigate({
                      search: { assignment: assignment.id },
                      replace: true,
                    })
                  }
                  className="flex w-full items-center justify-between gap-4 py-3 text-left hover:bg-board-bg/50"
                >
                  <span>
                    <span className="block text-sm font-medium text-board-text">
                      {assignment.serviceName}
                    </span>
                    <span className="mt-1 block text-xs text-board-muted">
                      {formatDate(assignment.serviceDate)} · {assignment.role}
                    </span>
                  </span>
                  <span
                    className={`shrink-0 text-[10px] font-semibold uppercase tracking-wide ${assignment.status === "confirmed" ? "text-green-400" : "text-fire-400"}`}
                  >
                    {assignment.status === "confirmed" ? "Accepted" : "Reply"}
                  </span>
                </button>
              ))}
          </div>
        </section>
      ) : null}
    </PortalShell>
  );
}

function PortalShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-[100dvh] bg-board-bg px-4 py-4 text-board-text sm:px-6 sm:py-8">
      <div className="mx-auto flex w-full max-w-5xl flex-col rounded-2xl border border-board-border bg-board-card px-5 py-6 shadow-2xl sm:px-10 sm:py-8 lg:px-14">
        <div className="mx-auto mb-8 flex w-full max-w-3xl flex-col items-center justify-center gap-2 text-center">
          <span className="font-display text-xl font-bold">
            <span className="text-fire-500">Show</span>Pilot
          </span>
          <span className="flex items-center gap-1.5 text-[11px] text-board-muted">
            <LockKeyhole className="h-3.5 w-3.5" />
            No account needed
          </span>
        </div>
        <div className="mx-auto w-full max-w-3xl flex-1">{children}</div>
        <footer className="mx-auto mt-10 w-full max-w-3xl border-t border-board-border pt-5 text-center text-[11px] leading-relaxed text-board-muted">
          <p>
            <LockKeyhole className="mr-1 inline h-3 w-3" />
            Secure link. This link is unique to you.
          </p>
          <p className="mt-2 font-medium text-board-text/70">
            Powered by <span className="text-fire-500">Show</span>Pilot
          </p>
        </footer>
      </div>
    </main>
  );
}
function Detail({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
}) {
  return (
    <div className="flex gap-4 py-5">
      <Icon className="mt-1 h-5 w-5 shrink-0 text-board-muted" />
      <div>
        <p className="text-sm font-medium text-board-text">{label}</p>
        <p className="mt-1 text-sm leading-relaxed text-board-muted">{value}</p>
      </div>
    </div>
  );
}
