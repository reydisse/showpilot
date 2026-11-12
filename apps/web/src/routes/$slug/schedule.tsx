import { ShowInventoryEditor } from "@/components/shows/ShowInventoryEditor";
import { useShowDeletions } from "@/hooks/useShowDeletions";
import { ShowDeletionProgress } from "@/components/shows/ShowDeletionProgress";
import { ShowDetailsEditor } from "@/components/shows/ShowDetailsEditor";
import { CopyTeamControl } from "@/components/schedule/CopyTeamControl";
import { useScheduleRoster } from "@/hooks/useScheduleRoster";
import { ReadFailureNotice } from "@/components/layout/ReadFailureNotice";
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
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  ExternalLink,
  MapPin,
  Pencil,
  Plus,
  Send,
  Trash2,
  X,
} from "lucide-react";
import { PageSkeleton } from "@/components/ui/Skeleton";
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
import { StatusMetric } from "@/components/ui/status-metric";
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
  pendingComponent: PageSkeleton,
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
  const liveAssignments = useMemo(() => [...data.assignments.filter(row => row.showId !== selected?.id), ...selectedAssignments], [data.assignments, selected?.id, selectedAssignments]);
  const departments = Array.from(
    new Set(
      liveAssignments
        .map((assignment) => assignment.department.trim())
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
      <div className="mx-auto grid min-h-[calc(100vh-58px)] max-w-[1700px] grid-cols-[minmax(0,1fr)] border-x border-board-border lg:grid-cols-[344px_minmax(0,1fr)]">
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
              <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-board-muted">
                {workspaceCopy(
                  "\n                Services\n              ",
                  workspaceTerms,
                )}
              </p>
              <button
                onClick={() => chooseDate(data.today)}
                className="min-h-11 min-w-11 text-[10px] text-fire-400 focus-visible:outline focus-visible:outline-fire-400"
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
                className={`min-w-[210px] snap-start border-b border-board-border border-l-[3px] px-4 py-4 text-left lg:w-full ${service.id === selected?.id ? "border-l-fire-500 bg-fire-500/[0.055]" : "border-l-transparent hover:bg-board-bg"}`}
              >
                <p
                  className={`text-[10px] font-semibold uppercase tracking-wider ${service.serviceDate === data.today ? "text-fire-400" : "text-board-muted"}`}
                >
                  {service.serviceDate === data.today
                    ? "Today"
                    : dayLabel(service.serviceDate, locale)}
                </p>
                <p className="mt-2 truncate text-sm font-medium text-board-text">
                  {service.name}
                </p>
                <p className="mt-1 text-[11px] text-board-muted">
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
        <main className="min-w-0 bg-board-bg">
          {selected ? (
            <>
              <section className="border-b border-board-border bg-board-card px-4 py-5 md:px-6">
                <div className="flex flex-wrap items-start gap-4">
                  <div className="min-w-0 flex-1">
                    <button
                      disabled={!data.canManage}
                      onClick={() => setServiceOpen(true)}
                      className="flex items-center gap-2 text-left disabled:cursor-default"
                      aria-label={data.canManage ? `Edit ${selected.name}` : undefined}
                    >
                      <h2 className="text-xl font-semibold text-board-text md:text-2xl">
                        {selected.name}
                      </h2>
                      {data.canManage ? (
                        <Pencil className="h-3.5 w-3.5 text-board-muted" />
                      ) : null}
                    </button>
                    <p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-board-muted">
                      <span className="flex items-center gap-1.5">
                        <CalendarDays className="h-3.5 w-3.5" />
                        {longDate(selected.serviceDate, locale)}
                      </span>
                      <span className="flex items-center gap-1.5">
                        <Clock3 className="h-3.5 w-3.5" />
                        {timeLabel(selected.scheduledStartTime, deviceTimeZone, locale)}
                      </span>
                      {selected.location ? (
                        <span className="flex items-center gap-1.5">
                          <MapPin className="h-3.5 w-3.5" />
                          {selected.location}
                        </span>
                      ) : null}
                    </p>
                  </div>
                  {data.provider.type === "native" && data.canManage ? (
                    <div className="flex flex-wrap gap-2">
                      <ReminderControl
                        orgId={data.orgId}
                        target={{ kind: "show", id: selected.id }}
                        label={`Remind awaiting crew (${stats.awaiting})`}
                        disabled={stats.awaiting === 0}
                        onChanged={async () => { await router.invalidate(); const match = router.state.matches.find(value => value.routeId === Route.id); if (match?.status === "error") throw match.error; }}
                      />
                      <button
                        onClick={() => {
                          setTeamBuilderOpen(true);
                        }}
                        className="flex items-center gap-2 rounded-lg border border-board-border px-3 py-2 text-xs text-board-text"
                      >
                        <Plus className="h-3.5 w-3.5" />
                        Build a team
                      </button>
                      <button
                        onClick={() => {
                          setAssignmentDepartment(departments[0] ?? "");
                          setAssignmentOpen(true);
                        }}
                        className="flex items-center gap-2 rounded-lg border border-board-border px-3 py-2 text-xs text-board-text"
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
              <section className="grid grid-cols-2 gap-2 border-b border-board-border bg-board-card px-4 py-3 sm:grid-cols-4 md:px-6 lg:grid-cols-[repeat(4,minmax(100px,150px))_1fr]">
                <StatusMetric label="Filled" value={stats.filled} tone="success" compact />
                <StatusMetric label="Open" value={stats.open} tone="danger" compact />
                <StatusMetric label="Awaiting" value={stats.awaiting} tone="warning" compact />
                <StatusMetric label="Declined" value={stats.declined} tone="danger" compact />
                <div className="ml-auto flex items-center gap-2">
                  <select
                    aria-label="Filter crew responses"
                    value={filter}
                    onChange={(event) =>
                      setFilter(event.target.value as ResponseFilter)
                    }
                    className="min-h-11 rounded-lg border border-board-border bg-board-bg px-3 py-2 text-[11px] text-board-text outline-none focus-visible:ring-2 focus-visible:ring-fire-500"
                  >
                    <option value="all">All responses</option>
                    <option value="confirmed">Confirmed</option>
                    <option value="assigned">Awaiting</option>
                    <option value="closed">Closed</option>
                    <option value="declined">Declined</option>
                    <option value="open">Open</option>
                  </select>
                  <Link
                    to="/$slug/rundown"
                    params={{ slug }}
                    search={{ show: selected.id, date: selected.serviceDate }}
                    className="hidden items-center gap-1 rounded-lg border border-board-border px-3 py-2 text-[11px] text-board-text sm:flex"
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
              <ReadFailureNotice error={roster.error} refreshing={roster.refreshing} retry={roster.retry} label="Retry roster" />
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
        <div className="mt-4 grid grid-cols-7 text-center text-[9px] font-medium uppercase text-board-muted">
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
        <div className="mt-4 flex items-center justify-between border-t border-board-border pt-3 text-[9px] text-board-muted">
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
function inferredDepartment(role: string) {
  const value = role.toLowerCase();
  if (/audio|sound|foh|monitor|wireless|mic/.test(value)) return "Audio";
  if (/camera|video|graphics|stream|projection|playback/.test(value))
    return "Video";
  if (/worship|vocal|guitar|bass|drum|keys|music/.test(value)) return "Worship";
  return "Production";
}

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
  const groups = departments.map((name) => ({
    name,
    rows: assignments.filter(
      (item) => (item.department || inferredDepartment(item.role)) === name,
    ),
  }));
  return (
    <>
      <div className="divide-y divide-board-border md:hidden">
        {groups.map((group) => (
          <section key={`mobile-${group.name}`}>
            <div className="flex items-center justify-between bg-board-card/70 px-4 py-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-board-muted">
              <span>{group.name} <span className="ml-1 text-board-muted/50">{group.rows.length}</span></span>
              {canManage ? (
                <button onClick={() => onAdd(group.name)} className="text-fire-400">Add position</button>
              ) : null}
            </div>
            <div className="divide-y divide-board-border">
              {group.rows.map((assignment) => (
                <RosterMobileCard
                  key={assignment.id}
                  assignment={assignment}
                  orgId={orgId}
                  canManage={canManage}
                  onEdit={() => onEdit(assignment)}
                  onChanged={onChanged}
                  confirm={confirm}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
      <div className="hidden overflow-x-auto md:block">
      <div className="min-w-[900px]">
        <div className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,.9fr)_minmax(0,.8fr)_104px] border-b border-board-border bg-board-bg px-6 py-2.5 text-[10px] uppercase tracking-wider text-board-muted">
          <span>Position</span>
          <span>Assigned to</span>
          <span>Invitation</span>
          <span>Response</span>
          <span />
        </div>
        {groups.map((group) => (
          <section key={group.name}>
            <div className="border-b border-board-border bg-board-card/70 px-6 py-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-board-muted">
              {group.name}{" "}
              <span className="ml-1 text-board-muted/50">
                {group.rows.length}
              </span>
            </div>
            {group.rows.map((assignment) => (
              <RosterRow
                key={assignment.id}
                assignment={assignment}
                orgId={orgId}
                canManage={canManage}
                onEdit={() => onEdit(assignment)}
                onChanged={onChanged}
                confirm={confirm}
              />
            ))}
            {canManage ? (
              <button
                onClick={() => onAdd(group.name)}
                className="flex w-full items-center gap-2 border-b border-board-border px-6 py-2.5 text-left text-[11px] text-fire-400 hover:bg-board-card"
              >
                <Plus className="h-3 w-3" />
                Add position
              </button>
            ) : null}
          </section>
        ))}
      </div>
      </div>
    </>
  );
}

function RosterMobileCard({
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
  const responseLabel = assignment.crewMemberId
    ? assignment.status === "assigned"
      ? closed
        ? "Closed"
        : "Awaiting response"
      : assignment.status
    : "Open position";
  const statusClass = assignment.status === "confirmed"
    ? "text-green-400"
    : assignment.status === "declined"
      ? "text-red-400"
      : closed
        ? "text-board-muted"
        : "text-yellow-300";
  return (
    <article id={`assignment-mobile-${assignment.id}`} className="min-w-0 space-y-3 bg-board-bg px-4 py-4">
      <div className="flex min-w-0 items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="break-words text-sm font-medium text-board-text">{assignment.role}</p>
          <p className="mt-1 text-[10px] text-board-muted">Call {timeLabel(assignment.effectiveCallTime, deviceTimeZone, locale)} · {assignment.department}</p>
        </div>
        <span className={`shrink-0 text-[10px] font-medium capitalize ${statusClass}`}>{responseLabel}</span>
      </div>
      <div className="rounded-xl border border-board-border bg-board-card/45 p-3">
        <p className="break-words text-xs font-medium text-board-text">{assignment.crewMember?.name ?? "Nobody assigned"}</p>
        <p className="mt-0.5 break-all text-[10px] text-board-muted">{assignment.crewMember?.email || "This position is open"}</p>
        <p className="mt-2 text-[10px] text-board-muted">{assignment.invitedAt ? "Invitation sent" : assignment.crewMember ? "Invitation not sent" : "No invitation needed"}</p>
      </div>
      {assignment.responseNote ? (
        <details className="min-w-0 rounded-xl border border-red-500/20 bg-red-500/[0.045] px-3 py-2.5">
          <summary className="cursor-pointer text-[10px] font-semibold text-red-300">Read declined response</summary>
          <p className="mt-2 whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-xs leading-5 text-board-text">{assignment.responseNote}</p>
        </details>
      ) : null}
      {canManage ? (
        <div className="flex flex-wrap gap-2">
          <button onClick={onEdit} aria-label={`Edit ${assignment.role}`} className="rounded-lg border border-board-border px-3 py-2 text-[11px] text-board-text">Edit</button>
          {assignment.crewMemberId ? (
            <ReminderControl orgId={orgId} target={{ kind: "assignment", id: assignment.id }} label="Resend invite" disabled={!pending} onChanged={onChanged} />
          ) : null}
          <RemoveAssignmentButton orgId={orgId} assignment={assignment} confirm={confirm} onChanged={onChanged} />
        </div>
      ) : null}
    </article>
  );
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
  return (
    <div id={`assignment-${assignment.id}`} className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,.9fr)_minmax(0,.8fr)_104px] items-center border-b border-board-border px-6 py-3 text-xs hover:bg-board-card/60">
      <button
        disabled={!canManage}
        onClick={onEdit}
        className="text-left font-medium text-board-text disabled:cursor-default"
      >
        {assignment.role}
        <span className="mt-0.5 block text-[9px] font-normal text-board-muted">Call {timeLabel(assignment.effectiveCallTime, deviceTimeZone, locale)}</span>
      </button>
      <button
        disabled={!canManage}
        onClick={onEdit}
        className={`text-left disabled:cursor-default ${assignment.crewMember ? "text-board-text" : "text-fire-400"}`}
      >
        {assignment.crewMember?.name ?? "Open position"}
        <p className="mt-0.5 text-[9px] text-board-muted">
          {assignment.crewMember?.email || "Click to assign a roster contact"}
        </p>
      </button>
      <div className="text-[10px] text-board-muted">
        {assignment.invitedAt ? (
          <>
            <Send className="mr-1 inline h-3 w-3 text-green-400" />
            Invitation sent
          </>
        ) : assignment.crewMember ? (
          "Not sent"
        ) : (
          "—"
        )}
      </div>
      <div className={`min-w-0 text-[10px] ${statusColor}`}>
        <div className="flex min-w-0 items-center gap-1.5 capitalize">
          {assignment.status === "confirmed" ? (
            <Check className="h-3 w-3 shrink-0" />
          ) : assignment.status === "declined" ? (
            <X className="h-3 w-3 shrink-0" />
          ) : (
            <Clock3 className="h-3 w-3 shrink-0" />
          )}
          <span>{assignment.crewMemberId
            ? assignment.status === "assigned"
              ? closed
                ? "Closed"
                : "Awaiting"
              : assignment.status
            : "Open"}</span>
          {canManage && assignment.crewMemberId ? (
            <ReminderControl orgId={orgId} target={{ kind: "assignment", id: assignment.id }} label="Resend invite" disabled={!pending} onChanged={onChanged} />
          ) : null}
        </div>
        {assignment.responseNote ? (
          <p className="mt-1 line-clamp-2 max-w-full break-all normal-case leading-4 text-board-muted" title={assignment.responseNote}>
            “{assignment.responseNote}”
          </p>
        ) : null}
      </div>
      <div className="flex items-center gap-1">
        {canManage ? (
          <>
            <button
              onClick={onEdit}
              aria-label={`Edit ${assignment.role}`}
              className="min-h-11 min-w-11 rounded p-1.5 text-board-muted hover:bg-board-border hover:text-board-text"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <RemoveAssignmentButton orgId={orgId} assignment={assignment} confirm={confirm} onChanged={onChanged} />
          </>
        ) : null}
      </div>
    </div>
  );
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
      <div className="mt-5 border-t border-board-border pt-4">
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
        className="flex max-h-[calc(100dvh-2rem)] min-w-0 flex-col gap-0 overflow-hidden border-board-border bg-board-card p-0 text-board-text sm:max-w-md [&_button]:min-h-11 [&_button]:min-w-11 [&_button]:outline-none [&_button]:focus-visible:ring-2 [&_button]:focus-visible:ring-fire-500"
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
