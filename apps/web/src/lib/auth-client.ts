import { createAuthClient } from "better-auth/react";
import { organizationClient } from "better-auth/client/plugins";
import { authAccessControl, authRoles } from "@/lib/auth-access";

export const authClient = createAuthClient({
  plugins: [
    organizationClient({
      ac: authAccessControl,
      roles: authRoles,
    }),
  ],
});
