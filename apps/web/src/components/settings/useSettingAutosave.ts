import { useCallback, useEffect, useRef, useState } from "react";
import type { SettingChange, SettingWriteResult } from "@/lib/setting-writes";

export const SETTING_SAVE_TIMEOUT_MS = 10_000;
export type PersistSetting = (change: SettingChange, signal: AbortSignal) => Promise<SettingWriteResult>;
type Completion = { promise: Promise<boolean>; resolve: (confirmed: boolean) => void };
type Intent = { value: string; persist: PersistSetting; completion: Completion };
type Work = Intent & { change: SettingChange };
type Phase =
  | { kind: "saving"; controller: AbortController }
  | { kind: "uncertain"; message: string; occurredAt: number }
  | { kind: "conflict"; message: string; currentValue: string | null; occurredAt: number };
type Lane = { work: Work; phase: Phase; queued: Intent | null };
export type SettingSaveFailure = {
  key: string; kind: "uncertain" | "conflict"; message: string; occurredAt: number;
  attemptedValue: string; queuedValue: string | null; currentValue: string | null;
};
export type SettingSaveState =
  | { kind: "saved" }
  | { kind: "saving" }
  | { kind: "error"; failures: SettingSaveFailure[] };

function completion(): Completion {
  let resolve: Completion["resolve"] = () => {};
  const promise = new Promise<boolean>(done => { resolve = done; });
  return { promise, resolve };
}
async function persistBounded(work: Work, controller: AbortController) {
  let cancel = () => {};
  const interrupted = new Promise<never>((_, reject) => {
    cancel = () => reject(controller.signal.reason);
    controller.signal.addEventListener("abort", cancel, { once: true });
  });
  const timer = setTimeout(() => controller.abort(new Error("Save confirmation timed out.")), SETTING_SAVE_TIMEOUT_MS);
  try {
    return await Promise.race([Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return work.persist(work.change, controller.signal);
    }), interrupted]);
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener("abort", cancel);
  }
}

