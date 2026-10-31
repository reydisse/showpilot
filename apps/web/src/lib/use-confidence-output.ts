import { useCallback, useEffect, useState } from "react";
import { isDesktopRuntime } from "@/lib/desktop-runtime";
import {
  getConfidenceOutputs,
  getConfidenceOutputStatus,
  outputTargetSchema,
  startConfidenceOutput,
  stopConfidenceOutput,
  type OutputInventory,
  type OutputStatus,
  type OutputTarget,
} from "@/lib/confidence-output";


export function useConfidenceOutput(slug: string) {
  const [loadedSlug, setLoadedSlug] = useState<string | null>(null);
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
      setTarget(saved.success ? saved.data : null);
    } catch {
      /* A stale local preference must not block output setup. */
    }
    setLoadedSlug(slug);
    void refresh();
    const changed = () => { void refresh(); };
    window.addEventListener("showpilot:confidence-output-changed", changed);
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
      window.removeEventListener("showpilot:confidence-output-changed", changed);
    };
  }, [refresh, slug]);
  useEffect(() => {
    if (!native || !target || loadedSlug !== slug) return;
    try {
      localStorage.setItem(
        `showpilot:confidence-output:${slug}`,
        JSON.stringify(target),
      );
    } catch {
      /* Output still works when local storage is unavailable. */
    }
  }, [native, target, slug, loadedSlug]);
  const enabled =
    status.state === "starting" ||
    status.state === "running" ||
    (status.state !== "error" && inventory?.active != null);
  async function toggle() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      if (enabled) await stopConfidenceOutput();
      else if (target) await startConfidenceOutput(slug, target);
      await refresh();
      window.dispatchEvent(new Event("showpilot:confidence-output-changed"));
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  return { native, inventory, target, setTarget, status, busy, error, setError, enabled, toggle, refresh };
}
