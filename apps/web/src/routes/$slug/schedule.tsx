import { ReadFailureNotice } from "@/components/layout/ReadFailureNotice";
import { groupRosterRows, rosterDepartment } from "@/lib/schedule-roster";
import { ShowInventoryEditor } from "@/components/shows/ShowInventoryEditor";
import { useShowDeletions } from "@/hooks/useShowDeletions";
import { ShowDeletionProgress } from "@/components/shows/ShowDeletionProgress";
import { ShowDetailsEditor } from "@/components/shows/ShowDetailsEditor";
import { CopyTeamControl } from "@/components/schedule/CopyTeamControl";
import { useScheduleRoster } from "@/hooks/useScheduleRoster";

import { AssignmentEditor } from "@/components/schedule/AssignmentEditor";
import { ReminderControl } from "@/components/schedule/ReminderControl";
import { ScheduleProviderControl } from "@/components/schedule/ScheduleProviderControl";
import { workspaceCopy } from "@showpilot/shared";
import { useTerms as useWorkspaceTerms } from "@/components/workspace/WorkspaceProvider";
import { useTerms } from "@/components/workspace/WorkspaceProvider";
import { useDeviceLocale } from "@/hooks/useDeviceLocale";
import { getDeviceTimeZone, useDeviceTimeZone } from "@/hooks/useDeviceTimeZone";
import { useRundownSync } from "@/hooks/useRundownSync";
import {
  createFileRoute,
  Link,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { ScheduleSkeleton } from "@/components/ui/Skeleton";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { ShowCreationForm, inventoryDraft, type ShowDraft } from "@/components/shows/ShowCreationForm";
import {
  getSchedule,
  type ScheduleProvider,
} from "@/lib/schedule";
import {
  getShowInventoryData,
  type ShowInventorySummary,
  type SavedRundownSource,
} from "@/lib/show-inventory";
import { getOrgSettings } from "@/lib/settings";
import { formatTimeInput, getTodayDateString } from "@/lib/utils";
import { type OrgTerminologyProfile } from "@/lib/org-terminology";
import { hasEffectivePermission } from "@/lib/app-permissions";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import {
  getScheduleSelectionDeps,
  getScheduleMonthWindow,
  normalizeScheduleSearch,
  type ScheduleSearch,
} from "@/lib/schedule-selection";

function shiftDate(date: string, days: number) {
  const value = new Date(`${date}T12:00:00`);
  value.setDate(value.getDate() + days);
  return value.toISOString().slice(0, 10);
}
function nextAvailableServiceDate(today: string, serviceDates: string[]) {
  const occupied = new Set(serviceDates);
  let candidate = shiftDate(today, 7);
  for (let attempt = 0; attempt < 52 && occupied.has(candidate); attempt += 1) {
    candidate = shiftDate(candidate, 7);
  }
  return candidate;
}
function dayLabel(date: string, locale: string) {
  return new Date(`${date}T12:00:00`).toLocaleDateString(locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}
function longDate(date: string, locale: string) {
  return new Date(`${date}T12:00:00`).toLocaleDateString(locale, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}
function timeLabel(value: string | null, timeZone: string | undefined, locale: string) {
  return value
    ? new Date(value).toLocaleTimeString(locale, {
        hour: "numeric",
        minute: "2-digit",
        timeZone: timeZone || "UTC",
      })
    : "Time not set";
}
function inputTime(value: string | null, timeZone?: string) {
  return formatTimeInput(value, timeZone || "UTC");
}
function providerName(provider: ScheduleProvider, label = "") {
  return (
    label ||
    {
      native: "ShowPilot",
      "planning-center": "Planning Center",
      faithteams: "Faith Teams",
      other: "External platform",
    }[provider]
  );
}
export const Route = createFileRoute("/$slug/schedule")({
  validateSearch: (search: Record<string, unknown>): ScheduleSearch =>
    normalizeScheduleSearch(search),
  loaderDeps: ({ search }) => getScheduleSelectionDeps(search),
  pendingComponent: ScheduleSkeleton,
  loader: async ({ context, deps }) => {
    const { withPermission } = await import("@/lib/route-permissions");
    await withPermission(
      context.role,
      "schedule:view",
      context.slug,
      context.orgId,
    );
    const settings = await getOrgSettings({ data: { orgId: context.orgId } });
    const orgTimezone = settings["org-timezone"] || "UTC";
    const today = getTodayDateString(orgTimezone);
    const calendarMonth = deps.calendarMonth ?? deps.selectedDate?.slice(0, 7) ?? today.slice(0, 7);
    const schedule = await getSchedule({
      data: {
        orgId: context.orgId,
        ...getScheduleMonthWindow(calendarMonth),
        selectedDate: deps.selectedDate,
        selectedShowId: deps.selectedShowId,
      },
    });
    // Keep these reads serialized: multiple Prisma D1 clients competing in
    // one Workers request can leave Miniflare waiting indefinitely.
    const { inventory, archivedInventory, savedTemplates } = await getShowInventoryData({ data: { orgId: context.orgId } });
    const defaultSelectedDate =
      schedule.services.find((service) => service.serviceDate >= today)
        ?.serviceDate ??
      schedule.services.at(-1)?.serviceDate ??
      null;
    const defaultSelectedShowId =
      schedule.services.find((service) => service.serviceDate >= today)?.id ??
      schedule.services.at(-1)?.id ??
      null;
    return {
      ...schedule,
      calendarMonth,
      defaultSelectedDate,
      defaultSelectedShowId,
      today,
      orgTimezone,
      orgId: context.orgId,
      canManage: hasEffectivePermission(
        context.role,
        context.grantedPermissions,
        "schedule:manage",
      ),
      inventory,
      archivedInventory,
      savedTemplates,
    };
  },
  component: SchedulePage,
});

type Assignment = Awaited<
  ReturnType<typeof getSchedule>
>["assignments"][number];
type ResponseFilter =
  | "all"
  | "assigned"
  | "confirmed"
  | "declined"
  | "closed"
  | "open";

function SchedulePage() {
  const locale = useDeviceLocale();
  const workspaceTerms = useWorkspaceTerms();
  const data = Route.useLoaderData();
  const { user } = Route.useRouteContext();
  const deviceTimeZone = useDeviceTimeZone();
  const { show: requestedShowId, date: requestedDate } = Route.useSearch();
  const { slug } = Route.useParams();
  const navigate = useNavigate({ from: Route.fullPath });
  const router = useRouter();
  const { confirm, ConfirmDialogEl } = useConfirmDialog();
  const refreshAssignments = async () => {
    await router.invalidate();
    const match = router.state.matches.find(value => value.routeId === Route.id);
    if (match?.status === "error") throw match.error;
  };
  const [createOpen, setCreateOpen] = useState(false);
  const [inventoryOpen, setInventoryOpen] = useState(false);
  const [inventorySeedId, setInventorySeedId] = useState<string | undefined>();
  const [assignmentOpen, setAssignmentOpen] = useState(false);
  const [assignmentDepartment, setAssignmentDepartment] = useState("");
  const [teamBuilderOpen, setTeamBuilderOpen] = useState(false);
  const [editing, setEditing] = useState<Assignment | null>(null);
  const [serviceOpen, setServiceOpen] = useState(false);
  const [filter, setFilter] = useState<ResponseFilter>("all");
  const terms = useTerms();
  const selected =
    data.services.find((service) => service.id === requestedShowId) ??
    data.services.find((service) => service.serviceDate === requestedDate) ??
    data.services.find((service) => service.id === data.defaultSelectedShowId) ??
    data.services[0] ??
    null;
  const deletions = useShowDeletions({ orgId: data.orgId, userId: user.id }, {
    refresh: async signal => {
      await router.invalidate();
      signal.throwIfAborted();
      const failed = router.state.matches.find(match => match.status === "error");
      if (failed) throw failed.error;
    },
    onConfirmed: id => { if (selected?.id === id) setServiceOpen(false); },
  });
  const selectedIndex = selected
    ? data.services.findIndex((service) => service.id === selected.id)
    : -1;
  const previous = selectedIndex > 0 ? data.services[selectedIndex - 1] : null;
  const roster = useScheduleRoster({ orgId: data.orgId, userId: user.id, showId: selected?.id, assignments: data.assignments });
  const selectedAssignments = roster.value;
  const savedTeams = selected ? data.services.filter(show => show.serviceDate < selected.serviceDate).map(show => {
    const crew = data.assignments.filter(row => row.showId === show.id);
    return { show, count: crew.length, departments: Array.from(new Set(crew.map(rosterDepartment).filter(Boolean))).join(" · ") };
  }).filter(team => team.count > 0).reverse() : [];

  const liveAssignments = useMemo(() => [...data.assignments.filter(row => row.showId !== selected?.id), ...selectedAssignments], [data.assignments, selected?.id, selectedAssignments]);
  const departments = Array.from(
    new Set(
      liveAssignments
        .map(rosterDepartment)
        .filter(Boolean),
    ),
  ).sort((a, b) => a.localeCompare(b));
  const assignments = useMemo(
    () =>
      selectedAssignments.filter(
        (assignment) => {
          const responseOpen = assignment.responseWindow.status === "open";
          if (filter === "all") return true;
          if (filter === "open") return !assignment.crewMemberId;
          if (filter === "closed") {
            return (
              assignment.status === "assigned" &&
              Boolean(assignment.crewMemberId) &&
              !responseOpen
            );
          }
          if (filter === "assigned") {
            return (
              assignment.status === "assigned" &&
              Boolean(assignment.crewMemberId) &&
              responseOpen
            );
          }
          return assignment.status === filter;
        },
      ),
    [selectedAssignments, filter],
  );
  const stats = {
    filled: selectedAssignments.filter((item) => item.crewMemberId).length,
    open: selectedAssignments.filter((item) => !item.crewMemberId).length,
    awaiting: selectedAssignments.filter(
      (item) =>
        item.status === "assigned" &&
        item.crewMemberId &&
        item.responseWindow.status === "open",
    ).length,
    declined: selectedAssignments.filter((item) => item.status === "declined")
      .length,
  };
  const chooseShow = (showId: string, date: string) =>
    void navigate({ search: { show: showId, date, month: date.slice(0, 7), assignment: undefined } });
  const chooseDate = (date: string) => {
    const show = data.services.find((service) => service.serviceDate === date);
    void navigate({
      search: { show: show?.id, date, month: date.slice(0, 7), assignment: undefined },
    });
  };

  return (
    <div className="h-full overflow-auto bg-board-bg">
      {selected ? (
        <ScheduleLiveDetails key={selected.id} orgId={data.orgId} service={selected} />
      ) : null}
      <header className="z-20 border-b border-board-border bg-board-bg/95 px-4 py-3 backdrop-blur-xl sm:sticky sm:top-0 md:px-6">
        <div className="mx-auto flex max-w-[1700px] flex-wrap items-center gap-3">
          <h1 className="min-w-0 basis-full text-xl font-semibold tracking-tight text-board-text sm:basis-auto sm:flex-1">
            Schedule
          </h1>
          {data.canManage ? (
            <ScheduleProviderControl
              key={`${user.id}:${data.orgId}`}
              userId={user.id}
              orgId={data.orgId}
              workspaceSettingsLink={
                <Link
                  to="/$slug/settings"
                  params={{ slug }}
                  search={{ section: "workspace" }}
                  className="inline-flex min-h-11 items-center text-fire-500 underline focus-visible:outline-2 focus-visible:outline-fire-500"
                >
                  Change wording in Settings → Workspace
                </Link>
              }
              refresh={async () => {
                await router.invalidate();
                const schedule = router.state.matches.find(
                  (match) => match.routeId === Route.id,
                );
                if (schedule?.status === "error") throw schedule.error;
              }}
            />
          ) : null}
          {data.canManage && data.provider.type === "native" ? (
            <button
              onClick={() => setInventoryOpen(true)}
              className="flex min-h-11 items-center gap-2 rounded-lg border border-board-border px-3 py-2 text-xs text-board-muted hover:text-board-text"
            >
              Inventory
            </button>
          ) : null}
          {data.canManage && data.provider.type === "native" ? (
            <button
              onClick={() => {
                setInventorySeedId(undefined);
                setCreateOpen(true);
              }}
              className="flex min-h-11 items-center gap-2 rounded-lg border border-board-border px-3 py-2 text-xs text-board-text"
            >
              <Plus className="h-3.5 w-3.5" />
              New {terms.event}
            </button>
          ) : null}
        </div>
      </header>
      <ShowDeletionProgress controller={deletions} />
      <div className="mx-auto grid min-h-[calc(100vh-58px)] max-w-[1700px] grid-cols-[minmax(0,1fr)] border-x border-board-border lg:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="border-b border-board-border bg-board-card lg:border-b-0 lg:border-r">
          <MonthCalendar
            calendarMonth={data.calendarMonth}
            onMonthChange={(month) => {
              const validMonth = normalizeScheduleSearch({ month }).month;
              if (validMonth) void navigate({ search: { month: validMonth, show: selected?.id, date: selected?.serviceDate } });
            }}
            selectedDate={selected?.serviceDate ?? data.today}
            today={data.today}
            serviceDates={data.services.map((service) => service.serviceDate)}
            onSelect={chooseDate}
          />
          <div className="border-y border-board-border px-4 py-3">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-board-muted">
                {workspaceCopy(
                  "\n                Services\n              ",
                  workspaceTerms,
                )}
              </p>
              <button
                onClick={() => chooseDate(data.today)}
                className="min-h-11 min-w-11 text-xs text-fire-400 focus-visible:outline focus-visible:outline-fire-400"
              >
                Today
              </button>
            </div>
          </div>
          <div className="flex snap-x overflow-x-auto lg:block lg:max-h-[calc(100vh-430px)] lg:overflow-y-auto">
            {data.services.map((service) => (
              <button
                key={service.id}
                onClick={() => chooseShow(service.id, service.serviceDate)}
                className={`min-w-[210px] snap-start border-b border-board-border border-l-[3px] px-3 py-2 text-left lg:w-full ${service.id === selected?.id ? "border-l-fire-500 bg-fire-500/[0.055]" : "border-l-transparent hover:bg-board-bg"}`}
              >
                <p
                  className={`text-xs font-semibold uppercase tracking-wider ${service.serviceDate === data.today ? "text-fire-400" : "text-board-muted"}`}
                >
                  {service.serviceDate === data.today
                    ? "Today"
                    : dayLabel(service.serviceDate, locale)}
                </p>
                <p className="mt-1 truncate text-sm font-medium text-board-text">
                  {service.name}
                </p>
                <p className="mt-1 text-xs text-board-muted">
                  {timeLabel(service.scheduledStartTime, deviceTimeZone, locale)} ·{" "}
                  {service.id === selected?.id
                    ? selectedAssignments.filter(
                        (assignment) => assignment.status === "confirmed",
                      ).length
                    : service.crewConfirmed}
                  /
                  {service.id === selected?.id
                    ? selectedAssignments.length
                    : service.crewTotal}{" "}
                  confirmed
                </p>
              </button>
            ))}
          </div>
        </aside>
        <main className="@container/schedule-main min-w-0 overflow-x-auto bg-board-bg [&_button]:outline-none [&_button]:focus-visible:ring-2 [&_button]:focus-visible:ring-fire-500">
          {selected ? (
            <>
              <section className="border-b border-board-border bg-board-card px-4 py-5 md:px-6">
                <div className="flex flex-wrap items-start gap-4">
                  <div className="min-w-0 flex-[1_1_18rem]">
                    <p className="mb-2 text-xs uppercase tracking-wider text-board-muted tabular-nums">{new Date(`${selected.serviceDate}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" })}{selected.serviceDate === data.today ? " · Today" : Math.round((Date.parse(selected.serviceDate) - Date.parse(data.today)) / 86400000) === 1 ? " · Tomorrow" : Math.round((Date.parse(selected.serviceDate) - Date.parse(data.today)) / 86400000) === -1 ? " · Yesterday" : ""}</p>
                    <button
                      disabled={!data.canManage}
                      onClick={() => setServiceOpen(true)}
                      className="flex max-w-full items-center gap-2 text-left disabled:cursor-default"
                      aria-label={data.canManage ? `Edit ${selected.name}` : undefined}
                    >
                      <h2 className="text-xl font-semibold text-board-text md:text-2xl">
                        {selected.name}
                      </h2>
                      {data.canManage ? (
                        <Pencil className="h-3.5 w-3.5 shrink-0 text-board-muted" />
                      ) : null}
                    </button>
                    <p className="mt-2 text-xs text-board-muted tabular-nums">
                      Starts {timeLabel(selected.scheduledStartTime, deviceTimeZone, locale)}{selected.effectiveCallTime ? ` · Crew call ${timeLabel(selected.effectiveCallTime, deviceTimeZone, locale)}` : ""}{selected.location ? ` · ${selected.location}` : ""}
                    </p>
                  </div>
                  {data.provider.type === "native" && data.canManage ? (
                    <div className="flex flex-wrap gap-2">

                      <button
                        onClick={() => {
                          setTeamBuilderOpen(true);
                        }}
                        className="flex items-center gap-2 rounded-lg px-3 py-2 text-xs text-board-muted hover:text-board-text"
                      >
                        <Plus className="h-3.5 w-3.5" />
                        Build a team
                      </button>
                      <button
                        onClick={() => {
                          setAssignmentDepartment(departments[0] ?? "");
                          setAssignmentOpen(true);
                        }}
                        className="flex items-center gap-2 rounded-lg bg-fire-500 px-3 py-2 text-xs font-semibold text-black"
                      >
                        <Plus className="h-3.5 w-3.5" />
                        Add position
                      </button>
                      <CopyTeamControl orgId={data.orgId} userId={user.id} showId={selected.id}
                        selection={previous ? { showId: selected.id, serviceDate: selected.serviceDate, copyFromShowId: previous.id, copyFrom: previous.serviceDate } : null}
                        canCopy={selectedAssignments.length === 0 && selected.status !== "running" && selected.status !== "paused"}
                        onChanged={refreshAssignments} />
                    </div>
                  ) : data.provider.url ? (
                    <a
                      href={data.provider.url}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center gap-2 rounded-lg bg-fire-500 px-3 py-2 text-xs font-semibold text-black"
                    >
                      Open{" "}
                      {providerName(data.provider.type, data.provider.label)}
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  ) : null}
                </div>
              </section>
              <section className="space-y-3 border-b border-board-border bg-board-card px-4 py-4 md:px-6">
                {stats.awaiting > 0 && (                      <ReminderControl
                        orgId={data.orgId}
                        target={{ kind: "show", id: selected.id }}
                        label={`Remind awaiting (${stats.awaiting})`}
                        disabled={stats.awaiting === 0}
                        onChanged={async () => { await router.invalidate(); const match = router.state.matches.find(value => value.routeId === Route.id); if (match?.status === "error") throw match.error; }}
                      />) }
                <p className="text-sm text-board-text tabular-nums">{stats.filled} of {selectedAssignments.length} filled · {stats.awaiting} awaiting · {stats.open} open</p>
                <div className="flex flex-wrap items-center gap-2">
                  {([['all', 'All'], ['confirmed', 'Confirmed'], ['assigned', 'Awaiting'], ['open', 'Open'], ['declined', 'Declined']] as const).map(([value, label]) => <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value)} className={`rounded-md px-3 py-2 text-xs focus-visible:outline focus-visible:outline-fire-500 ${filter === value ? 'bg-board-border text-board-text' : 'text-board-muted hover:text-board-text'}`}>{label}</button>)}
                  <Link
                    to="/$slug/rundown"
                    params={{ slug }}
                    search={{ show: selected.id, date: selected.serviceDate }}
                    className="flex min-h-11 items-center gap-1 rounded-lg border border-board-border px-3 py-2 text-xs text-board-text focus-visible:outline-2 focus-visible:outline-fire-500"
                  >
                    Rundown
                    <ChevronRight className="h-3 w-3" />
                  </Link>
                </div>
              </section>
              {data.provider.type !== "native" ? (
                <div className="border-b border-fire-500/20 bg-fire-500/[0.045] px-6 py-3 text-xs text-board-muted">
                  Assignments and confirmations are managed in{" "}
                  <strong className="text-board-text">
                    {providerName(data.provider.type, data.provider.label)}
                  </strong>
                  . ShowPilot remains the operational rundown and reporting
                  layer.
                </div>
              ) : null}
              <ReadFailureNotice error={roster.error} refreshing={roster.refreshing} retry={roster.retry} label="Try again" title="We couldn't load the crew for this show." description="Check your connection and try again. Nothing you changed has been lost." />
              {!assignments.length && !roster.refreshing && !roster.error ? (
                <div className="m-4 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                <div className="space-y-2 rounded-xl border border-dashed border-board-border p-8 text-sm text-board-muted" role="status">
                  <p className="font-semibold text-board-text">{selectedAssignments.length ? "No crew match this response filter." : "No crew on this show yet"}</p>
                  {!selectedAssignments.length && <><p className="max-w-md leading-6">Add positions one at a time, or start from a team you've already built. Everyone you add gets one invite they can accept in a single tap.</p>{data.canManage && <div className="flex gap-2 pt-2"><button onClick={() => setAssignmentOpen(true)} className="rounded-lg bg-fire-500 px-3 py-2 font-medium text-black">+ Add position</button></div>}</>}
                  {filter !== "all" ? <button type="button" className="rounded-lg px-3 text-fire-400" onClick={() => setFilter("all")}>Show all responses</button> : null}
                </div>
                {!selectedAssignments.length && data.canManage && data.provider.type === "native" && savedTeams.length > 0 && <section aria-label="Saved teams" className="py-4">
                  <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-board-muted">Saved teams</h3>
                  <ul className="divide-y divide-board-border">{savedTeams.map(({ show, count, departments }) => <li key={show.id} className="flex items-center justify-between gap-4 py-3">
                    <div className="min-w-0"><p className="text-sm font-medium text-board-text">{show.name}</p><p className="text-xs text-board-muted">{count} {count === 1 ? "position" : "positions"}{departments && ` · ${departments}`}</p></div>
                    <CopyTeamControl orgId={data.orgId} userId={user.id} showId={selected.id} label="Use" selection={{ showId: selected.id, serviceDate: selected.serviceDate, copyFromShowId: show.id, copyFrom: show.serviceDate }} canCopy={selected.status !== "running" && selected.status !== "paused"} onChanged={refreshAssignments} />
                  </li>)}</ul>
                </section>}
                </div>
              ) : null}
              <RosterTable
                assignments={assignments}
                departments={departments}
                orgId={data.orgId}
                canManage={data.canManage && data.provider.type === "native"}
                onAdd={(department) => {
                  setAssignmentDepartment(department);
                  setAssignmentOpen(true);
                }}
                onEdit={setEditing}
                onChanged={() => router.invalidate()}
                confirm={confirm}
              />
            </>
          ) : (
            <div className="py-24 text-center">
              <CalendarDays className="mx-auto h-9 w-9 text-board-muted/40" />
              <p className="mt-4 text-sm text-board-muted">
                {workspaceCopy(
                  "\n                Create your first service.\n              ",
                  workspaceTerms,
                )}
              </p>
            </div>
          )}
        </main>
      </div>
      {createOpen ? (
        <CreateServiceModal
          orgId={data.orgId}
          userId={user.id}
          venueTimeZone={data.orgTimezone}
          today={data.today}
          serviceDates={data.services.map((service) => service.serviceDate)}
          previousDate={data.services.at(-1)?.serviceDate}
          previousShowId={data.services.at(-1)?.id}
          inventory={data.inventory}
          initialInventoryId={inventorySeedId}
          terminologyProfile={data.terminologyProfile}
          onClose={() => setCreateOpen(false)}
          onCreated={async (showId, date, signal) => {
            await router.invalidate();
            signal.throwIfAborted();
            if (router.state.matches.some(match => match.status === "error")) throw new Error("The show was created, but Schedule could not refresh.");
            chooseShow(showId, date);
            setCreateOpen(false);
            setInventorySeedId(undefined);
          }}
        />
      ) : null}
      {inventoryOpen ? (
        <ShowInventoryModal
          key={`${user.id}:${data.orgId}`}
          userId={user.id}
          orgId={data.orgId}
          inventory={data.inventory}
          archivedInventory={data.archivedInventory}
          savedTemplates={data.savedTemplates}
          canManage={data.canManage}
          onClose={() => setInventoryOpen(false)}
          onUse={(item) => {
            setInventoryOpen(false);
            setInventorySeedId(item.id);
            setCreateOpen(true);
          }}
          onChanged={async (signal) => {
            await router.invalidate();
            signal.throwIfAborted();
            const failed = router.state.matches.find(match => match.status === "error");
            if (failed) throw failed.error;
          }}
        />
      ) : null}
      {assignmentOpen && selected ? (
        <AssignmentEditor
          key={`create:${user.id}:${data.orgId}:${selected.id}`}
          orgId={data.orgId} userId={user.id}
          target={{ kind: "create", showId: selected.id, serviceDate: selected.serviceDate }}
          departments={departments} initialDepartment={assignmentDepartment || "Production"}
          crew={data.crew} venueTimeZone={data.orgTimezone} confirm={confirm}
          onClose={() => setAssignmentOpen(false)} onSaved={refreshAssignments}
        />
      ) : null}
      {teamBuilderOpen && selected ? (
        <AssignmentEditor
          key={`team:${user.id}:${data.orgId}:${selected.id}`}
          orgId={data.orgId} userId={user.id}
          target={{ kind: "team", showId: selected.id, serviceDate: selected.serviceDate }}
          departments={departments} crew={data.crew} venueTimeZone={data.orgTimezone} confirm={confirm}
          onClose={() => setTeamBuilderOpen(false)} onSaved={refreshAssignments}
        />
      ) : null}
      {editing ? (
        <AssignmentEditor
          key={`edit:${user.id}:${data.orgId}:${editing.id}`}
          orgId={data.orgId} userId={user.id} target={{ kind: "edit", id: editing.id }}
          departments={departments} crew={data.crew} venueTimeZone={data.orgTimezone} confirm={confirm}
          onClose={() => setEditing(null)} onSaved={refreshAssignments}
        />
      ) : null}
      {serviceOpen && selected ? (
        <ServiceDetailsModal
          key={selected.id}
          orgId={data.orgId}
          userId={user.id}
          orgTimezone={deviceTimeZone}
          service={selected}
          onClose={() => setServiceOpen(false)}
          onSaved={async (signal) => {
            await router.invalidate();
            signal.throwIfAborted();
            const failed = router.state.matches.find(match => match.status === "error");
            if (failed) throw failed.error;
          }}
          deletion={deletions.work[selected.id]}
          onDelete={() => deletions.confirmDeletion({ showId: selected.id, name: selected.name, expectedUpdatedAt: new Date(selected.updatedAt).toISOString() }, () => confirm({
            title: "Delete this show?",
            description: `Delete ${selected.name || "this show"} and its rundown, crew assignments, notes, checklist and incidents? This cannot be undone.`,
            confirmLabel: "Delete show", variant: "danger",
          }))}
        />
      ) : null}
      {ConfirmDialogEl}
    </div>
  );
}

function MonthCalendar({
  calendarMonth,
  onMonthChange,
  selectedDate,
  today,
  serviceDates,
  onSelect,
}: {
  calendarMonth: string;
  onMonthChange: (month: string) => void;
  selectedDate: string;
  today: string;
  serviceDates: string[];
  onSelect: (date: string) => void;
}) {
  const locale = useDeviceLocale();
  const workspaceTerms = useWorkspaceTerms();
  const month = new Date(`${calendarMonth}-01T12:00:00`);
  const [expanded, setExpanded] = useState(false);
  const shiftMonth = (offset: number) => {
    const value = new Date(`${calendarMonth}-01T12:00:00Z`);
    value.setUTCMonth(value.getUTCMonth() + offset);
    onMonthChange(value.toISOString().slice(0, 7));
  };
  const serviceSet = useMemo(() => new Set(serviceDates), [serviceDates]);
  const startDay = month.getDay();
  const daysInMonth = new Date(
    month.getFullYear(),
    month.getMonth() + 1,
    0,
  ).getDate();
  const cells = Array.from({ length: 42 }, (_, index) => {
    const day = index - startDay + 1;
    return day > 0 && day <= daysInMonth ? day : null;
  });
  const dateFor = (day: number) =>
    `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return (
    <div className="p-1 sm:p-4">
      <button
        type="button"
        aria-controls="schedule-calendar"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="flex min-h-11 w-full items-center justify-center gap-2 rounded-lg text-sm text-board-text focus-visible:outline focus-visible:outline-fire-400 lg:hidden"
      >
        <CalendarDays className="h-4 w-4" />
        {expanded ? "Hide calendar" : "Show calendar"}
      </button>
      <div id="schedule-calendar" className={expanded ? "" : "hidden lg:block"}>
        <div className="flex items-center justify-between gap-1">
          <button
            onClick={() => shiftMonth(-1)}
            aria-label="Previous month"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded text-board-muted hover:bg-board-bg hover:text-board-text focus-visible:outline focus-visible:outline-fire-400"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <input
            type="month"
            aria-label="Calendar month"
            value={calendarMonth}
            onChange={(event) => onMonthChange(event.target.value)}
            className="h-11 min-w-0 w-full rounded-lg border border-board-border bg-board-bg px-2 text-sm text-board-text focus-visible:outline focus-visible:outline-fire-400"
          />
          <button
            onClick={() => shiftMonth(1)}
            aria-label="Next month"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded text-board-muted hover:bg-board-bg hover:text-board-text focus-visible:outline focus-visible:outline-fire-400"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-4 grid grid-cols-7 text-center text-xs font-medium uppercase text-board-muted">
          {["S", "M", "T", "W", "T", "F", "S"].map((label, index) => (
            <span key={`${label}-${index}`}>{label}</span>
          ))}
        </div>
        <div className="mt-2 grid grid-cols-7 gap-y-1">
          {cells.map((day, index) => {
            if (!day) return <span key={`empty-${index}`} className="h-11" />;
            const date = dateFor(day);
            const hasService = serviceSet.has(date);
            const selected = date === selectedDate;
            const isToday = date === today;
            return (
              <button
                key={date}
                disabled={!hasService}
                data-date={date}
                aria-label={longDate(date, locale)}
                aria-pressed={selected}
                onClick={() => onSelect(date)}
                className={`relative mx-auto flex h-11 w-11 items-center justify-center rounded-full text-xs transition-colors focus-visible:outline focus-visible:outline-fire-400 ${selected ? "bg-fire-500 font-semibold text-black" : hasService ? "text-board-text hover:bg-board-bg" : "text-board-muted/40"} ${isToday && !selected ? "ring-1 ring-fire-500/50" : ""}`}
              >
                {day}
                {hasService && !selected ? (
                  <span className="absolute bottom-0.5 h-0.5 w-0.5 rounded-full bg-fire-400" />
                ) : null}
              </button>
            );
          })}
        </div>
        <div className="mt-4 flex items-center justify-between border-t border-board-border pt-3 text-xs text-board-muted">
          <span>
            <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-fire-400" />
            {workspaceCopy(
              "\n          Service scheduled\n        ",
              workspaceTerms,
            )}
          </span>
          <button
            onClick={() => {
              onMonthChange(today.slice(0, 7));
            }}
            className="min-h-11 min-w-11 text-fire-400 focus-visible:outline focus-visible:outline-fire-400"
          >
            This month
          </button>
        </div>
      </div>
    </div>
  );
}
// TODO(design): bounce status is not exposed by the roster contract; add the flagged failure row when available.
// TODO(design): surface-2, surface-3 and border-strong reuse board-border, the nearest existing neutral token.
function RosterTable({
  assignments,
  departments,
  orgId,
  canManage,
  onAdd,
  onEdit,
  onChanged,
  confirm,
}: {
  assignments: Assignment[];
  departments: string[];
  orgId: string;
  canManage: boolean;
  onAdd: (department: string) => void;
  onEdit: (assignment: Assignment) => void;
  onChanged: () => Promise<void>;
  confirm: ReturnType<typeof useConfirmDialog>["confirm"];
}) {
  const groups = groupRosterRows(assignments, departments);
  return <div className="space-y-3">{groups.map(group => group.rows.length ? <details key={group.name} open className="rounded-xl border border-board-border bg-board-card">
    <summary className="flex min-h-11 cursor-pointer items-center justify-between gap-3 px-4 text-xs text-board-muted focus-visible:outline focus-visible:outline-fire-500">
      <span className="uppercase tracking-wider">{group.name} {group.rows.length} · {group.rows.filter(row => row.status === "confirmed").length} confirmed · {group.rows.filter(row => row.status === "declined").length} needs attention</span>
      {canManage && <button onClick={event => { event.preventDefault(); onAdd(group.name); }} className="rounded-md p-2 hover:text-board-text">+ Add position</button>}
    </summary>
    {group.rows.map(assignment => <RosterRow key={assignment.id} assignment={assignment} orgId={orgId} canManage={canManage} onEdit={() => onEdit(assignment)} onChanged={onChanged} confirm={confirm} />)}
  </details> : canManage ? <button key={group.name} onClick={() => onAdd(group.name)} className="w-full rounded-xl border border-dashed border-board-border p-3 text-left text-xs text-board-muted">+ {group.name}</button> : null)}</div>;
}

function RosterRow({
  assignment,
  orgId,
  canManage,
  onEdit,
  onChanged,
  confirm,
}: {
  assignment: Assignment;
  orgId: string;
  canManage: boolean;
  onEdit: () => void;
  onChanged: () => Promise<void>;
  confirm: ReturnType<typeof useConfirmDialog>["confirm"];
}) {
  const locale = useDeviceLocale();
  const deviceTimeZone = useDeviceTimeZone();
  const responseOpen = assignment.responseWindow.status === "open";
  const closed =
    assignment.status === "assigned" &&
    Boolean(assignment.crewMemberId) &&
    !responseOpen;
  const pending =
    assignment.status === "assigned" &&
    Boolean(assignment.crewMemberId) &&
    responseOpen;
  const statusColor =
    assignment.status === "confirmed"
      ? "text-green-400"
      : assignment.status === "declined"
        ? "text-red-400"
        : closed
          ? "text-board-muted"
          : "text-yellow-300";
  return <div id={`assignment-${assignment.id}`} className="grid h-12 grid-cols-[28px_minmax(64px,1.3fr)_minmax(48px,1fr)_64px_76px_28px] items-center gap-3 border-t border-board-border px-4 text-xs hover:bg-board-border/30 @min-[520px]/schedule-main:grid-cols-[28px_minmax(0,1.3fr)_minmax(0,1fr)_100px_28px] @min-[960px]/schedule-main:grid-cols-[28px_minmax(0,1.3fr)_minmax(0,1fr)_72px_110px_28px]">
    <span aria-hidden="true" className={`flex h-7 w-7 items-center justify-center rounded-full border border-board-border text-board-muted ${assignment.crewMember ? "bg-board-border" : "border-dashed"}`}>{assignment.crewMember?.name.split(" ").map(part => part[0]).slice(0,2).join("")}</span>
    <span className="truncate font-medium text-board-text">{assignment.crewMember?.name ?? "Open — nobody assigned"}</span>
    <span className="truncate text-board-muted">{assignment.role}</span>
    <span className="truncate tabular-nums text-board-muted">{timeLabel(assignment.effectiveCallTime, deviceTimeZone, locale)}</span>
    <span className={`truncate capitalize ${statusColor}`}>{!assignment.crewMemberId ? canManage ? <button onClick={onEdit} className="rounded-md border border-board-border px-2 py-1">Assign</button> : "Open" : `● ${assignment.status === "assigned" ? closed ? "Closed" : "Awaiting" : assignment.status}`}</span>
    <DropdownMenu><DropdownMenuTrigger aria-label={`Actions for ${assignment.crewMember?.name ?? assignment.role}`} className="h-8 rounded-md text-lg text-board-muted focus-visible:outline focus-visible:outline-fire-500">⋯</DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72 border-board-border bg-board-card text-board-text">
        <div className="space-y-1 border-b border-board-border p-3 text-xs text-board-muted"><p className="break-all">{assignment.crewMember?.email ?? "Nobody assigned"}</p><p>{assignment.invitedAt ? `Invitation sent ${new Date(assignment.invitedAt).toLocaleString(locale)}` : "Invitation not sent"}</p>{assignment.responseNote && <p className="whitespace-pre-wrap">{assignment.responseNote}</p>}</div>
        {canManage && <><div className="p-2">{assignment.crewMemberId && <ReminderControl orgId={orgId} target={{kind: "assignment", id: assignment.id}} label="Resend invite" disabled={!pending} onChanged={onChanged} />}</div><DropdownMenuItem onSelect={onEdit}>Edit</DropdownMenuItem><div className="mt-1 border-t border-board-border"><RemoveAssignmentButton orgId={orgId} assignment={assignment} confirm={confirm} onChanged={onChanged} /></div></>}
      </DropdownMenuContent>
    </DropdownMenu>
  </div>;
}

function RemoveAssignmentButton({ orgId, assignment, confirm, onChanged }: {
  orgId: string; assignment: Assignment; confirm: ReturnType<typeof useConfirmDialog>["confirm"]; onChanged: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const { user } = Route.useRouteContext();
  const data = Route.useLoaderData();
  const router = useRouter();
  return <>
    <button type="button" aria-label={`Remove ${assignment.role}`} onClick={() => setOpen(true)} className="min-h-11 min-w-11 rounded-lg px-2 text-xs text-red-300">Remove</button>
    {open && <AssignmentEditor orgId={orgId} userId={user.id} target={{ kind: "delete", id: assignment.id }}
      departments={[]} crew={data.crew} venueTimeZone={data.orgTimezone} confirm={confirm}
      onClose={() => setOpen(false)} onSaved={async () => {
        await onChanged();
        const match = router.state.matches.find(value => value.routeId === Route.id);
        if (match?.status === "error") throw match.error;
      }} />}
  </>;
}

function CreateServiceModal({
  orgId,
  userId,
  today,
  serviceDates,
  previousDate,
  previousShowId,
  inventory,
  initialInventoryId,
  venueTimeZone,
  onClose,
  onCreated,
}: {
  orgId: string;
  userId: string;
  today: string;
  serviceDates: string[];
  previousDate?: string;
  previousShowId?: string;
  inventory: ShowInventorySummary[];
  initialInventoryId?: string;
  venueTimeZone: string;
  terminologyProfile: OrgTerminologyProfile;
  onClose: () => void;
  onCreated: (
    showId: string,
    date: string,
    signal: AbortSignal,
  ) => Promise<void>;
}) {
  const terms = useTerms();
  const initial: ShowDraft = {
    serviceDate: nextAvailableServiceDate(today, serviceDates),
    name: "",
    startTime: "10:00",
    callTime: "",
    location: "",
    timeZone: getDeviceTimeZone(),
    source:
      previousDate && previousShowId
        ? {
            kind: "show",
            id: previousShowId,
            serviceDate: previousDate,
            name: "Previous show",
          }
        : { kind: "blank" },
  };
  const item = inventory.find((item) => item.id === initialInventoryId);
  return (
    <Modal
      title={`New ${terms.event}`}
      description="Choose the date, location and rundown for this show."
      onClose={onClose}
    >
      <ShowCreationForm
        scope={{ orgId, userId, entry: "schedule" }}
        initial={item ? inventoryDraft(initial, item, venueTimeZone) : initial}
        minDate={today}
        inventory={inventory}
        venueTimeZone={venueTimeZone}
        onClose={onClose}
        shows={
          previousDate && previousShowId
            ? [
                {
                  id: previousShowId,
                  serviceDate: previousDate,
                  name: "Previous show",
                },
              ]
            : []
        }
        onCreated={async (result, signal) =>
          onCreated(result.showId, result.serviceDate, signal)
        }
      />
    </Modal>
  );
}

function ShowInventoryModal({ onClose, ...props }: {
  orgId: string;
  userId: string;
  inventory: ShowInventorySummary[];
  archivedInventory: ShowInventorySummary[];
  savedTemplates: SavedRundownSource[];
  canManage: boolean;
  onClose: () => void;
  onUse: (item: ShowInventorySummary) => void;
  onChanged: (signal: AbortSignal) => Promise<void>;
}) {
  return (
    <Modal title="Show inventory" description="Save reusable show details or use a saved show to create a new date." onClose={onClose}>
      <ShowInventoryEditor {...props} />
    </Modal>
  );
}

function ScheduleLiveDetails({ orgId, service }: {
  orgId: string;
  service: Awaited<ReturnType<typeof getSchedule>>["services"][number];
}) {
  const router = useRouter();
  const { hydrated, stateShowId, serviceName, scheduledStartTime, scheduledCallTime } = useRundownSync(orgId, service.serviceDate, service.id);
  useEffect(() => {
    if (!hydrated || stateShowId !== service.id) return;
    if ((serviceName !== null && serviceName !== service.name)
      || (scheduledStartTime !== undefined && scheduledStartTime !== service.scheduledStartTime)
      || (scheduledCallTime !== undefined && scheduledCallTime !== service.scheduledCallTime)) {
      void router.invalidate();
    }
  }, [hydrated, stateShowId, serviceName, scheduledStartTime, scheduledCallTime, service.id, service.name, service.scheduledStartTime, service.scheduledCallTime, router]);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === "visible") void router.invalidate(); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [router]);
  return null;
}

function ServiceDetailsModal({
  orgId,
  userId,
  orgTimezone,
  service,
  onClose,
  onSaved,
  deletion,
  onDelete,
}: {
  orgId: string;
  userId: string;
  orgTimezone?: string;
  service: Awaited<ReturnType<typeof getSchedule>>["services"][number];
  onClose: () => void;
  onSaved: (signal: AbortSignal) => Promise<void>;
  deletion: ReturnType<typeof useShowDeletions>["work"][string];
  onDelete: () => Promise<void>;
}) {
  const locale = useDeviceLocale();
  const workspaceTerms = useWorkspaceTerms();
  const deleting = !!deletion && deletion.kind !== "rejected";
  return (
    <Modal title="Show details" description="Edit this show’s name, times and location." onClose={onClose}>
      <ShowDetailsEditor
        scope={{ orgId, userId, showId: service.id }}
        initialDraft={{ serviceDate: service.serviceDate, expectedUpdatedAt: new Date(service.updatedAt).toISOString(),
          name: service.name, startTime: inputTime(service.scheduledStartTime, orgTimezone),
          callTime: inputTime(service.scheduledCallTime, orgTimezone), location: service.location,
          timeZone: orgTimezone || getDeviceTimeZone() }}
        nameLabel={workspaceCopy("Show or service name", workspaceTerms)}
        callTimeNote={service.effectiveCallTime ? `Organization default: ${timeLabel(service.effectiveCallTime, orgTimezone, locale)}.` : "No call time until this show has a start time."}
        refresh={onSaved} onRefreshed={onClose} disabled={deleting}
      >
      {(locked) => <>
      <div className="mt-5 border-t border-board-border pt-4" aria-label="Delete show">
        <h3 className="mb-1 text-sm font-medium text-board-text">Delete show</h3>
        <p className="text-xs leading-5 text-board-muted">Deleting removes this stopped show’s rundown, crew assignments, notes, checklist, incidents and related notifications.</p>
        <button
          type="button"
          disabled={locked}
          onClick={() => void onDelete()}
          className="mt-3 flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-red-500/30 px-4 py-2.5 text-sm font-semibold text-red-300 transition hover:bg-red-500/10 disabled:opacity-50"
        >
          <Trash2 className="h-4 w-4" />
          Delete show
        </button>
      </div>
      </>}
      </ShowDetailsEditor>
    </Modal>
  );
}
function Modal({
  title,
  description,
  onClose,
  children,
}: {
  title: string;
  description: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const [opener] = useState(() =>
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        showCloseButton={false}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          // Inventory can open a new-show dialog directly. Let that dialog keep focus.
          if (!document.querySelector('[role="dialog"][data-state="open"]')) opener?.focus();
        }}
        className="flex max-h-[calc(100dvh-2rem)] min-w-0 flex-col gap-0 overflow-hidden border-board-border bg-board-card p-0 text-board-text sm:max-w-md [&_button]:outline-none [&_button]:focus-visible:ring-2 [&_button]:focus-visible:ring-fire-500"
      >
        <header className="flex shrink-0 items-start gap-3 border-b border-board-border p-4">
          <div className="min-w-0 flex-1">
            <DialogTitle className="text-base font-semibold">{title}</DialogTitle>
            <DialogDescription className="mt-1 text-xs text-board-muted">{description}</DialogDescription>
          </div>
          <button type="button" onClick={onClose} className="min-h-11 min-w-11 shrink-0 rounded-lg p-2 text-board-muted hover:bg-board-border" aria-label={`Close ${title}`}>
            <X className="mx-auto h-4 w-4" />
          </button>
        </header>
        <div className="min-h-0 overflow-y-auto p-4">{children}</div>
      </DialogContent>
    </Dialog>
  );
}
