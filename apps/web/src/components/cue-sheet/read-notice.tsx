import { useRef, useState } from "react";
import { RefreshCw } from "lucide-react";

/** One recovery message, independent of transport wording. */
export function CueReadNotice({ pending, onRetry }: { pending: boolean; onRetry: () => Promise<void> }) {
  const [retrying, setRetrying] = useState(false);
  const [failedAgain, setFailedAgain] = useState(false);
  const retry = useRef<HTMLButtonElement>(null);
  return <div role="alert" className="cue-read-error">
    <h2>Couldn't load the cue sheet</h2><p>Check your connection and try again. Nothing you saved is lost.</p>
    {failedAgain && <p>Still couldn't load. Check your connection.</p>}
    <button ref={retry} type="button" className="cue-button" style={{ minWidth: 128 }} disabled={pending || retrying} onClick={async () => {
      setRetrying(true);
      try { await onRetry(); }
      catch { setFailedAgain(true); requestAnimationFrame(() => retry.current?.focus()); }
      finally { setRetrying(false); }
    }}>{pending || retrying ? "Trying again…" : <><RefreshCw />Try again</>}</button>
  </div>;
}
