import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { createBrowserId } from "@/lib/browser-id";
import {
  mediaLibraryUrl,
  type MediaAsset,
  type MediaPage,
} from "@/lib/media-library";
import {
  deleteMedia,
  loadMediaPage,
  mediaFileProblem,
  uploadMedia,
} from "@/lib/media-library-client";

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; page: MediaPage };
type Operation =
  | { kind: "idle" }
  | { kind: "uploading" }
  | { kind: "deleting"; id: string }
  | { kind: "loading-more" };
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "Media request failed. Try again.";

/** Organization library; browsing here never starts a show output. */
export function MediaLibrary({ orgId }: { orgId: string }) {
  const fileId = useId();
  const [load, setLoad] = useState<LoadState>({ kind: "loading" });
  const [refresh, setRefresh] = useState(0);
  const [operation, setOperation] = useState<Operation>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ file: File; id: string } | null>(null);
  const [preview, setPreview] = useState<MediaAsset | null>(null);
  const [previewError, setPreviewError] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const mutation = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const { confirm, ConfirmDialogEl } = useConfirmDialog();
  const busy = operation.kind !== "idle" || load.kind === "loading";
  const fileProblem = draft ? mediaFileProblem(draft.file) : null;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      mutation.current?.abort();
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoad({ kind: "loading" });
    void loadMediaPage(orgId, null, controller.signal).then(
      (page) => {
        if (!controller.signal.aborted) setLoad({ kind: "ready", page });
      },
      (error) => {
        if (!controller.signal.aborted)
          setLoad({ kind: "error", message: errorText(error) });
      },
    );
    return () => controller.abort();
  }, [orgId, refresh]);

  async function upload() {
    if (!draft || busy || fileProblem) return;
    const controller = new AbortController();
    mutation.current = controller;
    setOperation({ kind: "uploading" });
    setError(null);
    setNotice(null);
    try {
      const asset = await uploadMedia(
        orgId,
        draft.id,
        draft.file,
        controller.signal,
      );
      if (!mounted.current) return;
      setLoad((previous) => ({
        kind: "ready",
        page: {
          assets: [
            asset,
            ...(previous.kind === "ready"
              ? previous.page.assets.filter((item) => item.id !== asset.id)
              : []),
          ],
          cursor: previous.kind === "ready" ? previous.page.cursor : null,
        },
      }));
      setDraft(null);
      if (input.current) input.current.value = "";
      setNotice(
        `${asset.name} uploaded. Preview it on the output computer to check codec support.`,
      );
    } catch (error) {
      if (mounted.current) setError(errorText(error));
    } finally {
      if (mounted.current) setOperation({ kind: "idle" });
      mutation.current = null;
    }
  }

  async function remove(asset: MediaAsset) {
    if (busy) return;
    const accepted = await confirm({
      title: "Delete media?",
      description: `Remove “${asset.name}” from this workspace? Stop any playback first. Cues using this file will fail until you choose a replacement.`,
      confirmLabel: "Delete media",
    });
    if (!accepted || !mounted.current) return;
    const controller = new AbortController();
    mutation.current = controller;
    setOperation({ kind: "deleting", id: asset.id });
    setError(null);
    setNotice(null);
    try {
      await deleteMedia(orgId, asset.id, controller.signal);
      if (!mounted.current) return;
      setLoad((previous) =>
        previous.kind !== "ready"
          ? previous
          : {
              kind: "ready",
              page: {
                ...previous.page,
                assets: previous.page.assets.filter(
                  (item) => item.id !== asset.id,
                ),
              },
            },
      );
      setPreview((current) => (current?.id === asset.id ? null : current));
      setNotice(`${asset.name} removed.`);
    } catch (error) {
      if (mounted.current) setError(errorText(error));
    } finally {
      if (mounted.current) setOperation({ kind: "idle" });
      mutation.current = null;
    }
  }

  async function more() {
    if (busy || load.kind !== "ready" || !load.page.cursor) return;
    const controller = new AbortController();
    mutation.current = controller;
    setOperation({ kind: "loading-more" });
    setError(null);
    try {
      const page = await loadMediaPage(
        orgId,
        load.page.cursor,
        controller.signal,
      );
      if (!mounted.current) return;
      setLoad((previous) => ({
        kind: "ready",
        page: {
          cursor: page.cursor,
          assets: [
            ...new Map(
              [
                ...(previous.kind === "ready" ? previous.page.assets : []),
                ...page.assets,
              ].map((asset) => [asset.id, asset]),
            ).values(),
          ],
        },
      }));
    } catch (error) {
      if (mounted.current) setError(errorText(error));
    } finally {
      if (mounted.current) setOperation({ kind: "idle" });
      mutation.current = null;
    }
  }

  return (
    <section
      aria-label="Media library"
      className="min-w-0 space-y-4 rounded-xl border border-board-border bg-board-card p-4 text-sm text-board-text"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">Media library</h2>
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          disabled={busy}
          onClick={() => {
            setError(null);
            setRefresh((value) => value + 1);
          }}
        >
          Refresh media
        </Button>
      </div>
      <p className="text-board-muted">
        Upload bumpers, countdown videos and stings. MP4, WebM, MP3, WAV or Ogg,
        up to 95 MB per file.
      </p>
      <div className="space-y-2">
        <label htmlFor={fileId} className="block">
          Media file
        </label>
        <input
          ref={input}
          id={fileId}
          type="file"
          accept=".mp4,.m4a,.webm,.mp3,.wav,.ogg"
          disabled={busy}
          className="block min-h-11 w-full min-w-0 max-w-full rounded border border-board-border p-2 focus-visible:outline-2 focus-visible:outline-fire-500"
          onChange={(event) => {
            const file = event.target.files?.[0];
            setDraft(file ? { file, id: createBrowserId() } : null);
            setError(null);
            setNotice(null);
          }}
        />
        {fileProblem && (
          <p role="alert" className="text-red-300">
            {fileProblem}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            className="min-h-11"
            disabled={busy || !draft || !!fileProblem}
            onClick={() => void upload()}
          >
            {operation.kind === "uploading" ? "Uploading…" : "Upload media"}
          </Button>
          {operation.kind === "uploading" && (
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={() => mutation.current?.abort()}
            >
              Cancel upload
            </Button>
          )}
        </div>
      </div>
      {error && (
        <p role="alert" className="break-words text-red-300">
          {error} Use the same action to retry.
        </p>
      )}
      {notice && (
        <p role="status" className="break-words text-board-muted">
          {notice}
        </p>
      )}
      {load.kind === "loading" && <p role="status">Loading media…</p>}
      {load.kind === "error" && (
        <div role="alert" className="space-y-2 text-red-300">
          <p>{load.message}</p>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={() => setRefresh((value) => value + 1)}
          >
            Retry loading media
          </Button>
        </div>
      )}
      {load.kind === "ready" && (
        <>
          {load.page.assets.length === 0 && (
            <p className="text-board-muted">No media uploaded yet.</p>
          )}
          <ul className="space-y-2">
            {load.page.assets.map((asset) => (
              <li
                key={asset.id}
                className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-board-border p-3"
              >
                <div className="min-w-0 flex-1 basis-40">
                  <p className="break-words [overflow-wrap:anywhere]">
                    {asset.name}
                  </p>
                  <p className="text-xs text-board-muted">
                    {asset.mimeType.startsWith("audio/") ? "Audio" : "Video"} ·{" "}
                    {asset.size < 1024 * 1024
                      ? `${Math.max(1, Math.ceil(asset.size / 1024))} KB`
                      : `${(asset.size / 1024 / 1024).toFixed(1)} MB`}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  aria-label={`Preview ${asset.name}`}
                  onClick={() => {
                    setPreview(asset);
                    setPreviewError(false);
                  }}
                >
                  Preview
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  disabled={busy}
                  aria-label={`Delete ${asset.name}`}
                  onClick={() => void remove(asset)}
                >
                  {operation.kind === "deleting" && operation.id === asset.id
                    ? "Deleting…"
                    : "Delete"}
                </Button>
              </li>
            ))}
          </ul>
          {load.page.cursor && (
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={busy}
              onClick={() => void more()}
            >
              {operation.kind === "loading-more"
                ? "Loading more…"
                : "Load more media"}
            </Button>
          )}
        </>
      )}
      {preview && (
        <div className="min-w-0 space-y-2 border-t border-board-border pt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="min-w-0 break-all">Preview: {preview.name}</p>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={() => setPreview(null)}
            >
              Close preview
            </Button>
          </div>
          <p className="text-xs text-board-muted">
            Preview plays on this computer only. Press Play to check picture and
            sound.
          </p>
          {previewError ? (
            <p role="alert" className="text-red-300">
              This computer could not load or decode the file. Check the
              connection and codec, then close and reopen the preview to retry.
            </p>
          ) : (
            <video
              key={preview.id}
              aria-label={`Media preview: ${preview.name}`}
              src={mediaLibraryUrl(orgId, preview.id)}
              controls
              preload="metadata"
              playsInline
              className={`w-full rounded-lg bg-black ${preview.mimeType.startsWith("audio/") ? "h-24" : "max-h-80"}`}
              onError={() => setPreviewError(true)}
            />
          )}
        </div>
      )}
      {ConfirmDialogEl}
    </section>
  );
}
