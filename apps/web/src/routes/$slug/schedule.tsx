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
  Copy,
  ExternalLink,
  MapPin,
  Pencil,
  Plus,
  Send,
  Settings2,
  Trash2,
  X,
} from "lucide-react";
import { PageSkeleton } from "@/components/ui/Skeleton";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { createNextService, copyCrewFromService } from "@/lib/pm-actions";
import {
  deleteServiceAssignment,
  getSchedule,
  getServiceAssignments,
  remindAllServiceAssignments,
  remindServiceAssignment,
  saveScheduleProvider,
  saveServiceAssignment,
  saveServiceDetails,
  type ScheduleProvider,
} from "@/lib/schedule";
import { getOrgSettings } from "@/lib/settings";
import { getTodayDateString } from "@/lib/utils";
import { orgTerms, type OrgTerminologyProfile } from "@/lib/org-terminology";
import { hasPermission } from "@/lib/app-permissions";
import { StatusMetric } from "@/components/ui/status-metric";

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
function dayLabel(date: string) {
  return new Date(`${date}T12:00:00`).toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}
function longDate(date: string) {
  return new Date(`${date}T12:00:00`).toLocaleDateString([], {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}
function timeLabel(value: string | null) {
  return value
    ? new Date(value).toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
      })
    : "Time not set";
}
function inputTime(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
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
const FORM_CONTROL =
  "w-full rounded-xl border border-board-border bg-board-bg px-3 py-2.5 text-sm text-board-text outline-none focus:border-fire-500/50";

export const Route = createFileRoute("/$slug/schedule")({
  validateSearch: (search: Record<string, unknown>) => ({
    date: typeof search.date === "string" ? search.date : undefined,
    assignment:
      typeof search.assignment === "string" ? search.assignment : undefined,
  }),
  loaderDeps: () => ({}),
  pendingComponent: PageSkeleton,
  loader: async ({ context }) => {
    const { withPermission } = await import("@/lib/route-permissions");
    await withPermission(
      context.role,
      "schedule:view",
      context.slug,
      context.orgId,
    );
    const settings = await getOrgSettings({ data: { orgId: context.orgId } });
    const today = getTodayDateString(settings["org-timezone"]);
    const schedule = await getSchedule({
      data: {
        orgId: context.orgId,
        from: shiftDate(today, -30),
        to: shiftDate(today, 31),
      },
    });
    const defaultSelectedDate =
      schedule.services.find((service) => service.serviceDate >= today)
        ?.serviceDate ??
      schedule.services.at(-1)?.serviceDate ??
      null;
    return {
      ...schedule,
      defaultSelectedDate,
      today,
      orgId: context.orgId,
      canManage: hasPermission(context.role, "schedule:manage"),
    };
  },
  component: SchedulePage,
});

type Assignment = Awaited<
  ReturnType<typeof getSchedule>
>["assignments"][number];
type ResponseFilter = "all" | "assigned" | "confirmed" | "declined" | "open";

function SchedulePage() {
  const data = Route.useLoaderData();
  const { date: requestedDate } = Route.useSearch();
  const { slug } = Route.useParams();
  const navigate = useNavigate({ from: Route.fullPath });
  const router = useRouter();
  const { confirm, ConfirmDialogEl } = useConfirmDialog();
  const [createOpen, setCreateOpen] = useState(false);
  const [assignmentOpen, setAssignmentOpen] = useState(false);
  const [assignmentDepartment, setAssignmentDepartment] = useState("");
  const [teamBuilderOpen, setTeamBuilderOpen] = useState(false);
  const [editing, setEditing] = useState<Assignment | null>(null);
  const [providerOpen, setProviderOpen] = useState(false);
  const [serviceOpen, setServiceOpen] = useState(false);
  const [filter, setFilter] = useState<ResponseFilter>("all");
  const [busy, setBusy] = useState(false);
  const [liveAssignments, setLiveAssignments] = useState(data.assignments);
  const terms = orgTerms(data.terminologyProfile);
  const departments = Array.from(
    new Set(
      liveAssignments
        .map((assignment) => assignment.department.trim())
        .filter(Boolean),
    ),
  ).sort((a, b) => a.localeCompare(b));
  const selectedDate = data.services.some(
    (service) => service.serviceDate === requestedDate,
  )
    ? requestedDate
    : data.defaultSelectedDate;
  const selected =
    data.services.find((service) => service.serviceDate === selectedDate) ??
    data.services[0] ??
    null;
  const previous = selected
    ? [...data.services]
        .reverse()
        .find((service) => service.serviceDate < selected.serviceDate)
    : null;
  useEffect(() => setLiveAssignments(data.assignments), [data.assignments]);
  useEffect(() => {
    if (!selected?.serviceDate) return;
    let active = true;
    const refresh = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const rows = await getServiceAssignments({
          data: { orgId: data.orgId, serviceDate: selected.serviceDate },
        });
        if (!active) return;
        setLiveAssignments((current) => [
          ...current.filter(
            (assignment) => assignment.serviceDate !== selected.serviceDate,
          ),
          ...rows,
        ]);
      } catch {
        // Keep the last good roster visible through transient network loss.
      }
    };
    void refresh();
    const timer = window.setInterval(refresh, 15_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [data.orgId, selected?.serviceDate]);
  const selectedAssignments = useMemo(
    () =>
      liveAssignments.filter(
        (assignment) => assignment.serviceDate === selected?.serviceDate,
      ),
    [liveAssignments, selected?.serviceDate],
  );
  const assignments = useMemo(
    () =>
      selectedAssignments.filter(
        (assignment) =>
          filter === "all" ||
          (filter === "open"
            ? !assignment.crewMemberId
            : assignment.status === filter),
      ),
    [selectedAssignments, filter],
  );
  const stats = {
    filled: selectedAssignments.filter((item) => item.crewMemberId).length,
    open: selectedAssignments.filter((item) => !item.crewMemberId).length,
    awaiting: selectedAssignments.filter(
      (item) => item.status === "assigned" && item.crewMemberId,
    ).length,
    declined: selectedAssignments.filter((item) => item.status === "declined")
      .length,
  };
  const chooseDate = (date: string) =>
    void navigate({ search: { date, assignment: undefined } });

  return (
    <div className="h-full overflow-auto bg-board-bg">
      <header className="sticky top-0 z-20 border-b border-board-border bg-board-bg/95 px-4 py-3 backdrop-blur-xl md:px-6">
        <div className="mx-auto flex max-w-[1700px] flex-wrap items-center gap-3">
          <h1 className="min-w-0 flex-1 text-xl font-semibold tracking-tight text-board-text">
            Schedule
          </h1>
          {data.canManage ? (
            <button
              onClick={() => setProviderOpen(true)}
              className="flex items-center gap-2 rounded-lg border border-board-border px-3 py-2 text-xs text-board-muted hover:text-board-text"
            >
              <Settings2 className="h-3.5 w-3.5" />
              Manage source
            </button>
          ) : null}
          {data.canManage && data.provider.type === "native" ? (
            <button
              onClick={() => setCreateOpen(true)}
              className="flex items-center gap-2 rounded-lg border border-board-border px-3 py-2 text-xs text-board-text"
            >
              <Plus className="h-3.5 w-3.5" />
              New {terms.event}
            </button>
          ) : null}
        </div>
      </header>
      <div className="mx-auto grid min-h-[calc(100vh-58px)] max-w-[1700px] border-x border-board-border lg:grid-cols-[260px_minmax(0,1fr)]">
        <aside className="border-b border-board-border bg-board-card lg:border-b-0 lg:border-r">
          <MonthCalendar
            selectedDate={selected?.serviceDate ?? data.today}
            today={data.today}
            serviceDates={data.services.map((service) => service.serviceDate)}
            onSelect={chooseDate}
          />
          <div className="border-y border-board-border px-4 py-3">
            <div className="flex items-center justify-between">
              <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-board-muted">
                Services
              </p>
              <button
                onClick={() => chooseDate(data.today)}
                className="text-[10px] text-fire-400"
              >
                Today
              </button>
            </div>
          </div>
          <div className="flex snap-x overflow-x-auto lg:block lg:max-h-[calc(100vh-430px)] lg:overflow-y-auto">
            {data.services.map((service) => (
              <button
                key={service.serviceDate}
                onClick={() => chooseDate(service.serviceDate)}
                className={`min-w-[210px] snap-start border-b border-board-border border-l-[3px] px-4 py-4 text-left lg:w-full ${service.serviceDate === selected?.serviceDate ? "border-l-fire-500 bg-fire-500/[0.055]" : "border-l-transparent hover:bg-board-bg"}`}
              >
                <p
                  className={`text-[10px] font-semibold uppercase tracking-wider ${service.serviceDate === data.today ? "text-fire-400" : "text-board-muted"}`}
                >
                  {service.serviceDate === data.today
                    ? "Today"
                    : dayLabel(service.serviceDate)}
                </p>
                <p className="mt-2 truncate text-sm font-medium text-board-text">
                  {service.name}
                </p>
                <p className="mt-1 text-[11px] text-board-muted">
                  {timeLabel(service.scheduledStartTime)} ·{" "}
                  {service.serviceDate === selected?.serviceDate
                    ? selectedAssignments.filter(
                        (assignment) => assignment.status === "confirmed",
                      ).length
                    : service.crewConfirmed}
                  /
                  {service.serviceDate === selected?.serviceDate
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
                        {longDate(selected.serviceDate)}
                      </span>
                      <span className="flex items-center gap-1.5">
                        <Clock3 className="h-3.5 w-3.5" />
                        {timeLabel(selected.scheduledStartTime)}
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
                      <button
                        disabled={busy || stats.awaiting === 0}
                        onClick={async () => {
                          setBusy(true);
                          try {
                            await remindAllServiceAssignments({
                              data: {
                                orgId: data.orgId,
                                serviceDate: selected.serviceDate,
                              },
                            });
                          } finally {
                            setBusy(false);
                          }
                        }}
                        className="flex items-center gap-2 rounded-lg bg-fire-500 px-3 py-2 text-xs font-semibold text-black disabled:opacity-40"
                      >
                        <Send className="h-3.5 w-3.5" />
                        {busy
                          ? "Sending reminders…"
                          : `Remind awaiting crew (${stats.awaiting})`}
                      </button>
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
                      {previous ? (
                        <button
                          disabled={busy || selectedAssignments.length > 0}
                          onClick={async () => {
                            setBusy(true);
                            try {
                              await copyCrewFromService({
                                data: {
                                  orgId: data.orgId,
                                  serviceDate: selected.serviceDate,
                                  copyFrom: previous.serviceDate,
                                },
                              });
                              await router.invalidate();
                            } finally {
                              setBusy(false);
                            }
                          }}
                          className="flex items-center gap-2 rounded-lg border border-board-border px-3 py-2 text-xs text-board-text disabled:opacity-40"
                        >
                          <Copy className="h-3.5 w-3.5" />
                          Copy team
                        </button>
                      ) : null}
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
                    value={filter}
                    onChange={(event) =>
                      setFilter(event.target.value as ResponseFilter)
                    }
                    className="rounded-lg border border-board-border bg-board-bg px-3 py-2 text-[11px] text-board-text outline-none"
                  >
                    <option value="all">All responses</option>
                    <option value="confirmed">Confirmed</option>
                    <option value="assigned">Awaiting</option>
                    <option value="declined">Declined</option>
                    <option value="open">Open</option>
                  </select>
                  <Link
                    to="/$slug/rundown"
                    params={{ slug }}
                    search={{ date: selected.serviceDate }}
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
                Create your first service.
              </p>
            </div>
          )}
        </main>
      </div>
      {createOpen ? (
        <CreateServiceModal
          orgId={data.orgId}
          today={data.today}
          serviceDates={data.services.map((service) => service.serviceDate)}
          previousDate={data.services.at(-1)?.serviceDate}
          terminologyProfile={data.terminologyProfile}
          onClose={() => setCreateOpen(false)}
          onCreated={async (date) => {
            setCreateOpen(false);
            await router.invalidate();
            chooseDate(date);
          }}
        />
      ) : null}
      {assignmentOpen && selected ? (
        <AssignmentModal
          orgId={data.orgId}
          serviceDate={selected.serviceDate}
          departments={departments}
          initialDepartment={assignmentDepartment}
          crew={data.crew}
          onClose={() => setAssignmentOpen(false)}
          onSaved={async () => {
            setAssignmentOpen(false);
            await router.invalidate();
          }}
        />
      ) : null}
      {teamBuilderOpen && selected ? (
        <TeamBuilderModal
          orgId={data.orgId}
          serviceDate={selected.serviceDate}
          crew={data.crew}
          onClose={() => setTeamBuilderOpen(false)}
          onSaved={async () => {
            setTeamBuilderOpen(false);
            await router.invalidate();
          }}
        />
      ) : null}
      {editing ? (
        <EditAssignmentModal
          orgId={data.orgId}
          assignment={editing}
          departments={departments}
          crew={data.crew}
          confirm={confirm}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await router.invalidate();
          }}
        />
      ) : null}
      {providerOpen ? (
        <ProviderModal
          orgId={data.orgId}
          current={{
            ...data.provider,
            terminologyProfile: data.terminologyProfile,
          }}
          onClose={() => setProviderOpen(false)}
          onSaved={async () => {
            setProviderOpen(false);
            await router.invalidate();
          }}
        />
      ) : null}
      {serviceOpen && selected ? (
        <ServiceDetailsModal
          orgId={data.orgId}
          service={selected}
          onClose={() => setServiceOpen(false)}
          onSaved={async () => {
            setServiceOpen(false);
            await router.invalidate();
          }}
        />
      ) : null}
      {ConfirmDialogEl}
    </div>
  );
}

function MonthCalendar({
  selectedDate,
  today,
  serviceDates,
  onSelect,
}: {
  selectedDate: string;
  today: string;
  serviceDates: string[];
  onSelect: (date: string) => void;
}) {
  const initial = new Date(`${selectedDate}T12:00:00`);
  const [month, setMonth] = useState(
    () => new Date(initial.getFullYear(), initial.getMonth(), 1),
  );
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
    <div className="hidden p-4 lg:block">
      <div className="flex items-center justify-between">
        <button
          onClick={() =>
            setMonth(
              (value) => new Date(value.getFullYear(), value.getMonth() - 1, 1),
            )
          }
          aria-label="Previous month"
          className="rounded p-1.5 text-board-muted hover:bg-board-bg hover:text-board-text"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
        <p className="text-xs font-semibold text-board-text">
          {month.toLocaleDateString([], { month: "long", year: "numeric" })}
        </p>
        <button
          onClick={() =>
            setMonth(
              (value) => new Date(value.getFullYear(), value.getMonth() + 1, 1),
            )
          }
          aria-label="Next month"
          className="rounded p-1.5 text-board-muted hover:bg-board-bg hover:text-board-text"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="mt-4 grid grid-cols-7 text-center text-[9px] font-medium uppercase text-board-muted">
        {["S", "M", "T", "W", "T", "F", "S"].map((label, index) => (
          <span key={`${label}-${index}`}>{label}</span>
        ))}
      </div>
      <div className="mt-2 grid grid-cols-7 gap-y-1">
        {cells.map((day, index) => {
          if (!day) return <span key={`empty-${index}`} className="h-7" />;
          const date = dateFor(day);
          const hasService = serviceSet.has(date);
          const selected = date === selectedDate;
          const isToday = date === today;
          return (
            <button
              key={date}
              disabled={!hasService}
              onClick={() => onSelect(date)}
              className={`relative mx-auto flex h-7 w-7 items-center justify-center rounded-full text-[10px] transition-colors ${selected ? "bg-fire-500 font-semibold text-black" : hasService ? "text-board-text hover:bg-board-bg" : "text-board-muted/40"} ${isToday && !selected ? "ring-1 ring-fire-500/50" : ""}`}
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
          Service scheduled
        </span>
        <button
          onClick={() => {
            const value = new Date(`${today}T12:00:00`);
            setMonth(new Date(value.getFullYear(), value.getMonth(), 1));
            if (serviceSet.has(today)) onSelect(today);
          }}
          className="text-fire-400"
        >
          This month
        </button>
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
    <div className="overflow-x-auto">
      <div className="min-w-[900px]">
        <div className="grid grid-cols-[1.2fr_1fr_.9fr_.8fr_72px] border-b border-board-border bg-board-bg px-6 py-2.5 text-[10px] uppercase tracking-wider text-board-muted">
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
  const [busy, setBusy] = useState(false);
  const pending = assignment.status === "assigned" && assignment.crewMemberId;
  const statusColor =
    assignment.status === "confirmed"
      ? "text-green-400"
      : assignment.status === "declined"
        ? "text-red-400"
        : "text-yellow-300";
  return (
    <div id={`assignment-${assignment.id}`} className="grid grid-cols-[1.2fr_1fr_.9fr_.8fr_72px] items-center border-b border-board-border px-6 py-3 text-xs hover:bg-board-card/60">
      <button
        disabled={!canManage}
        onClick={onEdit}
        className="text-left font-medium text-board-text disabled:cursor-default"
      >
        {assignment.role}
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
      <div
        className={`flex items-center gap-1.5 text-[10px] capitalize ${statusColor}`}
      >
        {assignment.status === "confirmed" ? (
          <Check className="h-3 w-3" />
        ) : assignment.status === "declined" ? (
          <X className="h-3 w-3" />
        ) : (
          <Clock3 className="h-3 w-3" />
        )}
        {assignment.crewMemberId
          ? assignment.status === "assigned"
            ? "Awaiting"
            : assignment.status
          : "Open"}
        {assignment.responseNote ? (
          <p className="mt-1 max-w-[220px] normal-case leading-4 text-board-muted" title={assignment.responseNote}>
            “{assignment.responseNote}”
          </p>
        ) : null}
        {pending && canManage ? (
          <button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await remindServiceAssignment({
                  data: { orgId, id: assignment.id },
                });
              } finally {
                setBusy(false);
              }
            }}
            className="ml-2 text-[9px] text-fire-400 disabled:opacity-50"
          >
            Resend
          </button>
        ) : null}
      </div>
      <div className="flex items-center gap-1">
        {canManage ? (
          <>
            <button
              onClick={onEdit}
              aria-label={`Edit ${assignment.role}`}
              className="rounded p-1.5 text-board-muted hover:bg-board-border hover:text-board-text"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={async () => {
                const approved = await confirm({
                  title: "Remove position",
                  description: `Remove ${assignment.role} from this service?`,
                  confirmLabel: "Remove",
                });
                if (!approved) return;
                await deleteServiceAssignment({
                  data: { orgId, id: assignment.id },
                });
                await onChanged();
              }}
              aria-label={`Remove ${assignment.role}`}
              className="rounded p-1.5 text-board-muted hover:bg-board-border hover:text-red-400"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}

function CreateServiceModal({
  orgId,
  today,
  serviceDates,
  previousDate,
  terminologyProfile,
  onClose,
  onCreated,
}: {
  orgId: string;
  today: string;
  serviceDates: string[];
  previousDate?: string;
  terminologyProfile: OrgTerminologyProfile;
  onClose: () => void;
  onCreated: (date: string) => void | Promise<void>;
}) {
  const [date, setDate] = useState(() =>
    nextAvailableServiceDate(today, serviceDates),
  );
  const [name, setName] = useState("");
  const [time, setTime] = useState("10:00");
  const [location, setLocation] = useState("");
  const [copy, setCopy] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const terms = orgTerms(terminologyProfile);
  return (
    <Modal title={`New ${terms.event}`} onClose={onClose}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await createNextService({
              data: {
                orgId,
                serviceDate: date,
                name,
                startTime: time,
                location,
                copyFrom: copy ? previousDate : undefined,
              },
            });
            await onCreated(date);
          } catch (cause) {
            setError(
              cause instanceof Error
                ? cause.message
                : `Could not create this ${terms.event}.`,
            );
          } finally {
            setBusy(false);
          }
        }}
        className="space-y-4"
      >
        <Field label={terms.eventName}>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Sunday Morning, Conference Day 1…"
            className={FORM_CONTROL}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Date">
            <input
              type="date"
              value={date}
              min={today}
              max={shiftDate(today, 31)}
              onChange={(event) => setDate(event.target.value)}
              className={FORM_CONTROL}
            />
          </Field>
          <Field label="Start time">
            <input
              type="time"
              value={time}
              onChange={(event) => setTime(event.target.value)}
              className={FORM_CONTROL}
            />
          </Field>
        </div>
        <Field label="Venue or location">
          <input
            value={location}
            onChange={(event) => setLocation(event.target.value)}
            placeholder="Main auditorium, Studio A, 123 Main St…"
            maxLength={240}
            className={FORM_CONTROL}
          />
        </Field>
        {previousDate ? (
          <label className="flex items-center gap-2 text-xs text-board-text">
            <input
              type="checkbox"
              checked={copy}
              onChange={(event) => setCopy(event.target.checked)}
              className="accent-fire-500"
            />
            Copy rundown from {dayLabel(previousDate)}
          </label>
        ) : null}
        {error ? (
          <p role="alert" className="text-xs leading-relaxed text-red-300">
            {error}
          </p>
        ) : null}
        <button
          disabled={busy || !date}
          className="w-full rounded-xl bg-fire-500 px-4 py-2.5 text-sm font-semibold text-black disabled:opacity-50"
        >
          {busy ? "Creating…" : "Create service"}
        </button>
      </form>
    </Modal>
  );
}

function ServiceDetailsModal({
  orgId,
  service,
  onClose,
  onSaved,
}: {
  orgId: string;
  service: Awaited<ReturnType<typeof getSchedule>>["services"][number];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(service.name);
  const [time, setTime] = useState(inputTime(service.scheduledStartTime));
  const [location, setLocation] = useState(service.location);
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="Show details" onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          try {
            await saveServiceDetails({
              data: {
                orgId,
                serviceDate: service.serviceDate,
                name,
                startTime: time,
                location,
              },
            });
            onSaved();
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Show or service name">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={120}
            className={FORM_CONTROL}
          />
        </Field>
        <Field label="Start time">
          <input
            type="time"
            value={time}
            onChange={(event) => setTime(event.target.value)}
            className={FORM_CONTROL}
          />
        </Field>
        <Field label="Venue or location">
          <input
            value={location}
            onChange={(event) => setLocation(event.target.value)}
            maxLength={240}
            placeholder="Main auditorium, Studio A, 123 Main St…"
            className={FORM_CONTROL}
          />
        </Field>
        <button
          disabled={busy || !name.trim()}
          className="w-full rounded-xl bg-fire-500 px-4 py-2.5 text-sm font-semibold text-black disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save show details"}
        </button>
      </form>
    </Modal>
  );
}
type TeamBuilderRow = { crewId: string; role: string };

function TeamBuilderModal({
  orgId,
  serviceDate,
  crew,
  onClose,
  onSaved,
}: {
  orgId: string;
  serviceDate: string;
  crew: Array<{ id: string; name: string; role: string; email: string }>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [category, setCategory] = useState("");
  const [rows, setRows] = useState<TeamBuilderRow[]>([
    { crewId: "", role: "" },
  ]);
  const [busy, setBusy] = useState(false);
  const validRows = rows.filter((row) => row.crewId && row.role.trim());
  const selectedIds = new Set(rows.map((row) => row.crewId).filter(Boolean));

  return (
    <Modal title="Build a team" onClose={onClose}>
      <form
        className="space-y-5"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!category.trim() || validRows.length === 0) return;
          setBusy(true);
          try {
            await Promise.all(
              validRows.map((row) =>
                saveServiceAssignment({
                  data: {
                    orgId,
                    serviceDate,
                    department: category.trim(),
                    role: row.role.trim(),
                    crewMemberId: row.crewId,
                    status: "assigned",
                    notes: "",
                  },
                }),
              ),
            );
            onSaved();
          } finally {
            setBusy(false);
          }
        }}
      >
        <div>
          <Field label="Team or category name">
            <input
              autoFocus
              value={category}
              onChange={(event) => setCategory(event.target.value)}
              placeholder="Technical, Broadcast, Guest Experience…"
              maxLength={80}
              className={FORM_CONTROL}
            />
          </Field>
          <p className="mt-2 text-[11px] text-board-muted">
            Name this group in the language your production already uses.
          </p>
        </div>

        <div className="space-y-2">
          <div className="grid grid-cols-[1fr_1fr_36px] gap-2 px-1 text-[10px] font-semibold uppercase tracking-wider text-board-muted">
            <span>Person</span>
            <span>Role</span>
            <span />
          </div>
          {rows.map((row, index) => {
            const person = crew.find((item) => item.id === row.crewId);
            return (
              <div key={index} className="grid grid-cols-[1fr_1fr_36px] gap-2">
                <select
                  value={row.crewId}
                  onChange={(event) => {
                    const crewId = event.target.value;
                    setRows((current) =>
                      current.map((item, rowIndex) =>
                        rowIndex === index
                          ? {
                              ...item,
                              crewId,
                              role:
                                item.role ||
                                crew.find((entry) => entry.id === crewId)
                                  ?.role ||
                                "",
                            }
                          : item,
                      ),
                    );
                  }}
                  className={FORM_CONTROL}
                >
                  <option value="">Choose person</option>
                  {crew.map((personOption) => (
                    <option
                      key={personOption.id}
                      value={personOption.id}
                      disabled={
                        selectedIds.has(personOption.id) &&
                        personOption.id !== row.crewId
                      }
                    >
                      {personOption.name}
                      {personOption.email ? "" : " (no email)"}
                    </option>
                  ))}
                </select>
                <input
                  value={row.role}
                  onChange={(event) =>
                    setRows((current) =>
                      current.map((item, rowIndex) =>
                        rowIndex === index
                          ? { ...item, role: event.target.value }
                          : item,
                      ),
                    )
                  }
                  placeholder="Role for this show"
                  maxLength={120}
                  className={FORM_CONTROL}
                />
                <button
                  type="button"
                  aria-label="Remove person"
                  disabled={rows.length === 1}
                  onClick={() =>
                    setRows((current) =>
                      current.filter((_, rowIndex) => rowIndex !== index),
                    )
                  }
                  className="grid place-items-center rounded-lg border border-board-border text-board-muted hover:text-red-300 disabled:opacity-30"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
                {person && !person.email ? (
                  <p className="col-span-3 text-[10px] text-red-300">
                    Add an email address to {person.name} before inviting them.
                  </p>
                ) : null}
              </div>
            );
          })}
          <button
            type="button"
            onClick={() =>
              setRows((current) => [...current, { crewId: "", role: "" }])
            }
            className="flex items-center gap-2 rounded-lg border border-dashed border-board-border px-3 py-2 text-xs text-fire-400 hover:bg-board-card"
          >
            <Plus className="h-3.5 w-3.5" />
            Add another person
          </button>
        </div>

        <button
          disabled={
            busy ||
            !category.trim() ||
            validRows.length === 0 ||
            validRows.some(
              (row) => !crew.find((person) => person.id === row.crewId)?.email,
            )
          }
          className="w-full rounded-xl bg-fire-500 px-4 py-2.5 text-sm font-semibold text-black disabled:opacity-50"
        >
          {busy
            ? "Creating team…"
            : `Create ${category.trim() || "team"} & send ${validRows.length} invitation${validRows.length === 1 ? "" : "s"}`}
        </button>
      </form>
    </Modal>
  );
}

