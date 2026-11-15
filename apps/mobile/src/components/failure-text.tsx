import { Children } from "react";
import { Text, type TextProps } from "react-native";
import { plainFailure } from "@showpilot/shared/ui-feedback";
/** Native recovery panels share the same plain-language failure boundary. */
export function FailureText({ children, ...props }: TextProps) {
  if (props.accessibilityRole !== "alert") return null;
  if (children === "" || children == null) return null;
  const parts = Children.toArray(children);
  const message = parts.every(part => typeof part === "string" || typeof part === "number") ? plainFailure(parts.join("")) : children;
  return <Text {...props}>{message}</Text>;
}
