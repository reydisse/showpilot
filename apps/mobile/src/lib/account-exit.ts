import type { QueryClient } from "@tanstack/react-query";
import { Platform } from "react-native";
import { authClient, authStorage } from "@/lib/auth-client";
import { getNativePushToken } from "@/lib/native-notifications";
import { SHOWPILOT_URL } from "@/lib/env";

let pending: AbortController | null = null;
let clearing: Promise<void> = Promise.resolve();
let generation = 0, locked = false, failed = false;
let retry: (() => void) | null = null;
const listeners = new Set<() => void>();
const publish = (value: boolean) => { failed = value; listeners.forEach(listener => listener()); };
export const mobileSignOutRecovery = {
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  getSnapshot: () => failed,
  getServerSnapshot: () => false,
};
export function retryMobileSignOut() { retry?.(); }
export function mobileAccountIsLocked() { try { return locked || authStorage.getItem("showpilot_signed_out") === "1"; } catch { return true; } }
async function clearStoredSession() {
  await authStorage.setItemAsync("showpilot_cookie", "{}");
  await authStorage.setItemAsync("showpilot_session_data", "{}");
}
/** Only local storage is awaited before accepting new credentials. */
export async function prepareMobileSignIn() {
  generation++; pending?.abort(); pending = null; retry = null; publish(false);
  clearing = clearing.catch(clearStoredSession);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([clearing, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("This device could not open your account.")), 8_000); })]); }
  catch { throw new Error("This device could not open your account."); }
  finally { clearTimeout(timer); }
}
export function finishMobileSignIn() {
  authStorage.setItem("showpilot_signed_out", ""); locked = false; publish(false);
}

/** Leave locally now; retain only captured credentials for background cleanup. */
export function exitMobileAccount(queryClient: QueryClient, organizationId?: string): void {
  if (pending) return;
  const owner = ++generation;
  const cookie = authClient.getCookie();
  const atom = authClient.$store.atoms.session;
  const expectedSessionId = atom.get().data?.session.id;
  locked = true;
  atom.set({ ...atom.get(), data: null, error: null, isPending: false });
  const activeOrganization = authClient.$store.atoms.activeOrganization;
  if (activeOrganization) activeOrganization.set({ ...activeOrganization.get(), data: null, error: null, isPending: false, isRefetching: false });
  const listOrganizations = authClient.$store.atoms.listOrganizations;
  if (listOrganizations) listOrganizations.set({ ...listOrganizations.get(), data: null, error: null, isPending: false, isRefetching: false });
  const activeMember = authClient.$store.atoms.activeMember;
  if (activeMember) activeMember.set({ ...activeMember.get(), data: null, error: null, isPending: false, isRefetching: false });
  const activeMemberRole = authClient.$store.atoms.activeMemberRole;
  if (activeMemberRole) activeMemberRole.set({ ...activeMemberRole.get(), data: null, error: null, isPending: false, isRefetching: false });
  void queryClient.cancelQueries(); queryClient.clear();
  try { authStorage.setItem("showpilot_signed_out", "1"); } catch { publish(true); }
  clearing = cookie.catch(() => undefined).then(clearStoredSession);
  // Revocation reports failure once; a second storage promise must not raise
  // an unhandled error or restore the account while cleanup is in the background.
  void clearing.catch(() => undefined);
  const start = () => {
    if (owner !== generation || pending) return;
    const controller = new AbortController(); pending = controller;
    const current = () => owner === generation && !controller.signal.aborted;
    let expire!: () => void;
    const deadline = new Promise<never>((_, reject) => { expire = () => reject(new Error("Sign-out could not finish.")); });
    const timer = setTimeout(() => { controller.abort(); expire(); }, 8_000);
    publish(false);
    const work = (async () => {
      const captured = await cookie;
      await clearing;
      if (!current()) return;
      const token = await getNativePushToken().catch(() => null);
      if (!current()) return;
      const headers = { "Content-Type": "application/json", "expo-origin": "showpilot://", cookie: captured };
      let tokenFailed = false;
      if (token && organizationId && Platform.OS !== "web") {
        await fetch(`${SHOWPILOT_URL}/api/mobile/v1/push-token`, {
          method: "POST", credentials: "omit", signal: controller.signal, headers,
          body: JSON.stringify({ orgId: organizationId, token, platform: Platform.OS, enabled: false }),
        }).then(response => { if (!response.ok) tokenFailed = true; }, () => { tokenFailed = true; });
      }
      if (!current()) return;
      if (Platform.OS === "web") {
        const response = await authClient.signOut({ fetchOptions: { signal: controller.signal, headers: { "X-ShowPilot-Local-Exit": "1" }, body: expectedSessionId ? { expectedSessionId } : undefined } });
        if (response.error) throw new Error("Sign-out could not finish.");
      } else {
        // Do not feed this response back to Expo's cookie store: an old response
        // must never overwrite credentials from a later explicit sign-in.
        const response = await fetch(`${SHOWPILOT_URL}/api/auth/sign-out`, {
          method: "POST", credentials: "omit", signal: controller.signal,
          headers: { ...headers, "X-ShowPilot-Local-Exit": "1" },
          body: JSON.stringify(expectedSessionId ? { expectedSessionId } : {}),
        });
        if (!response.ok || (await response.json())?.success !== true) throw new Error("Sign-out could not finish.");
      }
      if (tokenFailed) throw new Error("Sign-out could not finish.");
      if (owner === generation) retry = null;
    })();
    void Promise.race([work, deadline]).catch(() => { if (owner === generation) publish(true); })
      .finally(() => { clearTimeout(timer); if (pending === controller) pending = null; });
  };
  retry = start; start();
}
