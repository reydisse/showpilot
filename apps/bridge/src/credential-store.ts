import { Entry } from "@napi-rs/keyring";

const service = "tech.showpilot.bridge.standalone";
const unavailable = "Secure credential storage is unavailable. Unlock your system keychain and try again.";

function entry(reference: string): Entry {
  // The in-memory Linux fallback loses credentials on reboot. Require persistence.
  return new Entry(service, reference, { linux: { store: "secret-service" } });
}

export function readCredential(reference: string): string {
  try {
    const key = entry(reference).getPassword();
    if (!key) throw new Error(unavailable);
    return key;
  } catch { throw new Error(unavailable); }
}
export function writeCredential(reference: string, key: string): void {
  try { entry(reference).setPassword(key); }
  catch { throw new Error(unavailable); }
}
export function deleteCredential(reference: string): void {
  try { entry(reference).deleteCredential(); }
  catch { /* An encrypted orphan is safer than rolling back a committed config. */ }
}
