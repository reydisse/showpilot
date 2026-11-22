import { plainFailure } from "@showpilot/shared/ui-feedback";
import { QuietActivity } from "@/components/ui/QuietActivity";
import { ProPresenterOutputControl } from "@/components/rundown/ProPresenterOutputControl";
import { ProPresenterSlideControls } from "@/components/rundown/ProPresenterSlideControls";
import { runRouteLoad } from "@/lib/route-load-deadlines";
import { VirtualRows } from "@/components/ui/virtual-rows";
import { RundownOffset, RundownProgress, formatOperatorDuration as formatDuration } from "@/components/rundown/RundownClock";
import { useProPresenterCommands } from "@/hooks/useProPresenterCommands";
import { useOperatorRead } from "@/hooks/useOperatorRead";
import { ReadFailureNotice } from "@/components/layout/ReadFailureNotice";
import { Button } from "@/components/ui/button";
import { ResetRundownDialog } from "@/components/rundown/ResetRundownDialog";
import { SaveRundownModal } from "@/components/rundown/SaveRundownModal";
import { LoadRundownModal } from "@/components/rundown/LoadRundownModal";
import { restoreRundownItem } from "@/lib/rundown-undo";
import { rundownShortcut } from "@/lib/rundown-shortcuts";
import { RundownShortcutList } from "@/components/rundown/RundownShortcutHelp";
import { RUNDOWN_SHORTCUTS } from "@/lib/rundown-shortcuts";
import { Kbd, KeyCombo, Panel, RundownTimerCard, TakeLiveDialog, Toggle, WallClock, eyebrow, projectRundown, rundownButton, runningLabel, useCoarseNow, RundownSkeleton } from "@/components/rundown/rundown-a";
import { dayTime, minutesClock as formatMinutes } from "@/components/show/show-flow-a";
import { workspaceCopy } from "@showpilot/shared";
import { useTerms as useWorkspaceTerms } from "@/components/workspace/WorkspaceProvider";
import { useDeviceTimeZone } from "@/hooks/useDeviceTimeZone";
import { useShowEndConfirmation } from "@/hooks/useShowEndConfirmation";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { PageSkeleton } from "@/components/ui/Skeleton";
import { nextPlayableItem } from "@/lib/rundown-transport";
import { useState, useEffect, useCallback, useRef, useId } from "react";
import {
  Play,
  Pause,
  Square,
  SkipForward,
  SkipBack,
  Plus,
  Minus,
  Pencil,
  Trash2,
  ChevronUp,
  ChevronDown,
  GripVertical,
  Music,
  Heart,
  Megaphone,
  Gift,
  Layers,
  RotateCcw,
  Send,
  Copy,
  Check,
  MessageSquare,
  X,
  Monitor,
  FolderOpen,
  Save,
  CalendarDays,
  Tv,
  Download,
  MoreHorizontal,
  Keyboard,
  List as ListIcon,
  Timer,
  Eye,
  Lock,
} from "lucide-react";
import {
  getRundownEditAccess,
  getRundownState,
  saveRundownItems,
  saveRundownMeta,
  setActiveServiceDate,
  getRundownOpeningDate,
} from "@/lib/rundown";
import type {
  PPSlidePayload,
} from "@/lib/rundown";
import { exportShowReport } from "@/lib/report";
import { rundownItemNumbers } from "@/types/rundown";
import { hasEffectivePermission } from "@/lib/app-permissions";
import { computeCascadedTimes } from "@/lib/rundown-timing";
import {
  exportRundownCsv,
  exportRundownPdf,
  type ExportReport,
} from "@/lib/rundown-export";
import {
  formatTimeInput,
  formatWallTime,
  getTodayDateString,
  serviceTimeToIso,
  editServiceTimeToIso,
} from "@/lib/utils";
import { RundownUnlock } from "@/components/rundown/RundownUnlock";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ModalA, modalCancel, modalPrimary } from "@/components/schedule/modal-a";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useProPresenter } from "@/hooks/useProPresenter";
import { getOrgSettings, getProPresenterConfiguration } from "@/lib/settings";
import { useRundownSync } from "@/hooks/useRundownSync";
import { waitForRundownWrites } from "@/lib/rundown-selection";
import { createBrowserId } from "@/lib/browser-id";
import { useRundownDragReorder } from "@/hooks/useRundownDragReorder";
import { useServiceDateRollover } from "@/hooks/useServiceDateRollover";
import { cacheDesktopService, isDesktopRuntime } from "@/lib/desktop-runtime";
import {
  NewShowModal,
} from "@/components/rundown/NewShowModal";
import { ShowOptionsModal } from "@/components/rundown/ShowOptionsModal";
import { getServiceTiming, readPhaseSettings } from "@/lib/service-phase";
import { ACTIVE_RUNDOWN_CHANGED_EVENT } from "@/components/layout/LiveRundownBar";
import { decodeStageMessage, encodeStageMessage } from "@showpilot/shared";

type ItemType =
  | "segment"
  | "song"
  | "prayer"
  | "announcement"
  | "offering"
  | "custom"
  | "header";
type ItemStatus = "upcoming" | "live" | "complete";

interface RundownItem {
  id: string;
  title: string;
  type: ItemType;
  duration: number;
  notes: string;
  assignee: string;
  cue: string;
  status: ItemStatus;
  sortOrder: number;
  hardStop: boolean;
  actualStart?: string | null;
  actualEnd?: string | null;
  scheduledStart?: string | null;
  expectedEnd?: string | null;
}

const TYPE_CONFIG: Record<
  ItemType,
  { label: string; icon: React.ElementType; color: string }
> = {
  header: {
    label: "Section",
    icon: Layers,
    color: "bg-board-border text-board-muted border-board-border",
  },
  segment: {
    label: "Segment",
    icon: Layers,
    color: "bg-blue-500/15 text-blue-400 border-blue-500/25",
  },
  song: {
    label: "Song",
    icon: Music,
    color: "bg-purple-500/15 text-purple-400 border-purple-500/25",
  },
  prayer: {
    label: "Prayer",
    icon: Heart,
    color: "bg-pink-500/15 text-pink-400 border-pink-500/25",
  },
  announcement: {
    label: "Announce",
    icon: Megaphone,
    color: "bg-yellow-500/15 text-yellow-400 border-yellow-500/25",
  },
  offering: {
    label: "Offering",
    icon: Gift,
    color: "bg-green-500/15 text-green-400 border-green-500/25",
  },
  custom: {
    label: "Custom",
    icon: Layers,
    color: "bg-board-border text-board-muted border-board-border",
  },
};

/** Parse duration for item creation — bare number = minutes (e.g. "5" → 5 min) */
function parseDurationInput(str: string): number {
  const trimmed = str.trim();
  if (!trimmed) return 300000;
  const parts = trimmed.split(":").map(Number);
  if (parts.length === 3 && parts.every((n) => !isNaN(n)))
    return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
  if (parts.length === 2 && parts.every((n) => !isNaN(n)))
    return (parts[0] * 60 + parts[1]) * 1000;
  if (parts.length === 1 && !isNaN(parts[0])) return parts[0] * 60 * 1000;
  return 300000;
}

/** Parse time adjustment — bare number = seconds (e.g. "30" → 30s), colon = m:ss */
function parseAdjustInput(str: string): number {
  const trimmed = str.trim();
  if (!trimmed) return 0;
  const parts = trimmed.split(":").map(Number);
  if (parts.length === 2 && parts.every((n) => !isNaN(n)))
    return (parts[0] * 60 + parts[1]) * 1000;
  if (parts.length === 1 && !isNaN(parts[0])) return parts[0] * 1000;
  return 0;
}

function shiftDate(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T12:00:00");
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatDisplayDate(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

const rundownRowKey = (item: RundownItem) => item.id;
const transportBase = "inline-flex h-12 min-w-0 items-center justify-center gap-2 whitespace-nowrap rounded-xl border px-3 text-sm disabled:opacity-40 sm:px-4 [&_svg]:shrink-0";
const transportButton = `${transportBase} border-[var(--sa-border-strong)] bg-[var(--sa-surface-2)] font-medium text-board-text hover:bg-[var(--sa-surface-3)]`;
const transportGo = `${transportBase} border-transparent bg-[var(--sa-ok)] font-semibold text-[#04140c] hover:brightness-110`;
const transportPause = `${transportBase} border-fire-500/40 bg-fire-500/[0.08] font-medium text-fire-400 hover:bg-fire-500/15`;
const transportEnd = `${transportBase} border-[var(--sa-danger)]/30 bg-[var(--sa-danger)]/[0.08] font-medium text-[var(--sa-danger)] hover:bg-[var(--sa-danger)]/15`;
const rowIconButton = "inline-flex h-11 w-11 items-center justify-center rounded-lg text-[var(--sa-ink-3)] hover:bg-[var(--sa-surface-3)] hover:text-board-text disabled:opacity-30 lg:h-8 lg:w-8";
const estimateRundownRow = () => 100;
function rundownScrollParent(body: HTMLElement) {
  // Side by side the runsheet scrolls on its own; stacked, the whole page scrolls.
  for (let node = body.parentElement; node; node = node.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(node).overflowY)) return node;
    if (node.classList.contains("rundown-page")) return node;
  }
  return null;
}

export const Route = createFileRoute("/$slug/rundown")({
  validateSearch: (
    search: Record<string, unknown>,
  ): {
    show?: string;
    date?: string;
  } => ({
    show: typeof search.show === "string" ? search.show : undefined,
    date: typeof search.date === "string" ? search.date : undefined,
  }),
  loaderDeps: ({ search }) => ({
    showId: search.show,
    serviceDate: search.date,
  }),
  pendingComponent: () => <PageSkeleton />,
  loader: async ({ context, deps }) => {
    const { withPermission } = await import("@/lib/route-permissions");
    await withPermission(
      context.role,
      "rundown:view",
      context.slug,
      context.orgId,
    );
    const settings = await getOrgSettings({ data: { orgId: context.orgId } });
    const orgTimeZone = settings["org-timezone"] || "UTC";
    const resolvedSettings: Record<string, string> = {
      ...settings,
      "org-timezone": orgTimeZone,
    };
    const today = getTodayDateString(orgTimeZone);
    // Open on a service that exists rather than blindly on today. A
    // church has no service most days, so "today" meant the editor
    // opened empty six days a week — and once the cue sheet started
    // following the editor, that emptiness spread to it as well.
    const opening = await getRundownOpeningDate({
      data: {
        orgId: context.orgId,
        today,
        serviceDate: deps.serviceDate,
        showId: deps.showId,
      },
    });
    const openOn = opening.serviceDate;
    const openShowId = opening.showId;
    const rundownAccess = await getRundownEditAccess({ data: { orgId: context.orgId } });
    const state = await getRundownState({
      data: {
        orgId: context.orgId,
        serviceDate: openOn,
        showId: openShowId,
      },
    });
    return {
      orgId: context.orgId,
      slug: context.slug,
      today,
      openOn,
      initialState: state,
      rundownAccess,
      activeTarget: {
        serviceDate: opening.activeServiceDate,
        showId: opening.activeShowId,
      },
      settings: resolvedSettings,
      role: context.role,
      grantedPermissions: context.grantedPermissions,
      shows: opening.shows,
      initialNow: Date.now(),
    };
  },
  component: RundownPage,
});


