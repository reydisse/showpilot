// A local lock, never an authentication credential. Background sign-out still
// revokes the server session through the existing guarded endpoint.
export const LOCAL_ACCOUNT_EXIT_COOKIE = "showpilot-account-exit";
let exited = false;
const listeners = new Set<() => void>();
export const localAccountExit = {
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  getSnapshot: () => typeof document !== "undefined" && (exited || accountExitRequested(document.cookie)),
  getServerSnapshot: () => false,
};
export function accountExitRequested(cookie: string): boolean {
  return cookie.split(";").some(part => part.trim().startsWith(`${LOCAL_ACCOUNT_EXIT_COOKIE}=`) && part.trim() !== `${LOCAL_ACCOUNT_EXIT_COOKIE}=`);
}
export function lockLocalAccount() {
  exited = true;
  document.cookie = `${LOCAL_ACCOUNT_EXIT_COOKIE}=1; Path=/; Max-Age=31536000; SameSite=Lax`;
  try { localStorage.setItem(LOCAL_ACCOUNT_EXIT_COOKIE, crypto.randomUUID()); } catch { /* Storage is optional. */ }
  listeners.forEach(listener => listener());
}
export function unlockLocalAccount() {
  exited = false;
  document.cookie = `${LOCAL_ACCOUNT_EXIT_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
  try { localStorage.removeItem(LOCAL_ACCOUNT_EXIT_COOKIE); } catch { /* Storage is optional. */ }
  listeners.forEach(listener => listener());
}
