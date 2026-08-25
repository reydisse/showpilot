import { expoClient } from "@better-auth/expo/client";
import { organizationClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import * as SecureStore from "expo-secure-store";
import { SHOWPILOT_URL } from "@/lib/env";

export const authClient = createAuthClient({
  baseURL: SHOWPILOT_URL,
  plugins: [
    expoClient({
      scheme: "showpilot",
      storagePrefix: "showpilot",
      storage: SecureStore,
    }),
    organizationClient(),
  ],
});
