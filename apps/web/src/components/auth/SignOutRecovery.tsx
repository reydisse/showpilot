import { useSyncExternalStore } from "react";
import { reconcileSignOut, signOutReconciliation } from "@/lib/sign-out-reconciliation";
export function SignOutRecovery() {
  const { failed } = useSyncExternalStore(signOutReconciliation.subscribe, signOutReconciliation.getSnapshot, signOutReconciliation.getServerSnapshot);
  if (!failed) return null;
  return <div role="alert" className="my-3 text-sm text-red-400">
    <p>Sign-out could not finish.</p>
    <button type="button" className="min-h-11 underline" onClick={() => reconcileSignOut()}>Retry sign-out</button>
  </div>;
}
