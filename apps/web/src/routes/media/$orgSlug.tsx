import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { getOrgRouteContext } from "@/lib/session";
import { getTimecodeShows } from "@/lib/timecode-shows";
import { withOperationTimeout } from "@/lib/operation-timeout";
import { mediaOutputNameSchema } from "@/lib/media-output";
import {
  MediaPlaybackSession,
  type MediaPlayerStatus,
} from "@/lib/media-playback";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/media/$orgSlug")({
  validateSearch: (search: Record<string, unknown>) =>
    z
      .object({
        showId: z.string().max(64).default(""),
        output: mediaOutputNameSchema.default("Program"),
      })
      .parse(search),
  loaderDeps: ({ search }) => ({ showId: search.showId }),
  loader: ({ params, deps }) =>
    withOperationTimeout(
      (async () => {
        const context = await getOrgRouteContext({ data: params.orgSlug });
        if (!context?.effectivePermissions.includes("timecode:access"))
          return { context, show: null };
        const { shows } = await getTimecodeShows({
          data: { orgId: context.org.id },
        });
        return {
          context,
          show: shows.find((show) => show.id === deps.showId) ?? null,
        };
      })(),
      10_000,
      "Workspace access check timed out. Reload to retry.",
    ),
  pendingComponent: () => (
    <main className="min-h-dvh bg-black p-6 text-white" role="status">
      Checking workspace access…
    </main>
  ),
  errorComponent: () => (
    <main className="min-h-dvh space-y-4 bg-black p-6 text-white">
      <p role="alert">
        This media output could not open. Check the workspace, show and
        connection.
      </p>
      <Button className="min-h-11" onClick={() => location.reload()}>
        Retry opening output
      </Button>
      <a className="ml-4 underline" href="/login">
        Sign in
      </a>
    </main>
  ),
  component: MediaOutputPage,
});

function MediaOutputPage() {
  const { context, show } = Route.useLoaderData();
  const { showId, output } = Route.useSearch();
  if (!context?.effectivePermissions.includes("timecode:access"))
    return (
      <main className="min-h-dvh space-y-4 bg-black p-6 text-white">
        <h1 className="text-xl">Media output</h1>
        <p role="alert">
          Sign in to this workspace with timecode access to enable playback.
        </p>
        <a
          className="inline-flex min-h-11 items-center underline"
          href="/login"
        >
          Sign in
        </a>
      </main>
    );
  if (!show)
    return (
      <main className="min-h-dvh bg-black p-6 text-white">
        <p role="alert">
          Choose an available show in Timecode, then open its media output.
        </p>
        <a
          className="inline-flex min-h-11 items-center underline"
          href={`/${encodeURIComponent(context.org.slug)}/timecode`}
        >
          Open Timecode
        </a>
      </main>
    );
  return (
    <Player
      key={`${context.org.id}:${showId}:${output}`}
      orgId={context.org.id}
      showId={showId}
      output={output}
      orgName={`${context.org.name} · ${show.name}`}
    />
  );
}

function Player({
  orgId,
  showId,
  output,
  orgName,
}: {
  orgId: string;
  showId: string;
  output: string;
  orgName: string;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const screen = useRef<HTMLDivElement>(null);
  const session = useRef<MediaPlaybackSession | null>(null);
  const [status, setStatus] = useState<MediaPlayerStatus>({
    kind: "connecting",
    message: "Connecting…",
  });
  const [preparation, setPreparation] = useState("");
  const [fullscreenError, setFullscreenError] = useState<string | null>(null);
  useEffect(() => {
    if (!video.current) return;
    const current = new MediaPlaybackSession({
      orgId,
      showId,
      output,
      video: video.current,
      status: setStatus,
      preparation: setPreparation,
    });
    session.current = current;
    current.connect();
    const leave = () => current.disable();
    window.addEventListener("pagehide", leave);
    return () => {
      window.removeEventListener("pagehide", leave);
      current.dispose();
      session.current = null;
    };
  }, [orgId, showId, output]);
  return (
    <main className="flex h-dvh min-h-0 flex-col bg-black text-white">
      <header className="shrink-0 space-y-2 border-b border-white/15 p-4 text-sm">
        <h1 className="break-words text-lg font-semibold">
          {orgName} · {output}
        </h1>
        <p role="status" data-media-output-status={status.kind}>
          {status.message}
        </p>
        <div className="flex flex-wrap gap-2">
          {status.kind === "disconnected" ? (
            <Button
              className="min-h-11"
              onClick={() => session.current?.connect()}
            >
              Reconnect output
            </Button>
          ) : (
            <Button
              className="min-h-11"
              disabled={
                status.kind === "connecting" ||
                status.kind === "enabling" ||
                status.kind === "enabled"
              }
              onClick={() => void session.current?.enable()}
            >
              {status.kind === "enabling"
                ? "Enabling…"
                : status.kind === "enabled"
                  ? "Output enabled"
                  : "Enable output"}
            </Button>
          )}
          <Button
            className="min-h-11"
            variant="outline"
            disabled={status.kind !== "enabled" && status.kind !== "enabling"}
            onClick={() => session.current?.disable()}
          >
            Disable output and stop
          </Button>
          <Button
            className="min-h-11"
            variant="outline"
            onClick={() => {
              setFullscreenError(null);
              void screen.current
                ?.requestFullscreen()
                .catch(() =>
                  setFullscreenError(
                    "Fullscreen was blocked. Use your browser or desktop window controls.",
                  ),
                );
            }}
          >
            Fullscreen output
          </Button>
        </div>
        {preparation && (
          <p className="text-white/70" data-media-preparation>
            {preparation}
          </p>
        )}
        {fullscreenError && <p role="alert">{fullscreenError}</p>}
        <p className="text-xs text-white/70">
          Keep this window open. Disconnecting stops playback and requires
          Enable output again. Fullscreen shows only the media.
        </p>
      </header>
      <div ref={screen} data-media-screen className="min-h-0 flex-1 bg-black">
        <video
          ref={video}
          aria-label="Show media output"
          playsInline
          preload="auto"
          className="h-full w-full object-contain"
        />
      </div>
    </main>
  );
}
