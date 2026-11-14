import { ProPresenterOutputControl } from "@/components/rundown/ProPresenterOutputControl";
import { ProPresenterSlideControls } from "@/components/rundown/ProPresenterSlideControls";
import { runRouteLoad } from "@/lib/route-load-deadlines";
import { VirtualRows } from "@/components/ui/virtual-rows";
import { RundownClockCard, RundownOffset, RundownProgress, formatOperatorDuration as formatDuration } from "@/components/rundown/RundownClock";
import { useProPresenterCommands } from "@/hooks/useProPresenterCommands";
import { useOperatorRead } from "@/hooks/useOperatorRead";
import { ReadFailureNotice } from "@/components/layout/ReadFailureNotice";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ResetRundownDialog } from "@/components/rundown/ResetRundownDialog";
import { SaveRundownModal } from "@/components/rundown/SaveRundownModal";
import { LoadRundownModal } from "@/components/rundown/LoadRundownModal";
import { restoreRundownItem } from "@/lib/rundown-undo";
import { rundownShortcut } from "@/lib/rundown-shortcuts";
import { RundownShortcutBanner, RundownShortcutList } from "@/components/rundown/RundownShortcutHelp";
import { workspaceCopy } from "@showpilot/shared";
import { useTerms as useWorkspaceTerms } from "@/components/workspace/WorkspaceProvider";
import { useDeviceTimeZone } from "@/hooks/useDeviceTimeZone";
import { useShowEndConfirmation } from "@/hooks/useShowEndConfirmation";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { PageSkeleton } from "@/components/ui/Skeleton";
import { nextPlayableItem } from "@/lib/rundown-transport";
import { lazy, Suspense, useState, useEffect, useCallback, useRef, useId } from "react";
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
  Clock,
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
  Wifi,
  WifiOff,
  Download,
  MoreHorizontal,
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
import { computeCascadedTimes, itemOverrunMs } from "@/lib/rundown-timing";
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
import { useDesktopRuntime } from "@/hooks/useDesktopRuntime";
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
const estimateRundownRow = () => 100;
function rundownScrollParent(body: HTMLElement) {
  const section = body.closest<HTMLElement>("#rundown-runsheet");
  return section && getComputedStyle(section).overflowY !== "visible" ? section : body.closest<HTMLElement>(".rundown-columns");
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

const DesktopLocalShowPanel = lazy(() => import("@/components/rundown/DesktopLocalShowPanel").then((module) => ({ default: module.DesktopLocalShowPanel })));

function RundownPage() {
  const { user } = Route.useRouteContext();
  const desktop = useDesktopRuntime();
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
    lastErrorAt: syncErrorAt,
    retryConnection: reconnectRundown,
    saving: syncSaving,
    connected: syncConnected,
    unconfirmedCount,
    hasPendingCommands,
    sendCommand,
    seedState,
  } = useRundownSync(orgId, serviceDate, showId);
  const transportAvailable = canControlRundown && syncConnected;
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
    if (!showId) {
      const nextItems = [...items, item];
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
      setItems((prev) => [...prev, item]);
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
    const preferred = row?.querySelector<HTMLButtonElement>(`button[title="Move ${pending.direction}"]`);
    const fallback = row?.querySelector<HTMLButtonElement>(`button[title="Move ${pending.direction === "up" ? "down" : "up"}"]`);
    (preferred && !preferred.disabled ? preferred : fallback && !fallback.disabled ? fallback : row?.querySelector<HTMLButtonElement>('button[title="Edit"]'))?.focus();
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
  const itemNumbers = rundownItemNumbers(items);
  const selectedShowName =
    serviceName ||
    shows.find((show) => show.id === showId)?.name ||
    "Untitled show";
  const selectedShowIsLive =
    liveTarget.serviceDate === serviceDate &&
    liveTarget.showId === (showId ?? null);
  const takeSelectedShowLive = useCallback(async () => {
    if (!showId || activePublishPending) return;
    setSelectionError(null);
    try {
      await publishTarget(serviceDate, showId);
    } catch (error) {
      setSelectionError(
        error instanceof Error
          ? error.message
          : "Could not route this show to venue outputs",
      );
    }
  }, [activePublishPending, publishTarget, serviceDate, showId]);
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
    <div className="rundown-page h-full flex flex-col overflow-hidden">
      <div className="relative z-10 shrink-0 border-b border-board-border bg-board-bg/80 backdrop-blur-xl">
        <div className="flex min-h-[68px] flex-wrap items-center gap-3 px-4 py-3 sm:px-6">
          <div className="min-w-0 flex-1 basis-full sm:basis-0">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-board-muted">
              Rundown
            </p>
            <h1 className="truncate font-[family-name:var(--font-display)] text-lg font-semibold text-board-text">
              {selectedShowName}
            </h1>
            <p className="mt-0.5 hidden truncate text-xs text-board-muted sm:block">
              {formatDisplayDate(serviceDate)}
              {selectedShowStart ? ` · ${selectedShowStart} start` : ""}
              {selectedShowCall
                ? ` · ${formatWallTime(selectedShowCall)} call`
                : ""}
              {` · ${items.length} items · ${formatDuration(totalDuration)}`}
            </p>
          </div>
          <div className="ml-auto flex max-w-full flex-wrap items-center gap-2">
            <RundownUnlock orgId={orgId} pinAccess={rundownAccess.pin} />
            {selectedShowIsLive ? (
              <span className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-green-500/25 bg-green-500/10 px-3 text-xs font-semibold text-green-300">
                <span className="h-2 w-2 rounded-full bg-green-400" />
                Live output
              </span>
            ) : canEditRundown && showId ? (
              <Button variant="ghost"
                type="button"
                onClick={() => setShowTakeLiveConfirmation(true)}
                disabled={selectionBusy}
                className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-fire-500/35 bg-fire-500/10 px-3 text-xs font-semibold text-fire-300 transition-colors hover:bg-fire-500/20 disabled:opacity-50"
              >
                <Tv className="h-4 w-4" />
                Take live
              </Button>
            ) : null}
            <Button variant="ghost"
              type="button"
              onClick={() => setShowOptionsModal(true)}
              disabled={selectionBusy}
              className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-board-border bg-board-card px-3 text-xs font-semibold text-board-text transition-colors hover:border-fire-500/40 disabled:opacity-50"
              aria-label="Show options"
            >
              <CalendarDays className="h-4 w-4 text-board-muted" />
              <span className="hidden sm:inline">Show options</span>
              {selectionBusy ? (
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-fire-400" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5 text-board-muted" />
              )}
            </Button>
            {canEditRundown ? (
              <>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost"
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-board-muted hover:text-board-text hover:bg-board-border/50 text-xs font-medium transition-colors min-h-[44px]"
                      title="Rundown actions"
                      aria-label="Rundown actions"
                    >
                      <MoreHorizontal className="w-4 h-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-[190px]">
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
                      Reset timer
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      variant="destructive"
                      disabled={items.length === 0}
                      onSelect={() => setShowClearConfirmation(true)}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      Clear all items
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>

                <Button variant="ghost"
                  onClick={() => setShowAddForm(true)}
                  aria-label="Add item"
                  className="group flex min-h-[44px] shrink-0 items-center gap-2.5 rounded-xl px-2 py-1.5 text-black transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_12px_30px_rgba(255,193,7,0.24)] active:translate-y-0 sm:px-2.5 sm:pr-3.5"
                  style={{
                    background:
                      "linear-gradient(135deg, #FFC107 0%, #FF8F00 100%)",
                  }}
                >
                  <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-black/12 ring-1 ring-black/10 transition-colors group-hover:bg-black/16">
                    <Plus className="w-3.5 h-3.5" />
                  </span>
                  <span className="hidden whitespace-nowrap font-[family-name:var(--font-display)] text-sm font-bold tracking-tight sm:inline">
                    Add Item
                  </span>
                </Button>
              </>
            ) : (
              <span className="hidden rounded-lg border border-board-border px-3 py-1.5 text-xs font-medium uppercase tracking-wider text-board-muted sm:inline">
                View only
              </span>
            )}
          </div>
          <p className="basis-full truncate text-xs text-board-muted sm:hidden">
            {formatDisplayDate(serviceDate)}
            {selectedShowStart ? ` · ${selectedShowStart} start` : ""}
            {selectedShowCall
              ? ` · ${formatWallTime(selectedShowCall)} call`
              : ""}
            {` · ${items.length} items · ${formatDuration(totalDuration)}`}
          </p>
        </div>
      </div>

      {desktop && showId && <Suspense fallback={null}>
        <DesktopLocalShowPanel key={`${orgId}:${showId}:${serviceDate}`} orgId={orgId} slug={slug} showId={showId} serviceDate={serviceDate}
          cloudRevision={cloudRevision} canControl={canControlRundown}
          canPrepare={canControlRundown && hasEffectivePermission(role, grantedPermissions, "devices:access") && hasEffectivePermission(role, grantedPermissions, "timecode:access")}
          cloudReady={syncConnected && syncHydrated && syncedInitialized && relayMatchesTarget && !syncSaving && !metaSavePending && !hasPendingCommands() && !saveError && !syncError} />
      </Suspense>}

      {(selectionError || saveError || syncError) && (
        <div
          role="alert"
          className="shrink-0 flex items-start gap-2 px-6 py-2 bg-red-500/15 border-b border-red-500/30 text-[12px] text-red-300"
        >
          <span className="font-medium shrink-0">
            {selectionError
              ? "Show unchanged."
              : saveError
                ? "Not saved."
                : "Rundown sync."}
          </span>
          <span className="min-w-0">
            {selectionError || saveError || syncError}
            {!selectionError && !saveError && syncErrorAt !== null && <time className="ml-2 whitespace-nowrap" dateTime={new Date(syncErrorAt).toISOString()}>{new Date(syncErrorAt).toLocaleTimeString()}</time>}
          </span>
        </div>
      )}

      <ReadFailureNotice {...ppConfiguration} label="Retry ProPresenter configuration" />
      {canControlRundown && <RundownShortcutBanner />}
      {(!syncConnected || unconfirmedCount > 0) && (
        <div role="status" aria-live="polite" className="shrink-0 flex flex-wrap items-center gap-3 border-b border-amber-500/25 bg-amber-500/10 px-4 py-2 text-sm text-amber-200">
          <span className="min-w-0 flex-1 basis-full sm:basis-0">{syncConnected
            ? `Syncing ${unconfirmedCount} ${unconfirmedCount === 1 ? "change" : "changes"}…`
            : !syncHydrated && !syncError ? "Connecting to live rundown…"
            : `Offline, ${unconfirmedCount} changes queued. Transport is unavailable until live state reconnects.`}</span>
          {!syncConnected && (syncHydrated || syncError) && <Button type="button" variant="outline" className="min-h-11" onClick={reconnectRundown}>Reconnect rundown</Button>}
        </div>
      )}
      {/* Page body — flex-col container, never scrolls itself */}
      <div
        className="rundown-page-body flex-1 overflow-hidden flex flex-col"
        style={{ containerType: "inline-size" }}
      >
        {/* Export error */}
        {exportError && (
          <div className="shrink-0 bg-red-500/10 border-b border-red-500/20 px-6 py-2.5 flex items-center gap-3">
            <X className="w-4 h-4 text-red-400 shrink-0" />
            <p className="text-sm text-red-400 flex-1">
              Export failed: {exportError}
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
          <div className="shrink-0 bg-amber-500/10 border-b border-amber-500/20 px-6 py-2.5 flex items-center gap-3">
            <MessageSquare className="w-4 h-4 text-amber-400 shrink-0" />
            <p className="text-sm font-medium text-amber-300 flex-1">
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
          <div className="flex-1 flex items-center justify-center text-board-muted text-sm">
            Loading rundown...
          </div>
        ) : (
          <div className="rundown-columns flex-1 overflow-hidden flex flex-row gap-6 px-4 py-5 sm:px-6 max-w-[1400px] mx-auto w-full min-h-0">
            {/* Left: Timer + Controls + Message */}
            <div className="rundown-panel-left w-[360px] shrink-0 flex flex-col gap-4 overflow-y-auto hide-scrollbar min-h-0">
              <RundownClockCard timer={timer} currentItem={currentItem} nextItem={nextItem}
                initialNow={initialNow} overtimeBehavior={overtimeBehavior} />

              {/* Timer controls */}
              {canControlRundown && (
                <div className="flex gap-2">
                  {timer.playback === "play" ? (
                    <Button variant="ghost"
                      disabled={!transportAvailable}
                      onClick={handlePause}
                      className="flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-yellow-500/15 text-yellow-400 border border-yellow-500/25 font-medium text-sm hover:bg-yellow-500/25 transition-colors disabled:opacity-40"
                    >
                      <Pause className="w-4 h-4" /> Pause
                    </Button>
                  ) : timer.playback === "pause" ? (
                    <Button variant="ghost"
                      disabled={!transportAvailable}
                      onClick={handleResume}
                      className="flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-green-500/15 text-green-400 border border-green-500/25 font-medium text-sm hover:bg-green-500/25 transition-colors disabled:opacity-40"
                    >
                      <Play className="w-4 h-4" /> Resume
                    </Button>
                  ) : (
                    <Button variant="ghost"
                      onClick={() => {
                        const first = items.find(
                          (i) => i.status !== "complete" && i.type !== "header",
                        );
                        if (first) handleStart(first.id);
                      }}
                      disabled={!transportAvailable || items.length === 0}
                      className="flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-green-500/15 text-green-400 border border-green-500/25 font-medium text-sm hover:bg-green-500/25 transition-colors disabled:opacity-40"
                    >
                      <Play className="w-4 h-4" /> Start
                    </Button>
                  )}

                  <Button variant="ghost"
                    onClick={handlePrev}
                    disabled={!transportAvailable || timer.playback === "stop"}
                    className="flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-board-card border border-board-border text-board-text font-medium text-sm hover:bg-board-border/50 transition-colors disabled:opacity-40"
                    title="Previous item"
                    aria-label="Previous rundown item"
                  >
                    <SkipBack className="w-4 h-4" />
                  </Button>
                  <Button variant="ghost"
                    onClick={handleNext}
                    disabled={!transportAvailable || timer.playback === "stop"}
                    className="flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-board-card border border-board-border text-board-text font-medium text-sm hover:bg-board-border/50 transition-colors disabled:opacity-40"
                    title="Next item"
                    aria-label="Next rundown item"
                  >
                    <SkipForward className="w-4 h-4" />
                  </Button>
                  <Button variant="ghost"
                    onClick={handleStop}
                    disabled={!transportAvailable || timer.playback === "stop"}
                    className="flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 font-medium text-sm hover:bg-red-500/20 transition-colors disabled:opacity-40"
                    aria-label="Stop rundown"
                  >
                    <Square className="w-4 h-4" />
                  </Button>
                </div>
              )}

              {/* Add / Subtract time (OnTime-style) */}
              {canControlRundown && (
                <div className="rounded-xl border border-board-border bg-board-card p-3">
                  <p className="text-xs font-medium text-board-muted uppercase tracking-widest mb-2">
                    Adjust Time
                  </p>
                  {/* Preset buttons */}
                  <div className="flex gap-1.5 mb-2">
                    <Button variant="ghost"
                      onClick={() => handleAdjustTime(-60_000)}
                      disabled={!transportAvailable || timer.playback === "stop"}
                      aria-label="Subtract 1 minute from current item"
                      className="flex-1 flex items-center justify-center gap-1 px-2 py-2 rounded-lg bg-board-bg border border-board-border text-board-text font-medium text-xs hover:bg-board-border/50 transition-colors disabled:opacity-40"
                    >
                      <Minus className="w-3 h-3" /> 1m
                    </Button>
                    <Button variant="ghost"
                      onClick={() => handleAdjustTime(-15_000)}
                      disabled={!transportAvailable || timer.playback === "stop"}
                      aria-label="Subtract 15 seconds from current item"
                      className="flex-1 flex items-center justify-center gap-1 px-2 py-2 rounded-lg bg-board-bg border border-board-border text-board-text font-medium text-xs hover:bg-board-border/50 transition-colors disabled:opacity-40"
                    >
                      <Minus className="w-3 h-3" /> 15s
                    </Button>
                    <Button variant="ghost"
                      onClick={() => handleAdjustTime(15_000)}
                      disabled={!transportAvailable || timer.playback === "stop"}
                      aria-label="Add 15 seconds to current item"
                      className="flex-1 flex items-center justify-center gap-1 px-2 py-2 rounded-lg bg-board-bg border border-board-border text-board-text font-medium text-xs hover:bg-board-border/50 transition-colors disabled:opacity-40"
                    >
                      <Plus className="w-3 h-3" /> 15s
                    </Button>
                    <Button variant="ghost"
                      onClick={() => handleAdjustTime(60_000)}
                      disabled={!transportAvailable || timer.playback === "stop"}
                      aria-label="Add 1 minute to current item"
                      className="flex-1 flex items-center justify-center gap-1 px-2 py-2 rounded-lg bg-board-bg border border-board-border text-board-text font-medium text-xs hover:bg-board-border/50 transition-colors disabled:opacity-40"
                    >
                      <Plus className="w-3 h-3" /> 1m
                    </Button>
                  </div>
                  {/* Custom time input */}
                  <div className="flex gap-1.5">
                    <Button variant="ghost"
                      onClick={() =>
                        handleAdjustTime(-parseAdjustInput(customAdjust))
                      }
                      disabled={
                        !transportAvailable || timer.playback === "stop" ||
                        parseAdjustInput(customAdjust) === 0
                      }
                      className="px-3 py-1.5 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-xs font-medium hover:bg-red-500/20 transition-colors disabled:opacity-40"
                      title="Subtract custom time"
                    >
                      <Minus className="w-3.5 h-3.5" />
                    </Button>
                    <input
                      type="text"
                      value={customAdjust}
                      onChange={(e) => setCustomAdjust(e.target.value)}
                      placeholder="secs or m:ss"
                      aria-label="Custom time adjustment"
                      className="min-w-0 flex-1 px-3 py-1.5 rounded-lg bg-board-bg border border-board-border text-xs text-board-text text-center font-mono placeholder:text-board-muted focus:outline-none focus:border-fire-500/50 transition-colors"
                    />
                    <Button variant="ghost"
                      onClick={() =>
                        handleAdjustTime(parseAdjustInput(customAdjust))
                      }
                      disabled={
                        !transportAvailable || timer.playback === "stop" ||
                        parseAdjustInput(customAdjust) === 0
                      }
                      className="px-3 py-1.5 rounded-lg bg-green-500/10 border border-green-500/20 text-green-400 text-xs font-medium hover:bg-green-500/20 transition-colors disabled:opacity-40"
                      title="Add custom time"
                    >
                      <Plus className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
              )}

              {/* Send message to stage */}
              {canEditRundown && (
                <div className="rounded-xl border border-board-border bg-board-card p-4">
                  <div className="flex items-center justify-between mb-2">
                    <label htmlFor="stage-message" className="text-xs font-medium text-board-muted uppercase tracking-widest">
                      Stage Message
                    </label>
                    <label className="flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={messagePriority}
                        onChange={(e) => setMessagePriority(e.target.checked)}
                        className="w-3 h-3 rounded border-board-border accent-amber-500"
                      />
                      <span
                        className={`text-xs font-medium uppercase tracking-wider ${messagePriority ? "text-amber-400" : "text-board-muted"}`}
                      >
                        Priority
                      </span>
                    </label>
                  </div>
                  {messagePriority && (
                    <p className="text-xs text-amber-400 mb-2">
                      Message shown large, timer shown small on kiosk
                    </p>
                  )}
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={message}
                      onChange={(e) => setMessage(e.target.value)}
                      onKeyDown={(e) =>
                        e.key === "Enter" && handleSendMessage()
                      }
                      id="stage-message"
                      placeholder="Message to stage display..."
                      className="min-w-0 min-h-11 flex-1 px-3 py-2 rounded-lg bg-board-bg border border-board-border text-sm text-board-text placeholder:text-board-muted focus:outline-none focus:border-fire-500/50 transition-colors"
                    />
                    <Button variant="ghost"
                      onClick={handleSendMessage}
                      disabled={!message.trim()}
                      className={`p-2 rounded-lg transition-colors disabled:opacity-40 ${messagePriority ? "bg-amber-500/25 text-amber-300 hover:bg-amber-500/35" : "bg-amber-500/15 text-amber-400 hover:bg-amber-500/25"}`}
                      aria-label="Send stage message"
                    >
                      <Send className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              )}

              {/* ProPresenter Slide Feed */}
              {(ppHost || syncedPpSlide) && (
                <div
                  className={`rounded-xl border p-4 transition-colors ${ppEnabled ? "border-purple-500/30 bg-purple-500/5" : "border-board-border bg-board-card"}`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                    <div className="flex items-center gap-2">
                      <Tv className="w-3.5 h-3.5 text-purple-400" />
                      <p className="text-xs font-medium text-board-muted uppercase tracking-widest">
                        ProPresenter
                      </p>
                    </div>
                    {(canEditRundown || canControlRundown) && (
                      <>
                        <Button variant="ghost"
                          onClick={togglePP}
                          className={`min-h-11 flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium uppercase tracking-wider transition-colors ${
                            ppEnabled
                              ? "bg-purple-500/20 text-purple-300 hover:bg-purple-500/30"
                              : "bg-board-bg text-board-muted hover:bg-board-border"
                          }`}
                        >
                          {ppEnabled ? (
                            <Wifi className="w-3 h-3" />
                          ) : (
                            <WifiOff className="w-3 h-3" />
                          )}
                          {ppEnabled ? pp.isStreaming ? "Streaming" : "Reconnecting" : "Off"}
                        </Button>
                      </>
                    )}
                  </div>

                  {(canEditRundown || canControlRundown) && <ProPresenterOutputControl orgId={orgId} userId={user.id} surface="rundown" enabled /> }
                  {ppCommands.failure && (
                    <div role="alert" aria-label="ProPresenter command confirmation" className="my-3 space-y-2 text-sm text-amber-200">
                      <p>{ppCommands.failure.message} <time dateTime={new Date(ppCommands.failure.occurredAt).toISOString()}>{new Date(ppCommands.failure.occurredAt).toLocaleTimeString()}</time></p>
                      {ppCommands.canCheck && <Button type="button" variant="outline" className="min-h-11 h-auto whitespace-normal" onClick={() => void ppCommands.checkStatus()}>Check command status</Button>}
                      {ppCommands.canAcknowledge && <Button type="button" variant="outline" className="min-h-11 h-auto whitespace-normal" onClick={ppCommands.acknowledgeReview}>I've checked the output</Button>}
                    </div>
                  )}
                  {ppCommands.previousContext && <p role="status" className="my-2 text-sm text-board-muted">This action started before the show or ProPresenter settings changed. Its result belongs to that earlier action.</p>}
                  {ppCommands.notice && <p role="status" aria-live="polite" className="my-2 text-sm text-green-400">{ppCommands.notice}</p>}
                  {ppCommands.pending && <p role="status" aria-live="polite" className="my-2 text-sm text-board-muted">{ppCommands.checking ? "Checking the original command status…" : "Waiting for ProPresenter confirmation…"}</p>}

                  {ppEnabled && (
                    <>
                      {/* Connection status */}
                      <div className="flex items-center gap-2 mb-2">
                        <div
                          className={`w-2 h-2 rounded-full ${
                            ppIsConnected
                              ? "bg-green-500 shadow-[0_0_4px_rgba(34,197,94,0.5)]"
                              : pp.status === "connecting"
                                ? "bg-amber-500 animate-pulse"
                                : pp.status === "error"
                                  ? "bg-red-500"
                                  : "bg-gray-500"
                          }`}
                        />
                        <span className="text-xs text-board-muted">
                          {pp.status === "error"
                            ? "Reconnecting, showing last confirmed slide"
                            : ppIsConnected
                              ? "Connected through venue Bridge"
                              : pp.status === "connecting"
                                ? "Connecting..."
                                : "Waiting for venue Bridge..."}
                        </span>
                      </div>

                      <ReadFailureNotice error={pp.error && pp.errorAt !== null ? { message: pp.error, occurredAt: pp.errorAt } : null} refreshing={pp.refreshing} retry={pp.connect} label="Reconnect ProPresenter feed" />

                      {/* PP Control Buttons */}
                      {canControlRundown && (ppCuesEnabled && ppApiPort ? (
                        <div className="mb-2"><ProPresenterSlideControls scope={ppCommandScope}
                          disabled={ppControlsBlocked || !showId || !syncConnected || !pp.isStreaming}
                          onCommand={command => void handleProPresenterCommand(command)} />
                          {!showId && <p className="mt-2 text-xs text-board-muted">Open or create a show before controlling ProPresenter.</p>}
                        </div>
                      ) : <p className="text-xs text-board-muted mb-2">{!ppCuesEnabled
                        ? 'Enable "Send cues" in Settings → ProPresenter to control slides'
                        : "Set API Port in Settings → ProPresenter to control slides"}</p>)}

                      {/* Current slide preview */}
                      {activePpSlide && activePpSlide.text ? (
                        <div
                          className={`rounded-lg p-3 ${activePpSlide.isScripture ? "bg-purple-500/10 border border-purple-500/20" : "bg-blue-500/10 border border-blue-500/20"}`}
                        >
                          {activePpSlide.presentationName && (
                            <p
                              className={`text-xs font-medium uppercase tracking-wider mb-1 ${activePpSlide.isScripture ? "text-purple-400" : "text-blue-400"}`}
                            >
                              {activePpSlide.presentationName}
                            </p>
                          )}
                          <p
                            className={`text-sm leading-snug ${activePpSlide.isScripture ? "text-purple-200 italic" : "text-blue-100"}`}
                          >
                            {activePpSlide.text.length > 120
                              ? activePpSlide.text.slice(0, 120) + "..."
                              : activePpSlide.text}
                          </p>
                          <p className="text-xs text-board-muted mt-1.5">
                            {ppSource === "bridge"
                              ? "Rundown preview"
                              : "Direct ProPresenter preview"}
                          </p>
                        </div>
                      ) : (
                        <div>
                          <p className="text-xs text-board-muted italic">
                            Waiting for slide content from ProPresenter...
                          </p>
                          {/* Debug info — helps troubleshoot why slides aren't appearing */}
                          {pp.debugInfo && (
                            <div className="mt-2 rounded-lg bg-board-bg/80 border border-board-border/50 p-2 space-y-1">
                              <p className="text-xs font-medium text-board-muted uppercase tracking-wider">
                                Debug
                              </p>
                              <div className="text-xs text-board-muted font-mono space-y-0.5">
                                <p>
                                  Bridge:{" "}
                                  {pp.debugInfo.wsConnected ? "open" : "closed"}{" "}
                                  | msgs: {pp.debugInfo.wsMessagesReceived}
                                </p>
                                {pp.debugInfo.lastWsMessage && (
                                  <p
                                    className="truncate max-w-full"
                                    title={pp.debugInfo.lastWsMessage}
                                  >
                                    Last event:{" "}
                                    {pp.debugInfo.lastWsMessage.slice(0, 80)}
                                  </p>
                                )}
                                <p>
                                  Poll:{" "}
                                  {pp.debugInfo.pollingActive
                                    ? "active"
                                    : "inactive"}{" "}
                                  | ok: {pp.debugInfo.pollSuccessCount}
                                </p>
                                {pp.debugInfo.lastPollResult && (
                                  <p
                                    className="truncate max-w-full"
                                    title={pp.debugInfo.lastPollResult}
                                  >
                                    Poll:{" "}
                                    {pp.debugInfo.lastPollResult.slice(0, 80)}
                                  </p>
                                )}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </>
                  )}

                  {!ppEnabled && (
                    <p className="text-xs text-board-muted">
                      Stream lyrics & scripture from ProPresenter to stage
                      display
                    </p>
                  )}
                </div>
              )}

              {/* Shortcuts */}
              {canControlRundown && (
                <div className="rounded-xl border border-board-border bg-board-card/50 p-4">
                  <p className="text-xs font-medium text-board-muted uppercase tracking-widest mb-2">
                    Shortcuts
                  </p>
                  <RundownShortcutList />
                </div>
              )}
            </div>

            {/* Right: Runsheet */}
            <section id="rundown-runsheet" tabIndex={-1} aria-label="Rundown items" className="rundown-panel-right flex-1 min-w-0 flex flex-col overflow-y-auto hide-scrollbar rounded focus-visible:outline-2 focus-visible:outline-fire-500">
              <div className="flex min-w-0 flex-col min-h-full">
                <p id="rundown-reorder-help" className="sr-only">Drag the handle to reorder, or use the Move up and Move down buttons with a keyboard.</p>
                {/* Runsheet header — sticky within its own scroll container */}
                <div className="flex flex-wrap items-center justify-between gap-2 mb-3 shrink-0 sticky top-0 z-10 bg-board-bg/95 backdrop-blur-sm py-1 -mt-1">
                  <h2 className="text-xs font-medium text-board-muted uppercase tracking-widest">
                    Runsheet
                  </h2>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs tabular-nums text-board-muted">
                    <span>{items.length} items</span>
                    {completedDuration > 0 && (
                      <span>
                        {formatDuration(completedDuration)} /{" "}
                        {formatDuration(totalDuration)}
                      </span>
                    )}
                    <span>{formatDuration(remainingDuration)} remaining</span>
                  </div>
                </div>

                {items.length === 0 ? (
                  <div className="flex-1 flex flex-col items-center justify-center gap-3">
                    <Clock className="w-10 h-10 text-board-muted" />
                    <p className="text-sm text-board-muted">
                      No items in the rundown
                    </p>
                    <p className="text-xs text-board-muted">
                      {canEditRundown
                        ? 'Click "Add Item" or "Load" to get started'
                        : "No rundown items are available for this date"}
                    </p>
                  </div>
                ) : (
                  <VirtualRows items={timedItems} getKey={rundownRowKey} getScrollParent={rundownScrollParent}
                    estimateSize={estimateRundownRow} pinnedIds={[timer.currentItemId, draggedItemId]} gap={2} className="pr-1"
                    renderRow={(item, idx, rowProps) => {
                      const isCurrent = item.id === timer.currentItemId;
                      const config = TYPE_CONFIG[item.type];
                      const Icon = config.icon;
                      const isDraggingItem = draggedItemId === item.id;
                      const isDropTarget =
                        dropTargetItemId === item.id &&
                        draggedItemId !== item.id;

                      // A section band is structure, not running order: no
                      // duration, no clock, no play button. It reorders and
                      // deletes like anything else so the blocks can be moved
                      // as the service is planned.
                      if (item.type === "header") {
                        return (
                          <div
                            key={item.id}
                            {...rowProps}
                            data-rundown-item-id={item.id}
                            data-editable={canEditRundown}
                            onDragOver={(event) =>
                              handleItemDragOver(event, item.id)
                            }
                            onDrop={(event) => handleItemDrop(event, item.id)}
                            className={`rundown-section-row group flex items-center gap-2 px-3 py-1.5 border-l-2 border-board-muted/40 bg-board-border/25 ${
                              isDraggingItem ? "opacity-60" : ""
                            } ${isDropTarget ? "shadow-[0_0_0_1px_rgba(255,193,7,0.28)]" : ""}`}
                          >
                            {canEditRundown && (
                              <Button variant="ghost" size="icon" type="button" aria-label={`Reorder ${item.title || "item"}`} aria-describedby="rundown-reorder-help"
                                draggable
                                onDragStart={(event) =>
                                  handleItemDragStart(event, item.id)
                                }
                                onDragEnd={handleItemDragEnd}
                                onTouchStart={() =>
                                  handleItemTouchStart(item.id)
                                }
                                onTouchMove={handleItemTouchMove}
                                onTouchEnd={handleItemTouchEnd}
                                onTouchCancel={handleItemDragEnd}
                                className="rundown-drag-handle h-11 w-11 shrink-0 rounded cursor-grab active:cursor-grabbing touch-none select-none text-board-muted hover:text-board-text"
                                title="Drag to reorder"
                              >
                                <GripVertical className="w-3.5 h-3.5" />
                                </Button>
                            )}
                            <p className="rundown-row-title flex-1 min-w-0 break-words text-xs font-semibold uppercase tracking-[0.12em] text-board-muted">
                              {item.title || "Section"}
                            </p>
                            {canEditRundown && (
                              <div className="rundown-row-actions flex flex-wrap shrink-0 items-center gap-0.5">
                                <Button variant="ghost"
                                  onClick={() => setEditingItem(item)}
                                  className="p-1.5 rounded text-board-muted hover:text-fire-500 hover:bg-fire-500/10 transition-colors"
                                  title="Edit" aria-label={`Edit ${item.title || "item"}`}
                                >
                                  <Pencil className="w-3.5 h-3.5" />
                                </Button>
                                <Button variant="ghost"
                                  onClick={() => handleMoveItem(item.id, "up")}
                                  disabled={idx === 0}
                                  className="p-1 rounded text-board-muted hover:text-board-text hover:bg-board-border/30 transition-colors disabled:opacity-20"
                                  title="Move up" aria-label={`Move up ${item.title || "item"}`}
                                >
                                  <ChevronUp className="w-3.5 h-3.5" />
                                </Button>
                                <Button variant="ghost"
                                  onClick={() =>
                                    handleMoveItem(item.id, "down")
                                  }
                                  disabled={idx === items.length - 1}
                                  className="p-1 rounded text-board-muted hover:text-board-text hover:bg-board-border/30 transition-colors disabled:opacity-20"
                                  title="Move down" aria-label={`Move down ${item.title || "item"}`}
                                >
                                  <ChevronDown className="w-3.5 h-3.5" />
                                </Button>
                                <Button variant="ghost"
                                  onClick={() => handleRemoveItem(item.id)}
                                  className="p-1 rounded text-board-muted hover:text-red-400 hover:bg-red-500/10 transition-colors"
                                  title="Delete" aria-label={`Delete ${item.title || "item"}`}
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </Button>
                              </div>
                            )}
                          </div>
                        );
                      }

                      // Extract the bg color class for the binder bar
                      const binderColor = isCurrent
                        ? "bg-fire-500"
                        : item.status === "complete"
                          ? "bg-green-500/40"
                          : config.color.split(" ")[0].replace("/15", "/60");

                      return (
                        <div
                          key={item.id}
                          {...rowProps}
                          data-rundown-item-id={item.id}
                            data-editable={canEditRundown}
                          onDragOver={(event) =>
                            handleItemDragOver(event, item.id)
                          }
                          onDrop={(event) => handleItemDrop(event, item.id)}
                          className={`group flex border transition-[colors,opacity,box-shadow] ${
                            isDraggingItem
                              ? "opacity-60 border-fire-500/30"
                              : isDropTarget
                                ? "border-fire-500/50 shadow-[0_0_0_1px_rgba(255,193,7,0.28)]"
                                : "border-transparent"
                          } ${
                            isCurrent
                              ? "bg-fire-500/8"
                              : item.status === "complete"
                                ? "bg-board-card/15"
                                : "bg-board-card/30 hover:bg-board-card/50"
                          }`}
                        >
                          {/* Left binder bar (OnTime-style) */}
                          <div
                            className={`rundown-row-binder w-10 shrink-0 flex flex-col items-center justify-center gap-1 ${binderColor} ${
                              isCurrent ? "text-black" : "text-white"
                            }`}
                          >
                            <span className="text-xs font-bold tabular-nums">
                              {itemNumbers.get(item.id) ?? idx + 1}
                            </span>
                            {item.status === "live" && (
                              <div className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />
                            )}
                          </div>

                          {/* Content area */}
                          <div className="flex-1 min-w-0 flex flex-col">
                            {/* Main row */}
                            <div className="rundown-row-main flex items-center gap-3 px-3 py-2">
                              {canEditRundown && (
                                <Button variant="ghost" size="icon" type="button" aria-label={`Reorder ${item.title || "item"}`} aria-describedby="rundown-reorder-help"
                                  draggable
                                  onDragStart={(event) =>
                                    handleItemDragStart(event, item.id)
                                  }
                                  onDragEnd={handleItemDragEnd}
                                  onTouchStart={() =>
                                    handleItemTouchStart(item.id)
                                  }
                                  onTouchMove={handleItemTouchMove}
                                  onTouchEnd={handleItemTouchEnd}
                                  onTouchCancel={handleItemDragEnd}
                                  className={`rundown-drag-handle h-11 w-11 shrink-0 rounded cursor-grab active:cursor-grabbing touch-none select-none ${
                                    isDraggingItem
                                      ? "text-fire-400 bg-fire-500/10"
                                      : "text-board-muted hover:text-board-text hover:bg-board-border/30"
                                  } transition-colors`}
                                  title="Drag to reorder"
                                >
                                  <GripVertical className="w-3.5 h-3.5" />
                                </Button>
                              )}

                              {/* Duration */}
                              <span
                                className={`rundown-row-duration shrink-0 text-xs font-mono tabular-nums ${isCurrent ? "text-board-text" : "text-board-muted"}`}
                              >
                                {formatDuration(item.duration)}
                              </span>

                              {/* Divider */}
                              <div
                                className={`rundown-row-divider w-px h-7 shrink-0 ${isCurrent ? "bg-fire-500/30" : "bg-board-border/30"}`}
                              />

                              {/* Title section */}
                              <div className="rundown-row-title flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                  <Icon
                                    className={`w-3.5 h-3.5 shrink-0 ${
                                      isCurrent
                                        ? "text-fire-400"
                                        : config.color.split(" ")[1]
                                    }`}
                                  />
                                  <p
                                    className={`rundown-item-title text-sm font-medium truncate ${
                                      isCurrent
                                        ? "text-fire-400"
                                        : item.status === "complete"
                                          ? "text-board-muted line-through"
                                          : "text-board-text"
                                    }`}
                                  >
                                    {item.title || "Untitled"}
                                  </p>
                                </div>
                                {/* Assignee / notes inline */}
                                {(item.assignee || item.notes) && (
                                  <p className="text-xs text-board-muted truncate mt-0.5 pl-6">
                                    {item.assignee}
                                    {item.assignee && item.notes ? " · " : ""}
                                    {item.notes}
                                  </p>
                                )}
                                {/* Time display: scheduled start and actual times */}
                                {(item.scheduledStart || item.actualStart) && (
                                  <div className="flex flex-wrap items-center gap-2 mt-0.5 pl-6">
                                    {item.scheduledStart && (
                                      <span className="text-xs text-board-muted tabular-nums font-mono">
                                        {formatTimeInput(
                                          item.scheduledStart,
                                          deviceTimeZone,
                                        )}{" "}
                                        sched
                                      </span>
                                    )}
                                    {item.actualStart && (
                                      <span
                                        className={`text-xs tabular-nums font-mono ${
                                          item.status === "complete"
                                            ? (() => {
                                                const overrun =
                                                  itemOverrunMs(item);
                                                return overrun !== null &&
                                                  overrun > 30000
                                                  ? "text-red-400"
                                                  : "text-green-400";
                                              })()
                                            : "text-fire-400"
                                        }`}
                                      >
                                        {formatTimeInput(
                                          item.actualStart,
                                          deviceTimeZone,
                                        )}
                                        {item.actualEnd &&
                                          ` – ${formatTimeInput(item.actualEnd, deviceTimeZone)}`}
                                        {item.status === "complete" &&
                                          (() => {
                                            const overrun = itemOverrunMs(item);
                                            if (overrun === null) return null;
                                            const sign = overrun > 0 ? "+" : "";
                                            return ` (${sign}${Math.round(overrun / 1000)}s)`;
                                          })()}
                                      </span>
                                    )}
                                  </div>
                                )}
                              </div>

                              {isCurrent && <RundownOffset timer={timer} duration={item.duration} initialNow={initialNow} />}

                              {/* Row actions stay visible for pointer, keyboard and touch operators */}
                              {canEditRundown && (
                                <div
                                  className="rundown-row-actions flex flex-wrap items-center gap-0.5 shrink-0"
                                >
                                  {!isCurrent && item.status !== "complete" && (
                                    <Button variant="ghost"
                                      disabled={!transportAvailable}
                                      onClick={() => handleStart(item.id)}
                                      className="p-1.5 rounded text-board-muted hover:text-green-400 hover:bg-green-500/10 transition-colors"
                                      title="Start" aria-label={`Start ${item.title || "item"}`}
                                    >
                                      <Play className="w-3.5 h-3.5" />
                                    </Button>
                                  )}
                                  <Button variant="ghost"
                                    onClick={() => setEditingItem(item)}
                                    className="p-1.5 rounded text-board-muted hover:text-fire-500 hover:bg-fire-500/10 transition-colors"
                                    title="Edit" aria-label={`Edit ${item.title || "item"}`}
                                  >
                                    <Pencil className="w-3.5 h-3.5" />
                                  </Button>
                                  <Button variant="ghost"
                                    onClick={() =>
                                      handleMoveItem(item.id, "up")
                                    }
                                    disabled={idx === 0}
                                    className="p-1 rounded text-board-muted hover:text-board-text hover:bg-board-border/30 transition-colors disabled:opacity-20"
                                    title="Move up" aria-label={`Move up ${item.title || "item"}`}
                                  >
                                    <ChevronUp className="w-3.5 h-3.5" />
                                  </Button>
                                  <Button variant="ghost"
                                    onClick={() =>
                                      handleMoveItem(item.id, "down")
                                    }
                                    disabled={idx === items.length - 1}
                                    className="p-1 rounded text-board-muted hover:text-board-text hover:bg-board-border/30 transition-colors disabled:opacity-20"
                                    title="Move down" aria-label={`Move down ${item.title || "item"}`}
                                  >
                                    <ChevronDown className="w-3.5 h-3.5" />
                                  </Button>
                                  {!isCurrent && (
                                    <Button variant="ghost"
                                      onClick={() => handleRemoveItem(item.id)}
                                      className="p-1 rounded text-board-muted hover:text-red-400 hover:bg-red-500/10 transition-colors"
                                      title="Delete" aria-label={`Delete ${item.title || "item"}`}
                                    >
                                      <Trash2 className="w-3.5 h-3.5" />
                                    </Button>
                                  )}
                                </div>
                              )}
                            </div>

                            {/* Progress bar for current item */}
                            {isCurrent && (
                              <div className="h-0.5 w-full bg-board-border/20">
                                <RundownProgress timer={timer} duration={item.duration} initialNow={initialNow}
                                  overtimeBehavior={overtimeBehavior} id="rundown-item-progress" />
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    }} />
                )}
              </div>
            </section>
          </div>
        )}

        {canEditRundown && showAddForm && (
          <AddItemModal
            defaultDuration={defaultItemDuration}
            onAdd={handleAddItem}
            onClose={() => setShowAddForm(false)}
          />
        )}
        {canEditRundown && editingItem && (
          <EditItemModal
            item={editingItem}
            onSave={(title, type, duration, assignee, notes) =>
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
        <ConfirmDialog
          open={showTakeLiveConfirmation}
          onOpenChange={setShowTakeLiveConfirmation}
          title={`Take ${selectedShowName} live?`}
          description="Timer, lyrics, kiosk, Show Flow, and other venue outputs will switch to this show. Browsing alone never changes them."
          confirmLabel="Take live"
          variant="warning"
          loading={activePublishPending}
          onConfirm={() => void takeSelectedShowLive()}
        />
        <ConfirmDialog
          open={showClearConfirmation}
          onOpenChange={setShowClearConfirmation}
          title="Clear this rundown?"
          description="This removes every rundown item and stops the timer for all connected operators. This action cannot be undone."
          confirmLabel="Clear rundown"
          variant="danger"
          onConfirm={handleClearAll}
        />
      </div>
    </div>
  );
}

function AddItemModal({
  defaultDuration,
  onAdd,
  onClose,
}: {
  defaultDuration: string;
  onAdd: (
    title: string,
    type: ItemType,
    duration: string,
    assignee: string,
    notes: string,
  ) => void;
  onClose: () => void;
}) {
  const fieldId = useId();
  const workspaceTerms = useWorkspaceTerms();
  const [title, setTitle] = useState("");
  const [type, setType] = useState<ItemType>("segment");
  const [duration, setDuration] = useState(defaultDuration);
  const [assignee, setAssignee] = useState("");
  const [notes, setNotes] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    const isSection = type === "header";
    onAdd(
      title.trim(),
      type,
      isSection ? "0:00" : duration,
      isSection ? "" : assignee.trim(),
      isSection ? "" : notes.trim(),
    );
  };

  return (
    <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent aria-describedby={undefined} showCloseButton={false} className="rundown-modal block max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] overflow-y-auto bg-board-card border-board-border rounded-2xl p-4 sm:p-6 max-w-md sm:max-w-md shadow-2xl">
        <DialogTitle className="text-lg font-semibold text-board-text mb-5">
          {type === "header" ? "Add section" : "Add rundown item"}
        </DialogTitle>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm text-board-muted mb-1.5">
              Type
            </label>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {(Object.keys(TYPE_CONFIG) as ItemType[]).map((t) => {
                const config = TYPE_CONFIG[t];
                const Icon = config.icon;
                return (
                  <Button variant="ghost"
                    key={t}
                    type="button"
                    onClick={() => setType(t)}
                    aria-pressed={type === t}
                    className={`flex items-center gap-1.5 px-2.5 py-2 rounded-lg text-xs font-medium border transition-colors ${type === t ? "bg-fire-500/15 text-fire-500 border-fire-500/25" : "text-board-muted border-board-border hover:border-board-muted/50"}`}
                  >
                    <Icon className="w-3 h-3" />
                    {config.label}
                  </Button>
                );
              })}
            </div>
          </div>
          <div>
            <label htmlFor={`${fieldId}-title`} className="block text-sm text-board-muted mb-1.5">
              Title
            </label>
            <input
              type="text"
              id={`${fieldId}-title`}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={
                type === "header"
                  ? workspaceCopy("e.g. Pre-service", workspaceTerms)
                  : workspaceCopy("e.g. Worship Set", workspaceTerms)
              }
              autoFocus
              className="w-full px-4 py-2.5 rounded-xl bg-board-bg border border-board-border text-board-text placeholder:text-board-muted focus:outline-none focus:border-fire-500 transition-colors text-sm"
            />
          </div>
          {type !== "header" && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor={`${fieldId}-duration`} className="block text-sm text-board-muted mb-1.5">
                  Duration (mm:ss)
                </label>
                <input
                  type="text"
                  id={`${fieldId}-duration`}
              value={duration}
                  onChange={(e) => setDuration(e.target.value)}
                  placeholder="5:00"
                  className="w-full px-4 py-2.5 rounded-xl bg-board-bg border border-board-border text-board-text placeholder:text-board-muted focus:outline-none focus:border-fire-500 transition-colors text-sm font-mono"
                />
              </div>
              <div>
                <label htmlFor={`${fieldId}-assignee`} className="block text-sm text-board-muted mb-1.5">
                  Assignee
                </label>
                <input
                  type="text"
                  id={`${fieldId}-assignee`}
              value={assignee}
                  onChange={(e) => setAssignee(e.target.value)}
                  placeholder={workspaceCopy(
                    "e.g. Pastor James",
                    workspaceTerms,
                  )}
                  className="w-full px-4 py-2.5 rounded-xl bg-board-bg border border-board-border text-board-text placeholder:text-board-muted focus:outline-none focus:border-fire-500 transition-colors text-sm"
                />
              </div>
            </div>
          )}
          {type !== "header" && (
            <div>
              <label htmlFor={`${fieldId}-notes`} className="block text-sm text-board-muted mb-1.5">
                Notes
              </label>
              <textarea
                id={`${fieldId}-notes`}
              value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Production notes..."
                rows={2}
                className="w-full px-4 py-2.5 rounded-xl bg-board-bg border border-board-border text-board-text placeholder:text-board-muted focus:outline-none focus:border-fire-500 transition-colors text-sm resize-none"
              />
            </div>
          )}
          <div className="flex gap-3 pt-2">
            <Button variant="ghost"
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2.5 rounded-xl border border-board-border text-board-muted hover:bg-board-border transition-colors"
            >
              Cancel
            </Button>
            <Button variant="ghost"
              type="submit"
              disabled={!title.trim()}
              className="flex-1 px-4 py-2.5 rounded-xl bg-fire-500 text-black font-semibold hover:bg-fire-600 disabled:opacity-50 transition-colors"
            >
              Add
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function formatDurationForInput(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function EditItemModal({
  item,
  onSave,
  onClose,
}: {
  item: RundownItem;
  onSave: (
    title: string,
    type: ItemType,
    duration: string,
    assignee: string,
    notes: string,
  ) => void;
  onClose: () => void;
}) {
  const fieldId = useId();
  const workspaceTerms = useWorkspaceTerms();
  const [title, setTitle] = useState(item.title);
  const [type, setType] = useState<ItemType>(item.type);
  const [duration, setDuration] = useState(
    formatDurationForInput(item.duration),
  );
  const [assignee, setAssignee] = useState(item.assignee);
  const [notes, setNotes] = useState(item.notes);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    const isSection = type === "header";
    onSave(
      title.trim(),
      type,
      isSection ? "0:00" : duration,
      isSection ? "" : assignee.trim(),
      isSection ? "" : notes.trim(),
    );
  };

  return (
    <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent aria-describedby={undefined} showCloseButton={false} className="rundown-modal block max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] overflow-y-auto bg-board-card border-board-border rounded-2xl p-4 sm:p-6 max-w-md sm:max-w-md shadow-2xl">
        <DialogTitle className="text-lg font-semibold text-board-text mb-5">
          Edit Item
        </DialogTitle>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm text-board-muted mb-1.5">
              Type
            </label>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {(Object.keys(TYPE_CONFIG) as ItemType[]).map((t) => {
                const config = TYPE_CONFIG[t];
                const Icon = config.icon;
                return (
                  <Button variant="ghost"
                    key={t}
                    type="button"
                    onClick={() => setType(t)}
                    aria-pressed={type === t}
                    className={`flex items-center gap-1.5 px-2.5 py-2 rounded-lg text-xs font-medium border transition-colors ${type === t ? "bg-fire-500/15 text-fire-500 border-fire-500/25" : "text-board-muted border-board-border hover:border-board-muted/50"}`}
                  >
                    <Icon className="w-3 h-3" />
                    {config.label}
                  </Button>
                );
              })}
            </div>
          </div>
          <div>
            <label htmlFor={`${fieldId}-title`} className="block text-sm text-board-muted mb-1.5">
              Title
            </label>
            <input
              type="text"
              id={`${fieldId}-title`}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={
                type === "header"
                  ? workspaceCopy("e.g. Pre-service", workspaceTerms)
                  : workspaceCopy("e.g. Worship Set", workspaceTerms)
              }
              autoFocus
              className="w-full px-4 py-2.5 rounded-xl bg-board-bg border border-board-border text-board-text placeholder:text-board-muted focus:outline-none focus:border-fire-500 transition-colors text-sm"
            />
          </div>
          {type !== "header" && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor={`${fieldId}-duration`} className="block text-sm text-board-muted mb-1.5">
                  Duration (mm:ss)
                </label>
                <input
                  type="text"
                  id={`${fieldId}-duration`}
              value={duration}
                  onChange={(e) => setDuration(e.target.value)}
                  placeholder="5:00"
                  className="w-full px-4 py-2.5 rounded-xl bg-board-bg border border-board-border text-board-text placeholder:text-board-muted focus:outline-none focus:border-fire-500 transition-colors text-sm font-mono"
                />
              </div>
              <div>
                <label htmlFor={`${fieldId}-assignee`} className="block text-sm text-board-muted mb-1.5">
                  Assignee
                </label>
                <input
                  type="text"
                  id={`${fieldId}-assignee`}
              value={assignee}
                  onChange={(e) => setAssignee(e.target.value)}
                  placeholder={workspaceCopy(
                    "e.g. Pastor James",
                    workspaceTerms,
                  )}
                  className="w-full px-4 py-2.5 rounded-xl bg-board-bg border border-board-border text-board-text placeholder:text-board-muted focus:outline-none focus:border-fire-500 transition-colors text-sm"
                />
              </div>
            </div>
          )}
          {type !== "header" && (
            <div>
              <label htmlFor={`${fieldId}-notes`} className="block text-sm text-board-muted mb-1.5">
                Notes
              </label>
              <textarea
                id={`${fieldId}-notes`}
              value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Production notes..."
                rows={2}
                className="w-full px-4 py-2.5 rounded-xl bg-board-bg border border-board-border text-board-text placeholder:text-board-muted focus:outline-none focus:border-fire-500 transition-colors text-sm resize-none"
              />
            </div>
          )}
          <div className="flex gap-3 pt-2">
            <Button variant="ghost"
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2.5 rounded-xl border border-board-border text-board-muted hover:bg-board-border transition-colors"
            >
              Cancel
            </Button>
            <Button variant="ghost"
              type="submit"
              disabled={!title.trim()}
              className="flex-1 px-4 py-2.5 rounded-xl bg-fire-500 text-black font-semibold hover:bg-fire-600 disabled:opacity-50 transition-colors"
            >
              Save
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
