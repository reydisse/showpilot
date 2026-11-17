import { useEffect } from "react";
// Explicit extension prevents Metro from resolving this import back to the native wrapper.
// @ts-expect-error Metro supports explicit TypeScript extensions.
import { FailureText as SharedFailureText } from "./failure-text.tsx";
import { type TextProps } from "react-native";
import { authClient } from "@/lib/auth-client";
import { createFailureReporter } from "@/lib/failure-reporting";
import { fetch as expoFetch } from "expo/fetch";
import { SHOWPILOT_URL } from "@/lib/env";
const reporters = new Map<string, ReturnType<typeof createFailureReporter>>();
/** Native recovery panels share the same plain-language failure boundary. */
export function FailureText({ children, ...props }: TextProps) {
  const { data: organization } = authClient.useActiveOrganization();
  const visible = props.accessibilityRole === "alert" && children !== "" && children != null;
  useEffect(() => {
    if (!visible || !organization?.id) return;
    let reporter = reporters.get(organization.id);
    if (!reporter) {
      reporter = createFailureReporter({ orgId: organization.id, baseUrl: SHOWPILOT_URL, fetch: expoFetch, getCookie: () => authClient.getCookie() });
      reporters.set(organization.id, reporter);
    }
    reporter.reportError(undefined);
  }, [visible, children, organization?.id]);
  return <SharedFailureText {...props}>{children}</SharedFailureText>;
}