function AssignmentModal({
  orgId,
  serviceDate,
  departments,
  initialDepartment,
  crew,
  onClose,
  onSaved,
}: {
  orgId: string;
  serviceDate: string;
  departments: string[];
  initialDepartment: string;
  crew: Array<{ id: string; name: string; role: string; email: string }>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [role, setRole] = useState("");
  const [department, setDepartment] = useState(initialDepartment);
  const [crewId, setCrewId] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const selectedCrew = crew.find((person) => person.id === crewId);
  return (
    <Modal title="Add position" onClose={onClose}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          try {
            await saveServiceAssignment({
              data: {
                orgId,
                serviceDate,
                role,
                department,
                crewMemberId: crewId || null,
                status: "assigned",
                notes,
              },
            });
            onSaved();
          } finally {
            setBusy(false);
          }
        }}
        className="space-y-4"
      >
        <Field label="Position">
          <input
            value={role}
            onChange={(event) => setRole(event.target.value)}
            placeholder="Camera Operator"
            className={FORM_CONTROL}
          />
        </Field>
        <Field label="Department">
          <input
            list="schedule-department-options"
            value={department}
            onChange={(event) => setDepartment(event.target.value)}
            placeholder="Technical"
            maxLength={80}
            className={FORM_CONTROL}
          />
          <datalist id="schedule-department-options">
            {departments.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </datalist>
        </Field>
        <Field label="Roster contact">
          <select
            value={crewId}
            onChange={(event) => setCrewId(event.target.value)}
            className={FORM_CONTROL}
          >
            <option value="">Leave position open</option>
            {crew.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name} · {person.role}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Manager note (optional)">
          <textarea
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            rows={3}
            maxLength={500}
            placeholder="Call time, arrival instructions or preparation notes"
            className={FORM_CONTROL}
          />
        </Field>
        {selectedCrew ? (
          <div
            className={`rounded-lg border px-3 py-2.5 text-[11px] leading-relaxed ${selectedCrew.email ? "border-green-500/20 bg-green-500/[0.05] text-board-muted" : "border-red-500/20 bg-red-500/[0.05] text-red-300"}`}
          >
            {selectedCrew.email
              ? `A secure response link will be emailed to ${selectedCrew.email}. No account needed.`
              : "This roster contact has no email address. Add one before sending a request."}
          </div>
        ) : null}
        <button
          disabled={
            busy ||
            !role.trim() ||
            !department.trim() ||
            (Boolean(crewId) && !selectedCrew?.email)
          }
          className="w-full rounded-xl bg-fire-500 px-4 py-2.5 text-sm font-semibold text-black disabled:opacity-50"
        >
          {busy
            ? "Scheduling…"
            : crewId
              ? "Add position & send invitation"
              : "Add open position"}
        </button>
      </form>
    </Modal>
  );
}
function EditAssignmentModal({
  orgId,
  assignment,
  departments,
  crew,
  confirm,
  onClose,
  onSaved,
}: {
  orgId: string;
  assignment: Assignment;
  departments: string[];
  crew: Array<{ id: string; name: string; role: string; email: string }>;
  confirm: ReturnType<typeof useConfirmDialog>["confirm"];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [role, setRole] = useState(assignment.role);
  const [department, setDepartment] = useState(
    assignment.department || inferredDepartment(assignment.role),
  );
  const [crewId, setCrewId] = useState(assignment.crewMemberId ?? "");
  const [notes, setNotes] = useState(assignment.notes);
  const [busy, setBusy] = useState(false);
  const selectedCrew = crew.find((person) => person.id === crewId);
  const personChanged = crewId !== (assignment.crewMemberId ?? "");
  const submit = async () => {
    if (personChanged && assignment.status === "confirmed") {
      const approved = await confirm({
        title: crewId
          ? "Replace confirmed crew member?"
          : "Make confirmed position open?",
        description: `${assignment.crewMember?.name ?? "This person"} has already accepted ${assignment.role}. Their confirmation will be cleared.`,
        confirmLabel: crewId ? "Replace person" : "Make open",
      });
      if (!approved) return;
    }
    setBusy(true);
    try {
      await saveServiceAssignment({
        data: {
          orgId,
          id: assignment.id,
          serviceDate: assignment.serviceDate,
          role,
          department,
          crewMemberId: crewId || null,
          status: assignment.status as "assigned" | "confirmed" | "declined",
          notes,
        },
      });
      onSaved();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Edit assignment" onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        className="space-y-4"
      >
        <div className="rounded-lg border border-board-border bg-board-bg/50 px-3 py-2.5">
          <p className="text-[10px] uppercase tracking-wider text-board-muted">
            Current response
          </p>
          <p
            className={`mt-1 text-xs font-medium capitalize ${assignment.status === "confirmed" ? "text-green-400" : assignment.status === "declined" ? "text-red-400" : "text-yellow-300"}`}
          >
            {assignment.crewMemberId
              ? assignment.status === "assigned"
                ? "Awaiting response"
                : assignment.status
              : "Open position"}
          </p>
          {assignment.responseNote ? (
            <div className="mt-2 border-t border-board-border pt-2">
              <p className="text-[10px] uppercase tracking-wider text-board-muted">Crew response note</p>
              <p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-board-text">{assignment.responseNote}</p>
              {assignment.respondedAt ? <p className="mt-1 text-[10px] text-board-muted">Responded {new Date(assignment.respondedAt).toLocaleString()}</p> : null}
            </div>
          ) : null}
        </div>
        <Field label="Position">
          <input
            value={role}
            onChange={(event) => setRole(event.target.value)}
            className={FORM_CONTROL}
          />
        </Field>
        <Field label="Department">
          <select
            value={department}
            onChange={(event) => setDepartment(event.target.value)}
            className={FORM_CONTROL}
          >
            {departments.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Assigned roster contact">
          <select
            value={crewId}
            onChange={(event) => setCrewId(event.target.value)}
            className={FORM_CONTROL}
          >
            <option value="">Open position — nobody assigned</option>
            {crew.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name} · {person.role}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Manager note">
          <textarea
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            rows={3}
            maxLength={500}
            className={FORM_CONTROL}
          />
        </Field>
        {personChanged ? (
          <div
            className={`rounded-lg border px-3 py-2.5 text-[11px] leading-relaxed ${!crewId || selectedCrew?.email ? "border-fire-500/20 bg-fire-500/[0.05] text-board-muted" : "border-red-500/20 bg-red-500/[0.05] text-red-300"}`}
          >
            {!crewId
              ? "The position will remain on the schedule as open. The previous person will no longer see this assignment."
              : selectedCrew?.email
                ? `This resets the response to Awaiting and sends ${selectedCrew.name} a new secure invitation.`
                : "This roster contact needs an email address before they can be assigned."}
          </div>
        ) : (
          <p className="text-[11px] leading-relaxed text-board-muted">
            Changing only the position or note preserves the existing response.
          </p>
        )}
        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-board-border px-4 py-2.5 text-sm text-board-text"
          >
            Cancel
          </button>
          <button
            disabled={
              busy || !role.trim() || (Boolean(crewId) && !selectedCrew?.email)
            }
            className="rounded-xl bg-fire-500 px-4 py-2.5 text-sm font-semibold text-black disabled:opacity-50"
          >
            {busy
              ? "Saving…"
              : personChanged && crewId
                ? "Save and send request"
                : "Save changes"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
function ProviderModal({
  orgId,
  current,
  onClose,
  onSaved,
}: {
  orgId: string;
  current: {
    type: ScheduleProvider;
    url: string;
    label: string;
    terminologyProfile: OrgTerminologyProfile;
  };
  onClose: () => void;
  onSaved: () => void;
}) {
  const [provider, setProvider] = useState<ScheduleProvider>(current.type);
  const [url, setUrl] = useState(current.url);
  const [label, setLabel] = useState(current.label);
  const [terminologyProfile, setTerminologyProfile] = useState(
    current.terminologyProfile,
  );
  const [busy, setBusy] = useState(false);
  const external = provider !== "native";
  return (
    <Modal title="Scheduling source" onClose={onClose}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          try {
            await saveScheduleProvider({
              data: {
                orgId,
                provider,
                url: external ? url : "",
                label: provider === "other" ? label : "",
                terminologyProfile,
              },
            });
            onSaved();
          } finally {
            setBusy(false);
          }
        }}
        className="space-y-4"
      >
        <Field label="Source">
          <select
            value={provider}
            onChange={(event) =>
              setProvider(event.target.value as ScheduleProvider)
            }
            className={FORM_CONTROL}
          >
            <option value="native">ShowPilot native</option>
            <option value="planning-center">Planning Center</option>
            <option value="faithteams">Faith Teams</option>
            <option value="other">Another platform</option>
          </select>
        </Field>
        <Field label="Organization language">
          <select
            value={terminologyProfile}
            onChange={(event) =>
              setTerminologyProfile(event.target.value as OrgTerminologyProfile)
            }
            className={FORM_CONTROL}
          >
            <option value="general">
              General production — shows and assignments
            </option>
            <option value="church">
              Church production — services and serving
            </option>
          </select>
        </Field>
        {provider === "other" ? (
          <Field label="Platform name">
            <input
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              className={FORM_CONTROL}
            />
          </Field>
        ) : null}
        {external ? (
          <Field label="Scheduling workspace URL">
            <input
              type="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              className={FORM_CONTROL}
            />
          </Field>
        ) : (
          <p className="rounded-lg border border-board-border bg-board-bg p-3 text-xs leading-relaxed text-board-muted">
            ShowPilot will send secure accountless invitations to roster
            contacts by email.
          </p>
        )}
        <button
          disabled={busy || (external && !url)}
          className="w-full rounded-xl bg-fire-500 px-4 py-2.5 text-sm font-semibold text-black disabled:opacity-50"
        >
          Save source
        </button>
      </form>
    </Modal>
  );
}
function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-md"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="w-full max-w-md rounded-2xl border border-board-border bg-board-card p-5 shadow-2xl"
      >
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-base font-semibold text-board-text">{title}</h2>
          <button
            onClick={onClose}
            className="rounded-lg p-2 text-board-muted hover:bg-board-border"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block text-xs text-board-muted">
      <span className="mb-1.5 block">{label}</span>
      {children}
    </label>
  );
}
