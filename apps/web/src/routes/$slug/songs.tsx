import { createFileRoute, Link, Outlet, useParams, useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, LibraryBig, Plus, RefreshCw, Search, Upload, X } from "lucide-react";
import { hasEffectivePermission } from "@/lib/app-permissions";
import { useSongWrite } from "@/hooks/useSongWrite";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { SongLibraryRefresh, useSongLibraryRefresh } from "@/components/SongLibraryRefresh";
import { SongCreateModal } from "@/components/SongDialogs";
import { createSong, getProPresenterSong, importProPresenterSong, listProPresenterSongs, listSongs } from "@/lib/songs";
import { withOperationTimeout } from "@/lib/operation-timeout";

export const Route = createFileRoute("/$slug/songs")({
  loader: async ({ context }) => {
    const { withPermission } = await import("@/lib/route-permissions");
    await withPermission(context.role, "songs:access", context.slug, context.orgId);
    return {
      orgId: context.orgId,
      slug: context.slug,
      role: context.role,
      grantedPermissions: context.grantedPermissions,
      songs: await listSongs({ data: { orgId: context.orgId } }),
    };
  },
  component: SongsRoutePage,
});

type SongLibrary = Awaited<ReturnType<typeof listSongs>>;
function SongsRoutePage() {
  const { songId } = useParams({ strict: false });
  const { orgId, songs } = Route.useLoaderData();
  const [refreshed, setRefreshed] = useState<{ orgId: string; source: SongLibrary; songs: SongLibrary } | null>(null);
  const currentSongs = refreshed?.orgId === orgId && refreshed.source === songs ? refreshed.songs : songs;
  const refresh = async (signal: AbortSignal) => {
    const updated = await listSongs({ data: { orgId }, signal });
    if (!signal.aborted) setRefreshed({ orgId, source: songs, songs: updated });
  };
  return <SongLibraryRefresh value={refresh}>{songId ? <Outlet /> : <SongsLibraryPage key={orgId} songs={currentSongs} />}</SongLibraryRefresh>;
}

