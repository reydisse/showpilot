import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRoute,
} from "@tanstack/react-router";
import { useEffect } from "react";
import { DesktopBridgeController } from "@/components/layout/DesktopBridgeController";
import { DesktopNotificationController } from "@/components/layout/DesktopNotificationController";
import { registerNotificationWorker } from "@/lib/notifications";
import appCss from "../styles.css?url";

const THEME_BOOTSTRAP = `(function(){try{var saved=localStorage.getItem("showpilot-theme");var theme=saved==="light"||saved==="dark"?saved:(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");document.documentElement.classList.remove("light","dark");document.documentElement.classList.add(theme)}catch(_){}})();`;

export const Route = createRootRoute({
  pendingMs: 100, // show pending state after 100ms (avoids flash on fast navigations)
  pendingMinMs: 200, // keep it visible for at least 200ms to avoid flicker
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
      { name: "theme-color", content: "#0a0a0a" },
      { name: "apple-mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-status-bar-style", content: "black-translucent" },
      { title: "ShowPilot" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", type: "image/svg+xml", href: "/showpilot-logo.svg" },
      { rel: "manifest", href: "/manifest.json" },
      { rel: "apple-touch-icon", href: "/logo192.png" },
      {
        rel: "preconnect",
        href: "https://fonts.googleapis.com",
      },
      {
        rel: "preconnect",
        href: "https://fonts.gstatic.com",
        crossOrigin: "anonymous",
      },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Inter:wght@300..700&family=Montserrat:wght@600;700;800&display=swap",
      },
    ],
  }),
  component: RootComponent,
  shellComponent: RootDocument,
});

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
        <HeadContent />
      </head>
      <body className="bg-board-bg text-board-text antialiased">
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  useEffect(() => { void registerNotificationWorker(); }, []);
  return (
    <>
      <DesktopBridgeController />
      <DesktopNotificationController />
      <Outlet />
    </>
  );
}
