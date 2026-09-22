import {
  createFileRoute,
  Link,
  useBlocker,
  useRouter,
} from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
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
import { buildSongAutomationEvents, formatCueFrame } from "@/lib/song-cues";
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
import { useOrgTimecode } from "@/components/timecode/TimecodeContext";
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
  component: SongStudioPage,
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

function SongStudioPage() {
  const { orgId, slug, role, grantedPermissions, song, settings } =
    Route.useLoaderData();
  const router = useRouter();
  const canManage = hasEffectivePermission(
    role,
    grantedPermissions,
    "songs:manage",
  );
  const timecode = useOrgTimecode();
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
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [draggedSectionId, setDraggedSectionId] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
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
    shouldBlockFn: () => dirty && !allowNavigationRef.current,
    enableBeforeUnload: dirty,
    withResolver: true,
    disabled: !canManage,
  });

  const refresh = async () => {
    await router.invalidate();
  };
  useEffect(() => {
    const nextDraft = draftFromSong(song);
    setMetadata(nextDraft.metadata);
    setSections(song.sections);
    setMapId(nextDraft.cueMap.id);
    setMapName(nextDraft.cueMap.name);
    setFormat(nextDraft.cueMap.format);
    setCues(nextDraft.cueMap.cues);
    setSavedDraft(nextDraft);
  }, [song.id]);
  const chooseMap = async (id: string) => {
    if (id === mapId) return;
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
    const nextDraft = draftFromSong(song, id);
    setMapId(nextDraft.cueMap.id);
    setMapName(nextDraft.cueMap.name);
    setFormat(nextDraft.cueMap.format);
    setCues(nextDraft.cueMap.cues);
    setSavedDraft((current) => ({ ...current, cueMap: nextDraft.cueMap }));
  };
  const captureNext = () => {
    if (tapIndex === null || !timecode.state || sections.length === 0) return;
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

  const saveAll = async (successNotice = true): Promise<boolean> => {
    setBusy(true);
    setNotice(null);
    try {
      const result = await saveSongDraft({
        data: {
          orgId,
          songId: song.id,
          title: currentDraft.metadata.title,
          artist: currentDraft.metadata.artist,
          ccliNumber: currentDraft.metadata.ccliNumber,
          bpm: currentDraft.metadata.bpm
            ? Number(currentDraft.metadata.bpm)
            : null,
          keySignature: currentDraft.metadata.keySignature,
          sections: currentDraft.sections,
          cueMap: {
            cueMapId: currentDraft.cueMap.id || undefined,
            name: currentDraft.cueMap.name,
            frameRate: currentDraft.cueMap.format.frameRate,
            dropFrame: currentDraft.cueMap.format.dropFrame,
            cues: currentDraft.cueMap.cues,
          },
        },
      });
      const nextDraft = {
        ...currentDraft,
        cueMap: { ...currentDraft.cueMap, id: result.cueMapId },
      };
      setMapId(result.cueMapId);
      setSavedDraft(nextDraft);
      if (successNotice) setNotice("All song changes saved.");
      return true;
    } catch (cause) {
      setNotice(
        cause instanceof Error ? cause.message : "Song changes did not save.",
      );
      return false;
    } finally {
      setBusy(false);
    }
  };

  const saveMap = async (): Promise<string | null> => {
    setBusy(true);
    setNotice(null);
    try {
      const result = await saveSongCueMap({
        data: {
          orgId,
          songId: song.id,
          cueMapId: mapId || undefined,
          name: mapName,
          frameRate: format.frameRate,
          dropFrame: format.dropFrame,
          cues,
        },
      });
      setMapId(result.cueMapId);
      setSavedDraft((current) => ({
        ...current,
        cueMap: { ...currentDraft.cueMap, id: result.cueMapId },
      }));
      setNotice("Cue map saved.");
      return result.cueMapId;
    } catch (cause) {
      setNotice(
        cause instanceof Error ? cause.message : "Cue map did not save.",
      );
      return null;
    } finally {
      setBusy(false);
    }
  };
  const loadCues = async () => {
    const savedMapId = await saveMap();
    if (!savedMapId) return;
    const current = await getSong({ data: { orgId, songId: song.id } });
    const map = current.cueMaps.find(
      (candidate) => candidate.id === savedMapId,
    );
    if (!map) return;
    const events = buildSongAutomationEvents({
      song: current,
      cues: map.cues,
      format: parseFormat(map.format),
      target,
      offsetFrames,
      ppPresentationUuid: current.ppPresentationUuid,
      cueMapId: map.id,
    });
    const sourceKey = events[0]?.sourceKey;
    if (!sourceKey) return;
    timecode.replaceEventGroup(sourceKey, events);
    setNotice(
      `${events.length} lyric automation events loaded into Timecode. Loading this map again will replace them.`,
    );
  };
  const nudgeCue = (index: number, delta: number) => {
    const parsed = parseTimecodeString(cues[index]?.triggerTc ?? "");
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
    if (
      from === to ||
      from < 0 ||
      to < 0 ||
      from >= sections.length ||
      to >= sections.length
    )
      return;
    const next = [...sections];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setSections(next);
    try {
      await reorderSongSections({
        data: {
          orgId,
          songId: song.id,
          sectionIds: next.map((item) => item.id),
        },
      });
      const order = new Map(next.map((section, index) => [section.id, index]));
      setSavedDraft((current) => ({
        ...current,
        sections: [...current.sections].sort(
          (left, right) =>
            (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0),
        ),
      }));
    } catch (cause) {
      setSections(sections);
      setNotice(
        cause instanceof Error ? cause.message : "Section order did not save.",
      );
    }
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
    setBusy(true);
    setNotice(null);
    try {
      const presentation = await getProPresenterSong({
        data: { orgId, presentationUuid: song.ppPresentationUuid },
      });
      await importProPresenterSong({
        data: { orgId, presentation, strategy: "merge" },
      });
      await refresh();
      const updated = await getSong({ data: { orgId, songId: song.id } });
      const nextDraft = draftFromSong(updated, mapId);
      setMetadata(nextDraft.metadata);
      setSections(updated.sections);
      setMapId(nextDraft.cueMap.id);
      setMapName(nextDraft.cueMap.name);
      setFormat(nextDraft.cueMap.format);
      setCues(nextDraft.cueMap.cues);
      setSavedDraft(nextDraft);
      setNotice(
        "Updated from ProPresenter. Existing section IDs and cue maps were preserved.",
      );
    } catch (cause) {
      setNotice(
        cause instanceof Error ? cause.message : "ProPresenter update failed.",
      );
    } finally {
      setBusy(false);
    }
  };

  const removeSong = async () => {
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await deleteSong({ data: { orgId, songId: song.id } });
      if (timecode.state?.lyrics?.songId === song.id) timecode.clearLyrics();
      allowNavigationRef.current = true;
      await router.navigate({ to: "/$slug/songs", params: { slug } });
      await router.invalidate();
    } catch (cause) {
      setDeleteError(
        cause instanceof Error ? cause.message : "Song could not be deleted.",
      );
    } finally {
      setDeleteBusy(false);
    }
  };

  return (
    <div className="min-h-full bg-board-bg p-4 sm:p-6">
      <div className="mx-auto max-w-7xl space-y-5">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <Link
              to="/$slug/songs"
              params={{ slug }}
              aria-label="Back to songs"
              className="rounded-xl border border-board-border bg-board-card p-2.5 text-board-muted"
            >
              <ArrowLeft className="h-4 w-4" />
            </Link>
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
                  {dirty ? "Unsaved changes" : "All changes saved"}
                </span>
                <button
                  type="button"
                  disabled={busy || !dirty}
                  onClick={() => void saveAll()}
                  className="inline-flex min-h-10 items-center gap-1.5 rounded-lg bg-fire-500 px-3 text-xs font-bold text-black disabled:opacity-40"
                >
                  <Save className="h-3.5 w-3.5" />
                  {busy ? "Saving…" : "Save all changes"}
                </button>
              </>
            ) : null}
            {song.ppPresentationUuid && canManage ? (
              <button
                disabled={busy}
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
                onClick={() => {
                  setDeleteError(null);
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
                <span
                  className={`h-2 w-2 rounded-full ${timecode.connected ? "bg-green-400" : "bg-red-400"}`}
                />
                {timecode.connected ? timecode.display : "Timecode offline"}
              </div>
            ) : (
              <span className="rounded-full border border-board-border px-3 py-1.5 text-xs text-board-muted">
                Reader mode
              </span>
            )}
          </div>
        </header>
        {notice ? (
          <p
            role="status"
            className="rounded-xl border border-board-border bg-board-card px-4 py-3 text-sm text-board-muted"
          >
            {notice}
          </p>
        ) : null}
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(22rem,.8fr)]">
          <main className="space-y-5">
            <section className="rounded-2xl border border-board-border bg-board-card p-5">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field
                  readOnly={!canManage}
                  label="Title"
                  value={metadata.title}
                  onChange={(title) => setMetadata({ ...metadata, title })}
                />
                <Field
                  readOnly={!canManage}
                  label="Artist"
                  value={metadata.artist}
                  onChange={(artist) => setMetadata({ ...metadata, artist })}
                />
                <Field
                  readOnly={!canManage}
                  label="CCLI number"
                  value={metadata.ccliNumber}
                  onChange={(ccliNumber) =>
                    setMetadata({ ...metadata, ccliNumber })
                  }
                />
                <div className="grid grid-cols-2 gap-3">
                  <Field
                    readOnly={!canManage}
                    label="BPM"
                    value={metadata.bpm}
                    onChange={(bpm) => setMetadata({ ...metadata, bpm })}
                  />
                  <Field
                    readOnly={!canManage}
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
                  onClick={() => {
                    setBusy(true);
                    setNotice(null);
                    void saveSongMetadata({
                      data: {
                        orgId,
                        songId: song.id,
                        title: metadata.title,
                        artist: metadata.artist,
                        ccliNumber: metadata.ccliNumber,
                        bpm: metadata.bpm ? Number(metadata.bpm) : null,
                        keySignature: metadata.keySignature,
                      },
                    })
                      .then(() => {
                        setSavedDraft((current) => ({
                          ...current,
                          metadata,
                        }));
                        setNotice(
                        "Song details saved without changing your other drafts.",
                        );
                      })
                      .catch((cause: unknown) =>
                        setNotice(
                          cause instanceof Error
                            ? cause.message
                            : "Song details did not save.",
                        ),
                      )
                      .finally(() => setBusy(false));
                  }}
                  disabled={busy}
                  className="mt-4 inline-flex items-center gap-2 rounded-xl bg-fire-500 px-4 py-2.5 text-sm font-bold text-black"
                >
                  <Save className="h-4 w-4" />
                  Save song details
                </button>
              ) : null}
            </section>
            <section className="flex min-h-80 flex-col rounded-2xl border border-board-border bg-board-card p-5 xl:max-h-[calc(100dvh-22rem)]">
              <div className="flex shrink-0 items-center justify-between gap-3">
                <div>
                  <h2 className="font-semibold text-board-text">Arrangement</h2>
                  <p className="mt-1 text-xs text-board-muted">
                    Drag sections into show order.
                  </p>
                </div>
                {canManage ? (
                  <button
                    type="button"
                    onClick={async () => {
                      const created = await saveSongSection({
                        data: {
                          orgId,
                          songId: song.id,
                          label: `Section ${sections.length + 1}`,
                          lyrics: "",
                          sourceSlideIndex: null,
                        },
                      });
                      setSections((current) => [...current, created]);
                      setSavedDraft((current) => ({
                        ...current,
                        sections: [
                          ...current.sections,
                          {
                            id: created.id,
                            label: created.label,
                            lyrics: created.lyrics,
                            sourceSlideIndex: created.sourceSlideIndex,
                          },
                        ],
                      }));
                    }}
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
                    draggable={canManage}
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
                        readOnly={!canManage}
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
                            disabled={index === 0}
                            onClick={() => void moveSection(index, index - 1)}
                            className="p-2 text-board-muted disabled:opacity-20"
                          >
                            <ChevronUp className="h-4 w-4" />
                          </button>
                          <button
                            aria-label="Move section down"
                            disabled={index === sections.length - 1}
                            onClick={() => void moveSection(index, index + 1)}
                            className="p-2 text-board-muted disabled:opacity-20"
                          >
                            <ChevronDown className="h-4 w-4" />
                          </button>
                        </>
                      ) : null}
                    </div>
                    <textarea
                      readOnly={!canManage}
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
                        canManage
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
                            onClick={() =>
                              void saveSongSection({
                                data: {
                                  orgId,
                                  songId: song.id,
                                  sectionId: section.id,
                                  label: section.label,
                                  lyrics: section.lyrics,
                                  sourceSlideIndex: section.sourceSlideIndex,
                                },
                              }).then((saved) => {
                                setSections((current) =>
                                  current.map((item) =>
                                    item.id === saved.id
                                      ? { ...item, ...saved }
                                      : item,
                                  ),
                                );
                                setSavedDraft((current) =>
                                  reconcileSavedSection(current, {
                                    id: saved.id,
                                    label: saved.label,
                                    lyrics: saved.lyrics,
                                    sourceSlideIndex: saved.sourceSlideIndex,
                                  }),
                                );
                                setNotice(
                                  `${saved.label} saved without changing your other drafts.`,
                                );
                              })
                            }
                            className="text-xs font-semibold text-fire-500"
                          >
                            Save section
                          </button>
                          <button
                            aria-label={`Delete ${section.label}`}
                            onClick={async () => {
                              const mapped = song.cueMaps.some((map) =>
                                map.cues.some(
                                  (cue) => cue.sectionId === section.id,
                                ),
                              );
                              if (mapped) {
                                const approved = await confirm({
                                  title: `Delete ${section.label}?`,
                                  description:
                                    "This section is used in a cue map. Deleting it also removes every cue mapped to it.",
                                  confirmLabel: "Delete section",
                                  variant: "danger",
                                });
                                if (!approved) return;
                              }
                              void deleteSongSection({
                                data: {
                                  orgId,
                                  songId: song.id,
                                  sectionId: section.id,
                                  confirmMapped: mapped,
                                },
                              })
                                .then(() => {
                                  setSections((current) =>
                                    current.filter(
                                      (item) => item.id !== section.id,
                                    ),
                                  );
                                  setCues((current) =>
                                    current.filter(
                                      (cue) => cue.sectionId !== section.id,
                                    ),
                                  );
                                  setSavedDraft((current) => ({
                                    ...current,
                                    sections: current.sections.filter(
                                      (item) => item.id !== section.id,
                                    ),
                                    cueMap: {
                                      ...current.cueMap,
                                      cues: current.cueMap.cues.filter(
                                        (cue) => cue.sectionId !== section.id,
                                      ),
                                    },
                                  }));
                                })
                                .catch((cause: unknown) =>
                                  setNotice(
                                    cause instanceof Error
                                      ? cause.message
                                      : "Section did not delete.",
                                  ),
                                );
                            }}
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
          </main>
          <aside className="space-y-5 xl:sticky xl:top-6 xl:self-start">
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
              timecode={timecode.display}
              onClear={canManage ? timecode.clearLyrics : undefined}
            />
            {canManage ? (
              <section className="rounded-2xl border border-board-border bg-board-card p-5">
                <div className="flex flex-wrap items-end gap-3">
                  <label className="min-w-40 flex-1 text-xs text-board-muted">
                    Cue map
                    <select
                      value={mapId}
                      onChange={(event) =>
                        void chooseMap(event.target.value)
                      }
                      className="mt-2 w-full rounded-xl border border-board-border bg-board-bg p-2.5 text-sm text-board-text"
                    >
                      <option value="">New cue map</option>
                      {song.cueMaps.map((map) => (
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
                <div className="mt-3 grid grid-cols-3 gap-2">
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
                      className="grid grid-cols-[1fr_8rem_auto] gap-2"
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
                        className="min-w-0 rounded-lg border border-board-border bg-board-bg p-2 text-xs text-board-text"
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
                <div className="mt-4 grid grid-cols-[1fr_auto] gap-2">
                  <select
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
                    disabled={busy || !cues.length}
                    onClick={() => void loadCues()}
                    className="inline-flex items-center gap-2 rounded-xl bg-fire-500 px-4 text-sm font-bold text-black disabled:opacity-40"
                  >
                    <Upload className="h-4 w-4" />
                    Load cues
                  </button>
                </div>
                <button
                  disabled={busy}
                  onClick={() => void saveMap()}
                  className="mt-2 w-full rounded-xl border border-board-border p-2.5 text-sm font-semibold text-board-text"
                >
                  {busy ? "Saving…" : "Save cue map"}
                </button>
              </section>
            ) : (
              <section className="rounded-2xl border border-board-border bg-board-card p-5">
                <h2 className="text-sm font-semibold text-board-text">
                  Cue maps
                </h2>
                <p className="mt-1 text-xs text-board-muted">
                  Timing maps are view-only in Reader mode.
                </p>
                <div className="mt-4 flex flex-col gap-2">
                  {song.cueMaps.length ? (
                    song.cueMaps.map((map) => (
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
            cueMapCount={song.cueMaps.length}
            busy={deleteBusy}
            error={deleteError}
            onClose={() => {
              if (!deleteBusy) setDeleteOpen(false);
            }}
            onDelete={() => void removeSong()}
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
                This song has unsaved details, lyrics, or cue-map changes. Save
                them before leaving, discard them deliberately, or keep editing.
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
                disabled={busy}
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
  timecode: string;
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
          {lyrics}
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
