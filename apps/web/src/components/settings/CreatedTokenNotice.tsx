import { useState } from "react";

/** The creation response stays in component memory only until dismissed. */
export function CreatedTokenNotice({
  label,
  token,
  displayUrl,
  onDismiss,
}: {
  label: string;
  token: string;
  displayUrl?: string;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState<"token" | "link" | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function copy(kind: "token" | "link") {
    const value = kind === "link" ? displayUrl : token;
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
      setError(null);
    } catch {
      setError(
        `Copy failed. Select and copy the ${kind === "link" ? "display link" : "token"} before dismissing it.`,
      );
    }
  }
  return (
    <section
      aria-label="New access token"
      className="my-4 min-w-0 space-y-3 rounded-xl border border-fire-500/50 bg-board-card p-4"
    >
      <p className="text-sm font-semibold text-board-text">
        Copy the token for {label} now
      </p>
      <p className="text-xs text-board-muted">
        This is the only time it will be shown. Save it in your device before
        dismissing it or leaving this page.
      </p>
      <textarea
        aria-label="New token"
        readOnly
        value={token}
        className="min-h-24 w-full min-w-0 rounded-lg border border-board-border bg-board-bg p-3 font-mono text-xs text-board-text"
      />
      {displayUrl && (
        <div className="space-y-3">
          <p className="text-sm text-board-text">
            Open this link on the display computer. Check that it shows the
            expected output before sharing it.
          </p>
          <textarea
            aria-label="New display link"
            readOnly
            value={displayUrl}
            className="min-h-24 w-full min-w-0 rounded-lg border border-board-border bg-board-bg p-3 font-mono text-xs text-board-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fire-500"
          />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                void copy("link");
              }}
              className="min-h-11 rounded-lg border border-board-border px-3 text-sm text-board-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fire-500"
            >
              {copied === "link" ? "Display link copied" : "Copy display link"}
            </button>
            <a
              href={displayUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-h-11 items-center rounded-lg border border-board-border px-3 text-sm text-board-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fire-500"
            >
              Open display to check
            </a>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-red-300">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => {
            void copy("token");
          }}
          className="min-h-11 rounded-lg border border-board-border px-3 text-sm text-board-text"
        >
          {copied === "token" ? "Copied" : "Copy new token"}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="min-h-11 rounded-lg border border-board-border px-3 text-sm text-board-text"
        >
          Dismiss token
        </button>
      </div>
    </section>
  );
}
