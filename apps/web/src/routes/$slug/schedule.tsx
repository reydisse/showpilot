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
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  UserPlus,
  Users,
  User,
  CalendarDays,
  Check,
  ChevronDown,
  Clock,
  Copy,
  List,
  Package,
  SlidersVertical,
  MapPin,
  MoreHorizontal,
  Send,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { ScheduleSkeleton } from "@/components/ui/Skeleton";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { ModalA, modalDanger } from "@/components/schedule/modal-a";
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
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
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
  // The rail shows upcoming shows first; past ones (most recent first) stay collapsed unless one is selected.
  const upcomingServices = data.services.filter((service) => service.serviceDate >= data.today);
  const pastServices = data.services.filter((service) => service.serviceDate < data.today).sort((a, b) => b.serviceDate.localeCompare(a.serviceDate));
  const [pastOpen, setShowPast] = useState(false);
  const showPast = pastOpen || (!!selected && selected.serviceDate < data.today);
  const savedTeams = selected ? data.services.filter(show => show.serviceDate < selected.serviceDate).map(show => {
    const crew = data.assignments.filter(row => row.showId === show.id);
    return { show, count: crew.length, departments: Array.from(new Set(crew.map(rosterDepartment).filter(Boolean))).join(", ") };
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
    confirmed: selectedAssignments.filter((item) => item.status === "confirmed").length,
    open: selectedAssignments.filter((item) => !item.crewMemberId).length,
    awaiting: selectedAssignments.filter(
      (item) =>
        item.status === "assigned" &&
        item.crewMemberId &&
        item.responseWindow.status === "open",
    ).length,
    closed: selectedAssignments.filter(
      (item) =>
        item.status === "assigned" &&
        item.crewMemberId &&
        item.responseWindow.status !== "open",
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

  const sourceControl = data.canManage ? (
    <ScheduleProviderControl
      key={`${user.id}:${data.orgId}`}
      userId={user.id}
      orgId={data.orgId}
      triggerClassName={railGhost}
      triggerIcon={<SlidersVertical className="h-3.5 w-3.5" strokeWidth={1.5} />}
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
  ) : null;
  const inventoryButton = data.canManage && data.provider.type === "native" ? (
    <button type="button" onClick={() => setInventoryOpen(true)} className={railGhost}>
      <Package className="h-3.5 w-3.5" strokeWidth={1.5} />
      Inventory
    </button>
  ) : null;
  return (
    <div className="h-full overflow-auto bg-board-bg lg:overflow-hidden">
      {selected ? (
        <ScheduleLiveDetails key={selected.id} orgId={data.orgId} service={selected} />
      ) : null}
      <ShowDeletionProgress controller={deletions} />
      <div className="mx-auto grid min-h-[calc(100vh-58px)] max-w-[1700px] grid-cols-[minmax(0,1fr)] border-x border-board-border content-start lg:h-full lg:min-h-0 lg:content-normal lg:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="hidden flex-col gap-4 border-b border-board-border bg-board-bg px-3 pb-4 pt-5 lg:flex lg:min-h-0 lg:overflow-hidden lg:border-b-0 lg:border-r">
          <div className="flex items-center justify-between pl-2 pr-1.5"><h2 className="text-xl font-semibold tracking-[-0.015em] text-board-text">Schedule</h2>{data.canManage && data.provider.type === "native" && <button onClick={() => setCreateOpen(true)} className="flex h-7 items-center gap-1.5 rounded-md border border-board-border bg-board-card px-2.5 text-xs font-medium text-board-text"><Plus className="h-3.5 w-3.5" />New show</button>}</div>
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
          <div className="flex items-baseline justify-between px-2.5 pt-1 text-board-muted"><h3 className="text-[11px] font-medium uppercase tracking-[0.07em]">Upcoming</h3><span className="text-xs">{upcomingServices.length} {upcomingServices.length === 1 ? "show" : "shows"}</span></div>
          <div className="flex snap-x gap-0.5 overflow-x-auto lg:min-h-0 lg:flex-1 lg:flex-col lg:overflow-x-hidden lg:overflow-y-auto lg:overscroll-contain">
            {upcomingServices.length === 0 ? <p className="shrink-0 px-2.5 py-2 text-xs text-board-muted">No upcoming shows this month.</p> : null}
            {[...upcomingServices, ...(showPast ? pastServices : [])].map((service, index) => (
              <Fragment key={service.id}>
              {index === upcomingServices.length ? <p className="flex shrink-0 items-center px-2.5 pb-1 pt-3 text-[11px] font-medium uppercase tracking-[0.07em] text-board-muted lg:w-full">Past</p> : null}
              <button
                onClick={() => chooseShow(service.id, service.serviceDate)}
                className={`flex min-w-[210px] snap-start items-center gap-3 rounded-lg px-2.5 py-2 text-left lg:w-full ${service.id === selected?.id ? "bg-board-border" : "hover:bg-board-card"}`}
              >
                <span className="flex w-8 shrink-0 flex-col items-center"><span className="text-[10px] font-medium uppercase tracking-[0.06em] text-board-muted">{new Date(`${service.serviceDate}T12:00:00`).toLocaleDateString(locale, { weekday: "short" })}</span><span className={`tabular-nums text-[15px] font-medium leading-[1.2] ${service.id === selected?.id ? "text-fire-400" : "text-board-muted"}`}>{Number(service.serviceDate.slice(-2))}</span></span>
                <span className="flex min-w-0 flex-col gap-0.5">
                <p className="truncate text-[13px] font-medium text-board-text">
                  {service.name}
                </p>
                <p className="text-xs text-board-muted">
                  {timeLabel(service.scheduledStartTime, deviceTimeZone, locale)} ·{" "}
                  {(() => {
                    const total = service.id === selected?.id ? selectedAssignments.length : service.crewTotal;
                    const confirmed = service.id === selected?.id
                      ? selectedAssignments.filter((assignment) => assignment.status === "confirmed").length
                      : service.crewConfirmed;
                    return total ? `${confirmed} of ${total} confirmed` : "No crew yet";
                  })()}
                </p>
                </span>
              </button>
              </Fragment>
            ))}
            {pastServices.length ? <button type="button" onClick={() => setShowPast(open => !open)} aria-expanded={showPast}
              className="flex min-h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-board-muted hover:bg-board-card hover:text-board-text lg:w-full">
              {showPast ? "Hide past shows" : `Show ${pastServices.length} past ${pastServices.length === 1 ? "show" : "shows"}`}
            </button> : null}
          </div>
          {sourceControl || inventoryButton ? <div className="schedule-a mt-auto flex flex-wrap items-start gap-1 border-t border-board-border px-0.5 pt-3">{sourceControl}{inventoryButton}</div> : null}
        </aside>
        <ShowSwitcherBar
          services={data.services}
          selected={selected}
          today={data.today}
          calendar={<MonthCalendar
            calendarMonth={data.calendarMonth}
            onMonthChange={(month) => {
              const validMonth = normalizeScheduleSearch({ month }).month;
              if (validMonth) void navigate({ search: { month: validMonth, show: selected?.id, date: selected?.serviceDate } });
            }}
            selectedDate={selected?.serviceDate ?? data.today}
            today={data.today}
            serviceDates={data.services.map((service) => service.serviceDate)}
            onSelect={chooseDate}
          />}
          onChoose={chooseShow}
          onNew={data.canManage && data.provider.type === "native" ? () => setCreateOpen(true) : undefined}
          actions={<>{sourceControl}{inventoryButton}</>}
        />
        <main className="@container/schedule-main schedule-a flex min-w-0 flex-col gap-5 overflow-x-auto bg-board-bg lg:min-h-0 lg:overflow-y-auto lg:overscroll-contain px-4 pb-8 pt-6 md:px-6 lg:px-8 lg:pb-10 [&_button]:outline-none [&_button]:focus-visible:ring-2 [&_button]:focus-visible:ring-fire-500 [&_summary]:outline-none [&_summary]:focus-visible:ring-2 [&_summary]:focus-visible:ring-fire-500">
          {selected ? (
            <>
              <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
                <div className="flex min-w-0 flex-[1_1_18rem] flex-col gap-2">
                  <p className="tabular-nums text-xs uppercase tracking-[0.04em] text-[var(--sa-ink-3)]">{headerDate(selected.serviceDate, data.today)}</p>
                  <div className="flex min-w-0 items-center gap-1.5">
                    <h2 className="truncate text-2xl font-semibold lg:text-[26px] leading-[1.15] tracking-[-0.02em] text-board-text">
                      {selected.name}
                    </h2>
                    {data.canManage ? (
                      <button type="button" onClick={() => setServiceOpen(true)} className={ghostSm.replace("inline-flex", "hidden lg:inline-flex")}>
                        <Pencil className="h-3.5 w-3.5" strokeWidth={1.75} />
                        Edit details
                      </button>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] lg:gap-x-5 text-[var(--sa-ink-2)]">
                    <span className={metaItem}><Clock className={metaIcon} strokeWidth={1.75} />Starts {selected.scheduledStartTime ? <span className="tabular-nums text-xs text-board-text">{timeLabel(selected.scheduledStartTime, deviceTimeZone, locale)}</span> : data.canManage ? <button type="button" onClick={() => setServiceOpen(true)} className="inline-flex h-6 items-center gap-1.5 rounded-full border border-[var(--sa-warn)]/35 bg-[var(--sa-warn)]/[0.08] pl-2 pr-2.5 text-xs font-medium text-[var(--sa-warn)]"><span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-[var(--sa-warn)]" />Time not set<span className="border-l border-[var(--sa-warn)]/30 pl-1.5 text-board-text">Set time</span></button> : <span className="text-[var(--sa-warn)]">Time not set</span>}</span>
                    {selected.effectiveCallTime ? <span className={metaItem}><User className={metaIcon} strokeWidth={1.75} />Crew call <span className="tabular-nums text-xs text-board-text">{timeLabel(selected.effectiveCallTime, deviceTimeZone, locale)}</span></span> : null}
                    {selected.location ? <span className={metaItem}><MapPin className={metaIcon} strokeWidth={1.75} />{selected.location}</span> : null}
                    <Link to="/$slug/rundown" params={{ slug }} search={{ show: selected.id, date: selected.serviceDate }} className="hidden whitespace-nowrap border-b border-[var(--sa-border-strong)] text-[var(--sa-ink-2)] hover:text-board-text lg:inline">
                      {selected.itemCount ? `Rundown · ${selected.itemCount} ${selected.itemCount === 1 ? "item" : "items"}` : <span className="inline-flex items-center gap-1"><List className="h-3.5 w-3.5" strokeWidth={1.5} />Rundown<ChevronRight className="h-3.5 w-3.5" strokeWidth={1.75} /></span>}
                    </Link>
                  </div>
                </div>
                {data.canManage ? (
                  <div className={`flex items-center gap-2 sm:pt-5 ${!selectedAssignments.length && !roster.refreshing && data.provider.type === "native" ? "md:hidden" : ""}`}>
                    <MenuDetails className="relative">
                      <summary aria-label="Show actions" className="flex cursor-pointer list-none rounded-lg border border-[var(--sa-border-strong)] p-px [&::-webkit-details-marker]:hidden">
                        <span className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--sa-ink-3)] hover:bg-[var(--sa-surface-3)] hover:text-board-text"><MoreHorizontal className="h-4 w-4" /></span>
                      </summary>
                      <div className={popover}>
          {data.provider.type === "native" ? (
            <button
              onClick={() => {
                setInventorySeedId(undefined);
                setCreateOpen(true);
              }}
              className={menuButton}
            >
              <Plus className="h-3.5 w-3.5" />
              New {terms.event}
            </button>
          ) : null}
                        <button onClick={() => setServiceOpen(true)} className={menuButton}>Show details</button>
                        {sourceControl || inventoryButton ? <div className="flex flex-col items-start gap-1 border-t border-[var(--sa-border)] pt-1 md:hidden">{sourceControl}{inventoryButton}</div> : null}
                      </div>
                    </MenuDetails>
                    {data.provider.type === "native" && (selectedAssignments.length || roster.refreshing) ? (
                      <div className="relative flex h-8 rounded-lg bg-fire-500 text-[#1a1300]">
                        <button
                          type="button"
                          onClick={() => {
                            setAssignmentDepartment(departments[0] ?? "");
                            setAssignmentOpen(true);
                          }}
                          className="flex items-center gap-1.5 whitespace-nowrap rounded-l-lg px-3 text-[13px] font-semibold hover:bg-white/20"
                        >
                          <Plus className="h-3.5 w-3.5" strokeWidth={2.2} />
                          Add position
                        </button>
                        <MenuDetails className="static flex">
                          <summary aria-label="More ways to add" className="flex w-[30px] cursor-pointer list-none items-center justify-center rounded-r-lg border-l border-[rgba(26,19,0,0.22)] hover:bg-white/20 [&::-webkit-details-marker]:hidden">
                            <ChevronDown className="h-3.5 w-3.5" strokeWidth={2.2} />
                          </summary>
                          <div className={popover}>
                            <button type="button" onClick={() => setTeamBuilderOpen(true)} className={menuButton}>
                              <Users className="h-3.5 w-3.5" />
                              Build a team
                            </button>
                            {/* Copy team reports progress in place, so choosing it keeps the menu open. */}
                            <div data-keep-open>
                            <CopyTeamControl orgId={data.orgId} userId={user.id} showId={selected.id}
                              selection={previous ? { showId: selected.id, serviceDate: selected.serviceDate, copyFromShowId: previous.id, copyFrom: previous.serviceDate } : null}
                              canCopy={selectedAssignments.length === 0 && selected.status !== "running" && selected.status !== "paused"}
                              className={`${menuButton} w-full disabled:opacity-40`}
                              onChanged={refreshAssignments} />
                            </div>
                          </div>
                        </MenuDetails>
                      </div>
                    ) : null}
                  </div>
                ) : data.provider.url ? (
                  <a
                    href={data.provider.url}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-5 flex h-8 items-center gap-2 rounded-lg bg-fire-500 px-3 text-[13px] font-semibold text-[#1a1300]"
                  >
                    Open{" "}
                    {providerName(data.provider.type, data.provider.label)}
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                ) : null}
              </header>
              {selectedAssignments.length > 0 && <StaffingSummary
                stats={stats}
                total={selectedAssignments.length}
                filter={filter}
                onFilter={setFilter}
                reminder={stats.awaiting > 0 ? (
                  <ReminderControl
                    orgId={data.orgId}
                    target={{ kind: "show", id: selected.id }}
                    label={`Remind ${stats.awaiting} awaiting`}
                    icon={<Send className="h-3.5 w-3.5" strokeWidth={1.75} />}
                    className={secondarySm}
                    onChanged={refreshAssignments}
                  />
                ) : null}
              />}
              {data.provider.type !== "native" ? (
                <div className="rounded-xl border border-fire-500/20 bg-fire-500/[0.045] px-4 py-3 text-xs text-board-muted">
                  Assignments and confirmations are managed in{" "}
                  <strong className="text-board-text">
                    {providerName(data.provider.type, data.provider.label)}
                  </strong>
                  . ShowPilot remains the operational rundown and reporting
                  layer.
                </div>
              ) : null}
              <ReadFailureNotice variant="panel" error={roster.error} refreshing={roster.refreshing} retry={roster.retry} label="Try again" title="We couldn't load the crew for this show." description="Check your connection and try again. Nothing you changed has been lost." />
              {roster.refreshing && !selectedAssignments.length && !roster.error ? <RosterSkeleton /> : null}
              {!assignments.length && !roster.refreshing && !roster.error ? (
                selectedAssignments.length ? (
                  <div role="status" className="flex flex-col items-start gap-3 rounded-2xl border border-dashed border-[var(--sa-border-strong)] p-8 text-[13px] text-[var(--sa-ink-2)]">
                    <p className="text-base font-semibold text-board-text">No crew match this response filter.</p>
                    <button type="button" className={secondarySm} onClick={() => setFilter("all")}>Show all responses</button>
                  </div>
                ) : (
                  <div className={`grid gap-8 rounded-2xl border border-dashed border-[var(--sa-border-strong)] p-6 md:p-10 ${data.canManage && data.provider.type === "native" && savedTeams.length ? "@min-[760px]/schedule-main:grid-cols-[minmax(0,1fr)_minmax(0,440px)] @min-[760px]/schedule-main:items-center" : ""}`}>
                    <div role="status" className="flex flex-col items-start gap-4">
                      <span className="flex h-10 w-10 items-center justify-center rounded-[10px] bg-[var(--sa-surface-2)] text-[var(--sa-ink-2)]"><UserPlus className="h-5 w-5" strokeWidth={1.5} /></span>
                      <div className="flex max-w-[520px] flex-col gap-2">
                        <h2 className="text-base font-semibold tracking-[-0.01em] text-board-text">No crew on this show yet</h2>
                        <p className="text-[13px] leading-[1.6] text-[var(--sa-ink-2)]">Add positions one at a time, or start from a team you've already built. Everyone you add gets one invite they can accept in a single tap.</p>
                      </div>
                      {data.canManage && data.provider.type === "native" ? <div className="flex flex-wrap gap-2 pt-1">
                        <button type="button" onClick={() => setAssignmentOpen(true)} className="flex h-8 items-center gap-1.5 rounded-lg bg-fire-500 px-3 text-[13px] font-semibold text-[#1a1300] hover:bg-fire-400"><Plus className="h-3.5 w-3.5" strokeWidth={2} />Add position</button>
                        <button type="button" onClick={() => savedTeams.length ? document.getElementById("schedule-saved-teams")?.focus() : setTeamBuilderOpen(true)} className="flex h-8 items-center gap-1.5 rounded-lg border border-[var(--sa-border-strong)] bg-[var(--sa-surface-2)] px-3 text-[13px] font-medium text-board-text hover:bg-[var(--sa-surface-3)]"><Users className="h-3.5 w-3.5" strokeWidth={1.5} />{savedTeams.length ? "Use a saved team" : "Start from a team"}</button>
                      </div> : null}
                    </div>
                    {data.canManage && data.provider.type === "native" && savedTeams.length > 0 ? <section id="schedule-saved-teams" tabIndex={-1} aria-label="Saved teams" className="flex flex-col gap-2.5 rounded-lg focus-visible:outline-2 focus-visible:outline-fire-500">
                      <h3 className="text-[11px] font-medium uppercase tracking-[0.07em] text-[var(--sa-ink-3)]">Saved teams</h3>
                      <ul className="flex flex-col gap-2">{savedTeams.map(({ show, count, departments }) => <li key={show.id} className="flex items-center justify-between gap-4 rounded-lg border border-[var(--sa-border)] bg-[var(--sa-surface)] px-3.5 py-3">
                        <div className="min-w-0"><p className="truncate text-[13px] font-medium text-board-text">{show.name}</p><p className="truncate text-xs text-[var(--sa-ink-2)]">{count} {count === 1 ? "position" : "positions"}{departments && ` · ${departments}`}</p></div>
                        <CopyTeamControl orgId={data.orgId} userId={user.id} showId={selected.id} label="Use" className={secondarySm} selection={{ showId: selected.id, serviceDate: selected.serviceDate, copyFromShowId: show.id, copyFrom: show.serviceDate }} canCopy={selected.status !== "running" && selected.status !== "paused"} onChanged={refreshAssignments} />
                      </li>)}</ul>
                    </section> : null}
                  </div>
                )
              ) : null}
              {selectedAssignments.length > 0 && <RosterTable
                assignments={assignments}
                showEmptyDepartments={filter === "all"}
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
              />}
            </>
          ) : (
            <div className="py-24 text-center">
              <CalendarDays className="mx-auto h-9 w-9 text-board-muted" />
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
          previousName={data.services.at(-1)?.name}
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
          context={selected ? `${selected.name} · ${new Date(`${selected.serviceDate}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).replace(",", "")}` : undefined}
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
          context={selected ? `${selected.name} · ${new Date(`${selected.serviceDate}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).replace(",", "")}` : undefined}
          orgId={data.orgId} userId={user.id}
          target={{ kind: "team", showId: selected.id, serviceDate: selected.serviceDate }}
          departments={departments} crew={data.crew} venueTimeZone={data.orgTimezone} confirm={confirm}
          onClose={() => setTeamBuilderOpen(false)} onSaved={refreshAssignments}
        />
      ) : null}
      {editing ? (
        <AssignmentEditor
          key={`edit:${user.id}:${data.orgId}:${editing.id}`}
          context={selected ? `${selected.name} · ${new Date(`${selected.serviceDate}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).replace(",", "")}` : undefined}
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

function ShowSwitcherBar({ services, selected, today, calendar, onChoose, onNew, actions }: {
  services: Awaited<ReturnType<typeof getSchedule>>["services"];
  selected: Awaited<ReturnType<typeof getSchedule>>["services"][number] | null;
  today: string;
  calendar: React.ReactNode;
  onChoose: (showId: string, date: string) => void;
  onNew?: () => void;
  actions?: React.ReactNode;
}) {
  const locale = useDeviceLocale();
  const deviceTimeZone = useDeviceTimeZone();
  const [calendarOpen, setCalendarOpen] = useState(false);
  const index = selected ? services.findIndex(service => service.id === selected.id) : -1;
  const previous = index > 0 ? services[index - 1] : null;
  const next = index >= 0 && index < services.length - 1 ? services[index + 1] : null;
  const upcoming = services.filter(service => service.serviceDate >= today);
  const upcomingIndex = selected ? upcoming.findIndex(service => service.id === selected.id) : -1;
  const square = "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[var(--sa-border-strong)] bg-[var(--sa-surface-2)] text-[var(--sa-ink-2)] hover:text-board-text disabled:opacity-40";
  const day = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", timeZone: "UTC" }).toUpperCase();
  return <div className="schedule-a flex h-14 min-w-0 items-center gap-2 border-b border-[var(--sa-border)] bg-board-bg px-4 md:px-6 lg:hidden">
    <DropdownMenu open={calendarOpen} onOpenChange={setCalendarOpen}>
      <DropdownMenuTrigger aria-label="Open calendar" className={square}><CalendarDays className="h-4 w-4" strokeWidth={1.75} /></DropdownMenuTrigger>
      <DropdownMenuContent align="start" collisionPadding={12} className="w-72 border-none bg-transparent p-0 shadow-none" onClickCapture={event => { if ((event.target as HTMLElement).closest("button[data-date]")) setCalendarOpen(false); }}>
        {calendar}
      </DropdownMenuContent>
    </DropdownMenu>
    {selected ? <DropdownMenu>
      <DropdownMenuTrigger className="flex h-8 min-w-0 items-center gap-2.5 rounded-lg border border-[var(--sa-border-strong)] bg-[var(--sa-surface-2)] px-3 text-[13px] font-medium text-board-text">
        <span className="shrink-0 tabular-nums text-xs text-fire-500">{day(selected.serviceDate)}</span>
        <span className="truncate">{selected.name}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--sa-ink-3)]" strokeWidth={2} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" collisionPadding={12} className="max-h-[60vh] w-72 overflow-y-auto rounded-lg border-[var(--sa-border-strong)] bg-board-card p-1 text-board-text">
        {services.map(service => <DropdownMenuItem key={service.id} onSelect={() => onChoose(service.id, service.serviceDate)} className={`flex items-center gap-3 rounded-md px-2.5 py-2 ${service.id === selected.id ? "bg-board-border" : ""}`}>
          <span className={`w-14 shrink-0 tabular-nums text-xs ${service.id === selected.id ? "text-fire-400" : "text-board-muted"}`}>{day(service.serviceDate)}</span>
          <span className="flex min-w-0 flex-col"><span className="truncate text-[13px] font-medium">{service.name}</span><span className="text-xs text-board-muted">{timeLabel(service.scheduledStartTime, deviceTimeZone, locale)} · {service.crewTotal ? `${service.crewConfirmed} of ${service.crewTotal} confirmed` : "No crew yet"}</span></span>
        </DropdownMenuItem>)}
      </DropdownMenuContent>
    </DropdownMenu> : null}
    <span className={`ml-1 hidden whitespace-nowrap text-xs text-[var(--sa-ink-3)] ${actions ? "min-[900px]:inline" : "sm:inline"}`}>{upcomingIndex >= 0 ? `${upcomingIndex + 1} of ${upcoming.length} upcoming` : `${upcoming.length} upcoming`}</span>
    <span className="flex-1" />
    {actions ? <div className="hidden items-center gap-1 md:flex [&>div]:flex-row">{actions}</div> : null}
    <button type="button" aria-label="Previous show" disabled={!previous} onClick={() => previous && onChoose(previous.id, previous.serviceDate)} className={square}><ChevronLeft className="h-3.5 w-3.5" strokeWidth={2} /></button>
    <button type="button" aria-label="Next show" disabled={!next} onClick={() => next && onChoose(next.id, next.serviceDate)} className={square}><ChevronRight className="h-3.5 w-3.5" strokeWidth={2} /></button>
    {onNew ? <button type="button" onClick={onNew} className="flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border border-[var(--sa-border-strong)] bg-[var(--sa-surface-2)] px-3 text-[13px] font-medium text-board-text hover:bg-[var(--sa-surface-3)]"><Plus className="h-3.5 w-3.5" strokeWidth={2} /><span className="hidden sm:inline">New show</span></button> : null}
  </div>;
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
  const month = new Date(`${calendarMonth}-01T12:00:00`);
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
  const cells = Array.from({ length: Math.ceil((startDay + daysInMonth) / 7) * 7 }, (_, index) => {
    const day = index - startDay + 1;
    return day > 0 && day <= daysInMonth ? day : null;
  });
  const dateFor = (day: number) =>
    `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return (
    <div className="rounded-xl border border-board-border bg-board-card p-3">
      <div id="schedule-calendar">
        <div className="flex items-center justify-between gap-1">
          <label className="relative min-w-0 pl-1 text-[13px] font-semibold text-board-text">
            {month.toLocaleDateString(locale, { month: "long", year: "numeric" })}
            <input type="month" aria-label="Calendar month" value={calendarMonth} onChange={event => onMonthChange(event.target.value)} className="absolute inset-0 w-full cursor-pointer opacity-0" />
          </label>
          <div className="flex items-center gap-0.5 text-board-muted">
            <button onClick={() => shiftMonth(-1)} aria-label="Previous month" className="flex h-6 w-6 items-center justify-center rounded hover:bg-board-bg"><ChevronLeft className="h-3.5 w-3.5" /></button>
            <button onClick={() => onSelect(today)} className="h-6 rounded px-2 text-xs hover:bg-board-bg">Today</button>
            <button onClick={() => shiftMonth(1)} aria-label="Next month" className="flex h-6 w-6 items-center justify-center rounded hover:bg-board-bg"><ChevronRight className="h-3.5 w-3.5" /></button>
          </div>
        </div>
        <div className="mt-2 grid grid-cols-7 text-center text-[10px] font-medium uppercase text-board-muted">
          {["S", "M", "T", "W", "T", "F", "S"].map((label, index) => (
            <span className="flex h-6 items-center justify-center" key={`${label}-${index}`}>{label}</span>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-y-0.5">
          {cells.map((day, index) => {
            if (!day) return <span key={`empty-${index}`} className="h-[30px]" />;
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
                className={`relative mx-0.5 flex h-[30px] items-center justify-center rounded-md tabular-nums text-xs transition-colors focus-visible:outline focus-visible:outline-fire-400 ${selected ? "bg-fire-500 font-semibold text-black" : hasService ? "text-board-text hover:bg-board-bg" : "text-board-muted"} ${isToday && !selected ? "ring-1 ring-inset ring-board-border" : ""}`}
              >
                {day}
                {hasService ? (
                  <span className="absolute bottom-[3px] h-1 w-1 rounded-full bg-current" />
                ) : null}
              </button>
            );
          })}
        </div>
    </div>
    </div>
  );
}
// TODO(design): bounce status is not exposed by the roster contract; add the flagged failure row when available.
const ROW_GRID = "grid grid-cols-[28px_minmax(0,1.3fr)_minmax(0,1fr)_56px_100px_28px] gap-x-1 pl-2 pr-2 @min-[520px]/schedule-main:gap-x-3 @min-[520px]/schedule-main:pl-4 @min-[520px]/schedule-main:pr-3 @min-[700px]/schedule-main:grid-cols-[28px_minmax(0,1.3fr)_minmax(0,1fr)_56px_128px_28px]";
const ghostSm = "inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-xs font-medium text-[var(--sa-ink-2)] hover:bg-[var(--sa-surface-2)] hover:text-board-text";
const secondarySm = "inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-md border border-[var(--sa-border-strong)] bg-[var(--sa-surface-2)] px-2.5 text-xs font-medium text-board-text hover:bg-[var(--sa-surface-3)] disabled:opacity-40";
const metaItem = "inline-flex items-center gap-1.5 whitespace-nowrap";
const metaIcon = "h-3.5 w-3.5 text-[var(--sa-ink-3)]";
const popover = "absolute right-0 top-full z-30 mt-2 flex w-72 flex-col gap-1 rounded-lg border border-[var(--sa-border-strong)] bg-[var(--sa-surface)] p-2 text-board-text shadow-lg";
const menuButton = "flex min-h-9 items-center gap-2 rounded-md px-2.5 text-left text-[13px] text-[var(--sa-ink-2)] hover:bg-[var(--sa-surface-2)] hover:text-board-text";

/**
 * A <details> popover that behaves like a menu: closes on an outside press,
 * on Escape (focus returns to the trigger) and after a menu action. Kept as
 * <details> because Manage source opens a portaled dialog from inside it,
 * which a Radix menu would unmount on the first press inside that dialog.
 */
function MenuDetails({ className, children }: { className?: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const details = ref.current;
    if (!details) return;
    const close = (focus: boolean) => {
      if (!details.open) return;
      details.open = false;
      if (focus) details.querySelector("summary")?.focus();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!details.contains(event.target as Node)) close(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && details.open) { event.stopPropagation(); close(true); }
    };
    const onClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest("summary") || target.closest("[data-keep-open]")) return;
      if (target.closest("button, a")) close(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    details.addEventListener("keydown", onKeyDown);
    details.addEventListener("click", onClick);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      details.removeEventListener("keydown", onKeyDown);
      details.removeEventListener("click", onClick);
    };
  }, []);
  return <details ref={ref} className={className}>{children}</details>;
}

function headerDate(date: string, today: string) {
  const value = new Date(`${date}T12:00:00Z`);
  const part = (options: Intl.DateTimeFormatOptions) => value.toLocaleDateString("en-GB", { ...options, timeZone: "UTC" });
  const days = Math.round((Date.parse(date) - Date.parse(today)) / 86400000);
  const relative = days === 0 ? " · Today" : days === 1 ? " · Tomorrow" : days === -1 ? " · Yesterday" : "";
  return `${part({ weekday: "short" })} ${part({ day: "numeric" })} ${part({ month: "short" })} ${part({ year: "numeric" })}${relative}`;
}

const railGhost = "inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-xs font-medium text-[var(--sa-ink-2)] hover:bg-[var(--sa-surface-2)] hover:text-board-text";
const rowMenuItem = "flex min-h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-left text-[13px] text-board-text outline-none hover:bg-[var(--sa-surface-2)] focus:bg-[var(--sa-surface-2)] data-[highlighted]:bg-[var(--sa-surface-2)] disabled:opacity-40";

function invitationLine(assignment: Assignment, response: string, locale: string) {
  if (!assignment.invitedAt) return "Not sent yet";
  const sent = new Date(assignment.invitedAt);
  const when = `${sent.toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "short" })}, ${sent.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" })}`;
  const state = { awaiting: "no reply yet", confirmed: "confirmed", declined: "declined", closed: "reply window closed" }[response] ?? "";
  return `Sent ${when}${state ? ` · ${state}` : ""}`;
}

function CopyEmailButton({ email }: { email: string }) {
  const [copied, setCopied] = useState(false);
  return <button type="button" aria-label={copied ? "Email copied" : `Copy ${email}`} onClick={() => { void navigator.clipboard?.writeText(email).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }} className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--sa-ink-3)] hover:bg-[var(--sa-surface-2)] hover:text-board-text">
    {copied ? <Check className="h-3 w-3" strokeWidth={2} /> : <Copy className="h-3 w-3" strokeWidth={1.75} />}
  </button>;
}

const responseDot: Record<string, string> = {
  confirmed: "bg-[var(--sa-ok)]",
  awaiting: "bg-[var(--sa-warn)]",
  declined: "bg-[var(--sa-danger)]",
  open: "shadow-[inset_0_0_0_1.5px_var(--sa-ink-3)]",
  closed: "shadow-[inset_0_0_0_1.5px_var(--sa-ink-3)]",
};

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

function RosterSkeleton() {
  const bar = (width: string) => <span className={`block h-2.5 rounded bg-[var(--sa-surface-3)] ${width}`} />;
  return <><p role="status" aria-live="polite" className="sr-only">Loading schedule…</p><div aria-hidden="true" className="schedule-skeleton flex flex-col gap-5">
    <div className="flex flex-col gap-4 rounded-xl border border-[var(--sa-border)] bg-[var(--sa-surface)] p-4">
      {bar("h-3.5 w-44")}<span className="block h-1.5 rounded bg-[var(--sa-surface-3)]" />
      <div className="flex gap-2">{["w-12", "w-22", "w-26", "w-15"].map(w => <span key={w} className={`block h-6 rounded-md bg-[var(--sa-surface-3)] ${w}`} />)}</div>
    </div>
    <div className="overflow-hidden rounded-xl border border-[var(--sa-border)] bg-[var(--sa-surface)]">
      <div className="flex h-11 items-center px-3">{bar("w-34")}</div>
      {["w-28", "w-23", "w-26", "w-20"].map(w => <div key={w} className={`${ROW_GRID} h-12 items-center shadow-[inset_0_1px_0_var(--sa-border)]`}>
        <span className="h-7 w-7 rounded-full bg-[var(--sa-surface-3)]" />{bar(w)}{bar("w-22")}{bar("w-10")}{bar("w-20")}<span />
      </div>)}
    </div>
  </div></>;
}

function StaffingSummary({ stats, total, filter, onFilter, reminder }: {
  stats: { confirmed: number; open: number; awaiting: number; closed: number; declined: number };
  total: number;
  filter: ResponseFilter;
  onFilter: (filter: ResponseFilter) => void;
  reminder: React.ReactNode;
}) {
  const filled = stats.confirmed + stats.awaiting + stats.closed;
  const detail = [
    stats.awaiting ? `${plural(stats.awaiting, "person hasn't", "people haven't")} replied yet` : "",
    stats.closed ? `${plural(stats.closed, "reply", "replies")} closed without an answer` : "",
    stats.declined ? `${stats.declined} declined` : "",
    stats.open ? `${plural(stats.open, "position", "positions")} still open` : "",
  ].filter(Boolean).join(" · ") || "Everyone has confirmed";
  const segments = [
    { key: "confirmed", value: stats.confirmed, className: "bg-[var(--sa-ok)]" },
    { key: "awaiting", value: stats.awaiting, className: "bg-[var(--sa-warn)]" },
    { key: "closed", value: stats.closed, className: "bg-[var(--sa-ink-3)]" },
    { key: "declined", value: stats.declined, className: "bg-[var(--sa-danger)]" },
    { key: "open", value: stats.open, className: "shadow-[inset_0_0_0_1px_var(--sa-border-strong)] bg-[repeating-linear-gradient(135deg,var(--sa-border-strong)_0_2px,transparent_2px_6px)]" },
  ].filter(segment => segment.value > 0);
  const tabs = [
    { value: "all", label: "All", count: total, dot: "" },
    { value: "confirmed", label: "Confirmed", count: stats.confirmed, dot: responseDot.confirmed },
    { value: "assigned", label: "Awaiting", count: stats.awaiting, dot: responseDot.awaiting },
    { value: "open", label: "Open", count: stats.open, dot: responseDot.open },
    { value: "declined", label: "Declined", count: stats.declined, dot: responseDot.declined },
  ] as const;
  return <section aria-label="Staffing" className="flex flex-col gap-3.5 rounded-xl border border-[var(--sa-border)] bg-[var(--sa-surface)] p-4">
    <div className="flex flex-wrap items-center justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-base font-[550] tracking-[-0.01em] text-board-text"><span className="tabular-nums font-medium">{filled}</span> of <span className="tabular-nums font-medium">{total}</span> {total === 1 ? "position" : "positions"} filled</p>
        <p className="text-[13px] text-[var(--sa-ink-2)]">{detail}</p>
      </div>
      {reminder}
    </div>
    <div aria-hidden="true" className="flex h-1.5 gap-[3px]">
      {segments.map(segment => <span key={segment.key} className={`rounded-[3px] ${segment.className}`} style={{ flex: segment.value }} />)}
    </div>
    <div role="group" aria-label="Filter crew by response" className="flex flex-wrap gap-1">
      {tabs.map(tab => <button key={tab.value} type="button" aria-pressed={filter === tab.value} onClick={() => onFilter(tab.value)} className={`inline-flex h-7 items-center gap-[7px] whitespace-nowrap rounded-md px-2.5 text-xs font-medium ${filter === tab.value ? "bg-[var(--sa-surface-3)] text-board-text shadow-[inset_0_0_0_1px_var(--sa-border-strong)]" : "text-[var(--sa-ink-2)] hover:bg-[var(--sa-surface-2)] hover:text-board-text"}`}>
        {tab.dot ? <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${tab.dot}`} /> : null}
        {tab.label}
        <span className="tabular-nums text-[var(--sa-ink-3)]">{tab.count}</span>
      </button>)}
    </div>
  </section>;
}

function RosterTable({
  assignments,
  departments,
  showEmptyDepartments,
  orgId,
  canManage,
  onAdd,
  onEdit,
  onChanged,
  confirm,
}: {
  assignments: Assignment[];
  departments: string[];
  showEmptyDepartments: boolean;
  orgId: string;
  canManage: boolean;
  onAdd: (department: string) => void;
  onEdit: (assignment: Assignment) => void;
  onChanged: () => Promise<void>;
  confirm: ReturnType<typeof useConfirmDialog>["confirm"];
}) {
  const groups = groupRosterRows(assignments, departments);
  return <div className="flex flex-col gap-3">
    <div aria-hidden="true" className={`${ROW_GRID} -mb-1 h-8 items-center px-px text-[11px] font-medium uppercase tracking-[0.06em] text-[var(--sa-ink-3)]`}>
      <span /><span>Person</span><span>Role</span><span>Call</span><span>Response</span><span />
    </div>
    {groups.map(group => {
      if (!group.rows.length) {
        return canManage && showEmptyDepartments ? <button key={group.name} type="button" onClick={() => onAdd(group.name)} className="flex h-11 w-full items-center gap-2.5 rounded-xl border border-dashed border-[var(--sa-border-strong)] px-4 text-left text-[13px] text-[var(--sa-ink-2)] hover:bg-[var(--sa-surface)] hover:text-board-text">
          <Plus className="h-3.5 w-3.5 shrink-0" strokeWidth={2} />
          <span className="font-medium text-board-text">{group.name}</span>
          <span className="truncate text-[var(--sa-ink-3)]">No positions yet — add the first one</span>
        </button> : null;
      }
      // Person first: filled positions above open ones, original order otherwise.
      const rows = [...group.rows].sort((a, b) => Number(!a.crewMemberId) - Number(!b.crewMemberId));
      return <details key={group.name} open className="overflow-hidden rounded-xl border border-[var(--sa-border)] bg-[var(--sa-surface)]">
        <summary className="flex h-11 cursor-pointer list-none items-center gap-2 pl-3 pr-2 [&::-webkit-details-marker]:hidden">
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--sa-ink-3)] transition-transform [details:not([open])>summary>&]:-rotate-90" strokeWidth={2} />
          <span className="truncate text-xs font-semibold uppercase tracking-[0.06em] text-board-text">{group.name}</span>
          <span className="tabular-nums text-xs text-[var(--sa-ink-3)]">{group.rows.length}</span>
          <span className="ml-2 hidden truncate text-xs text-[var(--sa-ink-3)] @min-[520px]/schedule-main:inline">{[
            plural(group.rows.filter(row => row.status === "confirmed").length, "confirmed", "confirmed"),
            plural(group.rows.filter(row => row.status === "assigned" && row.crewMemberId).length, "awaiting", "awaiting"),
            plural(group.rows.filter(row => !row.crewMemberId).length, "open", "open"),
          ].filter(part => !part.startsWith("0 ")).join(" · ")}</span>
          {canManage && <button type="button" onClick={event => { event.preventDefault(); onAdd(group.name); }} className={`${ghostSm} ml-auto`}><Plus className="h-3.5 w-3.5" strokeWidth={2} />Add position</button>}
        </summary>
        {rows.map(assignment => <RosterRow key={assignment.id} assignment={assignment} orgId={orgId} canManage={canManage} onEdit={() => onEdit(assignment)} onChanged={onChanged} confirm={confirm} />)}
      </details>;
    })}
  </div>;
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
  const response = !assignment.crewMemberId
    ? "open"
    : assignment.status === "assigned"
      ? closed ? "closed" : "awaiting"
      : assignment.status;
  const responseLabel = { open: "Open", closed: "Closed", awaiting: "Awaiting", confirmed: "Confirmed", declined: "Declined" }[response] ?? response;
  return <div id={`assignment-${assignment.id}`} className={`${ROW_GRID} h-12 min-w-0 items-center text-board-text shadow-[inset_0_1px_0_var(--sa-border)] hover:bg-[var(--sa-surface-2)] has-[[data-state=open]]:bg-[var(--sa-surface-2)]`}>
    <span aria-hidden="true" className={`flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-semibold tracking-[0.02em] text-[var(--sa-ink-2)] ${assignment.crewMemberId ? "bg-[var(--sa-surface-3)]" : "border-[1.5px] border-dashed border-[var(--sa-border-strong)]"}`}>{assignment.crewMember?.name.split(" ").map(part => part[0]).slice(0,2).join("")}</span>
    <span className={`truncate ${assignment.crewMemberId ? "text-sm font-[550] text-board-text" : "text-sm font-[450] text-[var(--sa-ink-3)]"}`}>{assignment.crewMember?.name ?? "Open — nobody assigned"}</span>
    <span className="truncate text-[13px] text-[var(--sa-ink-2)]">{assignment.role}</span>
    <span className="truncate tabular-nums text-xs text-board-text">{timeLabel(assignment.effectiveCallTime, deviceTimeZone, locale)}</span>
    <span className="flex items-center">{!assignment.crewMemberId && canManage
      ? <button type="button" onClick={onEdit} className={secondarySm}>Assign</button>
      : <span className="inline-flex items-center gap-2 whitespace-nowrap text-[13px] text-[var(--sa-ink-2)]"><span aria-hidden="true" className={`h-[7px] w-[7px] shrink-0 rounded-full ${responseDot[response] ?? responseDot.open}`} />{responseLabel}</span>}</span>
    <DropdownMenu><DropdownMenuTrigger aria-label={`Actions for ${assignment.crewMember?.name ?? assignment.role}`} className="flex h-7 w-7 shrink-0 items-center justify-center justify-self-end rounded-md border border-transparent text-[var(--sa-ink-3)] hover:bg-[var(--sa-surface-3)] hover:text-board-text data-[state=open]:border-[var(--sa-border-strong)] data-[state=open]:bg-[var(--sa-surface-3)] data-[state=open]:text-board-text focus-visible:outline focus-visible:outline-fire-500"><MoreHorizontal className="h-4 w-4" /></DropdownMenuTrigger>
      <DropdownMenuContent align="end" collisionPadding={12} className="schedule-a w-72 max-w-[calc(100vw-24px)] rounded-xl border-[var(--sa-border-strong)] bg-[var(--sa-surface)] p-0 text-board-text shadow-xl">
        <div className="flex flex-col gap-2.5 p-2.5 pb-2">
          <div className="px-1.5 pt-1">
            <p className="truncate text-[13px] font-semibold">{assignment.crewMember?.name ?? "Open position"}</p>
            {assignment.crewMember?.email
              ? <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-[var(--sa-ink-2)]"><span className="truncate">{assignment.crewMember.email}</span><CopyEmailButton email={assignment.crewMember.email} /></p>
              : <p className="mt-0.5 truncate text-xs text-[var(--sa-ink-2)]">{assignment.role}</p>}
          </div>
          {assignment.crewMemberId ? <div className="rounded-md bg-[var(--sa-surface-2)] px-2 py-1.5">
            <p className="text-[11px] font-medium uppercase tracking-[0.06em] text-[var(--sa-ink-3)]">Invitation</p>
            <p className="mt-0.5 text-xs text-[var(--sa-ink-2)]">{invitationLine(assignment, response, locale)}</p>
            {assignment.responseNote ? <p className="mt-1 whitespace-pre-wrap text-xs text-[var(--sa-ink-2)]">“{assignment.responseNote}”</p> : null}
          </div> : null}
        </div>
        {canManage ? <>
          <DropdownMenuSeparator className="m-0 bg-[var(--sa-border)]" />
          <div className="flex flex-col gap-0.5 p-1.5">
            {pending ? <ReminderControl orgId={orgId} target={{ kind: "assignment", id: assignment.id }} label="Resend invite" icon={<Send className="h-3.5 w-3.5 text-[var(--sa-ink-3)]" strokeWidth={1.75} />} className={rowMenuItem} onChanged={onChanged} /> : null}
            <DropdownMenuItem onSelect={onEdit} className={rowMenuItem}><Pencil className="h-3.5 w-3.5 text-[var(--sa-ink-3)]" strokeWidth={1.75} />{assignment.crewMemberId ? "Edit assignment" : "Assign someone"}</DropdownMenuItem>
          </div>
          <DropdownMenuSeparator className="m-0 bg-[var(--sa-border)]" />
          <div className="p-1.5"><RemoveAssignmentButton orgId={orgId} assignment={assignment} confirm={confirm} onChanged={onChanged} /></div>
        </> : null}
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
    <button type="button" aria-label={`Remove ${assignment.role}`} onClick={() => setOpen(true)} className={rowMenuItem.replace("text-board-text", "text-[var(--sa-danger)]").replace("hover:bg-[var(--sa-surface-2)]", "hover:bg-[var(--sa-danger)]/10")}><Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />Remove from show</button>
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
  previousName,
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
  previousName?: string;
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
      description={`Times use ${getDeviceTimeZone()}.`}
      onClose={onClose}
    >
      <ShowCreationForm
        scope={{ orgId, userId, entry: "schedule" }}
        initial={item ? inventoryDraft(initial, item, venueTimeZone) : initial}
        minDate={today}
        inventory={inventory}
        venueTimeZone={venueTimeZone}
        onClose={onClose}
        variant="modal"
        shows={
          previousDate && previousShowId
            ? [
                {
                  id: previousShowId,
                  serviceDate: previousDate,
                  name: previousName ?? "Previous show",
                  meta: `Previous show · ${headerDate(previousDate, "").replace(/ · .*$/, "")}`,
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
  const [creating, setCreating] = useState(false);
  return (
    <Modal
      title={creating ? "New saved show" : "Saved shows"}
      description={creating ? "It will appear under “Start from” when you create a show." : "Reusable shows you can start new dates from."}
      onClose={onClose}
    >
      <ShowInventoryEditor {...props} onCreatingChange={setCreating} />
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
    <Modal title="Show details" description={`${service.name} · ${headerDate(service.serviceDate, "").replace(/ · .*$/, "")}`} onClose={onClose}>
      <ShowDetailsEditor
        scope={{ orgId, userId, showId: service.id }}
        initialDraft={{ serviceDate: service.serviceDate, expectedUpdatedAt: new Date(service.updatedAt).toISOString(),
          name: service.name, startTime: inputTime(service.scheduledStartTime, orgTimezone),
          callTime: inputTime(service.scheduledCallTime, orgTimezone), location: service.location,
          timeZone: orgTimezone || getDeviceTimeZone() }}
        nameLabel={workspaceCopy("Show or service name", workspaceTerms)}
        callTimeNote={service.effectiveCallTime ? `Organization default: ${timeLabel(service.effectiveCallTime, orgTimezone, locale)}.` : "No call time until this show has a start time."}
        refresh={onSaved} onRefreshed={onClose} disabled={deleting}
        variant="modal" onCancel={onClose}
      >
      {(locked) => <>
      <div className="flex items-start justify-between gap-4 border-t border-[var(--sa-border)] pt-4" aria-label="Delete show">
        <div className="min-w-0">
          <h3 className="text-[13px] font-semibold text-board-text">Delete show</h3>
          <p className="mt-1 text-xs leading-[1.5] text-[var(--sa-ink-3)]">Removes this stopped show’s rundown, crew assignments, notes, checklist, incidents and related notifications.</p>
        </div>
        <button
          type="button"
          disabled={locked}
          onClick={() => void onDelete()}
          aria-label="Delete show"
          className={`${modalDanger} h-7 shrink-0 px-2.5 text-xs`}
        >
          Delete
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
  description: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const [opener] = useState(() =>
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  return (
    <ModalA
      title={title}
      description={description}
      onClose={onClose}
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        // Inventory can open a new-show dialog directly. Let that dialog keep focus.
        if (!document.querySelector('[role="dialog"][data-state="open"]')) opener?.focus();
      }}
    >
      {children}
    </ModalA>
  );
}
