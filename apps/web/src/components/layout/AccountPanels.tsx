import { lazy, type ComponentProps } from "react";
import { runRouteLoad } from "@/lib/route-load-deadlines";
import type { ProfilePanel } from "./ProfileModal";
import type { NotificationInbox } from "./NotificationCenter";

type AccountPanelProps =
  | { view: "profile"; panelProps: ComponentProps<typeof ProfilePanel> }
  | {
      view: "notifications";
      panelProps: ComponentProps<typeof NotificationInbox>;
    };

/** Each explicit retry gets fresh lazy instances, including a previously failed child. */
export function createAccountPanels() {
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
  return function AccountPanels(props: AccountPanelProps) {
    if (props.view === "profile") return <Profile {...props.panelProps} />;
    return <Notifications {...props.panelProps} />;
  };
}
