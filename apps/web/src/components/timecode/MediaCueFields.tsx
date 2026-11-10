import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { loadMediaPage } from "@/lib/media-library-client";
import type { MediaAsset, MediaPage } from "@/lib/media-library";

type Choices =
  | { kind: "loading" }
  | { kind: "ready"; page: MediaPage }
  | { kind: "error"; message: string };
export function MediaCueFields({
  orgId,
  play,
  output,
  onOutput,
  asset,
  onAsset,
  volume,
  onVolume,
}: {
  orgId?: string;
  play: boolean;
  output: string;
  onOutput: (value: string) => void;
  asset: MediaAsset | null;
  onAsset: (asset: MediaAsset | null) => void;
  volume: string;
  onVolume: (value: string) => void;
}) {
  const id = useId();
  const [choices, setChoices] = useState<Choices>({ kind: "loading" });
  const [refresh, setRefresh] = useState(0);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  useEffect(() => {
    if (!play) return;
    const controller = new AbortController();
    onAsset(null);
    setChoices({ kind: "loading" });
    void (
      orgId
        ? loadMediaPage(orgId, null, controller.signal)
        : Promise.reject(
            new Error("Open Timecode inside a workspace to choose media."),
          )
    )
      .then((page) => {
        if (!controller.signal.aborted) setChoices({ kind: "ready", page });
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setChoices({
            kind: "error",
            message:
              error instanceof Error
                ? error.message
                : "Media list unavailable.",
          });
      });
    return () => controller.abort();
  }, [orgId, play, refresh, onAsset]);
  useEffect(() => {
    if (
      !loadingMore ||
      choices.kind !== "ready" ||
      !choices.page.cursor ||
      !orgId
    )
      return;
    const controller = new AbortController();
    const cursor = choices.page.cursor;
    setMoreError(null);
    void loadMediaPage(orgId, cursor, controller.signal)
      .then((page) => {
        if (!controller.signal.aborted)
          setChoices((current) =>
            current.kind !== "ready"
              ? current
              : {
                  kind: "ready",
                  page: {
                    cursor: page.cursor,
                    assets: [
                      ...new Map(
                        [...current.page.assets, ...page.assets].map(
                          (asset) => [asset.id, asset],
                        ),
                      ).values(),
                    ],
                  },
                },
          );
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setMoreError(
            error instanceof Error ? error.message : "Media list unavailable.",
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingMore(false);
      });
    return () => controller.abort();
  }, [loadingMore, orgId]);
  const input =
    "min-h-11 w-full min-w-0 rounded-lg border border-board-border bg-board-bg px-3 text-sm text-board-text focus-visible:outline-2 focus-visible:outline-fire-500";
  return (
    <div className="min-w-0 space-y-3">
      <div>
        <label
          htmlFor={`${id}-output`}
          className="mb-1 block text-xs text-board-muted"
        >
          Media output name
        </label>
        <input
          id={`${id}-output`}
          value={output}
          maxLength={80}
          required
          onChange={(event) => onOutput(event.target.value)}
          className={input}
          placeholder="Program"
        />
      </div>
      {play && (
        <>
          <div>
            <label
              htmlFor={`${id}-file`}
              className="mb-1 block text-xs text-board-muted"
            >
              Media clip
            </label>
            <select
              id={`${id}-file`}
              value={asset?.id ?? ""}
              required
              disabled={choices.kind !== "ready"}
              className={input}
              onChange={(event) =>
                onAsset(
                  choices.kind === "ready"
                    ? (choices.page.assets.find(
                        (asset) => asset.id === event.target.value,
                      ) ?? null)
                    : null,
                )
              }
            >
              <option value="">Choose a clip</option>
              {choices.kind === "ready" &&
                choices.page.assets.map((asset) => (
                  <option key={asset.id} value={asset.id}>
                    {asset.name}
                  </option>
                ))}
            </select>
          </div>
          {choices.kind === "loading" && (
            <p role="status" className="text-xs text-board-muted">
              Loading media clips…
            </p>
          )}
          {choices.kind === "error" && (
            <p role="alert" className="text-xs text-red-300">
              {choices.message}
            </p>
          )}
          {choices.kind === "ready" && choices.page.assets.length === 0 && (
            <p className="text-xs text-board-muted">
              Upload a clip in the Media library below, then refresh this list.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={choices.kind === "loading" || loadingMore}
              onClick={() => setRefresh((value) => value + 1)}
            >
              Refresh media clips
            </Button>
            {choices.kind === "ready" && choices.page.cursor && (
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={loadingMore}
                onClick={() => setLoadingMore(true)}
              >
                Load more clips
              </Button>
            )}
          </div>
          {moreError && (
            <p role="alert" className="text-xs text-red-300">
              {moreError} Use Load more clips to retry.
            </p>
          )}
          <div>
            <label
              htmlFor={`${id}-volume`}
              className="mb-1 block text-xs text-board-muted"
            >
              Media volume (%)
            </label>
            <input
              id={`${id}-volume`}
              type="number"
              min="0"
              max="100"
              step="1"
              required
              value={volume}
              onChange={(event) => onVolume(event.target.value)}
              className={input}
            />
          </div>
        </>
      )}
      <p className="text-xs text-board-muted">
        {play
          ? "Start this clip from the beginning on the named output. Enable its window and wait for upcoming media to prepare before starting timecode."
          : "Stop and clear the named output. Other media outputs keep playing."}{" "}
        A cue succeeds only after the output confirms the action.
      </p>
    </div>
  );
}
