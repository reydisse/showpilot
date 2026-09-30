import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({ platform: { OS: "ios" }, values: new Map() }));
vi.mock("react-native", () => ({ Platform: storage.platform }));
vi.mock("expo-secure-store", () => {
  function validate(key) {
    if (!/^[\w.-]+$/.test(key)) throw new Error("Invalid key provided to SecureStore");
  }
  return {
    getItemAsync: async (key) => { validate(key); return storage.values.get(key) ?? null; },
    setItemAsync: async (key, value) => { validate(key); storage.values.set(key, value); },
    deleteItemAsync: async (key) => { validate(key); storage.values.delete(key); },
  };
});
import { clearStoredRundownPin, getStoredRundownPin, setStoredRundownPin } from "../../../../mobile/src/lib/rundown-pin";

describe("rundown PIN storage", () => {
  beforeEach(() => { storage.platform.OS = "ios"; storage.values.clear(); sessionStorage.clear(); });

  it.each(["ios", "android"])("opens a rundown before any PIN is saved on %s", async (platform) => {
    storage.platform.OS = platform;
    expect(await getStoredRundownPin("org-123")).toBeNull();
  });

  it("saves, retrieves, and clears PINs with native-safe keys", async () => {
    const orgs = ["org-123", "org:123", "org_3a_123", "crew/name", "crew name", "équipe", "crew🎤", "crew🎬"];
    for (const [index, org] of orgs.entries()) await setStoredRundownPin(org, ` ${index}123 `);
    expect(storage.values.size).toBe(orgs.length);
    for (const [index, org] of orgs.entries()) expect(await getStoredRundownPin(org)).toBe(`${index}123`);
    await clearStoredRundownPin(orgs[0]);
    expect(await getStoredRundownPin(orgs[0])).toBeNull();
    expect(await getStoredRundownPin(orgs[1])).toBe("1123");
  });

  it("retains existing browser PINs and ignores empty organizations", async () => {
    storage.platform.OS = "web";
    sessionStorage.setItem("showpilot-rundown-pin:org-123", "4321");
    expect(await getStoredRundownPin("org-123")).toBe("4321");
    await clearStoredRundownPin("org-123");
    expect(await getStoredRundownPin("org-123")).toBeNull();
    storage.platform.OS = "ios";
    await setStoredRundownPin("", "1234");
    await clearStoredRundownPin("");
    expect(await getStoredRundownPin("")).toBeNull();
    expect(storage.values.size).toBe(0);
  });
});