/** Each field owns an acknowledged value, one immutable request and its latest queued edit. */
export function useSettingAutosave({ initialSettings, persist }: {
  initialSettings: Record<string, string>;
  persist: PersistSetting;
}) {
  const local = useRef({ ...initialSettings });
  const committed = useRef({ ...initialSettings });
  const drafts = useRef(new Set<string>());
  const lanes = useRef(new Map<string, Lane>());
  const active = useRef(true);
  const persistRef = useRef(persist);
  const [view, setView] = useState<{ settings: Record<string, string>; saveState: SettingSaveState; hasUnsavedChanges: boolean }>({
    settings: local.current, saveState: { kind: "saved" }, hasUnsavedChanges: false,
  });
  useEffect(() => { persistRef.current = persist; }, [persist]);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      for (const lane of lanes.current.values()) {
        if (lane.phase.kind === "saving") lane.phase.controller.abort(new Error("Settings closed."));
        lane.work.completion.resolve(false);
        lane.queued?.completion.resolve(false);
      }
      lanes.current.clear();
    };
  }, []);

  const publish = useCallback(() => {
    if (!active.current) return;
    const failures: SettingSaveFailure[] = [];
    for (const [key, lane] of lanes.current) {
      if (lane.phase.kind !== "saving") failures.push({
        key, kind: lane.phase.kind, message: lane.phase.message, occurredAt: lane.phase.occurredAt, attemptedValue: lane.work.value,
        queuedValue: lane.queued?.value ?? null,
        currentValue: lane.phase.kind === "conflict" ? lane.phase.currentValue : committed.current[key] ?? null,
      });
    }
    setView({ settings: { ...local.current }, saveState: failures.length ? { kind: "error", failures }
      : lanes.current.size ? { kind: "saving" } : { kind: "saved" },
      hasUnsavedChanges: lanes.current.size > 0 || [...drafts.current].some(key => local.current[key] !== (committed.current[key] ?? "")),
    });
  }, []);
  const assign = (target: Record<string, string>, key: string, value: string | null) => {
    if (value === null) delete target[key]; else target[key] = value;
  };
  const run = useCallback((work: Work, queued: Intent | null = null): void => {
    const key = work.change.key;
    const controller = new AbortController();
    const lane: Lane = { work, queued, phase: { kind: "saving", controller } };
    lanes.current.set(key, lane);
    if (!queued && !drafts.current.has(key)) local.current[key] = work.value;
    publish();
    void (async () => {
      try {
        const result = await persistBounded(work, controller);
        if (!active.current || lanes.current.get(key) !== lane) return;
        if (result.requestId !== work.change.requestId || result.key !== key
          || (result.outcome !== "applied" && result.outcome !== "conflict")
          || (result.currentValue !== null && typeof result.currentValue !== "string")) throw new Error("Missing save acknowledgement.");
        if (result.outcome === "conflict" || result.currentValue !== work.value) {
          lane.phase = { kind: "conflict", occurredAt: Date.now(), currentValue: result.currentValue,
            message: result.outcome === "applied" ? "Your earlier change was saved, then changed elsewhere. Review the saved value before applying your edit again."
              : "This setting changed elsewhere. Your edit was not applied. Review the saved value before choosing what to keep." };
          work.completion.resolve(false); lane.queued?.completion.resolve(false);
          publish(); return;
        }
        committed.current[key] = work.value;
        lanes.current.delete(key);
        work.completion.resolve(true);
        if (lane.queued) {
          const next = lane.queued;
          run({ ...next, change: { key, value: next.value, expectedValue: work.value, requestId: crypto.randomUUID() } });
        } else {
          if (!drafts.current.has(key)) local.current[key] = work.value;
          publish();
        }
      } catch (error) {
        if (!active.current || lanes.current.get(key) !== lane) return;
        const reason = error instanceof Error ? error.message : "Connection failed.";
        lane.phase = { kind: "uncertain", occurredAt: Date.now(), message: `${reason} Save was not confirmed. Retry checks the same change before saving any newer edit.` };
        if (!lane.queued && !drafts.current.has(key)) assign(local.current, key, committed.current[key] ?? null);
        work.completion.resolve(false); lane.queued?.completion.resolve(false);
        publish();
      }
    })();
  }, [publish]);

  const editSetting = useCallback((key: string, value: string) => {
    drafts.current.add(key); local.current[key] = value; publish();
  }, [publish]);
  const saveSetting = useCallback((key: SettingChange["key"], value: string): Promise<boolean> => {
    if (!active.current) return Promise.resolve(false);
    drafts.current.delete(key);
    local.current[key] = value;
    const lane = lanes.current.get(key);
    if (lane) {
      if (lane.queued?.value === value) return lane.phase.kind === "saving" ? lane.queued.completion.promise : Promise.resolve(false);
      if (!lane.queued && lane.work.value === value) return lane.phase.kind === "saving" ? lane.work.completion.promise : Promise.resolve(false);
      lane.queued?.completion.resolve(false);
      lane.queued = { value, persist: persistRef.current, completion: completion() };
      if (lane.phase.kind !== "saving") lane.queued.completion.resolve(false);
      publish();
      return lane.queued.completion.promise;
    }
    if (value === (committed.current[key] ?? "")) { publish(); return Promise.resolve(true); }
    const intent = { value, persist: persistRef.current, completion: completion() };
    run({ ...intent, change: { key, value, expectedValue: committed.current[key] ?? null, requestId: crypto.randomUUID() } });
    return intent.completion.promise;
  }, [publish, run]);
  const retrySetting = useCallback((key: string): Promise<boolean> => {
    const lane = lanes.current.get(key);
    if (!lane || lane.phase.kind !== "uncertain") return Promise.resolve(false);
    const work = { ...lane.work, completion: completion() };
    run(work, lane.queued);
    return work.completion.promise;
  }, [run]);
  const resolveConflict = useCallback((key: string, choice: "saved" | "mine"): Promise<boolean> => {
    const lane = lanes.current.get(key);
    if (!lane || lane.phase.kind !== "conflict") return Promise.resolve(false);
    const value = drafts.current.has(key) ? local.current[key] : lane.queued?.value ?? lane.work.value;
    assign(committed.current, key, lane.phase.currentValue);
    lane.queued?.completion.resolve(false);
    lanes.current.delete(key);
    drafts.current.delete(key);
    if (choice === "saved") {
      assign(local.current, key, lane.phase.currentValue); publish(); return Promise.resolve(true);
    }
    return saveSetting(lane.work.change.key, value);
  }, [publish, saveSetting]);
  const acceptSavedSetting = useCallback((key: string, value: string) => {
    committed.current[key] = value;
    if (!lanes.current.has(key) && !drafts.current.has(key)) local.current[key] = value;
    publish();
  }, [publish]);
  const getSetting = useCallback((key: string, fallback = "") => view.settings[key] ?? fallback, [view.settings]);
  return { ...view, getSetting, editSetting, saveSetting, retrySetting, resolveConflict, acceptSavedSetting };
}
