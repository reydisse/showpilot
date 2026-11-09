import { PageBreadcrumb } from "@/components/ui/PageBreadcrumb";
import {
  createFileRoute,
  Link,
  useBlocker,
  useRouter,
} from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { TimecodeDisplay, TimecodeText } from "@/components/timecode/TimecodeDisplay";
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  GripVertical,
  MonitorPlay,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  Upload,
} from "lucide-react";
import { hasEffectivePermission } from "@/lib/app-permissions";
import { useConfirmedWrite } from "@/hooks/useConfirmedWrite";
import { useSongLibraryRefresh } from "@/components/SongLibraryRefresh";
import { withOperationTimeout } from "@/lib/operation-timeout";
import { DeleteSongModal } from "@/components/SongDialogs";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { buildSongAutomationEvents, formatCueFrame, readSongCueFormat } from "@/lib/song-cues";
import { insertPastedLyrics } from "@/lib/song-lyrics-format";
import {
  deleteSong,
  deleteSongSection,
  getProPresenterSong,
  getSong,
  importProPresenterSong,
  reorderSongSections,
  saveSongDraft,
  saveSongCueMap,
  saveSongMetadata,
  saveSongSection,
} from "@/lib/songs";
import { useShowTimecode, TimecodeShowPicker, TimecodeControlNotice } from "@/components/timecode/TimecodeContext";
import type { FrameRate, TimecodeFormat } from "@/types/timecode";
import { parseTimecodeString, timecodeToFrames } from "@/lib/timecode";
import { getOrgSettings } from "@/lib/settings";
import {
  isCueMapDraftDirty,
  isSongDraftDirty,
  reconcileSavedSection,
  type SongDraft,
  type SongMapDraft,
  type SongMetadataDraft,
  type SongSectionDraft,
} from "@/lib/song-draft";

export const Route = createFileRoute("/$slug/songs/$songId")({
  loader: async ({ context, params }) => {
    const { withPermission } = await import("@/lib/route-permissions");
    await withPermission(
      context.role,
      "songs:access",
      context.slug,
      context.orgId,
    );
    const [song, settings] = await Promise.all([
      getSong({ data: { orgId: context.orgId, songId: params.songId } }),
      getOrgSettings({ data: { orgId: context.orgId } }),
    ]);
    return {
      orgId: context.orgId,
      slug: context.slug,
      role: context.role,
      grantedPermissions: context.grantedPermissions,
      song,
      settings,
    };
  },
  component: SongStudioRoute,
});

type CueDraft = SongMapDraft["cues"][number];

function parseFormat(value: string): TimecodeFormat {
  try {
    const parsed = JSON.parse(value) as Partial<TimecodeFormat>;
    if (
      [24, 25, 29.97, 30].includes(parsed.frameRate as number) &&
      (parsed.dropFrame === "df" || parsed.dropFrame === "ndf")
    )
      return parsed as TimecodeFormat;
  } catch {}
  return { frameRate: 30, dropFrame: "ndf" };
}

function lyricsTarget(
  value: string | undefined,
): "native" | "propresenter" | "both" {
  return value === "native" || value === "propresenter" ? value : "both";
}

type SongRecord = {
  title: string;
  artist: string;
  ccliNumber: string;
  bpm: number | null;
  keySignature: string;
  sections: SongSectionDraft[];
  cueMaps: Array<{
    id: string;
    name: string;
    format: string;
    cues: CueDraft[];
  }>;
};

function draftFromSong(song: SongRecord, preferredMapId?: string): SongDraft {
  const cueMap =
    song.cueMaps.find((candidate) => candidate.id === preferredMapId) ??
    song.cueMaps[0];
  return {
    metadata: {
      title: song.title,
      artist: song.artist,
      ccliNumber: song.ccliNumber,
      bpm: song.bpm ? String(song.bpm) : "",
      keySignature: song.keySignature,
    },
    sections: song.sections.map((section) => ({
      id: section.id,
      label: section.label,
      lyrics: section.lyrics,
      sourceSlideIndex: section.sourceSlideIndex,
    })),
    cueMap: {
      id: cueMap?.id ?? "",
      name: cueMap?.name ?? "Default",
      format: cueMap
        ? parseFormat(cueMap.format)
        : { frameRate: 30, dropFrame: "ndf" },
      cues:
        cueMap?.cues.map((cue) => ({
          sectionId: cue.sectionId,
          triggerTc: cue.triggerTc,
          ppSlideIndex: cue.ppSlideIndex,
        })) ?? [],
    },
  };
}

function SongStudioRoute() {
  const { orgId, song } = Route.useLoaderData();
  return <SongStudioPage key={`${orgId}/${song.id}`} />;
}