function RundownPage() {
  const { user } = Route.useRouteContext();
  const workspaceTerms = useWorkspaceTerms();
  const {
    orgId,
    slug,
    openOn,
    initialState,
    rundownAccess,    activeTarget,
    settings,
    role,
    grantedPermissions,
    shows,
    initialNow,
  } = Route.useLoaderData();
  const deviceTimeZone = useDeviceTimeZone();
  const navigate = useNavigate({ from: Route.fullPath });
  const canEditRundown = rundownAccess.canEdit;
  const canControlRundown = rundownAccess.canControl;
  const canCreateShow = hasEffectivePermission(
    role,
    grantedPermissions,
    "schedule:manage",
  );
  const [target, setTarget] = useState<{
    serviceDate: string;
    showId?: string;
  }>(() => ({
    serviceDate: openOn,
    showId: initialState.meta?.showId,
  }));
  const { serviceDate, showId } = target;
  const activePublishInFlightRef = useRef(false);
  const [activePublishPending, setActivePublishPending] = useState(false);
  const [liveTarget, setLiveTarget] = useState(activeTarget);
  const [showTakeLiveConfirmation, setShowTakeLiveConfirmation] =
    useState(false);
  const publishTarget = useCallback(
    async (date: string, targetShowId?: string) => {
      activePublishInFlightRef.current = true;
      setActivePublishPending(true);
      try {
        const activated = await setActiveServiceDate({
          data: { orgId, serviceDate: date, showId: targetShowId },
        });
        setLiveTarget(activated);
        window.dispatchEvent(new Event(ACTIVE_RUNDOWN_CHANGED_EVENT));
      } finally {
        activePublishInFlightRef.current = false;
        setActivePublishPending(false);
      }
    },
    [orgId],
  );
  const showCreationRef = useRef<{
    date: string;
    promise: Promise<string>;
  } | null>(null);
  const ensureShowId = useCallback(async () => {
    if (showId) return showId;
    if (showCreationRef.current?.date === serviceDate)
      return showCreationRef.current.promise;
    const promise = saveRundownMeta({ data: { orgId, serviceDate } })
      .then((result) => result.showId)
      .catch((error) => {
        if (showCreationRef.current?.date === serviceDate)
          showCreationRef.current = null;
        throw error;
      });
    showCreationRef.current = { date: serviceDate, promise };
    return promise;
  }, [orgId, serviceDate, showId]);
  const adoptShowId = useCallback(
    async (nextShowId: string) => {
      setTarget({ serviceDate, showId: nextShowId });
      await navigate({
        search: { show: nextShowId, date: serviceDate },
        replace: true,
      });
    },
    [navigate, serviceDate],
  );
  const defaultCountdownMinutes =
    Number(settings["default-countdown-minutes"] || "5") || 5;
  const defaultItemDuration = `${defaultCountdownMinutes}:00`;
  const defaultTimerModeSetting = settings["default-timer-mode"] || "countdown";
  const overtimeBehavior = settings["overtime-behavior"] || "flash";
  const defaultTimerMode =
    defaultTimerModeSetting === "countup"
      ? "count-up"
      : defaultTimerModeSetting === "clock"
        ? "clock"
        : "count-down";

  // Real-time sync via RundownRelay Durable Object
  const {
    items: syncedItems,
    timer: syncedTimer,
    hydrated: syncHydrated,
    stateServiceDate: syncedServiceDate,
    stateShowId: syncedShowId,
    serviceName: syncedServiceName,
    scheduledStartTime: syncedScheduledStartTime,
    scheduledCallTime: syncedScheduledCallTime,
    stateInitialized: syncedInitialized,
    revision: cloudRevision,
    ppPreviewSlide: syncedPpSlide,
    stageMessage: syncedStageMessage,
    lastError: syncError,

    retryConnection: reconnectRundown,
    saving: syncSaving,
    connected: syncConnected,
    unconfirmedCount,
    hasPendingCommands,
    sendCommand,
    seedState,
  } = useRundownSync(orgId, serviceDate, showId);
  const [dismissedSwitch, setDismissedSwitch] = useState<string | null>(null);
  const switchScope = JSON.stringify([showId, serviceDate, syncedShowId, syncedServiceDate]);
  const transportAvailable = canControlRundown && syncConnected && syncedServiceDate === serviceDate && (!showId || syncedShowId === showId);
  const relayMatchesTarget =
    syncedServiceDate === serviceDate && (!showId || syncedShowId === showId);

  // Local state — source of truth for rendering
  const [items, setItems] = useState<RundownItem[]>(
    initialState.items as RundownItem[],
  );
  /** Non-null when the last auto-save failed. Shown, not logged. */
  const [saveError, setSaveError] = useState<string | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);

  const [timer, setTimer] = useState<{
    playback: "stop" | "play" | "pause";
    currentItemId: string | null;
    elapsed: number;
    startedAt: number | null;
    mode: "count-down" | "count-up" | "clock";
  }>({
    playback: initialState.timer.playback,
    currentItemId: initialState.timer.currentItemId,
    elapsed: initialState.timer.elapsed,
    startedAt: initialState.timer.startedAt,
    mode: initialState.timer.mode,
  });
  const [scheduledStartIso, setScheduledStartIso] = useState<string | null>(initialState.meta?.scheduledStartTime ?? null);
  const [scheduledCallIso, setScheduledCallIso] = useState<string | null>(initialState.meta?.scheduledCallTime ?? null);
  const scheduledStartTime = formatTimeInput(scheduledStartIso, deviceTimeZone);
  const scheduledCallTime = formatTimeInput(scheduledCallIso, deviceTimeZone);
  const [serviceName, setServiceName] = useState<string>(
    initialState.meta?.name ?? "",
  );
  const saveNameTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingMetaFieldsRef = useRef(new Set<"name" | "time" | "call">());
  const [metaSavePending, setMetaSavePending] = useState(false);

  const setMetaFieldPending = useCallback(
    (field: "name" | "time" | "call", pending: boolean) => {
      if (pending) pendingMetaFieldsRef.current.add(field);
      else pendingMetaFieldsRef.current.delete(field);
      setMetaSavePending(pendingMetaFieldsRef.current.size > 0);
    },
    [],
  );

  // Immutable D1 snapshot for reconciling a Durable Object that survived
  // a deploy with rows from a different service under this date label.
  const databaseItemsRef = useRef(initialState.items as RundownItem[]);

  // Seed DO when we first connect and it's empty — push current items to DO
  // so all other devices get them via broadcast.
  // IMPORTANT: wait for hydrated=true so we know the DO has actually responded,
  // not just that the WS connected (syncedItems would still be [] before hydrate).
  const hasSeededRef = useRef(false);
  // Track which date we last seeded for — reset when date changes
  const seededDateRef = useRef(showId ?? serviceDate);
  useEffect(() => {
    const identity = showId ?? serviceDate;
    if (seededDateRef.current !== identity) {
      hasSeededRef.current = false;
      seededDateRef.current = identity;
    }
  }, [serviceDate, showId]);
  useEffect(() => {
    if (!syncHydrated) return; // Wait for actual DO response
    if (hasSeededRef.current) return; // Only seed once per date
    const databaseItems = databaseItemsRef.current;
    const sameRoom =
      syncedServiceDate === serviceDate && (!showId || syncedShowId === showId);
    // The relay wins whenever it already has state. A joining operator's D1
    // loader can be a fraction behind a live edit; forcing that snapshot into
    // the room is exactly how a second operator used to roll the show back.
    if (sameRoom && !syncedInitialized) {
      hasSeededRef.current = true;
      seedState(
        databaseItems,
        {
          playback: timer.playback,
          currentItemId: timer.currentItemId,
          elapsed: timer.elapsed,
          startedAt: timer.startedAt,
          pausedAt: null,
          mode: timer.mode,
        },
        false,
        {
          serviceName,
          scheduledStartTime: scheduledStartIso,
          scheduledCallTime: scheduledCallIso,
        },
      );
    } else if (sameRoom && syncedInitialized) {
      hasSeededRef.current = true;
    }
  }, [
    scheduledCallIso,
    scheduledStartIso,
    seedState,
    serviceDate,
    serviceName,
    settings,
    deviceTimeZone,
    showId,
    syncHydrated,
    syncedInitialized,
    syncedServiceDate,
    syncedShowId,
    timer,
  ]);

  // Shared with the dashboard header — see components/ui/scroll-edges.

  useEffect(() => {
    if (!relayMatchesTarget || syncSaving || metaSavePending) return;
    if (syncedServiceName !== null) setServiceName(syncedServiceName);
    if (syncedScheduledStartTime !== undefined) {
      setScheduledStartIso(syncedScheduledStartTime);
    }
    if (syncedScheduledCallTime !== undefined) {
      setScheduledCallIso(syncedScheduledCallTime);
    }
  }, [
    relayMatchesTarget,
    syncSaving,
    metaSavePending,
    settings,
    deviceTimeZone,
    syncedScheduledCallTime,
    syncedScheduledStartTime,
    syncedServiceName,
  ]);

  // The web app remains the source of truth. Desktop keeps a bounded local
  // snapshot after edits so the native engine can grow an offline bootstrap
  // without creating a second rundown implementation.
  useEffect(() => {
    if (!isDesktopRuntime()) return;
    const timeout = window.setTimeout(() => {
      void cacheDesktopService({
        version: 1,
        orgId,
        orgSlug: slug,
        serviceDate,
        serviceName,
        scheduledStartTime,
        items,
        timer,
        cachedAt: new Date().toISOString(),
      }).catch((cause) => {
        console.warn("[SP] Desktop snapshot failed", cause);
      });
    }, 500);
    return () => window.clearTimeout(timeout);
  }, [items, orgId, scheduledStartTime, serviceDate, serviceName, slug, timer]);

  const handleServiceNameChange = useCallback(
    (value: string) => {
      setServiceName(value);
      setSaveError(null);
      if (saveNameTimeoutRef.current) clearTimeout(saveNameTimeoutRef.current);
      setMetaFieldPending("name", true);
      saveNameTimeoutRef.current = setTimeout(() => {
        if (showId) {
          setMetaFieldPending("name", false);
          sendCommand("update-meta", { serviceName: value });
          return;
        }
        void ensureShowId()
          .then(async (targetShowId) => {
            await saveRundownMeta({
              data: { orgId, showId: targetShowId, serviceDate, name: value },
            });
            if (!showId) await adoptShowId(targetShowId);
          })
          .catch((error: unknown) =>
            setSaveError(
              error instanceof Error
                ? error.message
                : workspaceCopy("Service title did not save", workspaceTerms),
            ),
          )
          .finally(() => setMetaFieldPending("name", false));
      }, 800);
    },
    [
      adoptShowId,
      ensureShowId,
      orgId,
      sendCommand,
      serviceDate,
      setMetaFieldPending,
      showId,
    ],
  );

  const handleScheduledStartChange = useCallback(
    (timeStr: string) => {
      setSaveError(null);
      let isoTime: string | null;
      try {
        isoTime = editServiceTimeToIso({ serviceDate, time: timeStr, timeZone: deviceTimeZone, referenceTime: scheduledStartIso });
      } catch (error) {
        setSaveError(
          error instanceof Error
            ? error.message
            : workspaceCopy("Service time is invalid", workspaceTerms),
        );
        return;
      }
      setScheduledStartIso(isoTime);
      setMetaFieldPending("time", true);
      if (showId) {
        sendCommand("update-meta", { scheduledStartTime: isoTime });
        setMetaFieldPending("time", false);
        return;
      }
      void ensureShowId()
        .then(async (targetShowId) => {
          await saveRundownMeta({
            data: {
              orgId,
              showId: targetShowId,
              serviceDate,
              scheduledStartTime: isoTime,
            },
          });
          if (!showId) await adoptShowId(targetShowId);
        })
        .catch((error: unknown) =>
          setSaveError(
            error instanceof Error
              ? error.message
              : workspaceCopy("Service time did not save", workspaceTerms),
          ),
        )
        .finally(() => setMetaFieldPending("time", false));
    },
    [
      adoptShowId,
      ensureShowId,
      orgId,
      sendCommand,
      serviceDate,
      setMetaFieldPending,
      settings,
      deviceTimeZone,
      scheduledStartIso,
      showId,
    ],
  );

  const handleScheduledCallChange = useCallback(
    (timeStr: string) => {
      setSaveError(null);
      let isoTime: string | null;
      try {
        isoTime = editServiceTimeToIso({ serviceDate, time: timeStr, timeZone: deviceTimeZone, referenceTime: scheduledCallIso ?? scheduledStartIso });
      } catch (error) {
        setSaveError(error instanceof Error ? error.message : "Crew call is invalid");
        return;
      }
      setScheduledCallIso(isoTime);
      setMetaFieldPending("call", true);
      if (showId) {
        setMetaFieldPending("call", false);
        sendCommand("update-meta", { scheduledCallTime: isoTime });
        return;
      }
      void ensureShowId()
        .then(async (targetShowId) => {
          await saveRundownMeta({
            data: {
              orgId,
              showId: targetShowId,
              serviceDate,
              scheduledCallTime: isoTime,
            },
          });
          if (!showId) await adoptShowId(targetShowId);
        })
        .catch((error: unknown) =>
          setSaveError(
            error instanceof Error ? error.message : "Crew call did not save",
          ),
        )
        .finally(() => setMetaFieldPending("call", false));
    },
    [
      adoptShowId,
      ensureShowId,
      orgId,
      sendCommand,
      serviceDate,
      setMetaFieldPending,
      settings,
      deviceTimeZone,
      scheduledStartIso,
      scheduledCallIso,
      showId,
    ],
  );

  useEffect(
    () => () => {
      if (saveNameTimeoutRef.current) clearTimeout(saveNameTimeoutRef.current);
      pendingMetaFieldsRef.current.clear();
      setMetaSavePending(false);
    },
    [serviceDate],
  );

  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const handleExport = useCallback(
    async (format: "csv" | "pdf") => {
      setExporting(true);
      setExportError(null);
      try {
        const report = await exportShowReport({
          data: { orgId, serviceDate, showId },
        });
        const exportReport: ExportReport = {
          ...report,
          rundown: {
            items: report.rundown.items,
            stageMessage: report.rundown.stageMessage,
            name: report.rundown.name,
            scheduledStartTime: report.rundown.scheduledStartTime,
          },
        };
        if (format === "csv") {
          exportRundownCsv(exportReport);
        } else {
          await exportRundownPdf(exportReport);
        }
      } catch (err) {
        setExportError(err instanceof Error ? err.message : "Export failed");
      }
      setExporting(false);
    },
    [orgId, serviceDate, showId],
  );

  const [showAddForm, setShowAddForm] = useState(false);
  const [editingItem, setEditingItem] = useState<RundownItem | null>(null);
  const [showLoadModal, setShowLoadModal] = useState(false);
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showOptionsModal, setShowOptionsModal] = useState(false);
  const [message, setMessage] = useState("");
  const [messagePriority, setMessagePriority] = useState(false);
  const [loading, setLoading] = useState(false);
  const selectionInFlightRef = useRef(false);

  const waitForCurrentRundownWrites = useCallback(async () => {
    await waitForRundownWrites(
      () =>
        pendingMetaFieldsRef.current.size > 0 ||
        hasPendingCommands() ||
        activePublishInFlightRef.current,
    );
  }, [hasPendingCommands]);

  // Sync: accept DO state as source of truth, but ONLY after hydration.
  // Skip during date loads — loadDate() sets items directly and we don't
  // want stale DO broadcasts to overwrite the freshly loaded date.
  const loadingRef = useRef(false);
  loadingRef.current = loading;
  useEffect(() => {
    if (!syncHydrated || !syncedInitialized) return;
    if (!relayMatchesTarget) return;
    if (loadingRef.current) return; // Date load in progress — don't overwrite

    setItems(syncedItems as RundownItem[]);
    setTimer({
      playback: syncedTimer.playback,
      currentItemId: syncedTimer.currentItemId,
      elapsed: syncedTimer.elapsed,
      startedAt: syncedTimer.startedAt,
      mode: syncedTimer.mode,
    });
  }, [
    relayMatchesTarget,
    syncHydrated,
    syncedInitialized,
    syncedItems,
    syncedTimer,
  ]);

  const [copiedUrl, setCopiedUrl] = useState(false);
  const [customAdjust, setCustomAdjust] = useState("1:00");
  const [ppEnabled, setPpEnabled] = useState(false);
  const ppConfiguration = useOperatorRead<Record<string, string>>({
    key: orgId, initialValue: {}, enabled: canControlRundown,
    read: useCallback(signal => getProPresenterConfiguration({ data: { orgId }, signal }), [orgId]),
    errorMessage: "ProPresenter configuration could not be loaded. Retry before using its controls.",
  });
  const ppHost = ppConfiguration.value["propresenter-host"] || "";
  const ppPort = parseInt(ppConfiguration.value["propresenter-port"] || "50001", 10);
  const ppApiPort = parseInt(ppConfiguration.value["propresenter-api-port"] || "0", 10);
  const ppCuesEnabled = ppConfiguration.value["propresenter-send-cues"] === "true";
  const [ppCurrentSlide, setPpCurrentSlide] = useState<PPSlidePayload | null>(
    null,
  );
  const timerRef = useRef(timer);
  const itemsRef = useRef(items);
  const relayNeedsPriming =
    syncHydrated &&
    !syncedInitialized &&
    syncedServiceDate === serviceDate &&
    (!showId || syncedShowId === showId);

  // The authenticated venue feed updates the local preview.
  const handlePPSlideChange = useCallback(
    (slide: import("@/lib/propresenter-client").PPSlideData | null) => {
      if (!slide || !slide.text) {
        setPpCurrentSlide(null);
        return;
      }
      const trimmedText = slide.text.trim();
      if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(trimmedText)) return;
      if (/^[\d:.\-\s]+$/.test(trimmedText)) return;
      if (trimmedText.length < 3) return;
      const payload: PPSlidePayload = {
        text: slide.text,
        slideId: slide.slideId,
        nextText: slide.nextText,
        nextSlideId: slide.nextSlideId,
        notes: slide.notes,
        presentationName: slide.presentationName,
        isScripture: slide.isScripture,
        updatedAt: Date.now(),
      };
      setPpCurrentSlide(payload);
    },
    [],
  );

  // Observe the venue Bridge feed without exposing device credentials.
  const pp = useProPresenter({
    orgId,
    host: ppHost,
    port: ppPort,
    enabled: ppEnabled,
    onSlideChange: handlePPSlideChange,
  });

  const ppCommandScope = JSON.stringify([user.id, orgId, serviceDate, showId, ppHost, ppPort, ppApiPort]);
  const ppCommands = useProPresenterCommands({
    orgId, userId: user.id, showId: showId ?? null, scope: ppCommandScope,
    canCheckSlides: canControlRundown,
    canControlSlides: canControlRundown && syncConnected && pp.isStreaming && ppCuesEnabled && !!ppApiPort,
  });
  const ppControlsBlocked = ppCommands.blocked;
  const handleProPresenterCommand = (command: "next" | "previous" | "clear") => ppCommands.run({ kind: "slide", command });

  // Prefer the freshest confirmed preview from the rundown or the venue feed.
  const bridgeSlideUpdatedAt = syncedPpSlide?.updatedAt ?? 0;
  const feedSlideUpdatedAt = ppCurrentSlide?.updatedAt ?? 0;
  const ppSource =
    bridgeSlideUpdatedAt >= feedSlideUpdatedAt && bridgeSlideUpdatedAt > 0
      ? "bridge"
      : feedSlideUpdatedAt > 0
        ? "feed"
        : null;
  const activePpSlide: PPSlidePayload | null =
    ppSource === "bridge"
      ? syncedPpSlide
      : ppSource === "feed"
        ? ppCurrentSlide
        : null;

  // A retained preview must not hide a reported transport failure.
  const ppIsConnected = pp.status === "connected" || (!ppEnabled && ppSource !== null);

  const togglePP = useCallback(() => {
    if (!canEditRundown && !canControlRundown) return;
    if (ppEnabled) {
      setPpEnabled(false);
      setPpCurrentSlide(null);
    } else {
      setPpEnabled(true);
    }
  }, [canEditRundown, canControlRundown, ppEnabled]);


  // Load rundown for new date
  const loadDate = async (date: string, targetShowId?: string, signal?: AbortSignal) => {
    if (selectionInFlightRef.current) return false;
    if (date === serviceDate && targetShowId === showId) return true;

    selectionInFlightRef.current = true;
    setLoading(true);
    setSelectionError(null);
    try {
      const state = await runRouteLoad(async controller => {
        await waitForCurrentRundownWrites();
        controller.signal.throwIfAborted();
        return getRundownState({data:{orgId,serviceDate:date,showId:targetShowId},signal:controller.signal});
      }, signal, 12000);
      signal?.throwIfAborted();
      const nextShowId = state.meta?.showId;
      databaseItemsRef.current = state.items as RundownItem[];
      setItems(state.items as RundownItem[]);
      setServiceName(state.meta?.name ?? "");
      setTimer({
        playback: state.timer.playback,
        currentItemId: state.timer.currentItemId,
        elapsed: state.timer.elapsed,
        startedAt: state.timer.startedAt,
        mode: state.timer.mode,
      });
      setScheduledStartIso(state.meta?.scheduledStartTime ?? null);
      setScheduledCallIso(state.meta?.scheduledCallTime ?? null);
      showCreationRef.current = null;
      setTarget({ serviceDate: date, showId: nextShowId });
      setSaveError(null);
      await navigate({
        search: { show: nextShowId, date },
        replace: true,
      });

      // The date-aware sync effect seeds only the newly selected relay.
      return true;
    } catch (error) {
      setSelectionError(
        error instanceof Error ? error.message : "Could not open that rundown",
      );
      return false;
    } finally {
      selectionInFlightRef.current = false;
      setLoading(false);
    }
  };

  const handleDateChange = (days: number) => {
    const newDate = shiftDate(serviceDate, days);
    void loadDate(newDate);
  };

  useServiceDateRollover({
    serviceDate,
    timeZone: settings["org-timezone"],
    onTodayChanged: (nextToday) => {
      void loadDate(nextToday);
    },
  });

  // Commands read the latest local state
  timerRef.current = timer;
  itemsRef.current = items;

  const sendRundownCommand = useCallback(
    (action: string, payload?: Record<string, unknown>) => {
      if (relayNeedsPriming) {
        hasSeededRef.current = true;
        sendCommand("seed", {
          items: itemsRef.current,
          timer: {
            playback: timerRef.current.playback,
            currentItemId: timerRef.current.currentItemId,
            elapsed: timerRef.current.elapsed,
            startedAt: timerRef.current.startedAt,
            pausedAt: timerRef.current.playback === "pause" ? Date.now() : null,
            mode: timerRef.current.mode,
          },
          serviceName,
          scheduledStartTime: scheduledStartIso,
          scheduledCallTime: scheduledCallIso,
        });
      }

      sendCommand(action, payload);
    },
    [
      relayNeedsPriming,
      scheduledCallIso,
      scheduledStartIso,
      sendCommand,
      serviceDate,
      serviceName,
      settings,
      deviceTimeZone,
    ],
  );

  const currentItem = items.find((i) => i.id === timer.currentItemId);

  const handleStart = useCallback(
    (itemId: string) => {
      if (!transportAvailable) return;
      const target = items.find((item) => item.id === itemId);
      if (!target || target.type === "header") return;
      // Optimistic local update
      setItems((prev) =>
        prev.map((i) =>
          i.status === "live"
            ? { ...i, status: "complete" as ItemStatus }
            : i.id === itemId
              ? { ...i, status: "live" as ItemStatus }
              : i,
        ),
      );
      const startNow = Date.now();
      setTimer({
        playback: "play",
        currentItemId: itemId,
        elapsed: 0,
        startedAt: startNow,
        mode: timer.mode,
      });
      // Sync to DO + persist to DB
      sendRundownCommand("timer-start", { itemId });
    },
    [transportAvailable, items, sendRundownCommand, timer.mode],
  );

  const handlePause = useCallback(() => {
    if (!transportAvailable) return;
    if (timer.playback === "play" && timer.startedAt) {
      const newElapsed = timer.elapsed + (Date.now() - timer.startedAt);
      setTimer({
        ...timer,
        playback: "pause",
        elapsed: newElapsed,
        startedAt: null,
      });
      sendRundownCommand("timer-pause");
    }
  }, [transportAvailable, timer, sendRundownCommand]);

  const handleResume = useCallback(() => {
    if (!transportAvailable) return;
    if (timer.playback === "pause") {
      const resumeNow = Date.now();
      setTimer({ ...timer, playback: "play", startedAt: resumeNow });
      sendRundownCommand("timer-resume");
    }
  }, [transportAvailable, timer, sendRundownCommand]);

  const stopConfirmed = useCallback(() => {
    if (!transportAvailable) return;
    setItems((prev) =>
      prev.map((i) =>
        i.id === timer.currentItemId
          ? { ...i, status: "complete" as ItemStatus }
          : i,
      ),
    );
    setTimer({
      playback: "stop",
      currentItemId: null,
      elapsed: 0,
      startedAt: null,
      mode: timer.mode,
    });
    sendRundownCommand("timer-stop");
  }, [transportAvailable, timer.currentItemId, timer.mode, sendRundownCommand]);

  const { requestEndShow, endShowDialog } = useShowEndConfirmation(
    { orgId, showId, serviceDate }, stopConfirmed,
    !transportAvailable ? "Reconnect to live state before ending this show."
      : timer.playback === "stop" ? "This show is already stopped." : undefined,
    (() => {
      const current = items.find((item) => item.id === timer.currentItemId);
      const left = items.filter((item) => item.type !== "header" && item.status !== "complete" && item.id !== timer.currentItemId).length;
      return `The timer stops${current ? ` on ${current.title || "the current item"}` : ""} and the run ends for everyone following ${serviceName || "this show"}.${left ? ` ${left} ${left === 1 ? "item hasn't" : "items haven't"} run yet.` : ""}`;
    })(),
  );

  const handleStop = useCallback(() => {
    if (!transportAvailable || timer.playback === "stop") return;
    requestEndShow();
  }, [transportAvailable, timer.playback, requestEndShow, stopConfirmed]);

  const handleNext = useCallback(() => {
    if (!transportAvailable) return;
    if (timer.playback !== "stop" && !nextPlayableItem(items, timer.currentItemId)) {
      requestEndShow();
      return;
    }
    // Local optimistic update
    const currentIdx = items.findIndex((i) => i.id === timer.currentItemId);
    if (currentIdx >= 0) {
      setItems((prev) =>
        prev.map((i, idx) =>
          idx === currentIdx ? { ...i, status: "complete" as ItemStatus } : i,
        ),
      );
    }
    const nextItem = nextPlayableItem(items, timer.currentItemId);
    if (nextItem) {
      setItems((prev) =>
        prev.map((i) =>
          i.id === nextItem.id ? { ...i, status: "live" as ItemStatus } : i,
        ),
      );
      const startNow = Date.now();
      setTimer({
        playback: "play",
        currentItemId: nextItem.id,
        elapsed: 0,
        startedAt: startNow,
        mode: timer.mode,
      });
    } else {
      setTimer({
        playback: "stop",
        currentItemId: null,
        elapsed: 0,
        startedAt: null,
        mode: timer.mode,
      });
    }
    // Single DO command — DO handles the advance logic
    sendRundownCommand("timer-next");
  }, [
    transportAvailable,
    items,
    timer.currentItemId,
    timer.mode,
    timer.playback,
    requestEndShow,
    stopConfirmed,
    sendRundownCommand,
  ]);

  const handlePrev = useCallback(() => {
    if (!transportAvailable) return;
    const currentIdx = items.findIndex((i) => i.id === timer.currentItemId);
    if (currentIdx > 0) {
      const prevItem = [...items.slice(0, currentIdx)]
        .reverse()
        .find((item) => item.type !== "header");
      if (!prevItem) return;
      // Local optimistic update — reset current to upcoming, start previous
      setItems((prev) =>
        prev.map((i, idx) =>
          idx === currentIdx
            ? { ...i, status: "upcoming" as ItemStatus }
            : i.id === prevItem.id
              ? { ...i, status: "live" as ItemStatus }
              : i,
        ),
      );
      const startNow = Date.now();
      setTimer({
        playback: "play",
        currentItemId: prevItem.id,
        elapsed: 0,
        startedAt: startNow,
        mode: timer.mode,
      });
      sendRundownCommand("timer-prev");
    }
  }, [
    transportAvailable,
    items,
    timer.currentItemId,
    timer.mode,
    sendRundownCommand,
  ]);

  const rundownScope = `${orgId}:${showId ?? serviceDate}`;
  const [resetScope, setResetScope] = useState<string | null>(null);
  const handleReset = useCallback(() => {
    if (!canEditRundown || timer.playback === "play") return;
    setResetScope(rundownScope);
  }, [canEditRundown, timer.playback, rundownScope]);
  const resetConfirmed = useCallback(() => {
    if (!canEditRundown || timer.playback === "play" || resetScope !== rundownScope) return;
    setItems((prev) =>
      prev.map((i) => ({
        ...i,
        status: "upcoming" as ItemStatus,
        actualStart: null,
        actualEnd: null,
      })),
    );
    setTimer({
      playback: "stop",
      currentItemId: null,
      elapsed: 0,
      startedAt: null,
      mode: timer.mode,
    });
    sendRundownCommand("reset");
  }, [canEditRundown, sendRundownCommand, timer.mode, timer.playback, resetScope, rundownScope]);

  const [showClearConfirmation, setShowClearConfirmation] = useState(false);

  const handleClearAll = useCallback(() => {
    if (!canEditRundown) return;
    const clearedTimer = {
      playback: "stop" as const,
      currentItemId: null,
      elapsed: 0,
      startedAt: null,
      mode: timer.mode,
    };
    setItems([]);
    setTimer(clearedTimer);
    // The relay arbitrates and persists this destructive change so a stale
    // operator cannot clear D1 after another operator has already advanced.
    sendRundownCommand("clear-all");
  }, [canEditRundown, setTimer, sendRundownCommand, timer.mode]);

  // Add or subtract time from the running timer (like OnTime's +/- buttons)
  // Positive deltaMs = add time (reduce elapsed, giving more remaining)
  // Negative deltaMs = subtract time (increase elapsed, giving less remaining)
  const handleAdjustTime = useCallback(
    (deltaMs: number) => {
      if (!transportAvailable) return;
      if (timer.playback === "stop") return;

      if (timer.playback === "play" && timer.startedAt) {
        const currentElapsed = timer.elapsed + (Date.now() - timer.startedAt);
        const newElapsed = currentElapsed - deltaMs; // Allow negative = extra time added
        const adjustNow = Date.now();
        setTimer({ ...timer, elapsed: newElapsed, startedAt: adjustNow });
      } else if (timer.playback === "pause") {
        const newElapsed = timer.elapsed - deltaMs;
        setTimer({ ...timer, elapsed: newElapsed });
      }
      // Sync to DO → broadcasts to all clients and kiosk
      sendRundownCommand("timer-adjust", { deltaMs });
    },
    [transportAvailable, timer, sendRundownCommand],
  );

  const handleAddItem = async (
    title: string,
    type: ItemType,
    durationStr: string,
    assignee: string,
    notes: string,
    index: number | null = null,
  ) => {
    if (!canEditRundown) return;
    setSaveError(null);
    const item: RundownItem = {
      id: createBrowserId(),
      title,
      type,
      duration: parseDurationInput(durationStr),
      notes,
      assignee,
      cue: "",
      status: "upcoming",
      sortOrder: items.length,
      hardStop: false,
    };
    const at = index === null || index >= items.length ? null : Math.max(0, index);
    const ordered = (at === null ? [...items, item] : [...items.slice(0, at), item, ...items.slice(at)]).map((entry, sortOrder) => ({ ...entry, sortOrder }));
    if (!showId) {
      const nextItems = ordered;
      try {
        const targetShowId = await ensureShowId();
        await saveRundownItems({
          data: { orgId, showId: targetShowId, serviceDate, items: nextItems },
        });
        databaseItemsRef.current = nextItems;
        await adoptShowId(targetShowId);
      } catch (error) {
        setSaveError(
          error instanceof Error ? error.message : "This item did not save",
        );
        return;
      }
    } else {
      sendRundownCommand(
        "add-item",
        item as unknown as Record<string, unknown>,
      );
      if (at === null) setItems((prev) => [...prev, item]);
      else {
        // The relay appends; a second command places the item at the end of the chosen section.
        setItems(ordered);
        sendRundownCommand("reorder", { order: ordered.map((entry) => entry.id) });
      }
    }
    setShowAddForm(false);
  };

  const [deleteItem, setDeleteItem] = useState<{ id: string; scope: string } | null>(null);
  const [removedItem, setRemovedItem] = useState<{ item: RundownItem; index: number; nextId: string | null; scope: string } | null>(null);
  useEffect(() => {
    if (!removedItem) return;
    const timeout = window.setTimeout(() => setRemovedItem(null), 30000);
    return () => window.clearTimeout(timeout);
  }, [removedItem]);
  const handleRemoveItem = (id: string) => {
    if (canEditRundown) setDeleteItem({ id, scope: rundownScope });
  };
  const confirmRemoveItem = () => {
    if (!canEditRundown || !deleteItem || deleteItem.scope !== rundownScope) return;
    const index = items.findIndex((item) => item.id === deleteItem.id);
    const item = items[index];
    if (!item) return;
    const wasCurrent = timer.currentItemId === item.id;
    if (wasCurrent) setTimer({ playback: "stop", currentItemId: null, elapsed: 0, startedAt: null, mode: timer.mode });
    sendRundownCommand("remove-item", { id: item.id });
    setItems((current) => current.filter((row) => row.id !== item.id));
    setRemovedItem({
      item: wasCurrent ? { ...item, status: "complete", actualEnd: new Date().toISOString() } : item,
      index, nextId: items[index + 1]?.id ?? null, scope: rundownScope,
    });
  };
  const undoRemoveItem = () => {
    if (!canEditRundown || !removedItem || removedItem.scope !== rundownScope) return;
    if (!items.some((item) => item.id === removedItem.item.id)) {
      const restored = restoreRundownItem(items, removedItem).map((item, sortOrder) => ({ ...item, sortOrder }));
      sendRundownCommand("restore-item", { id: removedItem.item.id });
      setItems(restored);
    }
    setRemovedItem(null);
  };

  const pendingRowFocus = useRef<{ id: string; direction: "up" | "down" } | null>(null);
  useEffect(() => {
    const pending = pendingRowFocus.current;
    if (!pending) return;
    pendingRowFocus.current = null;
    const row = Array.from(document.querySelectorAll<HTMLElement>("[data-rundown-item-id]")).find(element => element.dataset.rundownItemId === pending.id);
    // Moves come from the row's actions menu; focus returns to that menu's button so the next move is one keypress away.
    requestAnimationFrame(() => row?.querySelector<HTMLButtonElement>('button[title="Item actions"]')?.focus());
  }, [items]);

  const handleMoveItem = (id: string, direction: "up" | "down") => {
    if (!canEditRundown) return;
    const idx = items.findIndex((item) => item.id === id);
    if (idx < 0) return;
    const newIdx = direction === "up" ? idx - 1 : idx + 1;
    if (newIdx < 0 || newIdx >= items.length) return;
    pendingRowFocus.current = { id, direction };
    const reordered = [...items];
    [reordered[idx], reordered[newIdx]] = [reordered[newIdx], reordered[idx]];
    const normalized = reordered.map((item, sortOrder) => ({
      ...item,
      sortOrder,
    }));
    setItems(normalized);
    sendRundownCommand("reorder", { order: normalized.map((item) => item.id) });
  };

  const reorderItemsById = useCallback(
    (sourceItemId: string, targetItemId: string) => {
      if (!canEditRundown || sourceItemId === targetItemId) return;

      const fromIndex = items.findIndex((item) => item.id === sourceItemId);
      const toIndex = items.findIndex((item) => item.id === targetItemId);
      if (fromIndex < 0 || toIndex < 0) return;
      const reordered = [...items];
      const [moved] = reordered.splice(fromIndex, 1);
      reordered.splice(toIndex, 0, moved);
      const normalized = reordered.map((item, sortOrder) => ({
        ...item,
        sortOrder,
      }));
      setItems(normalized);
      sendRundownCommand("reorder", {
        order: normalized.map((item) => item.id),
      });
    },
    [canEditRundown, items, sendRundownCommand],
  );

  const {
    draggedItemId,
    dropTargetItemId,
    handleDragStart: handleItemDragStart,
    handleDragOver: handleItemDragOver,
    handleDrop: handleItemDrop,
    handleTouchStart: handleItemTouchStart,
    handleTouchMove: handleItemTouchMove,
    handleTouchEnd: handleItemTouchEnd,
    cancelDrag: handleItemDragEnd,
  } = useRundownDragReorder({
    enabled: canEditRundown,
    onReorder: reorderItemsById,
  });

  const handleEditItem = (
    id: string,
    title: string,
    type: ItemType,
    durationStr: string,
    assignee: string,
    notes: string,
  ) => {
    if (!canEditRundown) return;
    const updates = {
      title,
      type,
      duration: parseDurationInput(durationStr),
      assignee,
      notes,
    };
    sendRundownCommand("update-item", { id, updates });
    setItems((prev) =>
      prev.map((i) => (i.id === id ? { ...i, ...updates } : i)),
    );
    setEditingItem(null);
  };

  // Load items into current date (from a previous date or saved template)
  const handleLoadItems = useCallback(
    async (loaded: {
      items: RundownItem[];
      serviceName?: string;
      scheduledStartTime?: string;
    }) => {
      if (!canEditRundown) return;
      const fresh = loaded.items.map((item, idx) => ({
        ...item,
        id: createBrowserId(),
        status: "upcoming" as ItemStatus,
        sortOrder: idx,
      }));
      const resetTimer = {
        playback: "stop" as const,
        currentItemId: null,
        elapsed: 0,
        startedAt: null,
        pausedAt: null,
        mode: defaultTimerMode as "count-down" | "count-up" | "clock",
      };
      let targetShowId = showId;
      setItems(fresh);
      setTimer(resetTimer);
      const scheduled =
        loaded.scheduledStartTime === undefined
          ? undefined
          : serviceTimeToIso(
              serviceDate,
              loaded.scheduledStartTime,
              deviceTimeZone,
            );
      if (showId) {
        // Seed DO with loaded items so all devices get them.
        sendCommand("seed", {
          items: fresh,
          timer: resetTimer,
          force: true,
          ...(loaded.serviceName === undefined
            ? {}
            : { serviceName: loaded.serviceName }),
          ...(scheduled === undefined ? {} : { scheduledStartTime: scheduled }),
        });
      } else {
        targetShowId = await ensureShowId();
        await saveRundownItems({
          data: { orgId, showId: targetShowId, serviceDate, items: fresh },
        });
        databaseItemsRef.current = fresh;
      }
      if (loaded.serviceName !== undefined) {
        setServiceName(loaded.serviceName);
      }
      if (loaded.scheduledStartTime !== undefined) {
        setScheduledStartIso(scheduled ?? null);
      }
      if (
        !showId &&
        (loaded.serviceName !== undefined ||
          loaded.scheduledStartTime !== undefined)
      ) {
        await saveRundownMeta({
          data: {
            orgId,
            showId: targetShowId!,
            serviceDate,
            name: loaded.serviceName ?? "",
            scheduledStartTime: scheduled,
          },
        });
      }
      if (!showId && targetShowId) await adoptShowId(targetShowId);
      setShowLoadModal(false);
    },
    [
      adoptShowId,
      canEditRundown,
      defaultTimerMode,
      ensureShowId,
      orgId,
      sendCommand,
      serviceDate,
      settings,
      deviceTimeZone,
      showId,
    ],
  );

  const handleSendMessage = () => {
    if (!canEditRundown) return;
    if (message.trim()) {
      // The relay persists before broadcasting so every display converges.
      sendRundownCommand("stage-message", {
        message: encodeStageMessage(message, messagePriority),
      });
      setMessage("");
    }
  };

  const handleClearMessage = () => {
    if (!canEditRundown) return;
    setMessagePriority(false);
    sendRundownCommand("stage-clear");
  };

  // Keyboard shortcuts
  useEffect(() => {
    if (!canControlRundown) return;
    const handler = (e: KeyboardEvent) => {
      const shortcut = rundownShortcut(e);
      if (!shortcut) return;
      e.preventDefault();
      if (shortcut === "toggle-playback") {
        if (timer.playback === "play") handlePause();
        else if (timer.playback === "pause") handleResume();
        else if (items.length > 0) {
          const first = items.find(
            (i) => i.status !== "complete" && i.type !== "header",
          );
          if (first) handleStart(first.id);
        }
      }
      if (shortcut === "next") handleNext();
      if (shortcut === "previous") handlePrev();
      if (shortcut === "end-show") handleStop();
      if (shortcut === "add-minute") handleAdjustTime(60_000);
      if (shortcut === "subtract-minute") handleAdjustTime(-60_000);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    canControlRundown,
    timer,
    items,
    handlePause,
    handleResume,
    handleStart,
    handleNext,
    handlePrev,
    handleStop,
    handleAdjustTime,
  ]);

  const nextItem = nextPlayableItem(items, timer.currentItemId);

  const totalDuration = items.reduce((sum, i) => sum + i.duration, 0);
  const completedDuration = items
    .filter((i) => i.status === "complete")
    .reduce((sum, i) => sum + i.duration, 0);

  const remainingDuration = totalDuration - completedDuration;
  const selectionBusy =
    loading || metaSavePending || syncSaving || activePublishPending;

  const rundownMeta = scheduledStartIso
    ? {
        serviceDate,
        scheduledStartTime: scheduledStartIso,
        status: "stopped" as const,
      }
    : undefined;
  const timedItems = computeCascadedTimes(items, rundownMeta);
  const hour12 = settings["clock-format"] !== "24hr";
  const liveItem = items.find((item) => item.id === timer.currentItemId);
  const renderNow = Date.now();
  const runningOver = timer.playback === "play" && !!liveItem && timer.startedAt !== null && timer.elapsed + Math.max(0, renderNow - timer.startedAt) > liveItem.duration;
  const projectionNow = Math.max(renderNow, useCoarseNow(runningOver, 15_000));
  const projection = projectRundown(items, scheduledStartIso, timer.currentItemId, timer.elapsed + (timer.playback === "play" && timer.startedAt !== null ? Math.max(0, projectionNow - timer.startedAt) : 0), projectionNow);
  const firstPlayable = items.find((i) => i.status !== "complete" && i.type !== "header") ?? null;
  const upNextId = timer.playback === "stop" ? firstPlayable?.id ?? null : nextItem?.id ?? null;
  const addPositions: ItemPosition[] = (() => {
    const headers = items.map((item, index) => ({ item, index })).filter(({ item }) => item.type === "header");
    const startAt = (index: number) => {
      if (projection.plan.plannedStart === null) return null;
      const before = items.slice(0, index).reduce((sum, item) => sum + (item.type === "header" ? 0 : item.duration), 0);
      return formatWallTime(new Date(projection.plan.plannedStart + before).toISOString());
    };
    if (!headers.length) return [{ key: "end", label: "End of rundown", index: null, startsAt: startAt(items.length) }];
    return headers.map(({ item }, n) => {
      const end = n + 1 < headers.length ? headers[n + 1].index : items.length;
      return { key: item.id, label: `End of ${item.title || "section"}`, index: end === items.length ? null : end, startsAt: startAt(end) };
    });
  })();
  const sectionTitleOf = (id: string) => { const sectionId = projection.plan.sectionOf.get(id); return sectionId ? projection.plan.sections.get(sectionId)?.title ?? null : null; };
  const itemNumbers = rundownItemNumbers(items);
  const selectedShowName =
    serviceName ||
    shows.find((show) => show.id === showId)?.name ||
    "Untitled show";
  const selectedShowIsLive =
    liveTarget.serviceDate === serviceDate &&
    liveTarget.showId === (showId ?? null);
  const [takeLiveResult, setTakeLiveResult] = useState<{ kind: "success" | "failed"; scope: string; message: string } | null>(null);
  useEffect(() => {
    if (takeLiveResult?.kind !== "success") return;
    const timeout = window.setTimeout(() => setTakeLiveResult(null), 10_000);
    return () => window.clearTimeout(timeout);
  }, [takeLiveResult]);
  const takeSelectedShowLive = useCallback(async () => {
    if (!showId || activePublishPending) return false;
    setTakeLiveResult(null);
    try {
      await publishTarget(serviceDate, showId);
      setTakeLiveResult({ kind: "success", scope: rundownScope, message: "" });
      return true;
    } catch (error) {
      setTakeLiveResult({
        kind: "failed",
        scope: rundownScope,
        message: error instanceof Error ? error.message : "Could not route this show to venue outputs.",
      });
      return false;
    }
  }, [activePublishPending, publishTarget, rundownScope, serviceDate, showId]);
  const offerTakeLive = canEditRundown && !!showId && !selectedShowIsLive;
  const lockedFromTakeLive = !canEditRundown && rundownAccess.pin === "locked" && !!showId && !selectedShowIsLive;
  const liveShowName = liveTarget.showId
    ? shows.find((show) => show.id === liveTarget.showId)?.name || "another show"
    : liveTarget.serviceDate ? `the ${formatDisplayDate(liveTarget.serviceDate)} rundown` : null;
  const selectedShowStart = scheduledStartTime
    ? formatWallTime(scheduledStartTime)
    : "";
  const phaseSettings = readPhaseSettings(settings);
  const effectiveCallTimeMs = getServiceTiming({
    scheduledStartTime: scheduledStartIso,
    scheduledCallTime: scheduledCallIso,
    callLeadMinutes: phaseSettings.callLeadMinutes,
  }).callTimeMs;
  const selectedShowCall =
    effectiveCallTimeMs === null
      ? ""
      : formatTimeInput(
          new Date(effectiveCallTimeMs),
          deviceTimeZone,
        );
  const activeStageMessage = decodeStageMessage(syncedStageMessage);
  useEffect(() => {
    if (!loading && window.location.hash === "#rundown-runsheet") document.getElementById("rundown-runsheet")?.focus();
  }, [loading, showId]);

  return (
    <div data-unconfirmed={unconfirmedCount > 0 || undefined} className="rundown-page schedule-a relative h-full flex flex-col overflow-x-hidden overflow-y-auto bg-board-bg">
      <div className="relative z-10 shrink-0">
        <div className="mx-auto flex w-full max-w-[1400px] flex-wrap items-end justify-between gap-x-6 gap-y-3 px-4 pb-1 pt-6 sm:px-6 lg:px-7">
          <div className="flex min-w-0 flex-col gap-1">
            <p className={eyebrow}>Rundown</p>
            <h1 className="truncate text-[22px] font-semibold leading-[1.2] tracking-[-0.02em] text-board-text">
              {selectedShowName}
            </h1>
            <p className="truncate text-[13px] text-[var(--sa-ink-3)]">
              {formatDisplayDate(serviceDate)}
              {selectedShowStart ? <> · <span className="tabular-nums text-[var(--sa-ink-2)]">{selectedShowStart}</span> start</> : null}
              {selectedShowCall ? <span className="hidden sm:inline"> · <span className="tabular-nums text-[var(--sa-ink-2)]">{formatWallTime(selectedShowCall)}</span> call</span> : null}
              {" · "}<span className="tabular-nums text-[var(--sa-ink-2)]">{items.length}</span> items
              <span className="hidden sm:inline"> · <span className="tabular-nums text-[var(--sa-ink-2)]">{formatDuration(totalDuration)}</span></span>
            </p>
          </div>
          <div className="flex max-w-full flex-wrap items-center gap-2">
            <WallClock timeZone={deviceTimeZone} hour12={hour12} />
            <RundownUnlock orgId={orgId} pinAccess={rundownAccess.pin} />
            {selectedShowIsLive ? (
              <span className="inline-flex h-8 items-center gap-2 rounded-full border border-[var(--sa-ok)]/35 bg-[var(--sa-ok)]/[0.08] px-3 text-xs font-medium text-board-text">
                <span aria-hidden="true" className="h-[7px] w-[7px] rounded-full bg-[var(--sa-ok)]" />
                Live output
              </span>
            ) : showId ? (
              <span className="inline-flex h-8 items-center gap-2 rounded-full border border-dashed border-[var(--sa-border-strong)] px-3 text-xs font-medium text-[var(--sa-ink-2)]">
                <span aria-hidden="true" className="h-[7px] w-[7px] rounded-full shadow-[inset_0_0_0_1.5px_var(--sa-ink-2)]" />
                Viewing · not live
              </span>
            ) : null}
            <button
              type="button"
              onClick={() => setShowOptionsModal(true)}
              disabled={loading}
              className={`${rundownButton} max-lg:w-11 max-lg:px-0 lg:min-w-[164px] lg:justify-between`}
              aria-label="Show options"
            >
              <span className="inline-flex items-center gap-2"><CalendarDays className="h-3.5 w-3.5 text-[var(--sa-ink-3)]" /><span className="hidden lg:inline">Show options</span></span>
              <ChevronDown className="hidden h-3.5 w-3.5 text-[var(--sa-ink-3)] lg:block" />
            </button>
            {canEditRundown ? (
              <>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-[var(--sa-ink-2)] hover:bg-[var(--sa-surface-2)] hover:text-board-text max-lg:h-11 max-lg:w-11"
                      title="Rundown actions"
                      aria-label="Rundown actions"
                    >
                      <MoreHorizontal className="h-4 w-4" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-[240px]">
                    <DropdownMenuItem
                      onSelect={() => {
                        void (async () => {
                          try {
                            const { createDisplayLink } = await import("@/lib/display-access");
                            const link = await createDisplayLink({ data: { orgSlug: slug, surface: "timer" } });
                            await navigator.clipboard.writeText(new URL(link.path, window.location.origin).href);
                            setCopiedUrl(true);
                            setTimeout(() => setCopiedUrl(false), 2000);
                          } catch { setSelectionError("Could not copy the display link. Check your connection and try again."); }
                        })();
                      }}
                    >
                      <Monitor className="w-3.5 h-3.5" />
                      {copiedUrl ? "8-hour display link copied" : "Copy 8-hour display link"}
                      {copiedUrl ? (
                        <Check className="ml-auto w-3.5 h-3.5 text-green-400" />
                      ) : (
                        <Copy className="ml-auto w-3.5 h-3.5" />
                      )}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => setShowLoadModal(true)}>
                      <FolderOpen className="w-3.5 h-3.5" />
                      Load from date or template
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={items.length === 0}
                      onSelect={() => setShowSaveModal(true)}
                    >
                      <Save className="w-3.5 h-3.5" />
                      Save as template
                    </DropdownMenuItem>

                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger
                        disabled={exporting || items.length === 0}
                      >
                        <Download className="w-3.5 h-3.5" />
                        {exporting ? "Exporting…" : "Export report"}
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent>
                        <DropdownMenuItem onSelect={() => handleExport("csv")}>
                          CSV
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => handleExport("pdf")}>
                          PDF
                        </DropdownMenuItem>
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>

                    <DropdownMenuSeparator />

                    <DropdownMenuItem onSelect={handleReset} disabled={timer.playback === "play"}>
                      <RotateCcw className="w-3.5 h-3.5" />
                      Reset timer…
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      variant="destructive"
                      disabled={items.length === 0}
                      onSelect={() => setShowClearConfirmation(true)}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      Clear all items…
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>

                <button
                  type="button"
                  onClick={() => setShowAddForm(true)}
                  aria-label="Add item"
                  className={offerTakeLive ? rundownButton : "inline-flex h-9 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg bg-fire-500 px-3.5 text-[13px] font-semibold text-[#1a1300] hover:bg-fire-400 max-lg:h-11"}
                >
                  <Plus className="h-3.5 w-3.5" strokeWidth={2.25} />
                  Add item
                </button>
              </>
            ) : (
              <span className="inline-flex h-8 items-center rounded-full border border-[var(--sa-border)] px-3 text-xs text-[var(--sa-ink-2)]">
                View only
              </span>
            )}
            {offerTakeLive || (lockedFromTakeLive) ? (
              <button
                type="button"
                onClick={() => setShowTakeLiveConfirmation(true)}
                disabled={loading || activePublishPending || lockedFromTakeLive}
                title={lockedFromTakeLive ? "Unlock the rundown to take a show live" : undefined}
                className="inline-flex h-9 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg bg-fire-500 px-3.5 text-[13px] font-semibold text-[#1a1300] hover:bg-fire-400 disabled:opacity-50 max-lg:h-11"
              >
                {activePublishPending ? <RotateCcw className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" /> : <Tv className="h-3.5 w-3.5" />}
                {activePublishPending ? "Switching…" : "Take live"}
              </button>
            ) : null}
          </div>
        </div>
      </div>

      {showId && !selectedShowIsLive && !loading ? (
        <div className="mx-auto w-full max-w-[1400px] shrink-0 px-4 pt-4 sm:px-6 lg:px-7">
          {takeLiveResult?.kind === "failed" && takeLiveResult.scope === rundownScope ? (
            <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl border border-[var(--sa-danger)]/30 bg-[var(--sa-danger)]/[0.07] px-4 py-3 text-[13px]">
              <X aria-hidden="true" className="h-4 w-4 shrink-0 text-[var(--sa-danger)]" />
              <p className="min-w-0 flex-1 text-[var(--sa-ink-2)]"><span className="font-semibold text-[var(--sa-danger)]">Show unchanged.</span> {plainFailure(takeLiveResult.message)}{liveShowName ? ` Outputs are still following ${liveShowName}.` : ""}</p>
              {canEditRundown ? <button type="button" className={rundownButton} disabled={activePublishPending} onClick={() => void takeSelectedShowLive()}><RotateCcw className="h-3.5 w-3.5" />Retry</button> : null}
            </div>
          ) : lockedFromTakeLive ? (
            <p className="flex items-center gap-3 rounded-xl border border-[var(--sa-border)] bg-[var(--sa-surface)] px-4 py-3 text-[13px] text-[var(--sa-ink-2)]"><Lock aria-hidden="true" className="h-4 w-4 shrink-0 text-[var(--sa-ink-3)]" />Unlock the rundown to take a show live.</p>
          ) : liveShowName ? (
            <p className="flex items-start gap-3 rounded-xl border border-[var(--sa-border)] bg-[var(--sa-surface)] px-4 py-3 text-[13px] leading-[1.5] text-[var(--sa-ink-2)]"><Eye aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-[var(--sa-ink-3)]" /><span>You're viewing <span className="font-semibold text-board-text">{selectedShowName}</span>. Venue outputs are following <span className="font-semibold text-board-text">{liveShowName}</span>, which is live now. Browsing alone never changes them.</span></p>
          ) : null}
        </div>
      ) : selectedShowIsLive && takeLiveResult?.kind === "success" && takeLiveResult.scope === rundownScope ? (
        <div className="mx-auto w-full max-w-[1400px] shrink-0 px-4 pt-4 sm:px-6 lg:px-7">
          <p role="status" className="flex items-center gap-3 rounded-xl border border-[var(--sa-ok)]/35 bg-[var(--sa-ok)]/[0.07] px-4 py-3 text-[13px] text-[var(--sa-ink-2)]"><Tv aria-hidden="true" className="h-4 w-4 shrink-0 text-[var(--sa-ok)]" /><span><span className="font-semibold text-[var(--sa-ok)]">Live: {selectedShowName}</span> · Timer, lyrics, kiosk, Show Flow and other venue outputs now follow this show.</span></p>
        </div>
      ) : null}

      {(selectionError || saveError || syncError) && (
        <div className="mx-auto w-full max-w-[1400px] shrink-0 px-4 pt-4 sm:px-6 lg:px-7">
          <div role="alert" className="flex flex-wrap items-start gap-3 rounded-xl border border-[var(--sa-danger)]/30 bg-[var(--sa-danger)]/[0.07] p-4">
            <X aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-[var(--sa-danger)]" />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-semibold text-board-text">{selectionError ? "We couldn't open this show." : saveError ? "Your rundown changes need attention." : "We couldn't update this rundown."}</p>
              <p className="mt-1 text-[13px] leading-[1.55] text-[var(--sa-ink-2)]">{selectionError ? plainFailure(selectionError) : saveError ? plainFailure(saveError) : "Check your connection and try again. Nothing in the rundown has been changed."}</p>
            </div>
            {syncError && !selectionError && !saveError && <button type="button" className={rundownButton} onClick={reconnectRundown}>Retry rundown</button>}
          </div>
        </div>
      )}

      <ReadFailureNotice {...ppConfiguration} label="Retry ProPresenter configuration" />
      {!syncConnected && !syncError && !saveError && !selectionError && <p role="status" className="pointer-events-none absolute right-4 top-2 z-20 inline-flex items-center gap-2 rounded-full border border-[var(--sa-border)] bg-[var(--sa-surface)] px-3 py-1 text-xs text-[var(--sa-ink-2)] sm:right-6 lg:right-7"><span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-[var(--sa-warn)]" />Reconnecting…</p>}
      {/* Page body — flex-col container, never scrolls itself */}
      <div
        className="rundown-page-body flex-1 min-h-0 flex flex-col"
        style={{ containerType: "inline-size" }}
      >
        {/* Export error */}
        {exportError && (
          <div className="shrink-0 bg-red-500/10 border-b border-red-500/20 px-6 py-2.5 flex items-center gap-3">
            <X className="w-4 h-4 text-red-400 shrink-0" />
            <p className="text-sm text-red-400 flex-1">
              Export failed: {plainFailure(exportError)}
            </p>
            <Button variant="ghost"
              type="button"
              onClick={() => setExportError(null)}
              aria-label="Dismiss export error"
              title="Dismiss export error"
              className="p-1 rounded text-red-400 hover:text-red-200 transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </Button>
          </div>
        )}

        {/* Message bar */}
        {activeStageMessage.text && (
          <div className="mx-auto mt-4 flex w-[calc(100%-2rem)] max-w-[calc(1400px-3.5rem)] shrink-0 items-center gap-3 rounded-xl border border-[var(--sa-warn)]/30 bg-[var(--sa-warn)]/[0.07] px-4 py-2.5 sm:w-[calc(100%-3rem)]">
            <MessageSquare className="w-4 h-4 text-[var(--sa-warn)] shrink-0" />
            <span className={eyebrow}>On stage</span>
            <p className="text-[13px] font-medium text-board-text flex-1 truncate">
              {activeStageMessage.text}
            </p>
            <Button variant="ghost"
              type="button"
              onClick={handleClearMessage}
              aria-label="Clear operator message"
              title="Clear operator message"
              className="p-1 rounded text-amber-400 hover:text-amber-200 transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </Button>
          </div>
        )}

        {loading ? (
          <RundownSkeleton />
        ) : (
          <div className="rundown-columns flex-1 overflow-hidden flex flex-row gap-5 px-4 pt-5 sm:px-6 lg:px-7 max-w-[1400px] mx-auto w-full min-h-0">
            {/* Left: Timer + Controls + Message */}
            <div className="rundown-panel-left w-[420px] shrink-0 flex flex-col gap-4 overflow-y-auto hide-scrollbar min-h-0 pb-6">
              <RundownTimerCard timer={timer} current={currentItem} next={nextItem} first={firstPlayable}
                section={currentItem ? sectionTitleOf(currentItem.id) : null} firstSection={firstPlayable ? sectionTitleOf(firstPlayable.id) : null}
                cueIndex={currentItem ? projection.plan.cues.findIndex(cue => cue.id === currentItem.id) + 1 : 0} cueCount={projection.plan.cues.length}
                startsAt={selectedShowStart || null} plannedStart={currentItem ? projection.plan.starts.get(currentItem.id) ?? null : null}
                plannedShowEnd={projection.plan.plannedEnd} timeZone={deviceTimeZone} hour12={hour12}
                initialNow={initialNow} overtimeBehavior={overtimeBehavior}
                transport={canControlRundown ? (
                  <div className="flex gap-2">
                    {timer.playback === "play" ? (
                      <button type="button" disabled={!transportAvailable} onClick={handlePause}
                        className={`${transportPause} flex-1`}>
                        <Pause className="h-4 w-4" /><span className="max-sm:sr-only">Pause</span>
                      </button>
                    ) : timer.playback === "pause" ? (
                      <button type="button" disabled={!transportAvailable} onClick={handleResume}
                        className={`${transportGo} flex-1`}>
                        <Play className="h-4 w-4" /><span className="max-sm:sr-only">Resume</span>
                      </button>
                    ) : (
                      <button type="button"
                        onClick={() => { if (firstPlayable) handleStart(firstPlayable.id); }}
                        disabled={!transportAvailable || !firstPlayable}
                        className={`${transportGo} flex-[2]`}>
                        <Play className="h-4 w-4" /> Start show
                      </button>
                    )}
                    <button type="button" onClick={handlePrev} disabled={!transportAvailable || timer.playback === "stop"}
                      className={`${transportButton} w-12 shrink-0 px-0`} title="Previous item" aria-label="Previous rundown item">
                      <SkipBack className="h-4 w-4" />
                    </button>
                    {timer.playback === "stop" ? (
                      <button type="button" onClick={handleNext} disabled
                        className={`${transportButton} w-12 shrink-0 px-0`} title="Next item" aria-label="Next rundown item">
                        <SkipForward className="h-4 w-4" />
                      </button>
                    ) : (
                      <button type="button" onClick={handleNext} disabled={!transportAvailable}
                        className={`${transportGo} flex-[2]`} title="Next item (Shift N)" aria-label="Next rundown item">
                        <SkipForward className="h-4 w-4" /> Next item
                      </button>
                    )}
                    <button type="button" onClick={requestEndShow} disabled={!transportAvailable || timer.playback === "stop"}
                      className={`${transportEnd} w-12 shrink-0 px-0`} aria-label="Stop rundown" title="End show (S)">
                      <Square className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ) : null}
                hint={canControlRundown && timer.playback === "stop" ? (
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs text-[var(--sa-ink-3)]">
                    <KeyCombo keys="Shift + Space" /> start <span aria-hidden="true">·</span> <KeyCombo keys="Shift + N" /> next <span aria-hidden="true">·</span> <Kbd>S</Kbd> end, asks first
                  </p>
                ) : null}
              />

              {/* Add / Subtract time (OnTime-style) */}
              {canControlRundown && (
                <Panel icon={Timer} title="Adjust time" labelledBy="rundown-adjust-title"
                  aside={timer.playback === "stop"
                    ? <span className="text-xs text-[var(--sa-ink-3)]">Available once the show is running</span>
                    : <span className="inline-flex items-center gap-1.5 text-xs text-[var(--sa-ink-3)]">±1 min <Kbd>−</Kbd><Kbd>+</Kbd></span>}>
                  <div className="flex flex-wrap items-center gap-2">
                    {([[-60_000, "1m", "Subtract 1 minute from current item"], [-15_000, "15s", "Subtract 15 seconds from current item"], [15_000, "15s", "Add 15 seconds to current item"], [60_000, "1m", "Add 1 minute to current item"]] as const).map(([amount, text, label]) => (
                      <button key={label} type="button" onClick={() => handleAdjustTime(amount)} disabled={!transportAvailable || timer.playback === "stop"} aria-label={label}
                        className={`${rundownButton} min-w-0 flex-1 px-2 tabular-nums`}>
                        {amount < 0 ? <Minus className="h-3 w-3" /> : <Plus className="h-3 w-3" />}{text}
                      </button>
                    ))}
                    <span aria-hidden="true" className="mx-0.5 hidden h-6 w-px bg-[var(--sa-border)] sm:block" />
                    <div className="flex h-9 items-center rounded-lg border border-[var(--sa-border-strong)] bg-board-bg max-lg:h-11 max-sm:w-full">
                      <button type="button" onClick={() => handleAdjustTime(-parseAdjustInput(customAdjust))}
                        disabled={!transportAvailable || timer.playback === "stop" || parseAdjustInput(customAdjust) === 0}
                        className="inline-flex h-full w-9 items-center justify-center text-[var(--sa-ink-2)] hover:text-board-text disabled:opacity-40 max-lg:w-11" title="Subtract custom time" aria-label="Subtract custom time">
                        <Minus className="h-3.5 w-3.5" />
                      </button>
                      <input type="text" value={customAdjust} onChange={(e) => setCustomAdjust(e.target.value)} placeholder="m:ss" aria-label="Custom time adjustment"
                        className="h-full w-14 min-w-0 bg-transparent text-center text-[13px] tabular-nums text-board-text outline-none placeholder:text-[var(--sa-ink-3)] max-sm:flex-1 max-lg:text-base" />
                      <button type="button" onClick={() => handleAdjustTime(parseAdjustInput(customAdjust))}
                        disabled={!transportAvailable || timer.playback === "stop" || parseAdjustInput(customAdjust) === 0}
                        className="inline-flex h-full w-9 items-center justify-center text-[var(--sa-ink-2)] hover:text-board-text disabled:opacity-40 max-lg:w-11" title="Add custom time" aria-label="Add custom time">
                        <Plus className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                </Panel>
              )}

              {/* Send message to stage */}
              {canEditRundown && (
                <Panel icon={MessageSquare} title={<label htmlFor="stage-message">Stage message</label>}
                  aside={<span className="inline-flex items-center gap-1"><Toggle checked={messagePriority} onChange={setMessagePriority} label="Priority stage message" tone="warn" /><span className={`text-[13px] ${messagePriority ? "text-[var(--sa-warn)]" : "text-[var(--sa-ink-2)]"}`}>Priority</span></span>}>
                  <div className="flex gap-2">
                    <div className={`flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-lg border bg-board-bg px-3 focus-within:border-fire-500 ${messagePriority ? "border-[var(--sa-warn)]/50" : "border-[var(--sa-border-strong)]"}`}>
                      {messagePriority ? <span className="shrink-0 rounded bg-[var(--sa-warn)]/15 px-1.5 py-0.5 text-xs font-semibold text-[var(--sa-warn)]">Priority</span> : null}
                      <input
                        type="text"
                        value={message}
                        onChange={(e) => setMessage(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && handleSendMessage()}
                        id="stage-message"
                        placeholder="Message to stage display…"
                        className="min-w-0 flex-1 bg-transparent text-base text-board-text outline-none placeholder:text-[var(--sa-ink-3)] lg:text-[13px]"
                      />
                    </div>
                    <button type="button" onClick={handleSendMessage} disabled={!message.trim()} aria-label="Send stage message"
                      className={`inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border disabled:opacity-40 ${messagePriority ? "border-[var(--sa-warn)]/50 bg-[var(--sa-warn)]/10 text-[var(--sa-warn)]" : "border-[var(--sa-border-strong)] bg-[var(--sa-surface-2)] text-board-text hover:bg-[var(--sa-surface-3)]"}`}>
                      <Send className="h-4 w-4" />
                    </button>
                  </div>
                  {messagePriority ? <p className="-mt-2 text-xs text-[var(--sa-ink-3)]">Shown large on stage displays, with the timer small.</p> : null}
                </Panel>
              )}

              {/* ProPresenter Slide Feed */}
              {(ppHost || syncedPpSlide) && (
                <Panel icon={Tv} title="ProPresenter"
                  aside={(canEditRundown || canControlRundown) ? <Toggle checked={ppEnabled} onChange={() => togglePP()} label="Stream ProPresenter slides" /> : null}>
                  {!ppEnabled ? (
                    <p className="flex items-center gap-2 text-[13px] text-board-text"><span aria-hidden="true" className="h-[7px] w-[7px] rounded-full shadow-[inset_0_0_0_1.5px_var(--sa-ink-2)]" />Slides off <span className="text-[var(--sa-ink-3)]">· stage displays show the timer only</span></p>
                  ) : (
                    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-board-text">
                      <span aria-hidden="true" className={`h-[7px] w-[7px] rounded-full ${ppIsConnected ? "bg-[var(--sa-ok)]" : pp.status === "error" ? "bg-[var(--sa-danger)]" : "bg-[var(--sa-warn)]"}`} />
                      {ppIsConnected ? <>Connected <span className="text-[var(--sa-ink-3)]">· through Venue Bridge</span></>
                        : pp.status === "error" ? "Venue Bridge is offline"
                        : pp.status === "connecting" ? <>Reconnecting to Venue Bridge… <span className="text-[var(--sa-ink-3)]">Slide controls come back when it connects</span></>
                        : <>Waiting for Venue Bridge <span className="text-[var(--sa-ink-3)]">· slides start when it connects</span></>}
                    </p>
                  )}

                  {(canEditRundown || canControlRundown) && <ProPresenterOutputControl orgId={orgId} userId={user.id} surface="rundown" enabled /> }
                  {ppCommands.failure && (
                    <div role="alert" aria-label="ProPresenter command confirmation" className="space-y-2 text-[13px] text-[var(--sa-warn)]">
                      <p>{plainFailure(ppCommands.failure.message)} </p>
                      {ppCommands.canCheck && <button type="button" className={rundownButton} onClick={() => void ppCommands.checkStatus()}>Check command status</button>}
                      {ppCommands.canAcknowledge && <button type="button" className={rundownButton} onClick={ppCommands.acknowledgeReview}>I've checked the output</button>}
                    </div>
                  )}
                  {ppCommands.previousContext && <p role="status" className="text-[13px] text-[var(--sa-ink-2)]">This action started before the show or ProPresenter settings changed. Its result belongs to that earlier action.</p>}
                  {ppCommands.pending && <p role="status" aria-live="polite" className="text-[13px] text-[var(--sa-ink-2)]">{<QuietActivity label="Checking the original command status…" />}</p>}

                  {ppEnabled && (
                    <>
                      {pp.status === "error" ? <p className="text-[13px] leading-[1.55] text-[var(--sa-ink-2)]">Stage slides are paused until Venue Bridge is back. Check that the Venue Bridge app is running on the ProPresenter computer.</p> : null}
                      <ReadFailureNotice error={pp.error && pp.errorAt !== null ? { message: pp.error, occurredAt: pp.errorAt } : null} refreshing={pp.refreshing} retry={pp.connect} label="Reconnect ProPresenter feed" />

                      {canControlRundown && (ppCuesEnabled && ppApiPort ? (
                        <div><ProPresenterSlideControls scope={ppCommandScope}
                          disabled={ppControlsBlocked || !showId || !syncConnected || !pp.isStreaming}
                          onCommand={command => void handleProPresenterCommand(command)} />
                          {!showId && <p className="mt-2 text-xs text-[var(--sa-ink-3)]">Open or create a show before controlling ProPresenter.</p>}
                        </div>
                      ) : <p className="text-xs text-[var(--sa-ink-3)]">{!ppCuesEnabled
                        ? 'Enable "Send cues" in Settings → ProPresenter to control slides'
                        : "Set API Port in Settings → ProPresenter to control slides"}</p>)}

                      {activePpSlide && activePpSlide.text ? (
                        <div className="rounded-lg border border-[var(--sa-border)] bg-board-bg p-3">
                          {activePpSlide.presentationName && <p className={`${eyebrow} mb-1`}>{activePpSlide.presentationName}</p>}
                          <p className={`text-[13px] leading-snug text-board-text ${activePpSlide.isScripture ? "italic" : ""}`}>
                            {activePpSlide.text.length > 120 ? activePpSlide.text.slice(0, 120) + "…" : activePpSlide.text}
                          </p>
                          <p className="mt-1.5 text-xs text-[var(--sa-ink-3)]">{ppSource === "bridge" ? "Rundown preview" : "Direct ProPresenter preview"}</p>
                        </div>
                      ) : pp.status !== "error" ? (
                        <p className="text-[13px] text-[var(--sa-ink-3)]">No slide on screen yet.</p>
                      ) : null}
                      {pp.debugInfo && (
                        <details className="group text-[13px] text-[var(--sa-ink-3)]">
                          <summary className="flex min-h-9 cursor-pointer list-none items-center gap-1.5 hover:text-board-text max-lg:min-h-11"><ChevronDown className="h-3.5 w-3.5 -rotate-90 transition-transform group-open:rotate-0" />Diagnostics</summary>
                          <div className="mt-2 space-y-0.5 rounded-lg border border-[var(--sa-border)] bg-board-bg p-3 font-mono text-xs text-[var(--sa-ink-2)]">
                            <p>Bridge: {pp.debugInfo.wsConnected ? "open" : "closed"} | msgs: {pp.debugInfo.wsMessagesReceived}</p>
                            {pp.debugInfo.lastWsMessage && <p className="truncate" title={pp.debugInfo.lastWsMessage}>Last event: {pp.debugInfo.lastWsMessage.slice(0, 80)}</p>}
                            <p>Poll: {pp.debugInfo.pollingActive ? "active" : "inactive"} | ok: {pp.debugInfo.pollSuccessCount}</p>
                            {pp.debugInfo.lastPollResult && <p className="truncate" title={pp.debugInfo.lastPollResult}>Poll: {pp.debugInfo.lastPollResult.slice(0, 80)}</p>}
                          </div>
                        </details>
                      )}
                    </>
                  )}
                </Panel>
              )}

              {/* Shortcuts */}
              {canControlRundown && (
                <details open={timer.playback === "stop"} className="group rounded-2xl border border-[var(--sa-border)] bg-[var(--sa-surface)]">
                  <summary className="flex min-h-[52px] cursor-pointer list-none items-center justify-between gap-3 px-5 max-lg:min-h-14">
                    <span className={`flex items-center gap-2.5 ${eyebrow} text-[var(--sa-ink-2)]`}><Keyboard aria-hidden="true" className="h-3.5 w-3.5 text-[var(--sa-ink-3)]" strokeWidth={1.75} />Keyboard shortcuts <span className="tabular-nums text-[var(--sa-ink-3)]">{RUNDOWN_SHORTCUTS.length}</span></span>
                    <ChevronDown aria-hidden="true" className="h-4 w-4 -rotate-90 text-[var(--sa-ink-3)] transition-transform group-open:rotate-0" />
                  </summary>
                  <div className="px-5 pb-5"><RundownShortcutList /></div>
                </details>
              )}
            </div>

            {/* Right: Runsheet */}
            <section id="rundown-runsheet" tabIndex={-1} aria-label="Rundown items" className="rundown-panel-right flex-1 min-w-0 flex flex-col overflow-y-auto hide-scrollbar rounded-2xl pb-6 focus-visible:outline-2 focus-visible:outline-fire-500">
              <div className="flex min-w-0 flex-col rounded-2xl border border-[var(--sa-border)] bg-[var(--sa-surface)]">
                <p id="rundown-reorder-help" className="sr-only">Drag the handle to reorder, or use Move up and Move down in the item's actions menu.</p>
                {/* Runsheet header — sticky within its own scroll container */}
                <div className="rundown-sheet-header sticky top-0 z-10 flex flex-wrap items-start justify-between gap-x-4 gap-y-1 rounded-t-2xl bg-[var(--sa-surface)] px-5 pb-3.5 pt-4">
                  <div className="flex min-w-0 flex-col gap-1">
                    <h2 className="text-[15px] font-semibold text-board-text">Runsheet</h2>
                    <p className="text-xs text-[var(--sa-ink-3)]">
                      {projection.plan.plannedStart === null
                        ? items.length ? "Set a start time in Show options to see when each item begins." : "Add items to build the runsheet."
                        : projection.behind !== null
                          ? <>Planned <span className="tabular-nums">{dayTime(projection.plan.plannedStart, deviceTimeZone, hour12)} → {dayTime(projection.plan.plannedEnd, deviceTimeZone, hour12)}</span> · projected end <span className={`tabular-nums ${projection.behind > 30_000 ? "text-[var(--sa-warn)]" : "text-[var(--sa-ink-2)]"}`}>{dayTime(projection.projectedEnd, deviceTimeZone, hour12)}</span> · running <span className={projection.behind > 30_000 ? "text-[var(--sa-warn)]" : "text-[var(--sa-ink-2)]"}>{runningLabel(projection.behind)}</span></>
                          : <>Start <span className="tabular-nums">{dayTime(projection.plan.plannedStart, deviceTimeZone, hour12)}</span> · ends <span className="tabular-nums">{dayTime(projection.plan.plannedEnd, deviceTimeZone, hour12)}</span> · start times computed from durations</>}
                    </p>
                  </div>
                  <p className="text-xs text-[var(--sa-ink-3)]"><span className="tabular-nums">{items.length}</span> items · <span className="tabular-nums text-board-text">{formatDuration(remainingDuration)}</span> remaining</p>
                </div>

                {items.length === 0 ? (
                  <div className="px-5 pb-5">
                    <div className="flex flex-col items-start gap-3 rounded-xl border border-dashed border-[var(--sa-border-strong)] p-7">
                      <span aria-hidden="true" className="flex h-10 w-10 items-center justify-center rounded-[10px] bg-[var(--sa-surface-2)] text-[var(--sa-ink-2)]"><ListIcon className="h-4 w-4" /></span>
                      <h3 className="text-base font-semibold text-board-text">No items in this rundown yet</h3>
                      <p className="max-w-[440px] text-[13px] leading-[1.6] text-[var(--sa-ink-2)]">
                        {canEditRundown ? "Add sections and items to build the runsheet, or load one from another date or a saved template." : "No rundown items are available for this show yet."}
                      </p>
                      {canEditRundown ? <div className="flex flex-wrap gap-2 pt-1">
                        <button type="button" onClick={() => setShowAddForm(true)} className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-fire-500 px-3.5 text-[13px] font-semibold text-[#1a1300] hover:bg-fire-400 max-lg:h-11"><Plus className="h-3.5 w-3.5" strokeWidth={2.25} />Add item</button>
                        <button type="button" onClick={() => setShowLoadModal(true)} className={rundownButton}><FolderOpen className="h-3.5 w-3.5" />Load from date or template</button>
                      </div> : null}
                    </div>
                  </div>
                ) : (
                  <VirtualRows items={timedItems} getKey={rundownRowKey} getScrollParent={rundownScrollParent}
                    estimateSize={estimateRundownRow} pinnedIds={[timer.currentItemId, draggedItemId]} gap={0} className="overflow-hidden rounded-b-2xl"
                    renderRow={(item, idx, rowProps) => {
                      const isCurrent = item.id === timer.currentItemId;
                      const config = TYPE_CONFIG[item.type];
                      const Icon = config.icon;
                      const isDraggingItem = draggedItemId === item.id;
                      const isDropTarget =
                        dropTargetItemId === item.id &&
                        draggedItemId !== item.id;
                      const number = itemNumbers.get(item.id) ?? String(idx + 1);
                      const label = item.title || (item.type === "header" ? "Section" : "item");
                      const dragHandle = canEditRundown ? (
                        <button type="button" aria-label={`Reorder ${label}`} aria-describedby="rundown-reorder-help"
                          draggable
                          onDragStart={(event) => handleItemDragStart(event, item.id)}
                          onDragEnd={handleItemDragEnd}
                          onTouchStart={() => handleItemTouchStart(item.id)}
                          onTouchMove={handleItemTouchMove}
                          onTouchEnd={handleItemTouchEnd}
                          onTouchCancel={handleItemDragEnd}
                          className={`rundown-drag-handle inline-flex h-11 w-7 cursor-grab touch-none select-none items-center justify-center rounded-md active:cursor-grabbing max-lg:w-11 ${isDraggingItem ? "text-fire-400" : "text-[var(--sa-ink-3)] hover:text-board-text lg:[@media(hover:hover)_and_(pointer:fine)]:opacity-0 lg:[@media(hover:hover)_and_(pointer:fine)]:group-hover:opacity-100 lg:[@media(hover:hover)_and_(pointer:fine)]:focus-visible:opacity-100"}`}
                          title="Drag to reorder"
                        >
                          <GripVertical className="h-3.5 w-3.5" />
                        </button>
                      ) : <span />;
                      const actions = (extra?: React.ReactNode) => canEditRundown ? (
                        <span className="rundown-row-actions flex w-[88px] shrink-0 items-center justify-end transition-opacity lg:w-[68px] lg:[@media(hover:hover)_and_(pointer:fine)]:opacity-0 lg:[@media(hover:hover)_and_(pointer:fine)]:group-hover:opacity-100 lg:[@media(hover:hover)_and_(pointer:fine)]:focus-within:opacity-100 lg:[@media(hover:hover)_and_(pointer:fine)]:has-[[data-state=open]]:opacity-100">
                          {extra}
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <button type="button" className={rowIconButton} title="Item actions" aria-label={`Actions for ${label}`}>
                                <MoreHorizontal className="h-4 w-4" />
                              </button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="min-w-[180px]">
                              <DropdownMenuItem onSelect={() => setEditingItem(item)}><Pencil className="h-3.5 w-3.5" />Edit</DropdownMenuItem>
                              <DropdownMenuItem disabled={idx === 0} onSelect={() => handleMoveItem(item.id, "up")}><ChevronUp className="h-3.5 w-3.5" />Move up</DropdownMenuItem>
                              <DropdownMenuItem disabled={idx === items.length - 1} onSelect={() => handleMoveItem(item.id, "down")}><ChevronDown className="h-3.5 w-3.5" />Move down</DropdownMenuItem>
                              {!isCurrent ? <>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem variant="destructive" onSelect={() => handleRemoveItem(item.id)}><Trash2 className="h-3.5 w-3.5" />Delete…</DropdownMenuItem>
                              </> : null}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </span>
                      ) : <span />;

                      // A section band is structure, not running order: no
                      // clock and no play button. It reorders and deletes like
                      // anything else so the blocks can be moved as the
                      // service is planned.
                      if (item.type === "header") {
                        const section = projection.plan.sections.get(item.id);
                        return (
                          <div
                            key={item.id}
                            {...rowProps}
                            data-rundown-item-id={item.id}
                            data-editable={canEditRundown}
                            onDragOver={(event) => handleItemDragOver(event, item.id)}
                            onDrop={(event) => handleItemDrop(event, item.id)}
                            className={`rundown-section-row group grid min-h-11 grid-cols-[28px_36px_minmax(0,1fr)_56px_auto] items-center gap-x-3 bg-board-bg pr-3 shadow-[inset_0_1px_0_var(--sa-border),inset_0_-1px_0_var(--sa-border)] max-lg:grid-cols-[44px_32px_minmax(0,1fr)_48px_auto] ${
                              isDraggingItem ? "opacity-60" : ""
                            } ${isDropTarget ? "shadow-[inset_0_0_0_1px_rgba(255,193,7,0.4)]" : ""}`}
                          >
                            {dragHandle}
                            <span className="rundown-row-number tabular-nums text-xs text-[var(--sa-ink-3)]">{number}</span>
                            <p className="rundown-row-title flex min-w-0 flex-wrap items-baseline gap-x-2.5">
                              <span className="break-words text-xs font-semibold uppercase tracking-[0.07em] text-board-text">{item.title || "Section"}</span>
                              {section?.start != null && section.duration > 0 ? <span className="tabular-nums text-xs text-[var(--sa-ink-3)]">{dayTime(section.start, deviceTimeZone, hour12)}–{dayTime(section.start + section.duration, deviceTimeZone, hour12)}</span> : null}
                            </p>
                            <span className="rundown-row-duration text-right tabular-nums text-xs text-[var(--sa-ink-3)]">{formatMinutes(section?.duration ?? 0)}</span>
                            {actions()}
                          </div>
                        );
                      }

                      const done = item.status === "complete";
                      const upNext = item.id === upNextId;
                      const planned = projection.plan.starts.get(item.id) ?? null;
                      const actual = projection.projected.get(item.id);
                      return (
                        <div
                          key={item.id}
                          {...rowProps}
                          data-rundown-item-id={item.id}
                          data-editable={canEditRundown}
                          aria-current={isCurrent ? "step" : undefined}
                          onDragOver={(event) => handleItemDragOver(event, item.id)}
                          onDrop={(event) => handleItemDrop(event, item.id)}
                          className={`rundown-row group relative grid min-h-[52px] grid-cols-[28px_36px_44px_16px_minmax(0,1fr)_auto_56px_auto] items-center gap-x-3 py-1 pr-3 transition-[background-color,opacity,box-shadow] max-lg:grid-cols-[44px_32px_44px_minmax(0,1fr)_auto_48px_auto] ${
                            isDraggingItem ? "opacity-60" : ""
                          } ${
                            isCurrent
                              ? "bg-fire-500/[0.10] shadow-[inset_0_1px_0_var(--sa-border),inset_2px_0_0_var(--color-fire-500)]"
                              : isDropTarget
                                ? "shadow-[inset_0_0_0_1px_rgba(255,193,7,0.4)]"
                                : "shadow-[inset_0_1px_0_var(--sa-border)] hover:bg-[var(--sa-surface-2)]"
                          }`}
                        >
                          {dragHandle}
                          <span className={`rundown-row-number tabular-nums text-xs ${isCurrent ? "text-fire-400" : "text-[var(--sa-ink-3)]"}`}>{number}</span>
                          <span className={`rundown-row-time tabular-nums text-[13px] ${isCurrent ? "text-fire-400" : done ? "text-[var(--sa-ink-3)]" : "text-[var(--sa-ink-2)]"}`}>{dayTime(planned, deviceTimeZone, hour12)}</span>
                          <Icon aria-hidden="true" className={`rundown-row-icon h-3.5 w-3.5 max-lg:hidden ${isCurrent ? "text-fire-400" : "text-[var(--sa-ink-3)]"}`} strokeWidth={1.75} />
                          <div className="rundown-row-title flex min-w-0 flex-col gap-0.5">
                            <p className={`rundown-item-title truncate text-[13px] ${isCurrent ? "font-semibold text-fire-400" : done ? "text-[var(--sa-ink-2)]" : "font-medium text-board-text"}`}>
                              {item.title || "Untitled"}
                            </p>
                            {(item.assignee || item.notes || actual) && (
                              <p className="truncate text-xs text-[var(--sa-ink-3)]">
                                {item.assignee}
                                {item.assignee && item.notes ? " · " : ""}
                                {item.notes}
                                {actual ? <span className={`tabular-nums text-[var(--sa-warn)] ${item.assignee || item.notes ? "ml-2" : ""}`}>{dayTime(actual.start, deviceTimeZone, hour12)} – {dayTime(actual.end, deviceTimeZone, hour12)}</span> : null}
                              </p>
                            )}
                          </div>
                          <span className="rundown-row-badge flex justify-end">
                            {isCurrent ? <RundownOffset timer={timer} duration={item.duration} initialNow={initialNow} />
                              : done ? <Check aria-label="Done" className="h-3.5 w-3.5 text-[var(--sa-ink-3)]" strokeWidth={2} />
                              : upNext ? <span className="inline-flex h-5 items-center rounded-full border border-[var(--sa-border-strong)] px-2 text-xs text-[var(--sa-ink-2)]">Next</span> : null}
                          </span>
                          <span className={`rundown-row-duration text-right tabular-nums text-[13px] ${done ? "text-[var(--sa-ink-3)]" : "font-medium text-board-text"}`}>{formatMinutes(item.duration)}</span>
                          {actions(!isCurrent && !done ? (
                              <button type="button" disabled={!transportAvailable} onClick={() => handleStart(item.id)}
                                className={`${rowIconButton} hover:text-[var(--sa-ok)]`} title="Start" aria-label={`Start ${label}`}>
                                <Play className="h-3.5 w-3.5" />
                              </button>
                            ) : undefined)}
                          {isCurrent && (
                            <div className="absolute inset-x-0 bottom-0 h-0.5">
                              <RundownProgress timer={timer} duration={item.duration} initialNow={initialNow}
                                overtimeBehavior={overtimeBehavior} id="rundown-item-progress" />
                            </div>
                          )}
                        </div>
                      );
                    }} />
                )}
              </div>
            </section>
          </div>
        )}

        {canEditRundown && showAddForm && (
          <ItemFormModal
            mode="add"
            showLabel={`Goes into ${selectedShowName} · ${formatDisplayDate(serviceDate)}`}
            initial={{ title: "", type: "segment", duration: defaultItemDuration, assignee: "", notes: "" }}
            positions={addPositions}
            onSubmit={handleAddItem}
            onClose={() => setShowAddForm(false)}
          />
        )}
        {canEditRundown && editingItem && (
          <ItemFormModal
            mode="edit"
            showLabel={`${selectedShowName} · ${formatDisplayDate(serviceDate)}`}
            initial={{ title: editingItem.title, type: editingItem.type, duration: formatDurationForInput(editingItem.duration), assignee: editingItem.assignee, notes: editingItem.notes }}
            onSubmit={(title, type, duration, assignee, notes) =>
              handleEditItem(
                editingItem.id,
                title,
                type,
                duration,
                assignee,
                notes,
              )
            }
            onClose={() => setEditingItem(null)}
          />
        )}
        {canEditRundown && showLoadModal && (
          <LoadRundownModal
            key={rundownScope}
            currentItemCount={items.length}
            playing={timer.playback === "play"}
            revision={cloudRevision}
            orgId={orgId}
            timeZone={deviceTimeZone}
            onLoad={handleLoadItems}
            onClose={() => setShowLoadModal(false)}
          />
        )}
        {canEditRundown && showSaveModal && (
          <SaveRundownModal
            key={rundownScope}
            orgId={orgId}
            items={items}
            initialServiceName={serviceName}
            initialStartTime={scheduledStartTime}
            onClose={() => setShowSaveModal(false)}
          />
        )}
        {showOptionsModal ? (
          <ShowOptionsModal
            busy={selectionBusy}
            canCreate={canCreateShow}
            canEdit={canEditRundown}
            onClose={() => setShowOptionsModal(false)}
            onCreate={() => {
              setShowOptionsModal(false);
              setShowCreateModal(true);
            }}
            onDateChange={(date) => void loadDate(date)}
            onCallTimeChange={handleScheduledCallChange}
            onNameChange={handleServiceNameChange}
            onSelectShow={(show) => void loadDate(show.serviceDate, show.id)}
            onShiftDate={handleDateChange}
            onStartTimeChange={handleScheduledStartChange}
            onToday={() =>
              void loadDate(getTodayDateString(settings["org-timezone"]))
            }
            selectedDate={serviceDate}
            selectedShowId={showId}
            serviceName={serviceName}
            callTime={scheduledCallTime}
            shows={shows}
            startTime={scheduledStartTime}
            timeZone={deviceTimeZone}
          />
        ) : null}
        {canCreateShow && showCreateModal ? (
          <NewShowModal
            currentDate={serviceDate}
            currentStartTime={scheduledStartTime}
            orgId={orgId}
            userId={user.id}
            currentShowId={showId}
            timeZone={deviceTimeZone}
            beforeCreate={async signal => {await waitForCurrentRundownWrites();signal.throwIfAborted();}}
            onCreated={async(result,signal)=>{
              const opened=await loadDate(result.serviceDate,result.showId,signal);
              signal.throwIfAborted();
              if(!opened)throw new Error("The show was created, but the rundown could not open. Retry opening it.");
              setShowCreateModal(false);
            }}
            onClose={() => setShowCreateModal(false)}
          />
        ) : null}
        <ConfirmDialog
          open={syncHydrated && syncConnected && canEditRundown && !!showId && !relayMatchesTarget && dismissedSwitch !== switchScope}
          onOpenChange={(open) => { if (!open) setDismissedSwitch(switchScope); }}
          title="Switch this room to the selected show?"
          description="The current rundown will be replaced only after the selected show's rundown is saved successfully."
          confirmLabel="Switch show"
          variant="warning"
          onConfirm={() => {
            sendCommand("switch-show", { showId, serviceDate });
            seedState(databaseItemsRef.current, initialState.timer, false, {
              serviceName, scheduledStartTime: scheduledStartIso, scheduledCallTime: scheduledCallIso,
            });
            setDismissedSwitch(switchScope);
          }}
        />
        <ResetRundownDialog open={resetScope === rundownScope} onOpenChange={(open) => setResetScope(open ? rundownScope : null)} playing={timer.playback === "play"} onReset={resetConfirmed} />
        <ConfirmDialog
          open={deleteItem?.scope === rundownScope}
          onOpenChange={(open) => { if (!open) setDeleteItem(null); }}
          title="Delete this rundown item?"
          description={deleteItem?.id === timer.currentItemId ? "This deletes the current item and ends the running timer for all operators. Undo restores the item without restarting playback." : "This removes the item from this rundown. You can undo the deletion for 30 seconds."}
          confirmLabel="Delete item"
          onConfirm={confirmRemoveItem}
        />
        {removedItem?.scope === rundownScope && (
          <div role="status" className="fixed bottom-5 left-1/2 z-50 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-xl border border-board-border bg-board-card px-4 py-2 shadow-xl">
            <span className="min-w-0 truncate text-sm text-board-text">Removed {removedItem.item.title}</span>
            <Button variant="ghost" type="button" disabled={!canEditRundown} onClick={undoRemoveItem} className="min-h-11 shrink-0 rounded-lg px-3 text-sm font-semibold text-fire-500">Undo</Button>
            <Button variant="ghost" type="button" onClick={() => setRemovedItem(null)} aria-label="Dismiss item deletion" className="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-board-muted"><X className="h-4 w-4" /></Button>
          </div>
        )}
        {endShowDialog}
        <TakeLiveDialog
          open={showTakeLiveConfirmation}
          onOpenChange={setShowTakeLiveConfirmation}
          showName={selectedShowName}
          liveName={liveShowName}
          pending={activePublishPending}
          onConfirm={takeSelectedShowLive}
        />
        <ConfirmDialog
          open={showClearConfirmation}
          onOpenChange={setShowClearConfirmation}
          title={`Clear all ${items.length} ${items.length === 1 ? "item" : "items"}?`}
          description={`Every section and item in ${selectedShowName} will be removed, including durations and notes, and the timer stops for everyone following it. Save it as a template first if you might want it back.`}
          confirmLabel="Clear all items"
          variant="danger"
          onConfirm={handleClearAll}
        />
      </div>
    </div>
  );
}

export type ItemPosition = { key: string; label: string; index: number | null; startsAt: string | null };

/** Add or edit a rundown item (Rundown — A "Add rundown item"). Sections take no time. */
function ItemFormModal({
  mode,
  showLabel,
  initial,
  positions,
  onSubmit,
  onClose,
}: {
  mode: "add" | "edit";
  showLabel: string;
  initial: { title: string; type: ItemType; duration: string; assignee: string; notes: string };
  positions?: ItemPosition[];
  onSubmit: (title: string, type: ItemType, duration: string, assignee: string, notes: string, index: number | null) => void;
  onClose: () => void;
}) {
  const fieldId = useId();
  const workspaceTerms = useWorkspaceTerms();
  const [title, setTitle] = useState(initial.title);
  const [type, setType] = useState<ItemType>(initial.type);
  const [duration, setDuration] = useState(initial.duration);
  const [assignee, setAssignee] = useState(initial.assignee);
  const [notes, setNotes] = useState(initial.notes);
  const [position, setPosition] = useState(positions?.at(-1)?.key ?? "end");
  const isSection = type === "header";
  const chosen = positions?.find((option) => option.key === position) ?? null;
  const durationOk = isSection || parseDurationInput(duration) > 0;

  const submit = () => {
    if (!title.trim() || !durationOk) return;
    onSubmit(title.trim(), type, isSection ? "0:00" : duration, isSection ? "" : assignee.trim(), isSection ? "" : notes.trim(), chosen?.index ?? null);
  };
  const label = "mb-1.5 block text-[13px] font-medium text-board-text";
  const field = "h-10 w-full rounded-lg border border-[var(--sa-border-strong)] bg-[var(--sa-surface-2)] px-3 text-base text-board-text outline-none placeholder:text-[var(--sa-ink-3)] focus:border-fire-500 sm:text-[13px] max-lg:h-11";

  return (
    <ModalA className="rundown-modal sm:max-w-[560px]" title={mode === "add" ? isSection ? "Add section" : "Add rundown item" : isSection ? "Edit section" : "Edit rundown item"} description={showLabel} onClose={onClose}>
      <form onSubmit={(event) => { event.preventDefault(); submit(); }} onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); submit(); } }} className="flex flex-col gap-5">
        <fieldset>
          <legend className={label}>Type</legend>
          <div className="flex flex-wrap gap-1.5">
            {(Object.keys(TYPE_CONFIG) as ItemType[]).map((t) => {
              const config = TYPE_CONFIG[t];
              const Icon = config.icon;
              return (
                <button key={t} type="button" onClick={() => setType(t)} aria-pressed={type === t}
                  className={`inline-flex h-9 items-center gap-2 rounded-lg border px-3 text-[13px] max-lg:h-11 ${type === t ? "border-[var(--sa-border-strong)] bg-[var(--sa-surface-3)] font-medium text-board-text shadow-[inset_0_0_0_1px_var(--sa-border-strong)]" : "border-[var(--sa-border)] text-[var(--sa-ink-2)] hover:text-board-text"}`}>
                  <Icon className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
                  {config.label}
                </button>
              );
            })}
          </div>
        </fieldset>
        <div>
          <label htmlFor={`${fieldId}-title`} className={label}>Title</label>
          <input type="text" id={`${fieldId}-title`} value={title} onChange={(e) => setTitle(e.target.value)} autoFocus maxLength={200}
            placeholder={isSection ? workspaceCopy("e.g. Pre-service", workspaceTerms) : workspaceCopy("e.g. Keynote Block", workspaceTerms)} className={field} />
        </div>
        {!isSection && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-[180px_minmax(0,1fr)]">
            <div>
              <label htmlFor={`${fieldId}-duration`} className={label}>Duration (mm:ss)</label>
              <input type="text" id={`${fieldId}-duration`} value={duration} onChange={(e) => setDuration(e.target.value)} placeholder="5:00" inputMode="numeric"
                aria-invalid={!durationOk} className={`${field} tabular-nums ${durationOk ? "" : "border-[var(--sa-danger)]"}`} />
              {!durationOk ? <p className="mt-1.5 text-xs text-[var(--sa-danger)]">Enter a length like 5:00.</p> : null}
            </div>
            <div>
              <label htmlFor={`${fieldId}-assignee`} className={label}>Assignee</label>
              <input type="text" id={`${fieldId}-assignee`} value={assignee} onChange={(e) => setAssignee(e.target.value)} maxLength={200} placeholder="Name or team" className={field} />
            </div>
          </div>
        )}
        {positions && positions.length > 1 ? (
          <div>
            <label htmlFor={`${fieldId}-position`} className={label}>Add to</label>
            <select id={`${fieldId}-position`} value={position} onChange={(e) => setPosition(e.target.value)} className={`${field} appearance-none`}>
              {positions.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
            </select>
            {chosen?.startsAt && !isSection ? <p className="mt-1.5 text-xs text-[var(--sa-ink-3)]">Starts <span className="tabular-nums">{chosen.startsAt}</span> · computed from the items above</p> : null}
          </div>
        ) : null}
        {!isSection && (
          <div>
            <label htmlFor={`${fieldId}-notes`} className={label}>Notes</label>
            <textarea id={`${fieldId}-notes`} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Production notes…" rows={3} maxLength={2000}
              className="w-full resize-none rounded-lg border border-[var(--sa-border-strong)] bg-[var(--sa-surface-2)] px-3 py-2.5 text-base text-board-text outline-none placeholder:text-[var(--sa-ink-3)] focus:border-fire-500 sm:text-[13px]" />
          </div>
        )}
        <div className="-mx-5 -mb-5 flex flex-wrap items-center gap-2 border-t border-[var(--sa-border)] bg-board-bg px-5 py-3.5">
          <span className="mr-auto hidden items-center gap-1.5 text-xs text-[var(--sa-ink-3)] sm:inline-flex"><KeyCombo keys="⌘ + Enter" /> to {mode === "add" ? "add" : "save"}</span>
          <button type="button" onClick={onClose} className={`${modalCancel} max-lg:h-11`}>Cancel</button>
          <button type="submit" disabled={!title.trim() || !durationOk} className={`${modalPrimary} max-lg:h-11`}>{mode === "add" ? isSection ? "Add section" : "Add item" : "Save changes"}</button>
        </div>
      </form>
    </ModalA>
  );
}

function formatDurationForInput(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
