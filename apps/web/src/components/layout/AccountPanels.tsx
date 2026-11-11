import { lazy, type ComponentProps } from "react";
import { runRouteLoad } from "@/lib/route-load-deadlines";
import type { SignOutControl } from "./SignOutControl";
import type { ProfilePanel } from "./ProfileModal";
import type { NotificationInbox } from "./NotificationCenter";
import type { NotificationTimeZone } from "./NotificationTimeZone";
import type { NotificationCountSummary } from "./NotificationCountSummary";

type AccountPanelProps =
  | { view: "signout"; panelProps: ComponentProps<typeof SignOutControl> }
  | {
      view: "timezone";
      panelProps: ComponentProps<typeof NotificationTimeZone>;
    }
  | {
      view: "count";
      panelProps: ComponentProps<typeof NotificationCountSummary>;
    }
  | { view: "profile"; panelProps: ComponentProps<typeof ProfilePanel> }
  | {
      view: "notifications";
      panelProps: ComponentProps<typeof NotificationInbox>;
    };

/** Each explicit retry gets fresh lazy instances, including a previously failed child. */
export function createAccountPanels() {
  const SignOut = lazy(() =>
    runRouteLoad(() =>
      import("./SignOutControl").then((module) => ({
        default: module.SignOutControl,
      })),
    ),
  );
  const Profile = lazy(() =>
    runRouteLoad(() =>
      import("./ProfileModal").then((module) => ({
        default: module.ProfilePanel,
      })),
    ),
  );
  const Notifications = lazy(() =>
    runRouteLoad(() =>
      import("./NotificationCenter").then((module) => ({
        default: module.NotificationInbox,
      })),
    ),
  );
  const TimeZone = lazy(() =>
    runRouteLoad(() =>
      import("./NotificationTimeZone").then((module) => ({
        default: module.NotificationTimeZone,
      })),
    ),
  );
  const Count = lazy(() =>
    runRouteLoad(() =>
      import("./NotificationCountSummary").then((module) => ({
        default: module.NotificationCountSummary,
      })),
    ),
  );
  return function AccountPanels(props: AccountPanelProps) {
    if (props.view === "signout") return <SignOut {...props.panelProps} />;
    if (props.view === "profile") return <Profile {...props.panelProps} />;
    if (props.view === "timezone") return <TimeZone {...props.panelProps} />;
    if (props.view === "count") return <Count {...props.panelProps} />;
    return <Notifications {...props.panelProps} />;
  };
}
