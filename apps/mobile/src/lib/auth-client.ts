import { expoClient } from "@better-auth/expo/client";
import { organizationClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import * as SecureStore from "expo-secure-store";
import Constants from "expo-constants";
import { Platform } from "react-native";
import { SHOWPILOT_URL } from "@/lib/env";

const webStorage = {
  getItem(key: string): string | null {
    if (typeof localStorage === "undefined") return null;
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem(key: string, value: string): void {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(key, value);
    } catch {
      // Browser storage can be unavailable in privacy-restricted contexts.
    }
  },
  async getItemAsync(key: string): Promise<string | null> {
    return this.getItem(key);
  },
  async setItemAsync(key: string, value: string): Promise<void> {
    this.setItem(key, value);
  },
};

const authStorage = Platform.OS === "web" ? webStorage : SecureStore;

export const authClient = createAuthClient({
  baseURL: SHOWPILOT_URL,
  fetchOptions: {
    onRequest(context) {
      // Expo Go is only the development container. Its temporary exp:// LAN
      // URL is not ShowPilot's application identity, so present the registered
      // app scheme that Better Auth already trusts. Signed builds use the
      // Expo plugin's normal origin and never enter this branch.
      if (Platform.OS !== "web" && __DEV__ && Constants.appOwnership === "expo") {
        context.headers.set("expo-origin", "showpilot://");
      }
    },
  },
  plugins: [
    expoClient({
      scheme: "showpilot",
      storagePrefix: "showpilot",
      storage: authStorage,
    }),
    organizationClient(),
  ],
});
