import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { connectionLabel, type ConnectionStatus } from "@/lib/connection-state";
import {
  mediaOutputNameSchema,
  mediaOutputUrl,
  type MediaOutputSnapshot,
} from "@/lib/media-output";

export function MediaOutputPanel({
  orgSlug,
  showId,
  connectionStatus,
  outputs,
}: {
  orgSlug: string;
  showId: string | null;
  connectionStatus: ConnectionStatus;
  outputs: MediaOutputSnapshot[];
}) {
  const connected = connectionStatus === "connected";
  const [name, setName] = useState("Program");
  const id = useId();
  const parsed = mediaOutputNameSchema.safeParse(name);
  return (
    <section
      aria-label="Media outputs"
      className="space-y-3 rounded-xl border border-board-border bg-board-card p-4 text-sm text-board-text"
    >
      <h2 className="font-semibold">Media outputs</h2>
      <p className="text-board-muted">
        Open a window on the playback computer and enable it there. Give the
        same output name to your Play and Stop cues.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1">
          <label htmlFor={id} className="mb-1 block">
            Output name
          </label>
          <input
            id={id}
            value={name}
            maxLength={80}
            onChange={(event) => setName(event.target.value)}
            className="min-h-11 w-full rounded-lg border border-board-border bg-board-bg px-3 focus-visible:outline-2 focus-visible:outline-fire-500"
          />
        </div>
        {showId && parsed.success ? (
          <Button asChild variant="outline" className="min-h-11">
            <a
              href={mediaOutputUrl(orgSlug, showId, parsed.data)}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open media output
            </a>
          </Button>
        ) : (
          <Button className="min-h-11" disabled>
            Open media output
          </Button>
        )}
      </div>
      {!connected && (
        <p role="status" className="text-amber-300">
          {connectionLabel[connectionStatus]}. Media output status is unconfirmed.
        </p>
      )}
      {outputs.length === 0 ? connected && (
        <p className="text-board-muted">
          No media output enabled for this show.
        </p>
      ) : (
        <ul className="space-y-2">
          {outputs.map((output) => (
            <li
              key={output.name}
              className="break-words rounded-lg border border-board-border p-3"
            >
              <span className="font-medium">{output.name}</span> ·{" "}
              {connected
                ? output.status === "ready"
                  ? "Enabled"
                  : output.status
                : `Last reported ${output.status}`}
              {output.mediaName && <p>{output.mediaName}</p>}
              {output.error && (
                <p role="alert" className="text-red-300">
                  {output.error}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
