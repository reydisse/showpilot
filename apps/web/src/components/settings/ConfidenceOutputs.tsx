import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { isDesktopRuntime } from "@/lib/desktop-runtime";
import {
  identifyConfidenceMonitor,
  getConfidenceOutputs,
  getConfidenceOutputStatus,
  preferredDeckLinkMode,
  outputTargetSchema,
  startConfidenceOutput,
  stopConfidenceOutput,
  type OutputInventory,
  type OutputStatus,
  type OutputTarget,
} from "@/lib/confidence-output";

const field =
  "mt-1 h-11 w-full rounded-lg border border-board-border bg-board-bg px-3 text-sm text-board-text";
export function ConfidenceOutputs({ slug }: { slug: string }) {
  const [native, setNative] = useState(false);
  const [inventory, setInventory] = useState<OutputInventory | null>(null);
  const [target, setTarget] = useState<OutputTarget | null>(null);
  const [status, setStatus] = useState<OutputStatus>({
    state: "stopped",
    message: "Output disabled",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    try {
      const inventory = await getConfidenceOutputs();
      setInventory(inventory);
      setTarget((previous) => inventory.active?.target ?? previous ?? null);
      setStatus(await getConfidenceOutputStatus());
      setError("");
    } catch {
      setError(
        "Could not read outputs. Make sure this computer has the latest ShowPilot Desktop build.",
      );
    }
  }, []);
  useEffect(() => {
    const desktop = isDesktopRuntime();
    setNative(desktop);
    if (!desktop) return;
    try {
      const saved = outputTargetSchema.safeParse(
        JSON.parse(
          localStorage.getItem(`showpilot:confidence-output:${slug}`) ?? "null",
        ),
      );
      if (saved.success) setTarget(saved.data);
    } catch {
      /* A stale local preference must not block output setup. */
    }
    void refresh();
    let active = true;
    let pending = false;
    const timer = setInterval(async () => {
      if (pending) return;
      pending = true;
      try {
        const next = await getConfidenceOutputStatus();
        if (active) {
          setStatus(next);
          if (next.state === "stopped")
            setInventory((value) =>
              value ? { ...value, active: null } : value,
            );
        }
      } catch {
        if (active)
          setError(
            "Lost contact with the local output engine. Refresh outputs to reconnect.",
          );
      } finally {
        pending = false;
      }
    }, 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [refresh, slug]);
  useEffect(() => {
    if (!native || !target) return;
    try {
      localStorage.setItem(
        `showpilot:confidence-output:${slug}`,
        JSON.stringify(target),
      );
    } catch {
      /* Output still works when local storage is unavailable. */
    }
  }, [native, target, slug]);
  const enabled =
    status.state === "starting" ||
    status.state === "running" ||
    inventory?.active != null;
  async function toggle() {
    setBusy(true);
    setError("");
    try {
      if (enabled) await stopConfidenceOutput();
      else if (target) await startConfidenceOutput(slug, target);
      await refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  const device =
    target?.kind === "decklink"
      ? inventory?.decklink.devices.find((device) => device.id === target.id)
      : undefined;
  return (
    <div className="mt-8 rounded-xl border border-board-border p-5">
      <h3 className="font-medium text-board-text">Confidence output</h3>
      <p className="mt-1 text-sm text-board-muted">
        Choose where this computer sends the screen.
      </p>
      {!native ? (
        <div className="mt-4 flex flex-wrap items-center gap-4">
          <p className="text-sm text-board-muted">
            Display and DeckLink assignments are available in ShowPilot Desktop
            on the output computer.
          </p>
          <Button variant="outline" asChild>
            <a
              href={`/timer/${slug}?output=clean`}
              target="_blank"
              rel="noreferrer"
            >
              Open clean screen
            </a>
          </Button>
        </div>
      ) : (
        <>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <label className="text-sm text-board-muted">
              Destination
              <select
                className={field}
                disabled={busy || enabled}
                value={target ? `${target.kind}:${target.id}` : ""}
                onChange={(event) => {
                  const value = event.target.value;
                  const monitor = inventory?.monitors.find(
                    (m) => `monitor:${m.id}` === value,
                  );
                  if (monitor) {
                    setTarget({ kind: "monitor", id: monitor.id });
                    return;
                  }
                  const device = inventory?.decklink.devices.find(
                    (d) => `decklink:${d.id}` === value,
                  );
                  const mode = device && preferredDeckLinkMode(device.modes);
                  setTarget(
                    device && mode
                      ? { kind: "decklink", id: device.id, mode: mode.id }
                      : null,
                  );
                }}
              >
                <option value="">Choose an output</option>
                <optgroup label="Connected displays">
                  {inventory?.monitors.map((m) => (
                    <option key={m.id} value={`monitor:${m.id}`}>
                      {m.name ?? "Display"} · {m.width} × {m.height}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="DeckLink channels">
                  {inventory?.decklink.devices.map((d) => (
                    <option
                      key={d.id}
                      value={`decklink:${d.id}`}
                      disabled={d.modes.length === 0}
                    >
                      {d.name}
                      {d.modes.length === 0 ? " · No available formats" : ""}
                    </option>
                  ))}
                </optgroup>
              </select>
            </label>
            {target?.kind === "decklink" && (
              <label className="text-sm text-board-muted">
                Video format
                <select
                  className={field}
                  disabled={busy || enabled}
                  value={target.mode}
                  onChange={(event) =>
                    setTarget({ ...target, mode: Number(event.target.value) })
                  }
                >
                  {device?.modes.map((mode) => (
                    <option key={mode.id} value={mode.id}>
                      {mode.name} · {mode.width} × {mode.height}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          {target?.kind === "decklink" && (
            <p className="mt-3 text-xs leading-5 text-board-muted">
              Use an available channel. Keep the clean output window open and
              unminimized. macOS may ask for screen-recording permission to send
              that window to the card. The format list reflects your card’s
              current profile.
            </p>
          )}
          {inventory?.decklink.error && (
            <p className="mt-3 text-xs text-board-muted">
              {inventory.decklink.error}
            </p>
          )}
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button
              disabled={busy || (!target && !enabled)}
              onClick={() => void toggle()}
            >
              {busy
                ? "Updating…"
                : enabled
                  ? "Disable output"
                  : "Enable output"}
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void refresh()}
            >
              Refresh outputs
            </Button>
            {target?.kind === "monitor" && (
              <Button
                variant="outline"
                disabled={busy || enabled}
                onClick={() => {
                  void identifyConfidenceMonitor(target.id).catch((error) =>
                    setError(String(error)),
                  );
                }}
              >
                Identify display
              </Button>
            )}
          </div>
          <p
            role={status.state === "error" ? "alert" : "status"}
            className={`mt-3 text-sm ${status.state === "error" ? "text-red-400" : "text-board-muted"}`}
          >
            {status.message}
            {status.orgSlug && status.orgSlug !== slug
              ? ` · ${status.orgSlug}`
              : ""}
          </p>
          {(status.droppedFrames ?? 0) > 0 && (
            <p className="mt-2 text-xs text-amber-400">
              {status.droppedFrames} late or dropped frames. Check output
              performance before using this format live.
            </p>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
