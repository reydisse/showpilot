import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { CalendarDays, Check, Clock3, MapPin, X } from "lucide-react";
import { useState } from "react";
import {
  getMyAssignments,
  respondToMyAssignment,
} from "@/lib/schedule";
import { formatWallTime } from "@/lib/utils";

export const Route = createFileRoute("/$slug/assignments")({
  validateSearch: (search: Record<string, unknown>) => ({
    assignment:
      typeof search.assignment === "string" && search.assignment.length <= 128
        ? search.assignment
        : undefined,
  }),
  loaderDeps: ({ search }) => ({ assignment: search.assignment }),
  loader: async ({ context, deps }) => ({
    orgId: context.orgId,
    slug: context.slug,
    data: await getMyAssignments({
      data: {
        orgId: context.orgId,
        assignmentId: deps.assignment,
      },
    }),
  }),
  component: MyAssignmentsPage,
});

type Assignment = Awaited<
  ReturnType<typeof getMyAssignments>
>["assignments"][number];

function MyAssignmentsPage() {
  const { orgId, slug, data } = Route.useLoaderData();
  const { assignment: requestedAssignment } = Route.useSearch();
  const router = useRouter();
  const [responding, setResponding] = useState<string | null>(null);
  const [declining, setDeclining] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const respond = async (
    assignment: Assignment,
    response: "confirmed" | "declined",
  ) => {
    setResponding(assignment.id);
    setError(null);
    try {
      await respondToMyAssignment({
        data: {
          orgId,
          assignmentId: assignment.id,
          response,
          reason: response === "declined" ? reason : "",
          reviewedVersion: assignment.responseVersion,
        },
      });
      setDeclining(null);
      setReason("");
      await router.invalidate();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Your response did not save.",
      );
    } finally {
      setResponding(null);
    }
  };

  return (
    <main className="min-h-full bg-board-bg px-4 py-6 sm:px-6">
      <div className="mx-auto max-w-3xl space-y-5">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-fire-500">
              Personal schedule
            </p>
            <h1 className="mt-1 text-2xl font-semibold text-board-text">
              My assignments
            </h1>
            <p className="mt-1 text-sm text-board-muted">
              Only assignments connected to {data.crewName} are shown here.
            </p>
          </div>
          {requestedAssignment ? (
            <Link
              to="/$slug/assignments"
              params={{ slug }}
              search={{ assignment: undefined }}
              className="rounded-xl border border-board-border px-4 py-2 text-sm font-semibold text-board-text"
            >
              View all mine
            </Link>
          ) : null}
        </header>

        {error ? (
          <p
            role="alert"
            className="rounded-xl border border-red-500/25 bg-red-500/10 px-4 py-3 text-sm text-red-300"
          >
            {error}
          </p>
        ) : null}

        {!data.requestedFound ? (
          <section className="rounded-2xl border border-board-border bg-board-card p-6">
            <h2 className="font-semibold text-board-text">
              Assignment unavailable
            </h2>
            <p className="mt-2 text-sm leading-6 text-board-muted">
              This assignment was removed, reassigned, or belongs to another
              person. It has not been exposed in this account.
            </p>
          </section>
        ) : data.assignments.length === 0 ? (
          <section className="rounded-2xl border border-board-border bg-board-card p-8 text-center">
            <CalendarDays className="mx-auto h-7 w-7 text-board-muted" />
            <h2 className="mt-3 font-semibold text-board-text">
              No assignments yet
            </h2>
            <p className="mt-1 text-sm text-board-muted">
              Your production assignments will appear here.
            </p>
          </section>
        ) : (
          <div className="space-y-4">
            {data.assignments.map((assignment) => {
              const pending = assignment.status === "assigned";
              const canRespond =
                pending && assignment.responseWindow.status === "open";
              return (
                <article
                  key={assignment.id}
                  className="rounded-2xl border border-board-border bg-board-card p-5 shadow-sm"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-fire-500">
                        {assignment.department}
                      </p>
                      <h2 className="mt-1 text-lg font-semibold text-board-text">
                        {assignment.role}
                      </h2>
                      <p className="mt-1 text-sm text-board-muted">
                        {assignment.serviceName}
                      </p>
                    </div>
                    <span
                      className={`rounded-full border px-3 py-1 text-xs font-semibold capitalize ${assignment.status === "confirmed" ? "border-green-500/25 bg-green-500/10 text-green-300" : assignment.status === "declined" ? "border-red-500/25 bg-red-500/10 text-red-300" : "border-amber-400/25 bg-amber-400/10 text-amber-300"}`}
                    >
                      {assignment.status}
                    </span>
                  </div>
                  <div className="mt-4 grid gap-2 text-sm text-board-muted sm:grid-cols-3">
                    <p className="flex items-center gap-2">
                      <CalendarDays className="h-4 w-4" />
                      {assignment.serviceDate}
                    </p>
                    <p className="flex items-center gap-2">
                      <Clock3 className="h-4 w-4" />
                      {assignment.callTime
                        ? `Call ${formatWallTime(assignment.callTime)}`
                        : assignment.scheduledStartTime
                          ? new Date(
                              assignment.scheduledStartTime,
                            ).toLocaleTimeString([], {
                              hour: "numeric",
                              minute: "2-digit",
                              timeZone: data.orgTimezone,
                            })
                          : "Time to be confirmed"}
                    </p>
                    <p className="flex items-center gap-2">
                      <MapPin className="h-4 w-4" />
                      {assignment.location || "Location to be confirmed"}
                    </p>
                  </div>
                  {assignment.notes ? (
                    <p className="mt-4 whitespace-pre-wrap rounded-xl bg-board-bg px-4 py-3 text-sm leading-6 text-board-text">
                      {assignment.notes}
                    </p>
                  ) : null}
                  {assignment.responseNote ? (
                    <p className="mt-3 text-xs text-board-muted">
                      Your note: {assignment.responseNote}
                    </p>
                  ) : null}
                  {canRespond && declining !== assignment.id ? (
                    <div className="mt-5 flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={responding === assignment.id}
                        onClick={() => void respond(assignment, "confirmed")}
                        className="inline-flex items-center gap-2 rounded-xl bg-green-500 px-4 py-2.5 text-sm font-bold text-black disabled:opacity-40"
                      >
                        <Check className="h-4 w-4" />
                        Accept
                      </button>
                      <button
                        type="button"
                        disabled={responding === assignment.id}
                        onClick={() => {
                          setDeclining(assignment.id);
                          setReason("");
                        }}
                        className="inline-flex items-center gap-2 rounded-xl border border-red-500/30 px-4 py-2.5 text-sm font-semibold text-red-300 disabled:opacity-40"
                      >
                        <X className="h-4 w-4" />
                        Decline
                      </button>
                    </div>
                  ) : null}
                  {canRespond && declining === assignment.id ? (
                    <div className="mt-5 space-y-3 rounded-xl border border-board-border bg-board-bg p-4">
                      <label className="block text-xs font-medium text-board-muted">
                        Optional note
                        <textarea
                          maxLength={500}
                          value={reason}
                          onChange={(event) => setReason(event.target.value)}
                          className="mt-2 min-h-24 w-full resize-y rounded-xl border border-board-border bg-board-card p-3 text-sm text-board-text outline-none"
                        />
                      </label>
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          disabled={responding === assignment.id}
                          onClick={() => setDeclining(null)}
                          className="rounded-xl border border-board-border px-4 py-2 text-sm text-board-text"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          disabled={responding === assignment.id}
                          onClick={() => void respond(assignment, "declined")}
                          className="rounded-xl bg-red-500 px-4 py-2 text-sm font-bold text-white disabled:opacity-40"
                        >
                          {responding === assignment.id
                            ? "Saving…"
                            : "Confirm decline"}
                        </button>
                      </div>
                    </div>
                  ) : null}
                  {pending && assignment.responseWindow.status === "closed" ? (
                    <p className="mt-4 text-xs text-board-muted">
                      Responses closed after this show ended.
                    </p>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}
