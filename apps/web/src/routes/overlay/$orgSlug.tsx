import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect, useRef, useCallback } from "react";

export const Route = createFileRoute("/overlay/$orgSlug")({
  component: OverlayPage,
});

// ─── Types ────────────────────────────────────────────────────

interface GraphicData {
  id: string;
  title: string;
  subtitle?: string;
  style?: string;
}

interface Controls {
  accentColor: string;
  bgOpacity: number;
  primarySize: number;
  secondarySize: number;
  posX: number;
  posY: number;
  animSpeed: "fast" | "normal" | "slow";
}

const DEFAULT_CONTROLS: Controls = {
  accentColor: "#f59e0b",
  bgOpacity: 85,
  primarySize: 26,
  secondarySize: 15,
  posX: 5,
  posY: 82,
  animSpeed: "normal",
};

function parseStyleData(style?: string): { templateId?: string; controls?: Controls } {
  if (!style) return {};
  try {
    return JSON.parse(style);
  } catch {
    return {};
  }
}

function getAnimDuration(speed: Controls["animSpeed"]) {
  return speed === "fast" ? 150 : speed === "slow" ? 600 : 300;
}

function hexToRgba(hex: string, alpha: number) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function getPositionStyles(c: Controls) {
  const isLeft = c.posX < 33;
  const isCenter = c.posX >= 33 && c.posX <= 67;
  const isRight = c.posX > 67;
  const isTop = c.posY < 33;

  let left: string | number = `${c.posX}%`;
  let right: string | number = "auto";
  const top: string | number = `${c.posY}%`;
  let translateX = "0%";
  let textAlign: "left" | "center" | "right" = "left";

  if (isCenter) {
    translateX = "-50%";
    textAlign = "center";
  } else if (isRight) {
    left = "auto";
    right = `${100 - c.posX}%`;
    textAlign = "right";
  }

  return { left, right, top, translateX, textAlign, isLeft, isCenter, isRight, isTop };
}

// ─── Base CSS ─────────────────────────────────────────────────

const OVERLAY_CSS = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body, #root {
    width: 100%;
    height: 100%;
    background: transparent !important;
    overflow: hidden;
    font-family: 'Inter', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }
  .overlay-container {
    position: fixed;
    inset: 0;
    background: transparent;
    overflow: hidden;
    pointer-events: none;
  }
