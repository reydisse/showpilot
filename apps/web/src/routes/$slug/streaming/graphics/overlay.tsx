import { createFileRoute } from "@tanstack/react-router";
import { PageSkeleton } from "@/components/ui/Skeleton";
import { useState, useEffect } from "react";
import { getActiveGraphic } from "@/lib/graphics";

export const Route = createFileRoute(
  "/$slug/streaming/graphics/overlay"
)({
  pendingComponent: () => <PageSkeleton />,
  loader: async ({ context }) => {
    const { withPermission } = await import("@/lib/route-permissions");
    await withPermission(context.role, "lowerthird:view", context.slug, context.orgId);
    return { orgId: context.orgId };
  },
  component: OverlayPage,
});

function OverlayPage() {
  const { orgId } = Route.useLoaderData();
  const [graphic, setGraphic] = useState<{
    id: string;
    title: string;
    subtitle: string;
    style: string;
  } | null>(null);
  const [visible, setVisible] = useState(false);
  const [prevId, setPrevId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    const poll = async () => {
      try {
        const result = await getActiveGraphic({ data: { orgId } });
        if (!active) return;

        if (result) {
          if (result.id !== prevId) {
            setVisible(false);
            setTimeout(() => {
              setGraphic(result);
              setPrevId(result.id);
              setVisible(true);
            }, 100);
          }
        } else {
          if (prevId) {
            setVisible(false);
            setTimeout(() => {
              setGraphic(null);
              setPrevId(null);
            }, 500);
          }
        }
      } catch {
        // Silently retry on next poll
      }
    };

    poll();
    const interval = setInterval(poll, 2000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [orgId, prevId]);

  const style = graphic
    ? (() => {
        try {
          return JSON.parse(graphic.style) as { styleName?: string };
        } catch {
          return {};
        }
      })()
    : {};

  const isAccent = style.styleName === "accent";
  const isMinimal = style.styleName === "minimal";

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "transparent",
        overflow: "hidden",
        fontFamily: "'Inter', 'Montserrat', sans-serif",
      }}
    >
      {graphic && (
        <div
          style={{
            position: "absolute",
            bottom: "80px",
            left: "60px",
            transition: "all 0.5s cubic-bezier(0.16, 1, 0.3, 1)",
            transform: visible ? "translateX(0)" : "translateX(-120%)",
            opacity: visible ? 1 : 0,
          }}
        >
          <div
            style={{
              background: isAccent
                ? "linear-gradient(135deg, #FFC107 0%, #FF8F00 100%)"
                : isMinimal
                  ? "rgba(0, 0, 0, 0.6)"
                  : "rgba(0, 0, 0, 0.85)",
              backdropFilter: "blur(12px)",
              borderRadius: "12px",
              padding: isMinimal ? "12px 24px" : "16px 32px",
              borderLeft: isAccent
                ? "none"
                : isMinimal
                  ? "2px solid rgba(255, 193, 7, 0.6)"
                  : "4px solid #FFC107",
              maxWidth: "600px",
            }}
          >
            <p
              style={{
                color: isAccent ? "#000" : "#fff",
                fontSize: isMinimal ? "20px" : "24px",
                fontWeight: 700,
                margin: 0,
                lineHeight: 1.2,
              }}
            >
              {graphic.title}
            </p>
            {graphic.subtitle && (
              <p
                style={{
                  color: isAccent
                    ? "rgba(0, 0, 0, 0.7)"
                    : "rgba(255, 255, 255, 0.7)",
                  fontSize: isMinimal ? "14px" : "16px",
                  fontWeight: 400,
                  margin: "4px 0 0",
                  lineHeight: 1.3,
                }}
              >
                {graphic.subtitle}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
