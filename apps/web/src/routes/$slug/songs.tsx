import { createFileRoute, Link, Outlet, useParams, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { LibraryBig, Plus, Search, Upload, X } from "lucide-react";
import { hasEffectivePermission } from "@/lib/app-permissions";
import { SongCreateModal } from "@/components/SongDialogs";
import { createSong, importProPresenterSong, listProPresenterSongs, listSongs } from "@/lib/songs";

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

function SongsRoutePage() {
  const { songId } = useParams({ strict: false });
  return songId ? <Outlet /> : <SongsLibraryPage />;
}

function SongsLibraryPage() {
  const { orgId, slug, role, grantedPermissions, songs } = Route.useLoaderData();
  const router = useRouter();
  const canManage = hasEffectivePermission(role, grantedPermissions, "songs:manage");
  const [query, setQuery] = useState("");
  const [newSong, setNewSong] = useState(false);
  const [importing, setImporting] = useState(false);
  const [presentations, setPresentations] = useState<Awaited<ReturnType<typeof listProPresenterSongs>>["presentations"]>([]);
  const [error, setError] = useState<string | null>(null);
  const filtered = songs.filter((song) => `${song.title} ${song.artist} ${song.ccliNumber}`.toLowerCase().includes(query.trim().toLowerCase()));

  const openImport = async () => {
    setImporting(true);
    setError(null);
    try {
      const result = await listProPresenterSongs({ data: { orgId } });
      if (!result.connected) throw new Error("Connect ProPresenter through Venue Bridge, then try again.");
      setPresentations(result.presentations);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not read ProPresenter.");
    }
  };

  return <div className="min-h-full bg-board-bg p-4 sm:p-6">
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-fire-500">Lyrics automation</p><h1 className="mt-1 text-2xl font-semibold text-board-text">Songs</h1><p className="mt-1 max-w-xl text-sm text-board-muted">One lyric arrangement and cue map can drive the native stage display, ProPresenter, or both.</p></div>
        {canManage ? <div className="flex gap-2"><button type="button" onClick={() => void openImport()} className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-board-border bg-board-card px-4 text-sm font-semibold text-board-text"><Upload className="h-4 w-4" />Import from ProPresenter</button><button type="button" onClick={() => setNewSong(true)} className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-fire-500 px-4 text-sm font-bold text-black"><Plus className="h-4 w-4" />New song</button></div> : null}
      </header>
      {error ? <p role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">{error}</p> : null}
      {songs.length ? <div className="space-y-4"><label className="flex min-h-11 items-center gap-2 rounded-xl border border-board-border bg-board-card px-3"><Search className="h-4 w-4 text-board-muted" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search title, artist, or CCLI" className="min-w-0 flex-1 bg-transparent text-sm text-board-text outline-none" /></label><div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{filtered.map((song) => <Link key={song.id} to="/$slug/songs/$songId" params={{ slug, songId: song.id }} className="group rounded-2xl border border-board-border bg-board-card p-5 transition hover:-translate-y-0.5 hover:border-fire-500/40"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><h2 className="truncate text-base font-semibold text-board-text">{song.title}</h2><p className="mt-1 truncate text-sm text-board-muted">{song.artist || "Artist not set"}</p></div>{song.importSource === "propresenter" ? <span className="rounded-full bg-blue-500/10 px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-blue-300">PP</span> : null}</div><p className="mt-5 text-xs text-board-muted">{song._count.sections} sections · {song._count.cueMaps} cue maps{song.ccliNumber ? ` · CCLI ${song.ccliNumber}` : ""}</p></Link>)}</div></div> : <div className="flex min-h-80 flex-col items-center justify-center rounded-3xl border border-dashed border-board-border bg-board-card/50 p-8 text-center"><LibraryBig className="h-10 w-10 text-fire-500" /><h2 className="mt-4 text-lg font-semibold text-board-text">Build your first lyrics cue map</h2><p className="mt-2 max-w-md text-sm leading-6 text-board-muted">Import a ProPresenter presentation when the Venue Bridge is connected, or create a song manually.</p>{canManage ? <div className="mt-5 flex flex-wrap justify-center gap-2"><button type="button" onClick={() => void openImport()} className="rounded-xl bg-fire-500 px-4 py-2.5 text-sm font-bold text-black">Import from ProPresenter</button><button type="button" onClick={() => setNewSong(true)} className="rounded-xl border border-board-border px-4 py-2.5 text-sm font-semibold text-board-text">Create manually</button></div> : null}</div>}
    </div>
    {newSong ? <SongCreateModal onClose={() => setNewSong(false)} onCreate={async (draft) => { const song = await createSong({ data: { orgId, ...draft } }); await router.navigate({ to: "/$slug/songs/$songId", params: { slug, songId: song.id } }); await router.invalidate(); }} /> : null}
    {importing ? <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"><div className="max-h-[75vh] w-full max-w-lg overflow-hidden rounded-2xl border border-board-border bg-board-card"><div className="flex items-center justify-between border-b border-board-border p-5"><div><h2 className="font-semibold text-board-text">Import from ProPresenter</h2><p className="mt-1 text-xs text-board-muted">Choose a presentation. Re-imports merge changed slides.</p></div><button aria-label="Close import" onClick={() => setImporting(false)} className="p-2 text-board-muted"><X className="h-4 w-4" /></button></div><div className="max-h-[60vh] space-y-2 overflow-y-auto p-4">{presentations.length ? presentations.map((presentation) => <button key={presentation.uuid} type="button" onClick={async () => { const result = await importProPresenterSong({ data: { orgId, presentation, strategy: "merge" } }); await router.navigate({ to: "/$slug/songs/$songId", params: { slug, songId: result.songId } }); }} className="w-full rounded-xl border border-board-border bg-board-bg p-4 text-left hover:border-fire-500/40"><span className="font-medium text-board-text">{presentation.name}</span><span className="mt-1 block text-xs text-board-muted">{presentation.slides.length} slides</span></button>) : <p className="py-8 text-center text-sm text-board-muted">{error || "Reading presentations…"}</p>}</div></div></div> : null}
  </div>;
}
