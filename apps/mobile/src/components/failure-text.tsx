import { Children, useEffect } from "react";
import { Text, type TextProps } from "react-native";
import { plainFailure } from "@showpilot/shared/ui-feedback";
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
  if (props.accessibilityRole !== "alert") return null;
  if (children === "" || children == null) return null;
  const parts = Children.toArray(children);
  const message = parts.every(part => typeof part === "string" || typeof part === "number") ? plainFailure(parts.join("")) : children;
  return <Text {...props}>{message}</Text>;
}
