import type { DesktopUpdateInfo } from "./desktop-runtime";

export type DesktopOperationState<T> =
  | { kind: "idle" }
  | { kind: "pending" | "unconfirmed"; label: string }
  | { kind: "failed"; label: string; message: string }
  | { kind: "complete"; label: string; value: T };
export const desktopOperationPending = (state: DesktopOperationState<unknown>) => state.kind === "pending" || state.kind === "unconfirmed";

/** A slow native invocation remains owned until the native promise settles.
 * The UI deadline reports uncertainty; it does not cancel IPC or permit replay. */
export class DesktopOperation<T> {
  private state: DesktopOperationState<T> = { kind: "idle" };
  private listeners = new Set<() => void>();
  subscribe = (notify: () => void) => { this.listeners.add(notify); return () => { this.listeners.delete(notify); }; };
  getSnapshot = () => this.state;
  private publish(state: DesktopOperationState<T>) { this.state = state; this.listeners.forEach(notify => notify()); }
  start(label: string, work: (withinDeadline: () => boolean) => Promise<T>, timeoutMs = 12000) {
    if (desktopOperationPending(this.state)) return false;
    const pending: DesktopOperationState<T> = { kind: "pending", label };
    this.publish(pending);
    const timer = setTimeout(() => this.publish({ kind: "unconfirmed", label }), timeoutMs);
    void Promise.resolve().then(() => work(() => this.state === pending)).then(
      value => { clearTimeout(timer); this.publish({ kind: "complete", label, value }); },
      error => { clearTimeout(timer); this.publish({ kind: "failed", label, message: error instanceof Error ? error.message : typeof error === "string" ? error : `${label} could not be confirmed.` }); },
    );
    return true;
  }
  dismiss() { if (this.state.kind === "failed") this.publish({ kind: "idle" }); }
}
function createActions() {
  return {
    window: new DesktopOperation<void>(),
    localShow: new DesktopOperation<void>(),
    bridge: new DesktopOperation<void>(),
    check: new DesktopOperation<DesktopUpdateInfo | null>(),
    install: new DesktopOperation<(DesktopUpdateInfo & { restartRequired: boolean }) | null>(),
  };
}
const actions = new WeakMap<object, ReturnType<typeof createActions>>();
const inert = createActions();
/** Tauri's core object belongs to this webview. Navigation/remounting must not
 * release its pending installer or device-mode command. SSR never starts one. */
export function getDesktopActions() {
  const core = typeof window === "undefined" ? undefined : window.__TAURI__?.core;
  if (!core) return inert;
  let current = actions.get(core);
  if (!current) { current = createActions(); actions.set(core, current); }
  return current;
}

export async function desktopRead<T>(work: () => Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([Promise.resolve().then(work), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); })]);
  } finally { clearTimeout(timer!); }
}
