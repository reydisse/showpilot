import { confirmAccountSignOut, SignOutFailure, type SignOutCommand } from "./account-sign-out";
type State = { failed: boolean; pending: boolean };
const initial: State = { failed: false, pending: false };
let state = initial;
let controller: AbortController | null = null;
let command: SignOutCommand | null = null;
const listeners = new Set<() => void>();
const publish = (next: State) => { state = next; listeners.forEach(listener => listener()); };
export const signOutReconciliation = {
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  getSnapshot: () => state,
  getServerSnapshot: () => initial,
};
/** Retire the old attempt before a new explicit sign-in sends credentials. */
export function stopSignOutReconciliation() {
  controller?.abort(); controller = null; command = null; publish(initial);
}
export function reconcileSignOut(next?: SignOutCommand) {
  if (controller) return;
  command = next ?? command;
  if (!command) return;
  const active = new AbortController(); controller = active;
  publish({ failed: false, pending: true });
  void confirmAccountSignOut(command, active.signal).then(() => {
    if (controller === active) { command = null; publish(initial); }
  }, error => {
    if (controller !== active) return;
    if (error instanceof SignOutFailure) command = error.command;
    publish({ failed: true, pending: false });
  }).finally(() => { if (controller === active) controller = null; });
}