`;

// ─── Template Renderers (matching lt-preview exactly) ─────────

function renderTemplate(
  templateId: string,
  primary: string,
  secondary: string,
  visible: boolean,
  c: Controls,
) {
  const p = getPositionStyles(c);
  const dur = getAnimDuration(c.animSpeed);

  switch (templateId) {
    case "classic":
    default: {
      const slideDir = p.isTop ? "-40px" : "40px";
      return (
        <div
          style={{
            position: "absolute",
            maxWidth: 560,
            left: p.left,
            right: p.right,
            top: p.top,
            transform: `translateX(${p.translateX}) ${visible ? "translateY(0)" : `translateY(${slideDir})`}`,
            opacity: visible ? 1 : 0,
            transition: `all ${dur}ms cubic-bezier(0.16, 1, 0.3, 1)`,
            textAlign: p.textAlign,
          }}
        >
          <div
            style={{
              backdropFilter: "blur(16px)",
              WebkitBackdropFilter: "blur(16px)",
              borderRadius: 6,
              padding: "20px 32px",
              background: `rgba(0, 0, 0, ${c.bgOpacity / 100})`,
              borderLeft: p.isRight ? "none" : `4px solid ${c.accentColor}`,
              borderRight: p.isRight ? `4px solid ${c.accentColor}` : "none",
            }}
          >
            <p style={{ color: "#fff", fontWeight: 700, lineHeight: 1.2, letterSpacing: "-0.01em", fontSize: c.primarySize }}>
              {primary}
            </p>
            {secondary && (
              <p style={{ color: "rgba(255,255,255,0.65)", fontWeight: 400, marginTop: 4, fontSize: c.secondarySize }}>
                {secondary}
              </p>
            )}
          </div>
        </div>
      );
    }

    case "gradient-slab": {
      const slideDir = p.isTop ? "-100%" : "100%";
      const bg = p.isRight
        ? `linear-gradient(to left, ${hexToRgba(c.accentColor, 0.92)}, ${hexToRgba(c.accentColor, 0.5)} 50%, transparent)`
        : p.isCenter
          ? `linear-gradient(to right, transparent, ${hexToRgba(c.accentColor, 0.85)} 25%, ${hexToRgba(c.accentColor, 0.85)} 75%, transparent)`
          : `linear-gradient(to right, ${hexToRgba(c.accentColor, 0.92)}, ${hexToRgba(c.accentColor, 0.5)} 50%, transparent)`;
      return (
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: p.top,
            transform: visible ? "translateY(0)" : `translateY(${slideDir})`,
            opacity: visible ? 1 : 0,
            transition: `all ${dur + 200}ms cubic-bezier(0.16, 1, 0.3, 1)`,
          }}
        >
          <div style={{ padding: "20px 48px", background: bg, textAlign: p.textAlign }}>
            <p style={{ color: "#fff", fontWeight: 800, lineHeight: 1.2, letterSpacing: "-0.01em", fontSize: c.primarySize + 2 }}>
              {primary}
            </p>
            {secondary && (
              <p style={{ color: "rgba(255,255,255,0.8)", fontWeight: 500, marginTop: 4, letterSpacing: "0.05em", textTransform: "uppercase" as const, fontSize: c.secondarySize }}>
                {secondary}
              </p>
            )}
          </div>
        </div>
      );
    }

    case "glass-panel": {
      const slideDir = p.isTop ? "-20px" : "20px";
      return (
        <div
          style={{
            position: "absolute",
            maxWidth: 540,
            left: p.left,
            right: p.right,
            top: p.top,
            transform: `translateX(${p.translateX}) ${visible ? "translateY(0) scale(1)" : `translateY(${slideDir}) scale(0.97)`}`,
            opacity: visible ? 1 : 0,
            transition: `all ${dur + 100}ms cubic-bezier(0.16, 1, 0.3, 1)`,
            textAlign: p.textAlign,
          }}
        >
          <div
            style={{
              borderRadius: 12,
              padding: "20px 32px",
              border: "1px solid rgba(255,255,255,0.1)",
              background: `rgba(15, 15, 15, ${c.bgOpacity / 130})`,
              backdropFilter: "blur(24px) saturate(1.4)",
              WebkitBackdropFilter: "blur(24px) saturate(1.4)",
              boxShadow: `0 0 40px ${hexToRgba(c.accentColor, 0.1)}, inset 0 1px 0 rgba(255,255,255,0.05)`,
            }}
          >
            <p style={{ color: "#fff", fontWeight: 600, lineHeight: 1.2, fontSize: c.primarySize }}>
              {primary}
            </p>
            {secondary && (
              <p style={{ color: "rgba(255,255,255,0.5)", fontWeight: 400, marginTop: 6, fontSize: c.secondarySize }}>
                {secondary}
              </p>
            )}
          </div>
        </div>
      );
    }

    case "split": {
      const slideX = p.isRight ? "60px" : "-60px";
      return (
        <div
          style={{
            position: "absolute",
            display: "flex",
            left: p.left,
            right: p.right,
            top: p.top,
            transform: `translateX(${p.translateX}) ${visible ? "" : `translateX(${slideX})`}`,
            opacity: visible ? 1 : 0,
            transition: `all ${dur}ms cubic-bezier(0.16, 1, 0.3, 1)`,
            flexDirection: p.isRight ? "row-reverse" : "row",
          }}
        >
          <div style={{ padding: "16px 28px", display: "flex", alignItems: "center", background: c.accentColor }}>
            <p style={{ color: "#000", fontWeight: 800, lineHeight: 1.2, whiteSpace: "nowrap" as const, fontSize: c.primarySize - 2 }}>
              {primary}
            </p>
          </div>
          {secondary && (
            <div style={{ padding: "16px 28px", display: "flex", alignItems: "center", background: `rgba(0,0,0,${c.bgOpacity / 100})` }}>
              <p style={{ color: "rgba(255,255,255,0.8)", fontWeight: 500, whiteSpace: "nowrap" as const, fontSize: c.secondarySize + 1 }}>
                {secondary}
              </p>
            </div>
          )}
        </div>
      );
    }

    case "cinematic": {
      return (
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: `${c.posY}%`,
            opacity: visible ? 1 : 0,
            clipPath: visible ? "inset(0 0 0 0)" : "inset(0 50% 0 50%)",
            transition: `all ${dur + 200}ms cubic-bezier(0.16, 1, 0.3, 1)`,
          }}
        >
          <div
            style={{
              backdropFilter: "blur(12px)",
              WebkitBackdropFilter: "blur(12px)",
              padding: "16px 0",
              textAlign: "center",
              background: `rgba(0, 0, 0, ${c.bgOpacity / 100})`,
              borderTop: "1px solid rgba(255,255,255,0.05)",
              borderBottom: "1px solid rgba(255,255,255,0.05)",
            }}
          >
            <p style={{ color: "#fff", fontWeight: 300, letterSpacing: "0.15em", textTransform: "uppercase" as const, fontSize: c.primarySize - 4 }}>
              {primary}
              {secondary && (
                <span style={{ margin: "0 16px", fontWeight: 400, color: hexToRgba(c.accentColor, 0.8) }}>|</span>
              )}
              {secondary && (
                <span style={{ color: "rgba(255,255,255,0.5)", letterSpacing: "0.2em", fontWeight: 300, fontSize: c.secondarySize + 1 }}>
                  {secondary}
                </span>
              )}
            </p>
          </div>
        </div>
      );
    }

    case "accent-line": {
      const slideDir = p.isTop ? "-30px" : "30px";
      return (
        <div
          style={{
            position: "absolute",
            maxWidth: 480,
            left: p.left,
            right: p.right,
            top: p.top,
            transform: `translateX(${p.translateX}) ${visible ? "translateY(0)" : `translateY(${slideDir})`}`,
            opacity: visible ? 1 : 0,
            transition: `all ${dur}ms cubic-bezier(0.16, 1, 0.3, 1)`,
            textAlign: p.textAlign,
          }}
        >
          <div style={{ paddingBottom: 12, borderBottom: `2px solid ${c.accentColor}` }}>
            <p style={{ color: "#fff", fontWeight: 600, lineHeight: 1.2, fontSize: c.primarySize, textShadow: "0 2px 12px rgba(0,0,0,0.9)" }}>
              {primary}
            </p>
            {secondary && (
              <p style={{ color: "rgba(255,255,255,0.6)", fontWeight: 400, marginTop: 4, fontSize: c.secondarySize, textShadow: "0 2px 8px rgba(0,0,0,0.8)" }}>
                {secondary}
              </p>
            )}
          </div>
        </div>
      );
    }

    case "scripture-card": {
      const slideDir = c.posY < 33 ? "-30px" : "30px";
      return (
        <div
          style={{
            position: "absolute",
            width: "85%",
            maxWidth: 780,
            left: `${c.posX}%`,
            top: `${c.posY}%`,
            transform: visible
              ? "translateX(-50%) translateY(0)"
              : `translateX(-50%) translateY(${slideDir})`,
            opacity: visible ? 1 : 0,
            transition: `all ${dur + 200}ms cubic-bezier(0.16, 1, 0.3, 1)`,
          }}
        >
          <div
            style={{
              borderRadius: 12,
              padding: "32px 40px",
              textAlign: "center",
              border: "1px solid rgba(255,255,255,0.08)",
              background: `rgba(0, 0, 0, ${c.bgOpacity / 120})`,
              backdropFilter: "blur(20px)",
              WebkitBackdropFilter: "blur(20px)",
            }}
          >
            <p style={{ color: "#fff", fontWeight: 300, fontStyle: "italic", lineHeight: 1.5, fontSize: c.primarySize + 2 }}>
              &ldquo;{primary}&rdquo;
            </p>
            {secondary && (
              <p style={{ fontWeight: 600, marginTop: 16, letterSpacing: "0.08em", textTransform: "uppercase" as const, fontSize: c.secondarySize + 1, color: c.accentColor }}>
                {secondary}
              </p>
            )}
          </div>
        </div>
      );
    }

    case "corner-badge": {
      const slideX = p.isRight ? "20px" : "-20px";
      const initials = primary.split(" ").map((w) => w[0]).join("").slice(0, 2);
      return (
        <div
          style={{
            position: "absolute",
            left: p.left,
            right: p.right,
            top: p.top,
            transform: `translateX(${p.translateX}) ${visible ? "scale(1)" : `translateX(${slideX}) scale(0.9)`}`,
            opacity: visible ? 1 : 0,
            transition: `all ${dur}ms cubic-bezier(0.16, 1, 0.3, 1)`,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              borderRadius: 9999,
              padding: "6px 24px 6px 6px",
              background: `rgba(0, 0, 0, ${c.bgOpacity / 100})`,
              flexDirection: p.isRight ? "row-reverse" : "row",
            }}
          >
            <div
              style={{
                width: 40,
                height: 40,
                borderRadius: 9999,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: c.accentColor,
              }}
            >
              <span style={{ color: "#000", fontSize: 14, fontWeight: 900 }}>{initials}</span>
            </div>
            <div style={{ textAlign: p.isRight ? "right" : "left" }}>
              <p style={{ color: "#fff", fontWeight: 600, lineHeight: 1.2, fontSize: c.primarySize - 10 }}>
                {primary}
              </p>
              {secondary && (
                <p style={{ color: "rgba(255,255,255,0.5)", fontWeight: 400, fontSize: c.secondarySize - 3 }}>
                  {secondary}
                </p>
              )}
            </div>
          </div>
        </div>
      );
    }

    case "boxed": {
      const slideDir = p.isTop ? "-50px" : "50px";
      return (
        <div
          style={{
            position: "absolute",
            maxWidth: 520,
            left: p.left,
            right: p.right,
            top: p.top,
            transform: `translateX(${p.translateX}) ${visible ? "translateY(0)" : `translateY(${slideDir})`}`,
            opacity: visible ? 1 : 0,
            transition: `all ${dur + 100}ms cubic-bezier(0.16, 1, 0.3, 1)`,
            textAlign: p.textAlign,
          }}
        >
          <div>
            <div style={{ padding: "14px 28px", borderRadius: "8px 8px 0 0", background: c.accentColor }}>
              <p style={{ color: "#000", fontWeight: 800, lineHeight: 1.2, fontSize: c.primarySize - 2 }}>
                {primary}
              </p>
            </div>
            {secondary && (
              <div style={{ padding: "12px 28px", borderRadius: "0 0 8px 8px", background: `rgba(0,0,0,${c.bgOpacity / 100})` }}>
                <p style={{ color: "rgba(255,255,255,0.75)", fontWeight: 500, fontSize: c.secondarySize }}>
                  {secondary}
                </p>
              </div>
            )}
          </div>
        </div>
      );
    }

    case "revealer": {
      const slideX = p.isRight ? "20px" : "-20px";
      return (
        <div
          style={{
            position: "absolute",
            maxWidth: 520,
            left: p.left,
            right: p.right,
            top: p.top,
            textAlign: p.textAlign,
          }}
        >
          <div
            style={{
              height: 3,
              marginBottom: 12,
              background: c.accentColor,
              transformOrigin: p.isRight ? "right" : "left",
              transform: visible ? "scaleX(1)" : "scaleX(0)",
              transition: `transform ${dur + 200}ms cubic-bezier(0.16, 1, 0.3, 1)`,
            }}
          />
          <div
            style={{
              transform: visible ? "translateX(0)" : `translateX(${slideX})`,
              opacity: visible ? 1 : 0,
              transition: `all ${dur + 200}ms cubic-bezier(0.16, 1, 0.3, 1)`,
              transitionDelay: visible ? `${dur * 0.6}ms` : "0ms",
            }}
          >
            <p style={{ color: "#fff", fontWeight: 700, lineHeight: 1.2, fontSize: c.primarySize, textShadow: "0 2px 16px rgba(0,0,0,0.9)" }}>
              {primary}
            </p>
            {secondary && (
              <p style={{ fontWeight: 500, marginTop: 4, letterSpacing: "0.05em", textTransform: "uppercase" as const, fontSize: c.secondarySize, color: hexToRgba(c.accentColor, 0.7), textShadow: "0 2px 8px rgba(0,0,0,0.8)" }}>
                {secondary}
              </p>
            )}
          </div>
        </div>
      );
    }
  }
}

// ─── Overlay Page Component ───────────────────────────────────

function OverlayPage() {
  const { orgSlug } = Route.useParams();

  const [graphic, setGraphic] = useState<GraphicData | null>(null);
  const [visible, setVisible] = useState(false);
  const prevIdRef = useRef<string | null>(null);
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const poll = useCallback(async () => {
    try {
      const baseUrl = typeof window !== "undefined" ? window.location.origin : "";
      const res = await fetch(`${baseUrl}/api/overlay/${orgSlug}`);
      const result: GraphicData | null = await res.json();

      if (result) {
        if (result.id !== prevIdRef.current) {
          // New graphic — clear then show
          if (visible) {
            setVisible(false);
            if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
            clearTimerRef.current = setTimeout(() => {
              setGraphic(result);
              prevIdRef.current = result.id;
              requestAnimationFrame(() => {
                requestAnimationFrame(() => setVisible(true));
              });
            }, 350);
          } else {
            setGraphic(result);
            prevIdRef.current = result.id;
            requestAnimationFrame(() => {
              requestAnimationFrame(() => setVisible(true));
            });
          }
        }
      } else {
        if (prevIdRef.current !== null) {
          setVisible(false);
          prevIdRef.current = null;
          if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
          clearTimerRef.current = setTimeout(() => {
            setGraphic(null);
          }, 350);
        }
      }
    } catch {
      // Silently retry
    }
  }, [orgSlug, visible]);

  useEffect(() => {
    poll();
    const interval = setInterval(poll, 500);
    return () => {
      clearInterval(interval);
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
    };
  }, [poll]);

  // Parse style data from graphic
  const styleData = graphic ? parseStyleData(graphic.style) : {};
  const controls: Controls = { ...DEFAULT_CONTROLS, ...(styleData.controls ?? {}) };
  const templateId = styleData.templateId ?? "classic";

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: OVERLAY_CSS }} />
      <div className="overlay-container">
        {graphic &&
          renderTemplate(
            templateId,
            graphic.title,
            graphic.subtitle ?? "",
            visible,
            controls,
          )}
      </div>
    </>
  );
}