function SongStudioPage() {
  const { orgId, slug, role, grantedPermissions, song, settings } =
    Route.useLoaderData();
  const router = useRouter();
  const canManage = hasEffectivePermission(
    role,
    grantedPermissions,
    "songs:manage",
  );
  const timecode = useShowTimecode();
  const [storedSong, setStoredSong] = useState(song);
  const initialDraft = draftFromSong(song);
  const [metadata, setMetadata] =
    useState<SongMetadataDraft>(initialDraft.metadata);
  const [sections, setSections] = useState(song.sections);
  const [mapId, setMapId] = useState(initialDraft.cueMap.id);
  const [mapName, setMapName] = useState(initialDraft.cueMap.name);
  const [format, setFormat] = useState<TimecodeFormat>(
    initialDraft.cueMap.format,
  );
  const [cues, setCues] = useState<CueDraft[]>(initialDraft.cueMap.cues);
  const [savedDraft, setSavedDraft] = useState<SongDraft>(initialDraft);
  const [target, setTarget] = useState<"native" | "propresenter" | "both">(() =>
    lyricsTarget(settings["lyrics-output"]),
  );
  const [offsetFrames, setOffsetFrames] = useState(0);
  const [tapIndex, setTapIndex] = useState<number | null>(null);
  const write = useConfirmedWrite(`${orgId}/${song.id}`);
  const [loadingCues, setLoadingCues] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const cueLoad = useRef<AbortController | null>(null);
  const reviewRead = useRef<AbortController | null>(null);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  useEffect(() => () => { reviewRead.current?.abort(); reviewRead.current = null; }, []);
  const currentTimecode = useRef(timecode);
  currentTimecode.current = timecode;
  const busy = write.state.status === "saving" || loadingCues || reviewBusy;
  const locked = write.state.status !== "idle" || loadingCues || reviewBusy;
  useEffect(() => {
    setLoadingCues(false);
    return () => { cueLoad.current?.abort(); cueLoad.current = null; };
  }, [song.id, timecode.showId]);
  const refreshLibrary = useSongLibraryRefresh();
  const [notice, setNotice] = useState<string | null>(null);
  const [draggedSectionId, setDraggedSectionId] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const deleteBusy = busy && write.state.status === "saving" && write.state.label === "Delete song";
  const deleteError = write.state.status === "failed" && write.state.label === "Delete song" ? write.state.message : null;
  const allowNavigationRef = useRef(false);
  const { confirm, ConfirmDialogEl } = useConfirmDialog();

  const currentDraft = useMemo<SongDraft>(
    () => ({
      metadata,
      sections: sections.map((section) => ({
        id: section.id,
        label: section.label,
        lyrics: section.lyrics,
        sourceSlideIndex: section.sourceSlideIndex,
      })),
      cueMap: { id: mapId, name: mapName, format, cues },
    }),
    [cues, format, mapId, mapName, metadata, sections],
  );
  const dirty = canManage && isSongDraftDirty(currentDraft, savedDraft);
  const blocker = useBlocker({
    shouldBlockFn: () => (dirty || locked) && !allowNavigationRef.current,
    enableBeforeUnload: dirty || locked,
    withResolver: true,
    disabled: !canManage,
  });

  // A navigation requested while a save was settling can resume as soon as
  // its result is confirmed and there are no remaining drafts to discard.
  useEffect(() => {
    if (blocker.status === "blocked" && !dirty && !locked) blocker.proceed?.();
  }, [blocker.status, blocker.proceed, dirty, locked]);
  useEffect(() => {
    const nextDraft = draftFromSong(song);
    setStoredSong(song);
    setMetadata(nextDraft.metadata);
    setSections(song.sections);
    setMapId(nextDraft.cueMap.id);
    setMapName(nextDraft.cueMap.name);
    setFormat(nextDraft.cueMap.format);
    setCues(nextDraft.cueMap.cues);
    setSavedDraft(nextDraft);
  }, [song.id]);
  const chooseMap = async (id: string) => {
    if (locked || id === mapId) return;
    if (isCueMapDraftDirty(currentDraft.cueMap, savedDraft.cueMap)) {
      const discard = await confirm({
        title: "Discard cue-map changes?",
        description:
          "Switching maps will discard the unsaved map name, format, and cue changes. Your song details and lyric drafts will stay here.",
        confirmLabel: "Discard and switch",
        variant: "warning",
      });
      if (!discard) return;
    }
    const nextDraft = draftFromSong(storedSong, id);
    setMapId(nextDraft.cueMap.id);
    setMapName(nextDraft.cueMap.name);
    setFormat(nextDraft.cueMap.format);
    setCues(nextDraft.cueMap.cues);
    setSavedDraft((current) => ({ ...current, cueMap: nextDraft.cueMap }));
  };
  const captureNext = () => {
    if (locked || tapIndex === null || !timecode.state || sections.length === 0) return;
    const section = sections[tapIndex % sections.length];
    setCues((current) => [
      ...current,
      {
        sectionId: section.id,
        triggerTc: timecode.display,
        ppSlideIndex: section.sourceSlideIndex,
      },
    ]);
    setTapIndex((current) => (current === null ? null : current + 1));
  };
  useEffect(() => {
    if (tapIndex === null) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.code !== "Space" && event.code !== "Enter") return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.matches("input, textarea, select, button") ||
          target.isContentEditable)
      )
        return;
      event.preventDefault();
      captureNext();
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  });

  const refreshSavedSong = async (signal: AbortSignal) => {
    const [updated] = await Promise.all([
      getSong({ signal, data: { orgId, songId: song.id } }), refreshLibrary(signal),
    ]);
    if (!signal.aborted) setStoredSong(updated);
  };
  const metadataInput = {
    orgId, songId: song.id, title: metadata.title, artist: metadata.artist,
    ccliNumber: metadata.ccliNumber, bpm: metadata.bpm ? Number(metadata.bpm) : null,
    keySignature: metadata.keySignature,
  };
  const mapInput = {
    orgId, songId: song.id, cueMapId: mapId || undefined, name: mapName,
    frameRate: format.frameRate, dropFrame: format.dropFrame, cues,
  };
  const saveAll = async (successNotice = true): Promise<boolean> => {
    setNotice(null);
    return write.start({
      label: "Save all changes",
      write: (requestId, signal) => saveSongDraft({ signal, data: {
        ...metadataInput, requestId, sections: currentDraft.sections,
        cueMap: { cueMapId: mapId || undefined, name: mapName,
          frameRate: format.frameRate, dropFrame: format.dropFrame, cues },
      } }),
      finish: (_, signal) => refreshSavedSong(signal),
      apply: result => {
        setMapId(result.cueMapId);
        setSavedDraft({ ...currentDraft, cueMap: { ...currentDraft.cueMap, id: result.cueMapId } });
        if (successNotice) setNotice("All song changes saved.");
      },
    });
  };
  const saveMap = async (): Promise<string | null> => {
    setNotice(null);
    let savedId: string | null = null;
    const saved = await write.start({
      label: "Save cue map",
      write: (requestId, signal) => saveSongCueMap({ signal, data: { ...mapInput, requestId } }),
      finish: (_, signal) => refreshSavedSong(signal),
      apply: result => {
        savedId = result.cueMapId;
        setMapId(result.cueMapId);
        setSavedDraft(current => ({ ...current, cueMap: { ...currentDraft.cueMap, id: result.cueMapId } }));
        setNotice("Cue map saved.");
      },
    });
    return saved ? savedId : null;
  };
  const saveMetadata = () => write.start({
    label: "Save song details",
    write: (requestId, signal) => saveSongMetadata({ signal, data: { ...metadataInput, requestId } }),
    finish: (_, signal) => refreshSavedSong(signal),
      apply: () => {
      setSavedDraft(current => ({ ...current, metadata }));
      setNotice("Song details saved without changing your other drafts.");
    },
  });
  const addSection = () => write.start({
    label: "Add section",
    write: (requestId, signal) => saveSongSection({ signal, data: {
      orgId, songId: song.id, requestId, label: `Section ${sections.length + 1}`, lyrics: "", sourceSlideIndex: null,
    } }),
    finish: (_, signal) => refreshSavedSong(signal),
      apply: created => {
      setSections(current => [...current, created]);
      setSavedDraft(current => ({ ...current, sections: [...current.sections, created] }));
      setNotice("Section added.");
    },
  });
  const saveSection = (section: (typeof sections)[number]) => write.start({
    label: "Save section",
    write: (requestId, signal) => saveSongSection({ signal, data: {
      orgId, songId: song.id, requestId, sectionId: section.id, label: section.label,
      lyrics: section.lyrics, sourceSlideIndex: section.sourceSlideIndex,
    } }),
    finish: (_, signal) => refreshSavedSong(signal),
      apply: saved => {
      setSections(current => current.map(item => item.id === saved.id ? { ...item, ...saved } : item));
      setSavedDraft(current => reconcileSavedSection(current, saved));
      setNotice(`${saved.label} saved without changing your other drafts.`);
    },
  });
  const removeSection = async (section: (typeof sections)[number]) => {
    if (locked) return;
    const mapped = cues.some(cue => cue.sectionId === section.id)
      || storedSong.cueMaps.some(map => map.cues.some(cue => cue.sectionId === section.id));
    if (!await confirm({
      title: `Delete ${section.label}?`,
      description: mapped ? "This section is used in a cue map. Deleting it also removes every cue mapped to it."
        : "This permanently removes the section and its lyrics from the song.",
      confirmLabel: "Delete section", variant: "danger",
    })) return;
    await write.start({
      label: "Delete section",
      write: (requestId, signal) => deleteSongSection({ signal, data: { orgId, songId: song.id, sectionId: section.id, confirmMapped: mapped, requestId } }),
      finish: (_, signal) => refreshSavedSong(signal),
      apply: () => {
        setSections(current => current.filter(item => item.id !== section.id));
        setCues(current => current.filter(cue => cue.sectionId !== section.id));
        setSavedDraft(current => ({ ...current, sections: current.sections.filter(item => item.id !== section.id),
          cueMap: { ...current.cueMap, cues: current.cueMap.cues.filter(cue => cue.sectionId !== section.id) } }));
        setNotice("Section deleted.");
      },
    });
  };
  const loadCues = async () => {
    if (locked || cueLoad.current) return;
    setLoadError(null);
    if (!timecode.connected || !timecode.state || timecode.state.running) {
      setLoadError("Connect to the selected show and stop its clock before loading cues."); return;
    }
    if (!Number.isInteger(offsetFrames) || offsetFrames < 0) {
      setLoadError("Cue offset must be a whole number of frames, zero or greater."); return;
    }
    const savedMapId = await saveMap();
    if (!savedMapId) return;
    const controller = new AbortController();
    cueLoad.current = controller;
    setLoadingCues(true);
    try {
      const current = await withOperationTimeout(getSong({ data: { orgId, songId: song.id }, signal: controller.signal }), 10_000, "The saved map could not be read. Retry Load cues.");
      if (controller.signal.aborted || cueLoad.current !== controller) return;
      const live = currentTimecode.current;
      if (live.showId !== timecode.showId || !live.connected || !live.state || live.state.running) throw new Error("The show's connection or clock changed. Stop the clock, then retry loading cues.");
      const map = current.cueMaps.find(candidate => candidate.id === savedMapId);
      if (!map) throw new Error("The saved cue map was removed. Review the song before loading cues.");
      const parsed = readSongCueFormat(map.format, live.state.format);
      if ("error" in parsed) throw new Error(parsed.error);
      const events = buildSongAutomationEvents({ song: current, cues: map.cues, format: parsed.format,
        target, offsetFrames, ppPresentationUuid: current.ppPresentationUuid, cueMapId: map.id });
      const sourceKey = events[0]?.sourceKey;
      if (!sourceKey) throw new Error("Add at least one cue before loading this map.");
      await live.replaceEventGroup(sourceKey, events);
      if (!controller.signal.aborted && cueLoad.current === controller) setNotice(`${events.length} lyric automation events confirmed by Timecode. Loading this map again will replace them.`);
    } catch (error) {
      if (!controller.signal.aborted && cueLoad.current === controller) setLoadError(error instanceof Error ? error.message : "Cue loading could not be confirmed. Retry Load cues.");
    } finally {
      controller.abort();
      if (cueLoad.current === controller) { cueLoad.current = null; setLoadingCues(false); }
    }
  };
  const nudgeCue = (index: number, delta: number) => {
    const parsed = parseTimecodeString(cues[index]?.triggerTc ?? "", format);
    if (!parsed) return;
    const frame = Math.max(0, timecodeToFrames(parsed, format) + delta);
    setCues((current) =>
      current.map((item, itemIndex) =>
        itemIndex === index
          ? { ...item, triggerTc: formatCueFrame(frame, format) }
          : item,
      ),
    );
  };
  const moveSection = async (from: number, to: number) => {
    if (locked || from === to || from < 0 || to < 0 || from >= sections.length || to >= sections.length) return;
    const next = [...sections];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    await write.start({
      label: "Reorder sections",
      write: (requestId, signal) => reorderSongSections({ signal, data: {
        orgId, songId: song.id, sectionIds: next.map(item => item.id), requestId,
      } }),
      finish: (_, signal) => refreshSavedSong(signal),
      apply: () => {
        setSections(next);
        const order = new Map(next.map((section, index) => [section.id, index]));
        setSavedDraft(current => ({ ...current, sections: [...current.sections].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)) }));
        setNotice("Section order saved.");
      },
    });
  };
  const reimport = async () => {
    if (!song.ppPresentationUuid) return;
    if (dirty) {
      const discard = await confirm({
        title: "Discard drafts and update from ProPresenter?",
        description:
          "This update replaces your unsaved song details, lyrics, and cue-map edits. Cancel and use Save all changes if you want to keep them.",
        confirmLabel: "Discard and update",
        variant: "warning",
      });
      if (!discard) return;
    }
    const presentationUuid = song.ppPresentationUuid;
    let presentation: Awaited<ReturnType<typeof getProPresenterSong>> | null = null;
    await write.start({
      label: "Update from ProPresenter",
      write: async (requestId, signal) => {
        if (!presentation) {
          const read = await getProPresenterSong({ signal, data: { orgId, presentationUuid } });
          if (signal.aborted) throw new Error("Reading ProPresenter was cancelled. Retry to read it again.");
          presentation = read;
        }
        return importProPresenterSong({ signal, data: { orgId, presentation, strategy: "merge", requestId } });
      },
      apply: () => {},
      finish: async (result, signal) => {
        const [updated] = await Promise.all([getSong({ signal, data: { orgId, songId: song.id } }), refreshLibrary(signal)]);
        if (signal.aborted) return;
        setStoredSong(updated);
        const nextDraft = draftFromSong(updated, mapId);
        setMetadata(nextDraft.metadata); setSections(updated.sections); setMapId(nextDraft.cueMap.id);
        setMapName(nextDraft.cueMap.name); setFormat(nextDraft.cueMap.format); setCues(nextDraft.cueMap.cues); setSavedDraft(nextDraft);
        const preserved = result.preservedMappedSections?.length ?? 0;
        setNotice(preserved ? `Updated from ProPresenter. ${preserved} mapped sections were preserved; review their timing before loading cues.`
          : "Updated from ProPresenter. Existing section IDs and cue maps were preserved.");
      },
    });
  };

  const removeSong = () => write.start({
    label: "Delete song",
    write: (requestId, signal) => deleteSong({ signal, data: { orgId, songId: song.id, requestId } }),
    apply: () => { if (timecode.state?.lyrics?.songId === song.id) timecode.clearLyrics(); },
    finish: async (_, signal) => {
      await refreshLibrary(signal);
      if (signal.aborted) return;
      allowNavigationRef.current = true;
      await router.navigate({ to: "/$slug/songs", params: { slug } });
    },
  });
  const abandonWrite = async () => {
    if (reviewRead.current || !await confirm({
      title: "Review the stored song and keep your drafts?",
      description: "The earlier change may already be saved. Read the stored song before editing again. Your current text and cue drafts will stay here and be compared with that saved version.",
      confirmLabel: "Keep drafts and edit", variant: "warning",
    })) return;
    const controller = new AbortController();
    reviewRead.current = controller; setReviewBusy(true); setReviewError(null);
    try {
      const [updated] = await withOperationTimeout(Promise.all([
        getSong({ signal: controller.signal, data: { orgId, songId: song.id } }), refreshLibrary(controller.signal),
      ]), 10_000, "Could not read the stored song. Retry reviewing it; your drafts are still here.");
      if (controller.signal.aborted || reviewRead.current !== controller) return;
      setStoredSong(updated); setSavedDraft(draftFromSong(updated, mapId));
      write.discard(); setNotice("Stored song reviewed. Your current drafts were preserved.");
    } catch (error) {
      if (!controller.signal.aborted && reviewRead.current === controller) setReviewError(error instanceof Error ? error.message : "Could not review the saved song.");
    } finally {
      controller.abort();
      if (reviewRead.current === controller) { reviewRead.current = null; setReviewBusy(false); }
    }
  };

  return (
    <div className="min-h-full min-w-0 bg-board-bg p-4 sm:p-6">
      <div className="mx-auto max-w-7xl space-y-5">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <PageBreadcrumb current="Song studio">
              <Link activeOptions={{ exact: true }}
                to="/$slug/songs"
                params={{ slug }}
                aria-label="Back to songs"
                className="inline-flex min-h-11 min-w-11 items-center justify-center gap-2 px-3 outline-none focus-visible:ring-2 focus-visible:ring-fire-500 rounded-xl border border-board-border bg-board-card p-2.5 text-board-muted"
              >
                <ArrowLeft className="h-4 w-4" />
                Songs
              </Link>
            </PageBreadcrumb>
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-fire-500">
                Song studio
              </p>
              <h1 className="truncate text-xl font-semibold text-board-text">
                {metadata.title}
              </h1>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {canManage ? (
              <>
                <span
                  className={`rounded-full border px-3 py-1.5 text-xs font-semibold ${dirty ? "border-amber-400/30 bg-amber-400/10 text-amber-300" : "border-board-border text-board-muted"}`}
                >
                  {loadingCues ? "Waiting for Timecode…" : busy ? "Saving changes…" : locked ? "Change needs review" : dirty ? "Unsaved changes" : "All changes saved"}
                </span>
                {dirty && <button
                  type="button"
                  disabled={locked}
                  onClick={() => void saveAll()}
                  className="inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-fire-500 px-3 text-xs font-bold text-black disabled:opacity-40"
                >
                  <Save className="h-3.5 w-3.5" />
                  {busy ? "Saving…" : "Save all changes"}
                </button>}
              </>
            ) : null}
            {song.ppPresentationUuid && canManage ? (
              <button
                disabled={locked}
                onClick={() => void reimport()}
                className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-board-border bg-board-card px-3 text-xs font-semibold text-board-text disabled:opacity-40"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Check ProPresenter
              </button>
            ) : null}
            {canManage ? (
              <button
                type="button"
                disabled={locked}
                onClick={() => {
                  setDeleteOpen(true);
                }}
                className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-red-500/30 bg-red-500/5 px-3 text-xs font-semibold text-red-300 hover:bg-red-500/10"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete song
              </button>
            ) : null}
            {canManage ? (
              <div className="flex items-center gap-2 text-xs text-board-muted">
                <TimecodeDisplay state={timecode.state} connectionStatus={timecode.connectionStatus} showState />
              </div>
            ) : (
              <span className="rounded-full border border-board-border px-3 py-1.5 text-xs text-board-muted">
                Reader mode
              </span>
            )}
          </div>
        </header>
        {loadError && <div role="alert" className="space-y-2 rounded-xl border border-red-500/30 p-4 text-sm text-red-300">
          <p>{loadError}</p><button type="button" disabled={locked} onClick={() => void loadCues()} className="min-h-11 rounded-lg border border-red-400/40 px-3 disabled:opacity-40">Retry Load cues</button>
        </div>}
        {write.state.status === "failed" && <div role="alert" className="space-y-2 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">
          <p>{write.state.label}: {write.state.saved ? "Saved, but the view could not be refreshed. Retry will not repeat the write." : "Result unconfirmed. Retry the same request to recover its result."}</p>
          <p>{write.state.message}</p>
          {reviewError && <p>{reviewError}</p>}
          {reviewBusy && <p role="status">Reading the stored song before editing…</p>}
          <p className="text-xs">Last attempt: {new Date(write.state.at).toLocaleTimeString()}</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={reviewBusy} onClick={() => void write.retry()} className="min-h-11 rounded-lg border border-red-400/40 px-3">Retry {write.state.label.toLowerCase()}</button>
            <button type="button" disabled={reviewBusy} onClick={() => void abandonWrite()} className="min-h-11 rounded-lg border border-board-border px-3">Keep drafts and edit</button>
          </div>
        </div>}
        {notice && !locked ? (
          <p
            role="status"
            className="rounded-xl border border-board-border bg-board-card px-4 py-3 text-sm text-board-muted"
          >
            {notice}
          </p>
        ) : null}
        <div className="grid min-w-0 grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(22rem,.8fr)]">
          <div className="min-w-0 space-y-5">
            <section className="rounded-2xl border border-board-border bg-board-card p-5">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field
                  readOnly={!canManage || locked}
                  label="Title"
                  value={metadata.title}
                  onChange={(title) => setMetadata({ ...metadata, title })}
                />
                <Field
                  readOnly={!canManage || locked}
                  label="Artist"
                  value={metadata.artist}
                  onChange={(artist) => setMetadata({ ...metadata, artist })}
                />
                <Field
                  readOnly={!canManage || locked}
                  label="CCLI number"
                  value={metadata.ccliNumber}
                  onChange={(ccliNumber) =>
                    setMetadata({ ...metadata, ccliNumber })
                  }
                />
                <div className="grid grid-cols-2 gap-3">
                  <Field
                    readOnly={!canManage || locked}
                    label="BPM"
                    value={metadata.bpm}
                    onChange={(bpm) => setMetadata({ ...metadata, bpm })}
                  />
                  <Field
                    readOnly={!canManage || locked}
                    label="Key"
                    value={metadata.keySignature}
                    onChange={(keySignature) =>
                      setMetadata({ ...metadata, keySignature })
                    }
                  />
                </div>
              </div>
              {canManage ? (
                <button
                  type="button"
                  onClick={() => void saveMetadata()}
                  disabled={locked}
                  className="mt-4 inline-flex items-center gap-2 rounded-xl bg-fire-500 px-4 py-2.5 text-sm font-bold text-black"
                >
                  <Save className="h-4 w-4" />
                  Save song details
                </button>
              ) : null}
            </section>
            <section className="flex min-h-80 flex-col rounded-2xl border border-board-border bg-board-card p-5 xl:max-h-[calc(100dvh-22rem)]">
              <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="font-semibold text-board-text">Arrangement</h2>
                  <p className="mt-1 text-xs text-board-muted">
                    Use the up/down arrows or drag to change the section order.
                  </p>
                </div>
                {canManage ? (
                  <button
                    type="button"
                    disabled={locked}
                    onClick={() => void addSection()}
                    className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-board-border px-3 py-2 text-xs font-semibold text-board-text"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Section
                  </button>
                ) : null}
              </div>
              <div className="modern-scrollbar mt-4 min-h-0 space-y-3 xl:flex-1 xl:overflow-y-auto xl:overscroll-contain xl:pr-2">
                {sections.map((section, index) => (
                  <div
                    key={section.id}
                    draggable={canManage && !locked}
                    onDragStart={() => setDraggedSectionId(section.id)}
                    onDragEnd={() => setDraggedSectionId(null)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={() => {
                      const from = sections.findIndex(
                        (item) => item.id === draggedSectionId,
                      );
                      setDraggedSectionId(null);
                      void moveSection(from, index);
                    }}
                    className={`rounded-xl border bg-board-bg p-3 ${draggedSectionId === section.id ? "border-fire-500/60 opacity-60" : "border-board-border"}`}
                  >
                    <div className="flex gap-2">
                      {canManage ? (
                        <span
                          aria-hidden="true"
                          className="cursor-grab p-2 text-board-muted"
                        >
                          <GripVertical className="h-4 w-4" />
                        </span>
                      ) : null}
                      <input
                        readOnly={!canManage || locked}
                        aria-label={`Section ${index + 1} name`}
                        value={section.label}
                        onChange={(event) =>
                          setSections((current) =>
                            current.map((item) =>
                              item.id === section.id
                                ? { ...item, label: event.target.value }
                                : item,
                            ),
                          )
                        }
                        className="min-w-0 flex-1 bg-transparent text-sm font-semibold text-board-text outline-none read-only:cursor-default"
                      />
                      {canManage ? (
                        <>
                          <button
                            aria-label="Move section up"
                            disabled={locked || index === 0}
                            onClick={() => void moveSection(index, index - 1)}
                            className="min-h-11 min-w-11 rounded-lg p-2 text-board-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-fire-400 disabled:opacity-20"
                          >
                            <ChevronUp className="h-4 w-4" />
                          </button>
                          <button
                            aria-label="Move section down"
                            disabled={locked || index === sections.length - 1}
                            onClick={() => void moveSection(index, index + 1)}
                            className="min-h-11 min-w-11 rounded-lg p-2 text-board-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-fire-400 disabled:opacity-20"
                          >
                            <ChevronDown className="h-4 w-4" />
                          </button>
                        </>
                      ) : null}
                    </div>
                    <textarea
                      readOnly={!canManage || locked}
                      aria-label={`Section ${index + 1} lyrics`}
                      value={section.lyrics}
                      onChange={(event) =>
                        setSections((current) =>
                          current.map((item) =>
                            item.id === section.id
                              ? { ...item, lyrics: event.target.value }
                              : item,
                          ),
                        )
                      }
                      onPaste={
                        canManage && !locked
                          ? (event) => {
                              event.preventDefault();
                              const lyrics = insertPastedLyrics({
                                value: section.lyrics,
                                pastedText:
                                  event.clipboardData.getData("text/plain"),
                                selectionStart:
                                  event.currentTarget.selectionStart,
                                selectionEnd: event.currentTarget.selectionEnd,
                              });
                              setSections((current) =>
                                current.map((item) =>
                                  item.id === section.id
                                    ? { ...item, lyrics }
                                    : item,
                                ),
                              );
                            }
                          : undefined
                      }
                      rows={4}
                      placeholder="Lyrics, up to four display lines per section"
                      className="mt-2 w-full resize-y rounded-lg border border-board-border bg-board-card p-3 text-sm leading-6 text-board-text outline-none read-only:cursor-default"
                    />
                    {canManage ? (
                      <div className="mt-2 flex justify-between">
                        <button
                          onClick={() =>
                            timecode.setLyrics({
                              songId: song.id,
                              songTitle: metadata.title,
                              sectionId: section.id,
                              sectionLabel: section.label,
                              lyrics: section.lyrics,
                              nextLabel: sections[index + 1]?.label ?? "",
                            })
                          }
                          className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-300"
                        >
                          <MonitorPlay className="h-3.5 w-3.5" />
                          Show now
                        </button>
                        <div className="flex gap-2">
                          <button
                            disabled={locked}
                            onClick={() => void saveSection(section)}
                            className="text-xs font-semibold text-fire-500"
                          >
                            Save section
                          </button>
                          <button
                            aria-label={`Delete ${section.label}`}
                            disabled={locked}
                            onClick={() => void removeSection(section)}
                            className="text-red-400"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </section>
          </div>
          <aside className="min-w-0 space-y-5 xl:sticky xl:top-6 xl:self-start">
            <TimecodeShowPicker />
            <TimecodeControlNotice />
            <LyricsPreview
              title={timecode.state?.lyrics?.songTitle ?? metadata.title}
              section={timecode.state?.lyrics?.sectionLabel ?? "Preview"}
              lyrics={
                timecode.state?.lyrics?.lyrics ??
                sections[0]?.lyrics ??
                "Lyrics will appear here"
              }
              next={
                timecode.state?.lyrics?.nextLabel ?? sections[1]?.label ?? ""
              }
              timecode={<TimecodeText state={timecode.state} connected={timecode.connected} />}
              onClear={canManage ? timecode.clearLyrics : undefined}
            />
            {canManage ? (
              <fieldset disabled={locked} className="rounded-2xl border border-board-border bg-board-card p-5">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <label className="min-w-0 text-xs text-board-muted">
                    Cue map
                    <select
                      value={mapId}
                      onChange={(event) =>
                        void chooseMap(event.target.value)
                      }
                      className="mt-2 w-full rounded-xl border border-board-border bg-board-bg p-2.5 text-sm text-board-text"
                    >
                      <option value="">New cue map</option>
                      {storedSong.cueMaps.map((map) => (
                        <option key={map.id} value={map.id}>
                          {map.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <Field
                    label="Map name"
                    value={mapName}
                    onChange={setMapName}
                  />
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
                  <label className="text-xs text-board-muted">
                    FPS
                    <select
                      value={format.frameRate}
                      onChange={(event) =>
                        setFormat({
                          frameRate: Number(event.target.value) as FrameRate,
                          dropFrame:
                            Number(event.target.value) === 29.97
                              ? format.dropFrame
                              : "ndf",
                        })
                      }
                      className="mt-1 w-full rounded-lg border border-board-border bg-board-bg p-2 text-board-text"
                    >
                      <option>24</option>
                      <option>25</option>
                      <option>29.97</option>
                      <option>30</option>
                    </select>
                  </label>
                  <label className="text-xs text-board-muted">
                    Mode
                    <select
                      value={format.dropFrame}
                      onChange={(event) =>
                        setFormat({
                          ...format,
                          dropFrame: event.target.value as "df" | "ndf",
                        })
                      }
                      className="mt-1 w-full rounded-lg border border-board-border bg-board-bg p-2 text-board-text"
                    >
                      <option value="ndf">NDF</option>
                      {format.frameRate === 29.97 ? (
                        <option value="df">DF</option>
                      ) : null}
                    </select>
                  </label>
                  <label className="text-xs text-board-muted">
                    Offset
                    <input
                      type="number"
                      value={offsetFrames}
                      onChange={(event) =>
                        setOffsetFrames(Number(event.target.value))
                      }
                      className="mt-1 w-full rounded-lg border border-board-border bg-board-bg p-2 text-board-text"
                    />
                  </label>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px] text-board-muted">
                  <span>Quick offset</span>
                  {[-5, -2, -1, 0, 1, 2, 5].map((value) => (
                    <button
                      key={value}
                      onClick={() => setOffsetFrames(value)}
                      className={`rounded-md border px-2 py-1 ${offsetFrames === value ? "border-fire-500/50 bg-fire-500/10 text-fire-300" : "border-board-border"}`}
                    >
                      {value > 0 ? `+${value}` : value}f
                    </button>
                  ))}
                </div>
                <div className="mt-4 space-y-2">
                  {cues.map((cue, index) => (
                    <div
                      key={`${index}-${cue.sectionId}`}
                      className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-2 sm:grid-cols-[minmax(0,1fr)_8rem_auto]"
                    >
                      <select
                        aria-label={`Cue ${index + 1} section`}
                        value={cue.sectionId}
                        onChange={(event) =>
                          setCues((current) =>
                            current.map((item, itemIndex) =>
                              itemIndex === index
                                ? { ...item, sectionId: event.target.value }
                                : item,
                            ),
                          )
                        }
                        className="col-span-2 min-w-0 sm:col-span-1 min-w-0 rounded-lg border border-board-border bg-board-bg p-2 text-xs text-board-text"
                      >
                        {sections.map((section) => (
                          <option key={section.id} value={section.id}>
                            {section.label}
                          </option>
                        ))}
                      </select>
                      <div className="flex">
                        <button
                          aria-label="Nudge cue back one frame"
                          onClick={() => nudgeCue(index, -1)}
                          className="border border-board-border px-2 text-board-muted"
                        >
                          −
                        </button>
                        <input
                          aria-label={`Cue ${index + 1} timecode`}
                          value={cue.triggerTc}
                          onChange={(event) =>
                            setCues((current) =>
                              current.map((item, itemIndex) =>
                                itemIndex === index
                                  ? { ...item, triggerTc: event.target.value }
                                  : item,
                              ),
                            )
                          }
                          className="min-w-0 flex-1 border-y border-board-border bg-board-bg px-1 text-center font-mono text-[10px] text-board-text"
                        />
                        <button
                          aria-label="Nudge cue forward one frame"
                          onClick={() => nudgeCue(index, 1)}
                          className="border border-board-border px-2 text-board-muted"
                        >
                          +
                        </button>
                      </div>
                      <button
                        aria-label="Remove cue"
                        onClick={() =>
                          setCues((current) =>
                            current.filter(
                              (_, itemIndex) => itemIndex !== index,
                            ),
                          )
                        }
                        className="p-2 text-red-400"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    disabled={!sections.length}
                    onClick={() =>
                      setCues((current) => [
                        ...current,
                        {
                          sectionId: sections[0].id,
                          triggerTc: timecode.display,
                          ppSlideIndex: sections[0].sourceSlideIndex,
                        },
                      ])
                    }
                    className="rounded-lg border border-board-border px-3 py-2 text-xs font-semibold text-board-text"
                  >
                    <Plus className="mr-1 inline h-3.5 w-3.5" />
                    Cue
                  </button>
                  <button
                    onClick={() => setTapIndex(tapIndex === null ? 0 : null)}
                    className={`rounded-lg px-3 py-2 text-xs font-semibold ${tapIndex === null ? "border border-board-border text-board-text" : "bg-red-500 text-white"}`}
                  >
                    {tapIndex === null
                      ? "Tap-to-mark"
                      : `Mark ${sections[tapIndex % Math.max(1, sections.length)]?.label ?? "next"} · Space`}
                  </button>
                  {tapIndex !== null ? (
                    <button
                      onClick={captureNext}
                      className="rounded-lg bg-fire-500 px-3 py-2 text-xs font-bold text-black"
                    >
                      Mark {timecode.display}
                    </button>
                  ) : null}
                </div>
                <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                  <select
                    aria-label="Cue output"
                    value={target}
                    onChange={(event) =>
                      setTarget(event.target.value as typeof target)
                    }
                    className="rounded-xl border border-board-border bg-board-bg p-2.5 text-sm text-board-text"
                  >
                    <option value="native">Native display</option>
                    <option value="propresenter">ProPresenter</option>
                    <option value="both">Both outputs</option>
                  </select>
                  <button
                    disabled={locked || !cues.length || !timecode.connected || Boolean(timecode.state?.running)}
                    onClick={() => void loadCues()}
                    className="inline-flex items-center gap-2 rounded-xl bg-fire-500 px-4 text-sm font-bold text-black disabled:opacity-40"
                  >
                    <Upload className="h-4 w-4" />
                    Load cues
                  </button>
                </div>
                <button
                  disabled={locked}
                  onClick={() => void saveMap()}
                  className="mt-2 w-full rounded-xl border border-board-border p-2.5 text-sm font-semibold text-board-text"
                >
                  {busy ? "Saving…" : "Save cue map"}
                </button>
              </fieldset>
            ) : (
              <section className="rounded-2xl border border-board-border bg-board-card p-5">
                <h2 className="text-sm font-semibold text-board-text">
                  Cue maps
                </h2>
                <p className="mt-1 text-xs text-board-muted">
                  Cue maps are view-only in Reader mode.
                </p>
                <div className="mt-4 flex flex-col gap-2">
                  {storedSong.cueMaps.length ? (
                    storedSong.cueMaps.map((map) => (
                      <div
                        key={map.id}
                        className="flex items-center justify-between rounded-lg bg-board-bg px-3 py-2 text-xs"
                      >
                        <span className="font-medium text-board-text">
                          {map.name}
                        </span>
                        <span className="text-board-muted">
                          {map.cues.length} cues
                        </span>
                      </div>
                    ))
                  ) : (
                    <p className="text-xs text-board-muted">
                      No cue maps saved.
                    </p>
                  )}
                </div>
              </section>
            )}
          </aside>
        </div>
        {deleteOpen ? (
          <DeleteSongModal
            title={metadata.title}
            sectionCount={song.sections.length}
            cueMapCount={storedSong.cueMaps.length}
            busy={deleteBusy}
            saved={write.state.status !== "idle" && write.state.label === "Delete song" && write.state.saved}
            error={deleteError}
            onClose={() => {
              if (!deleteBusy) setDeleteOpen(false);
            }}
            onDelete={() => void (write.state.status === "failed" ? write.retry() : removeSong())}
          />
        ) : null}
        <Dialog
          open={blocker.status === "blocked"}
          onOpenChange={(open) => {
            if (!open && blocker.status === "blocked") blocker.reset?.();
          }}
        >
          <DialogContent
            showCloseButton={false}
            className="border-board-border bg-board-card sm:max-w-md"
          >
            <DialogHeader>
              <DialogTitle className="text-board-text">
                Save your song changes?
              </DialogTitle>
              <DialogDescription className="text-board-muted">
                {locked ? "A song change is unconfirmed or still refreshing. Stay to retry it. Leaving does not undo a write that reached the server."
                  : "This song has unsaved details, lyrics, or cue-map changes. Save them before leaving, discard them deliberately, or keep editing."}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="gap-2 sm:gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => blocker.reset?.()}
                className="rounded-xl border border-board-border px-4 py-2 text-sm font-semibold text-board-text disabled:opacity-40"
              >
                Keep editing
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => blocker.proceed?.()}
                className="rounded-xl border border-red-500/30 px-4 py-2 text-sm font-semibold text-red-300 disabled:opacity-40"
              >
                Discard and leave
              </button>
              <button
                type="button"
                disabled={locked}
                onClick={() => {
                  void saveAll(false).then((saved) => {
                    if (saved) blocker.proceed?.();
                  });
                }}
                className="rounded-xl bg-fire-500 px-4 py-2 text-sm font-bold text-black disabled:opacity-40"
              >
                {busy ? "Saving…" : "Save and leave"}
              </button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        {ConfirmDialogEl}
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  readOnly = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
}) {
  return (
    <label className="min-w-0 flex-1 text-xs text-board-muted">
      {label}
      <input
        readOnly={readOnly}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-2 w-full rounded-xl border border-board-border bg-board-bg px-3 py-2.5 text-sm text-board-text outline-none read-only:cursor-default read-only:opacity-80"
      />
    </label>
  );
}

function LyricsPreview({
  title,
  section,
  lyrics,
  next,
  timecode,
  onClear,
}: {
  title: string;
  section: string;
  lyrics: string;
  next: string;
  timecode: ReactNode;
  onClear?: () => void;
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-board-border bg-black shadow-2xl">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <div>
          <p className="text-xs font-semibold text-white">{title}</p>
          <p className="text-[10px] uppercase tracking-wider text-amber-400">
            {section}
          </p>
        </div>
        <span className="font-mono text-[10px] text-white/40">{timecode}</span>
      </div>
      <div className="flex min-h-64 items-center justify-center p-7 text-center">
        <p className="whitespace-pre-line text-balance text-2xl font-semibold leading-tight text-white">
          {lyrics.trim() ? lyrics : "Add lyrics to a section to preview them here."}
        </p>
      </div>
      <div className="flex items-center justify-between border-t border-white/10 px-4 py-3 text-[10px] text-white/40">
        <span>{next ? `Next · ${next}` : "End of song"}</span>
        {onClear ? (
          <button onClick={onClear} className="text-white/60">
            Clear output
          </button>
        ) : null}
      </div>
    </section>
  );
}