function SongsLibraryPage({ songs }: { songs: SongLibrary }) {
  const { orgId, slug, role, grantedPermissions } = Route.useLoaderData();
  const router = useRouter();
  const refreshLibrary = useSongLibraryRefresh();
  const canManage = hasEffectivePermission(role, grantedPermissions, "songs:manage");
  const [query, setQuery] = useState("");
  const [newSong, setNewSong] = useState(false);
  const [importing, setImporting] = useState(false);
  const [presentations, setPresentations] = useState<Awaited<ReturnType<typeof listProPresenterSongs>>["presentations"]>([]);
  const [importQuery, setImportQuery] = useState("");
  const [selectedPresentationId, setSelectedPresentationId] = useState<string | null>(null);
  const importWrite = useSongWrite(`${orgId}/import-song`);
  const importingPresentationId = importWrite.state.status === "saving" ? selectedPresentationId : null;
  const libraryRead = useRef<AbortController | null>(null);
  const { confirm, ConfirmDialogEl } = useConfirmDialog();
  useEffect(() => () => { libraryRead.current?.abort(); libraryRead.current = null; }, []);
  const [importReadState, setImportReadState] = useState<"idle" | "loading" | "complete" | "partial" | "failed">("idle");
  const [failedLibraries, setFailedLibraries] = useState<Array<{ id: string; name: string; error: string }>>([]);
  const [importNotice, setImportNotice] = useState<string | null>(null);
  const [importedSongId, setImportedSongId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const filtered = songs.filter((song) => `${song.title} ${song.artist} ${song.ccliNumber}`.toLowerCase().includes(query.trim().toLowerCase()));
  const normalizedImportQuery = importQuery.trim().toLowerCase();
  const filteredPresentations = normalizedImportQuery
    ? presentations.filter((presentation) => presentation.name.toLowerCase().includes(normalizedImportQuery))
    : presentations;

  const readLibraries = async (libraryIds?: string[]) => {
    if (libraryRead.current) return;
    const controller = new AbortController();
    libraryRead.current = controller;
    setError(null); setImportReadState("loading");
    try {
      const result = await withOperationTimeout(listProPresenterSongs({ signal: controller.signal, data: { orgId, libraryIds } }), 15_000,
        "ProPresenter took too long to list songs. Check the venue Bridge connection and retry.");
      if (libraryRead.current !== controller) return;
      if (!result.connected) throw new Error("Connect ProPresenter through Venue Bridge, then retry.");
      setPresentations(current => {
        const merged = new Map((libraryIds ? current : []).map(item => [item.uuid, item]));
        for (const item of result.presentations) merged.set(item.uuid, item);
        return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
      });
      setFailedLibraries(result.failedLibraries);
      setImportReadState(result.failedLibraries.length ? result.readLibraries === 0 ? "failed" : "partial" : "complete");
    } catch (error) {
      if (libraryRead.current === controller) {
        setError(error instanceof Error ? error.message : "Could not read ProPresenter. Retry reading songs.");
        setImportReadState("failed");
      }
    } finally {
      controller.abort();
      if (libraryRead.current === controller) libraryRead.current = null;
    }
  };
  const openImport = async () => {
    setImporting(true);
    if (importWrite.state.status !== "idle") return;
    setPresentations([]); setImportQuery(""); setImportNotice(null); setImportedSongId(null); setFailedLibraries([]);
    await readLibraries();
  };
  const closeImport = () => {
    if (importWrite.state.status === "saving") return;
    libraryRead.current?.abort(); libraryRead.current = null;
    setImporting(false);
  };
  const retryFailedLibraries = () => readLibraries(failedLibraries.map(library => library.id).filter(Boolean));
  const importPresentation = async (presentationUuid: string) => {
    if (importWrite.state.status !== "idle") return;
    setSelectedPresentationId(presentationUuid); setError(null);
    let presentation: Awaited<ReturnType<typeof getProPresenterSong>> | null = null;
    await importWrite.start({
      label: "Import song",
      write: async (requestId, signal) => {
        if (!presentation) {
          const read = await getProPresenterSong({ signal, data: { orgId, presentationUuid } });
          if (signal.aborted) throw new Error("Reading the presentation was cancelled. Retry to read it again.");
          presentation = read;
        }
        return importProPresenterSong({ signal, data: { orgId, presentation, strategy: "merge", requestId } });
      },
      apply: result => {
        const preserved = result.preservedMappedSections?.length ?? 0;
        setImportedSongId(result.songId);
        setImportNotice(preserved ? `${preserved} timed sections were preserved because ProPresenter changed or removed their source slides. Review the cue map before loading it.` : null);
      },
      finish: async (result, signal) => {
        await refreshLibrary(signal);
        if (!signal.aborted && !result.preservedMappedSections?.length) await router.navigate({ to: "/$slug/songs/$songId", params: { slug, songId: result.songId } });
      },
    });
  };
  const restartImport = async () => {
    if (await confirm({ title: "Read slides for a new import request?", description: "The previous import may already be saved. Starting again reads the current slides and may update that song. Retry first to recover the original result.", confirmLabel: "Start a new import", variant: "warning" })) {
      importWrite.discard(); setImportNotice(null); setImportedSongId(null);
    }
  };

  return <div className="min-h-full bg-board-bg p-4 sm:p-6">
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-fire-500">Lyrics automation</p><h1 className="mt-1 text-2xl font-semibold text-board-text">Songs</h1><p className="mt-1 max-w-xl text-sm text-board-muted">One lyric arrangement and cue map can drive the native stage display, ProPresenter, or both.</p></div>
        {canManage && songs.length > 0 ? <div className="flex gap-2"><button type="button" onClick={() => void openImport()} className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-board-border bg-board-card px-4 text-sm font-semibold text-board-text"><Upload className="h-4 w-4" />Import from ProPresenter</button><button type="button" onClick={() => setNewSong(true)} className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-fire-500 px-4 text-sm font-bold text-black"><Plus className="h-4 w-4" />New song</button></div> : null}
      </header>
      {error ? <p role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">{error}</p> : null}
      {songs.length ? <div className="space-y-4"><label className="flex min-h-11 items-center gap-2 rounded-xl border border-board-border bg-board-card px-3"><Search className="h-4 w-4 text-board-muted" /><span className="sr-only">Search songs</span><input aria-label="Search songs" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search title, artist, or CCLI" className="min-w-0 flex-1 bg-transparent text-sm text-board-text outline-none" /></label>{filtered.length === 0 ? <div role="status" className="rounded-xl border border-board-border p-5 text-sm text-board-muted"><p>No songs match “{query}”.</p><button type="button" onClick={() => setQuery("")} className="mt-3 min-h-11 rounded-lg border border-board-border px-4 font-semibold text-board-text">Clear search</button></div> : null}<div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{filtered.map((song) => <Link key={song.id} to="/$slug/songs/$songId" params={{ slug, songId: song.id }} className="group rounded-2xl border border-board-border bg-board-card p-5 transition hover:-translate-y-0.5 hover:border-fire-500/40"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><h2 className="truncate text-base font-semibold text-board-text">{song.title}</h2><p className="mt-1 truncate text-sm text-board-muted">{song.artist || "Artist not set"}</p></div>{song.importSource === "propresenter" ? <span className="rounded-full bg-blue-500/10 px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-blue-300" title="Imported from ProPresenter">ProPresenter</span> : null}</div><p className="mt-5 text-xs text-board-muted">{song._count.sections} sections · {song._count.cueMaps} cue maps{song.ccliNumber ? ` · CCLI ${song.ccliNumber}` : ""}</p></Link>)}</div></div> : <div className="flex min-h-80 flex-col items-center justify-center rounded-3xl border border-dashed border-board-border bg-board-card/50 p-8 text-center"><LibraryBig className="h-10 w-10 text-fire-500" /><h2 className="mt-4 text-lg font-semibold text-board-text">Build your first lyrics cue map</h2><p className="mt-2 max-w-md text-sm leading-6 text-board-muted">Import a ProPresenter presentation when the Venue Bridge is connected, or create a song manually.</p>{canManage ? <div className="mt-5 flex flex-wrap justify-center gap-2"><button type="button" onClick={() => void openImport()} className="min-h-11 rounded-xl bg-fire-500 px-4 py-2.5 text-sm font-bold text-black">Import from ProPresenter</button><button type="button" onClick={() => setNewSong(true)} className="min-h-11 rounded-xl border border-board-border px-4 py-2.5 text-sm font-semibold text-board-text">Create manually</button></div> : null}</div>}
    </div>
    {canManage && <SongCreateModal key={orgId} orgId={orgId} open={newSong} onClose={() => setNewSong(false)}
      onCreate={(draft, requestId, signal) => createSong({ data: { orgId, ...draft, requestId }, signal })}
      onOpenSong={async (songId, signal) => {
        // Read before changing route state so a failed refresh leaves recovery
        // mounted. Invalidating an active loader can replace it with an error page.
        await refreshLibrary(signal);
        if (signal.aborted) return;
        await router.navigate({ to: "/$slug/songs/$songId", params: { slug, songId } });
      }} />}
    <Dialog open={importing} onOpenChange={open => { if (!open) closeImport(); }}><DialogContent showCloseButton={false} className="flex max-h-[82dvh] w-full max-w-xl flex-col gap-0 overflow-hidden border-board-border bg-board-card p-0 text-board-text"><div className="flex items-center justify-between border-b border-board-border p-5"><div><DialogTitle className="font-semibold text-board-text">Import from ProPresenter</DialogTitle><DialogDescription className="mt-1 text-xs text-board-muted">Search every presentation, then choose one to import its slides.</DialogDescription></div><button aria-label="Close import" disabled={importWrite.state.status === "saving"} onClick={closeImport} className="min-h-11 min-w-11 p-2 text-board-muted disabled:opacity-40"><X className="h-4 w-4" /></button></div>{presentations.length ? <div className="border-b border-board-border p-4"><label className="flex min-h-11 items-center gap-2 rounded-xl border border-board-border bg-board-bg px-3"><Search className="h-4 w-4 text-board-muted" /><input aria-label="Search ProPresenter songs" autoFocus value={importQuery} onChange={(event) => setImportQuery(event.target.value)} placeholder="Search ProPresenter songs" className="min-w-0 flex-1 bg-transparent text-sm text-board-text outline-none" /></label><p className="mt-2 px-1 text-xs text-board-muted">{filteredPresentations.length.toLocaleString()} of {presentations.length.toLocaleString()} presentations</p></div> : null}<div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4">
      {importWrite.state.status === "failed" && <div role="alert" className="space-y-2 rounded-xl border border-red-500/30 p-3 text-sm text-red-300">
        <p>{importWrite.state.saved ? "The import was saved, but its view could not be refreshed." : "Import result unconfirmed. Retry the original request before starting another import."}</p>
        <p>{importWrite.state.message}</p><p className="text-xs">Last attempt: {new Date(importWrite.state.at).toLocaleTimeString()}</p>
        <div className="flex flex-wrap gap-2"><button type="button" onClick={() => void importWrite.retry()} className="min-h-11 rounded-lg border border-red-400/40 px-3">Retry import</button>
        <button type="button" onClick={() => void restartImport()} className="min-h-11 rounded-lg border border-board-border px-3">Read slides again</button></div>
      </div>}
      {importReadState === "failed" && <button type="button" onClick={() => void readLibraries()} className="min-h-11 rounded-lg border border-board-border px-3 text-sm">Retry reading songs</button>}
      {error ? <p role="alert" className="mb-3 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">{error}</p> : null}{failedLibraries.length ? <div className="mb-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200"><div className="flex gap-2"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><div><p className="font-semibold">{failedLibraries.length} ProPresenter librar{failedLibraries.length === 1 ? "y was" : "ies were"} not read</p><p className="mt-1 text-xs text-amber-200/80">{failedLibraries.map((library) => library.name).join(", ")}. Results below are incomplete.</p><button type="button" disabled={importReadState === "loading"} onClick={() => void retryFailedLibraries()} className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-lg border border-amber-400/30 px-3 text-xs font-semibold disabled:opacity-50"><RefreshCw className={`h-3.5 w-3.5 ${importReadState === "loading" ? "animate-spin" : ""}`} />Retry unread libraries</button></div></div></div> : null}{importNotice && importedSongId ? <div className="mb-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100"><p>{importNotice}</p><button type="button" onClick={() => void router.navigate({ to: "/$slug/songs/$songId", params: { slug, songId: importedSongId } })} className="mt-3 rounded-lg bg-amber-400 px-3 py-2 text-xs font-bold text-black">Review imported song</button></div> : null}{presentations.length ? filteredPresentations.map((presentation) => <button key={presentation.uuid} type="button" disabled={importWrite.state.status !== "idle"} onClick={() => void importPresentation(presentation.uuid)} className="flex w-full items-center justify-between gap-3 rounded-xl border border-board-border bg-board-bg p-4 text-left hover:border-fire-500/40 disabled:opacity-50"><span className="min-w-0 truncate font-medium text-board-text">{presentation.name}</span><span className="shrink-0 text-xs text-board-muted">{importingPresentationId === presentation.uuid ? "Reading slides…" : "Import"}</span></button>) : importReadState === "loading" ? <p className="py-8 text-center text-sm text-board-muted">Reading all presentations…</p> : importReadState === "complete" ? <p className="py-8 text-center text-sm text-board-muted">No readable presentations were found in ProPresenter.</p> : null}{presentations.length && !filteredPresentations.length ? <p className="py-8 text-center text-sm text-board-muted">No ProPresenter songs match “{importQuery}”.</p> : null}</div></DialogContent></Dialog>
    {ConfirmDialogEl}
  </div>;
}
