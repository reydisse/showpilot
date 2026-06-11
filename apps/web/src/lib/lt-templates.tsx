import { useCallback, useRef, useState } from "react";

// ─────────────────────────────────────────────────────────────
// Lower Third Templates — single source of truth
//
// Both the operator preview (/$slug/streaming/lt-preview) and the
// public OBS overlay (/overlay/:slug) render through this module, so
// what an operator previews is exactly what goes on air.
//
// Everything is authored against a fixed 1920×1080 broadcast stage and
// scaled to fit its container via <LtStage>. That makes font sizes and
// spacing map directly to real broadcast pixels — true WYSIWYG.
// ─────────────────────────────────────────────────────────────

export const STAGE_W = 1920;
export const STAGE_H = 1080;

export interface Controls {
  accentColor: string;
  bgOpacity: number; // 30–100
  primarySize: number; // px on the 1920 stage
  secondarySize: number; // px on the 1920 stage
  posX: number; // 0–100 percentage from left
  posY: number; // 0–100 percentage from top
  animSpeed: "fast" | "normal" | "slow";
}

export const DEFAULT_CONTROLS: Controls = {
  accentColor: "#f59e0b",
  bgOpacity: 85,
  primarySize: 46,
  secondarySize: 26,
  posX: 5,
  posY: 82,
  animSpeed: "normal",
};

export const PRIMARY_SIZE_RANGE = { min: 24, max: 96 } as const;
export const SECONDARY_SIZE_RANGE = { min: 14, max: 56 } as const;

export const ACCENT_PRESETS = [
  { label: "Amber", value: "#f59e0b" },
  { label: "Fire", value: "#ffc107" },
  { label: "Blue", value: "#3b82f6" },
  { label: "Emerald", value: "#10b981" },
  { label: "Purple", value: "#8b5cf6" },
  { label: "Rose", value: "#f43f5e" },
  { label: "Cyan", value: "#06b6d4" },
  { label: "White", value: "#ffffff" },
];

// 3x3 position grid presets (percentages)
export const POSITION_PRESETS = [
  { label: "TL", x: 5, y: 8 },
  { label: "TC", x: 50, y: 8 },
  { label: "TR", x: 95, y: 8 },
  { label: "ML", x: 5, y: 45 },
  { label: "MC", x: 50, y: 45 },
  { label: "MR", x: 95, y: 45 },
  { label: "BL", x: 5, y: 82 },
  { label: "BC", x: 50, y: 82 },
  { label: "BR", x: 95, y: 82 },
];

// ─── Helpers ──────────────────────────────────────────────────

export function getAnimDuration(speed: Controls["animSpeed"]) {
  return speed === "fast" ? 150 : speed === "slow" ? 600 : 300;
}

export function hexToRgba(hex: string, alpha: number) {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  if ([r, g, b].some((n) => Number.isNaN(n))) return `rgba(0,0,0,${alpha})`;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// Relative luminance — used to pick black/white text over an accent fill.
export function readableText(hex: string): string {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const r = parseInt(full.slice(0, 2), 16) / 255;
  const g = parseInt(full.slice(2, 4), 16) / 255;
  const b = parseInt(full.slice(4, 6), 16) / 255;
  if ([r, g, b].some((n) => Number.isNaN(n))) return "#000";
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 0.6 ? "#000" : "#fff";
}

export function getPositionStyles(c: Controls) {
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

const EASE = "cubic-bezier(0.16, 1, 0.3, 1)";

function initials(name: string) {
  return name
    .split(" ")
    .filter(Boolean)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

// ─── Template definitions ─────────────────────────────────────

export interface TemplateStyle {
  id: string;
  name: string;
  description: string;
  /** Grouping shown in the gallery. */
  category: "Bars" | "Cards" | "Minimal" | "Broadcast" | "Scripture";
  /** Full-width templates ignore horizontal position (X drives gradient/anchor only). */
  fullWidth?: boolean;
  render: (
    primary: string,
    secondary: string,
    visible: boolean,
    c: Controls,
  ) => React.ReactNode;
}

export const TEMPLATES: TemplateStyle[] = [
  // ── 1. Classic Bar ──
  {
    id: "classic",
    name: "Classic Bar",
    description: "Dark translucent bar with accent border. Clean broadcast standard.",
    category: "Bars",
    render: (primary, secondary, visible, c) => {
      const p = getPositionStyles(c);
      const dur = getAnimDuration(c.animSpeed);
      const slideDir = p.isTop ? "-60px" : "60px";
      return (
        <div
          style={{
            position: "absolute",
            maxWidth: 980,
            left: p.left,
            right: p.right,
            top: p.top,
            transform: `translateX(${p.translateX}) ${visible ? "translateY(0)" : `translateY(${slideDir})`}`,
            opacity: visible ? 1 : 0,
            transition: `all ${dur}ms ${EASE}`,
            textAlign: p.textAlign,
          }}
        >
          <div
            style={{
              backdropFilter: "blur(16px)",
              WebkitBackdropFilter: "blur(16px)",
              borderRadius: 10,
              padding: "28px 48px",
              background: `rgba(0, 0, 0, ${c.bgOpacity / 100})`,
              borderLeft: p.isRight ? "none" : `7px solid ${c.accentColor}`,
              borderRight: p.isRight ? `7px solid ${c.accentColor}` : "none",
            }}
          >
            <p style={{ color: "#fff", fontWeight: 700, lineHeight: 1.15, letterSpacing: "-0.01em", fontSize: c.primarySize }}>
              {primary}
            </p>
            {secondary && (
              <p style={{ color: "rgba(255,255,255,0.65)", fontWeight: 400, marginTop: 6, fontSize: c.secondarySize }}>
                {secondary}
              </p>
            )}
          </div>
        </div>
      );
    },
  },

  // ── 2. Gradient Slab ──
  {
    id: "gradient-slab",
    name: "Gradient Slab",
    description: "Modern gradient from accent to transparent. Bold, contemporary feel.",
    category: "Bars",
    fullWidth: true,
    render: (primary, secondary, visible, c) => {
      const p = getPositionStyles(c);
      const dur = getAnimDuration(c.animSpeed);
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
            transition: `all ${dur + 200}ms ${EASE}`,
          }}
        >
          <div style={{ padding: "34px 96px", background: bg, textAlign: p.textAlign }}>
            <p style={{ color: "#fff", fontWeight: 800, lineHeight: 1.15, letterSpacing: "-0.01em", fontSize: c.primarySize + 4 }}>
              {primary}
            </p>
            {secondary && (
              <p style={{ color: "rgba(255,255,255,0.82)", fontWeight: 500, marginTop: 6, letterSpacing: "0.05em", textTransform: "uppercase", fontSize: c.secondarySize }}>
                {secondary}
              </p>
            )}
          </div>
        </div>
      );
    },
  },

  // ── 3. Glass Panel ──
  {
    id: "glass-panel",
    name: "Glass Panel",
    description: "Frosted glass with a soft accent glow. Premium, modern aesthetic.",
    category: "Cards",
    render: (primary, secondary, visible, c) => {
      const p = getPositionStyles(c);
      const dur = getAnimDuration(c.animSpeed);
      const slideDir = p.isTop ? "-30px" : "30px";
      return (
        <div
          style={{
            position: "absolute",
            maxWidth: 940,
            left: p.left,
            right: p.right,
            top: p.top,
            transform: `translateX(${p.translateX}) ${visible ? "translateY(0) scale(1)" : `translateY(${slideDir}) scale(0.97)`}`,
            opacity: visible ? 1 : 0,
            transition: `all ${dur + 100}ms ${EASE}`,
            textAlign: p.textAlign,
          }}
        >
          <div
            style={{
              borderRadius: 20,
              padding: "30px 48px",
              border: "1px solid rgba(255,255,255,0.12)",
              background: `rgba(15, 15, 15, ${c.bgOpacity / 130})`,
              backdropFilter: "blur(24px) saturate(1.4)",
              WebkitBackdropFilter: "blur(24px) saturate(1.4)",
              boxShadow: `0 0 60px ${hexToRgba(c.accentColor, 0.12)}, inset 0 1px 0 rgba(255,255,255,0.06)`,
            }}
          >
            <p style={{ color: "#fff", fontWeight: 600, lineHeight: 1.15, fontSize: c.primarySize }}>
              {primary}
            </p>
            {secondary && (
              <p style={{ color: "rgba(255,255,255,0.55)", fontWeight: 400, marginTop: 8, fontSize: c.secondarySize }}>
                {secondary}
              </p>
            )}
          </div>
        </div>
      );
    },
  },

  // ── 4. Split Two-Tone ──
  {
    id: "split",
    name: "Split Two-Tone",
    description: "Name in an accent block, title in a dark block. High contrast, unmissable.",
    category: "Bars",
    render: (primary, secondary, visible, c) => {
      const p = getPositionStyles(c);
      const dur = getAnimDuration(c.animSpeed);
      const slideX = p.isRight ? "100px" : "-100px";
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
            transition: `all ${dur}ms ${EASE}`,
            flexDirection: p.isRight ? "row-reverse" : "row",
          }}
        >
          <div style={{ padding: "22px 44px", display: "flex", alignItems: "center", background: c.accentColor }}>
            <p style={{ color: readableText(c.accentColor), fontWeight: 800, lineHeight: 1.15, whiteSpace: "nowrap", fontSize: c.primarySize - 4 }}>
              {primary}
            </p>
          </div>
          {secondary && (
            <div style={{ padding: "22px 44px", display: "flex", alignItems: "center", background: `rgba(0,0,0,${c.bgOpacity / 100})` }}>
              <p style={{ color: "rgba(255,255,255,0.82)", fontWeight: 500, whiteSpace: "nowrap", fontSize: c.secondarySize + 2 }}>
                {secondary}
              </p>
            </div>
          )}
        </div>
      );
    },
  },

  // ── 5. Cinematic Strip ──
  {
    id: "cinematic",
    name: "Cinematic Strip",
    description: "Ultra-wide thin strip, centered text. Elegant film/broadcast look.",
    category: "Broadcast",
    fullWidth: true,
    render: (primary, secondary, visible, c) => {
      const dur = getAnimDuration(c.animSpeed);
      return (
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: `${c.posY}%`,
            opacity: visible ? 1 : 0,
            clipPath: visible ? "inset(0 0 0 0)" : "inset(0 50% 0 50%)",
            transition: `all ${dur + 200}ms ${EASE}`,
          }}
        >
          <div
            style={{
              backdropFilter: "blur(12px)",
              WebkitBackdropFilter: "blur(12px)",
              padding: "28px 0",
              textAlign: "center",
              background: `rgba(0, 0, 0, ${c.bgOpacity / 100})`,
              borderTop: "1px solid rgba(255,255,255,0.06)",
              borderBottom: "1px solid rgba(255,255,255,0.06)",
            }}
          >
            <p style={{ color: "#fff", fontWeight: 300, letterSpacing: "0.18em", textTransform: "uppercase", fontSize: c.primarySize - 6 }}>
              {primary}
              {secondary && (
                <span style={{ margin: "0 28px", fontWeight: 400, color: hexToRgba(c.accentColor, 0.85) }}>|</span>
              )}
              {secondary && (
                <span style={{ color: "rgba(255,255,255,0.5)", letterSpacing: "0.22em", fontWeight: 300, fontSize: c.secondarySize + 2 }}>
                  {secondary}
                </span>
              )}
            </p>
          </div>
        </div>
      );
    },
  },

  // ── 6. Accent Line ──
  {
    id: "accent-line",
    name: "Accent Line",
    description: "Minimal — just text over a thin accent underline. No background fill.",
    category: "Minimal",
    render: (primary, secondary, visible, c) => {
      const p = getPositionStyles(c);
      const dur = getAnimDuration(c.animSpeed);
      const slideDir = p.isTop ? "-40px" : "40px";
      return (
        <div
          style={{
            position: "absolute",
            maxWidth: 860,
            left: p.left,
            right: p.right,
            top: p.top,
            transform: `translateX(${p.translateX}) ${visible ? "translateY(0)" : `translateY(${slideDir})`}`,
            opacity: visible ? 1 : 0,
            transition: `all ${dur}ms ${EASE}`,
            textAlign: p.textAlign,
          }}
        >
          <div style={{ paddingBottom: 18, borderBottom: `3px solid ${c.accentColor}` }}>
            <p style={{ color: "#fff", fontWeight: 600, lineHeight: 1.15, fontSize: c.primarySize, textShadow: "0 2px 16px rgba(0,0,0,0.9)" }}>
              {primary}
            </p>
            {secondary && (
              <p style={{ color: "rgba(255,255,255,0.62)", fontWeight: 400, marginTop: 6, fontSize: c.secondarySize, textShadow: "0 2px 10px rgba(0,0,0,0.8)" }}>
                {secondary}
              </p>
            )}
          </div>
        </div>
      );
    },
  },

  // ── 7. Scripture Card ──
  {
    id: "scripture-card",
    name: "Scripture Card",
    description: "Centered frosted card tuned for Bible verses. Large italic body text.",
    category: "Scripture",
    render: (primary, secondary, visible, c) => {
      const dur = getAnimDuration(c.animSpeed);
      const slideDir = c.posY < 33 ? "-40px" : "40px";
      return (
        <div
          style={{
            position: "absolute",
            width: "82%",
            maxWidth: 1240,
            left: `${c.posX}%`,
            top: `${c.posY}%`,
            transform: visible
              ? "translateX(-50%) translateY(0)"
              : `translateX(-50%) translateY(${slideDir})`,
            opacity: visible ? 1 : 0,
            transition: `all ${dur + 200}ms ${EASE}`,
          }}
        >
          <div
            style={{
              borderRadius: 22,
              padding: "52px 72px",
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
              <p style={{ fontWeight: 600, marginTop: 26, letterSpacing: "0.1em", textTransform: "uppercase", fontSize: c.secondarySize + 2, color: c.accentColor }}>
                {secondary}
              </p>
            )}
          </div>
        </div>
      );
    },
  },

  // ── 8. Corner Badge ──
  {
    id: "corner-badge",
    name: "Corner Badge",
    description: "Compact pill with an initials circle. Great for persistent identifiers.",
    category: "Minimal",
    render: (primary, secondary, visible, c) => {
      const p = getPositionStyles(c);
      const dur = getAnimDuration(c.animSpeed);
      const slideX = p.isRight ? "40px" : "-40px";
      const avatar = Math.round(c.primarySize * 1.4);
      return (
        <div
          style={{
            position: "absolute",
            left: p.left,
            right: p.right,
            top: p.top,
            transform: `translateX(${p.translateX}) ${visible ? "scale(1)" : `translateX(${slideX}) scale(0.9)`}`,
            opacity: visible ? 1 : 0,
            transition: `all ${dur}ms ${EASE}`,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 18,
              borderRadius: 9999,
              padding: "10px 36px 10px 10px",
              background: `rgba(0, 0, 0, ${c.bgOpacity / 100})`,
              flexDirection: p.isRight ? "row-reverse" : "row",
            }}
          >
            <div
              style={{
                width: avatar,
                height: avatar,
                borderRadius: 9999,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: c.accentColor,
                flexShrink: 0,
              }}
            >
              <span style={{ color: readableText(c.accentColor), fontSize: avatar * 0.42, fontWeight: 900 }}>{initials(primary)}</span>
            </div>
            <div style={{ textAlign: p.isRight ? "right" : "left", paddingRight: p.isRight ? 0 : 8 }}>
              <p style={{ color: "#fff", fontWeight: 600, lineHeight: 1.15, fontSize: c.primarySize - 8 }}>
                {primary}
              </p>
              {secondary && (
                <p style={{ color: "rgba(255,255,255,0.5)", fontWeight: 400, fontSize: c.secondarySize - 2 }}>
                  {secondary}
                </p>
              )}
            </div>
          </div>
        </div>
      );
    },
  },

  // ── 9. Boxed Highlight ──
  {
    id: "boxed",
    name: "Boxed Highlight",
    description: "Bold accent header block + dark subtitle. High-energy, conference feel.",
    category: "Cards",
    render: (primary, secondary, visible, c) => {
      const p = getPositionStyles(c);
      const dur = getAnimDuration(c.animSpeed);
      const slideDir = p.isTop ? "-70px" : "70px";
      return (
        <div
          style={{
            position: "absolute",
            maxWidth: 900,
            left: p.left,
            right: p.right,
            top: p.top,
            transform: `translateX(${p.translateX}) ${visible ? "translateY(0)" : `translateY(${slideDir})`}`,
            opacity: visible ? 1 : 0,
            transition: `all ${dur + 100}ms ${EASE}`,
            textAlign: p.textAlign,
          }}
        >
          <div>
            <div style={{ padding: "20px 44px", borderRadius: "12px 12px 0 0", background: c.accentColor }}>
              <p style={{ color: readableText(c.accentColor), fontWeight: 800, lineHeight: 1.15, fontSize: c.primarySize - 2 }}>
                {primary}
              </p>
            </div>
            {secondary && (
              <div style={{ padding: "18px 44px", borderRadius: "0 0 12px 12px", background: `rgba(0,0,0,${c.bgOpacity / 100})` }}>
                <p style={{ color: "rgba(255,255,255,0.78)", fontWeight: 500, fontSize: c.secondarySize }}>
                  {secondary}
                </p>
              </div>
            )}
          </div>
        </div>
      );
    },
  },

  // ── 10. Revealer ──
  {
    id: "revealer",
    name: "Revealer",
    description: "Accent line wipes in from the side, text fades up after. Theatrical entrance.",
    category: "Minimal",
    render: (primary, secondary, visible, c) => {
      const p = getPositionStyles(c);
      const dur = getAnimDuration(c.animSpeed);
      const slideX = p.isRight ? "30px" : "-30px";
      return (
        <div
          style={{
            position: "absolute",
            maxWidth: 900,
            left: p.left,
            right: p.right,
            top: p.top,
            textAlign: p.textAlign,
          }}
        >
          <div
            style={{
              height: 5,
              marginBottom: 18,
              background: c.accentColor,
              transformOrigin: p.isRight ? "right" : "left",
              transform: visible ? "scaleX(1)" : "scaleX(0)",
              transition: `transform ${dur + 200}ms ${EASE}`,
            }}
          />
          <div
            style={{
              transform: visible ? "translateX(0)" : `translateX(${slideX})`,
              opacity: visible ? 1 : 0,
              transition: `all ${dur + 200}ms ${EASE}`,
              transitionDelay: visible ? `${dur * 0.6}ms` : "0ms",
            }}
          >
            <p style={{ color: "#fff", fontWeight: 700, lineHeight: 1.15, fontSize: c.primarySize, textShadow: "0 2px 20px rgba(0,0,0,0.9)" }}>
              {primary}
            </p>
            {secondary && (
              <p style={{ fontWeight: 500, marginTop: 6, letterSpacing: "0.05em", textTransform: "uppercase", fontSize: c.secondarySize, color: hexToRgba(c.accentColor, 0.75), textShadow: "0 2px 10px rgba(0,0,0,0.8)" }}>
                {secondary}
              </p>
            )}
          </div>
        </div>
      );
    },
  },

  // ── 11. Broadcast News (NEW) ──
  {
    id: "broadcast",
    name: "Broadcast News",
    description: "Network-style block: accent tab, name bar, and an uppercase kicker line.",
    category: "Broadcast",
    render: (primary, secondary, visible, c) => {
      const p = getPositionStyles(c);
      const dur = getAnimDuration(c.animSpeed);
      const txt = readableText(c.accentColor);
      return (
        <div
          style={{
            position: "absolute",
            maxWidth: 1000,
            left: p.left,
            right: p.right,
            top: p.top,
            transform: `translateX(${p.translateX})`,
            opacity: visible ? 1 : 0,
            transition: `opacity ${dur}ms ${EASE}`,
            textAlign: "left",
            display: "flex",
            overflow: "hidden",
          }}
        >
          {/* accent tab wipes in */}
          <div
            style={{
              width: 14,
              background: c.accentColor,
              transformOrigin: "bottom",
              transform: visible ? "scaleY(1)" : "scaleY(0)",
              transition: `transform ${dur}ms ${EASE}`,
            }}
          />
          <div style={{ flex: 1, overflow: "hidden" }}>
            <div
              style={{
                background: c.accentColor,
                padding: "8px 28px",
                transform: visible ? "translateX(0)" : "translateX(-100%)",
                transition: `transform ${dur}ms ${EASE}`,
              }}
            >
              <p style={{ color: txt, fontWeight: 800, letterSpacing: "0.16em", textTransform: "uppercase", fontSize: Math.max(14, c.secondarySize - 4) }}>
                {secondary || "Live"}
              </p>
            </div>
            <div
              style={{
                background: `rgba(0,0,0,${c.bgOpacity / 100})`,
                backdropFilter: "blur(14px)",
                WebkitBackdropFilter: "blur(14px)",
                padding: "20px 32px",
                transform: visible ? "translateX(0)" : "translateX(-100%)",
                transition: `transform ${dur}ms ${EASE}`,
                transitionDelay: visible ? `${Math.round(dur * 0.25)}ms` : "0ms",
              }}
            >
              <p style={{ color: "#fff", fontWeight: 700, lineHeight: 1.1, letterSpacing: "-0.01em", fontSize: c.primarySize }}>
                {primary}
              </p>
            </div>
          </div>
        </div>
      );
    },
  },

  // ── 12. Neon Pill (NEW) ──
  {
    id: "neon",
    name: "Neon Pill",
    description: "Rounded glass pill with a glowing accent dot and outer glow. Streamer-modern.",
    category: "Minimal",
    render: (primary, secondary, visible, c) => {
      const p = getPositionStyles(c);
      const dur = getAnimDuration(c.animSpeed);
      const slideDir = p.isTop ? "-24px" : "24px";
      return (
        <div
          style={{
            position: "absolute",
            left: p.left,
            right: p.right,
            top: p.top,
            transform: `translateX(${p.translateX}) ${visible ? "translateY(0) scale(1)" : `translateY(${slideDir}) scale(0.96)`}`,
            opacity: visible ? 1 : 0,
            transition: `all ${dur + 100}ms ${EASE}`,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 20,
              borderRadius: 9999,
              padding: "18px 40px",
              background: "rgba(10,10,12,0.72)",
              border: `1px solid ${hexToRgba(c.accentColor, 0.45)}`,
              backdropFilter: "blur(18px)",
              WebkitBackdropFilter: "blur(18px)",
              boxShadow: `0 0 40px ${hexToRgba(c.accentColor, 0.35)}, inset 0 0 24px ${hexToRgba(c.accentColor, 0.08)}`,
              flexDirection: p.isRight ? "row-reverse" : "row",
            }}
          >
            <div
              style={{
                width: Math.round(c.primarySize * 0.4),
                height: Math.round(c.primarySize * 0.4),
                borderRadius: 9999,
                background: c.accentColor,
                boxShadow: `0 0 16px ${c.accentColor}`,
                flexShrink: 0,
              }}
            />
            <div style={{ textAlign: p.isRight ? "right" : "left" }}>
              <p style={{ color: "#fff", fontWeight: 700, lineHeight: 1.1, fontSize: c.primarySize }}>
                {primary}
              </p>
              {secondary && (
                <p style={{ color: hexToRgba(c.accentColor, 0.9), fontWeight: 500, marginTop: 4, letterSpacing: "0.05em", fontSize: c.secondarySize }}>
                  {secondary}
                </p>
              )}
            </div>
          </div>
        </div>
      );
    },
  },

  // ── 13. Lower Bar (NEW) ──
  {
    id: "lower-bar",
    name: "Lower Bar",
    description: "Full-width footer bar with an accent label chip. Clean newsroom ticker base.",
    category: "Broadcast",
    fullWidth: true,
    render: (primary, secondary, visible, c) => {
      const dur = getAnimDuration(c.animSpeed);
      const txt = readableText(c.accentColor);
      return (
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: `${c.posY}%`,
            transform: visible ? "translateY(0)" : "translateY(100%)",
            opacity: visible ? 1 : 0,
            transition: `all ${dur + 150}ms ${EASE}`,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "stretch",
              background: `rgba(0,0,0,${Math.max(0.6, c.bgOpacity / 100)})`,
              backdropFilter: "blur(14px)",
              WebkitBackdropFilter: "blur(14px)",
              borderTop: `3px solid ${c.accentColor}`,
            }}
          >
            <div style={{ background: c.accentColor, display: "flex", alignItems: "center", padding: "0 40px" }}>
              <span style={{ color: txt, fontWeight: 800, letterSpacing: "0.14em", textTransform: "uppercase", fontSize: Math.max(14, c.secondarySize - 2) }}>
                {secondary || "Now"}
              </span>
            </div>
            <div style={{ display: "flex", alignItems: "center", padding: "22px 44px" }}>
              <p style={{ color: "#fff", fontWeight: 700, lineHeight: 1.1, fontSize: c.primarySize }}>
                {primary}
              </p>
            </div>
          </div>
        </div>
      );
    },
  },

  // ── 14. Stacked Accent (NEW) ──
  {
    id: "stacked",
    name: "Stacked Accent",
    description: "Two offset blocks — name over an inset accent subtitle. Editorial, layered.",
    category: "Cards",
    render: (primary, secondary, visible, c) => {
      const p = getPositionStyles(c);
      const dur = getAnimDuration(c.animSpeed);
      const txt = readableText(c.accentColor);
      const slideX = p.isRight ? "50px" : "-50px";
      return (
        <div
          style={{
            position: "absolute",
            left: p.left,
            right: p.right,
            top: p.top,
            transform: `translateX(${p.translateX})`,
            opacity: visible ? 1 : 0,
            transition: `opacity ${dur}ms ${EASE}`,
            textAlign: "left",
          }}
        >
          <div
            style={{
              display: "inline-block",
              background: `rgba(0,0,0,${c.bgOpacity / 100})`,
              backdropFilter: "blur(16px)",
              WebkitBackdropFilter: "blur(16px)",
              padding: "20px 40px",
              borderRadius: 8,
              transform: visible ? "translateX(0)" : `translateX(${slideX})`,
              transition: `transform ${dur}ms ${EASE}`,
            }}
          >
            <p style={{ color: "#fff", fontWeight: 700, lineHeight: 1.1, fontSize: c.primarySize }}>{primary}</p>
          </div>
          {secondary && (
            <div
              style={{
                display: "inline-block",
                background: c.accentColor,
                padding: "10px 28px",
                borderRadius: 6,
                marginTop: -6,
                marginLeft: p.isRight ? 0 : 32,
                marginRight: p.isRight ? 32 : 0,
                transform: visible ? "translateX(0)" : `translateX(${slideX})`,
                transition: `transform ${dur}ms ${EASE}`,
                transitionDelay: visible ? `${Math.round(dur * 0.3)}ms` : "0ms",
                position: "relative",
              }}
            >
              <p style={{ color: txt, fontWeight: 700, letterSpacing: "0.05em", fontSize: c.secondarySize }}>{secondary}</p>
            </div>
          )}
        </div>
      );
    },
  },

  // ── 15. Spotlight (NEW) ──
  {
    id: "spotlight",
    name: "Spotlight",
    description: "Soft radial glow behind clean text. No hard edges — cinematic and airy.",
    category: "Minimal",
    render: (primary, secondary, visible, c) => {
      const p = getPositionStyles(c);
      const dur = getAnimDuration(c.animSpeed);
      const slideDir = p.isTop ? "-20px" : "20px";
      return (
        <div
          style={{
            position: "absolute",
            maxWidth: 1000,
            left: p.left,
            right: p.right,
            top: p.top,
            transform: `translateX(${p.translateX}) ${visible ? "translateY(0)" : `translateY(${slideDir})`}`,
            opacity: visible ? 1 : 0,
            transition: `all ${dur + 150}ms ${EASE}`,
            textAlign: p.textAlign,
          }}
        >
          <div
            style={{
              padding: "40px 64px",
              background:
                p.textAlign === "center"
                  ? `radial-gradient(ellipse at center, rgba(0,0,0,${c.bgOpacity / 130}) 0%, transparent 72%)`
                  : `radial-gradient(ellipse at ${p.isRight ? "right" : "left"}, rgba(0,0,0,${c.bgOpacity / 130}) 0%, transparent 72%)`,
              margin: "-40px -64px",
            }}
          >
            <p style={{ color: "#fff", fontWeight: 700, lineHeight: 1.12, fontSize: c.primarySize, textShadow: "0 2px 24px rgba(0,0,0,0.95)" }}>
              {primary}
            </p>
            {secondary && (
              <p
                style={{
                  marginTop: 8,
                  fontWeight: 600,
                  letterSpacing: "0.12em",
                  textTransform: "uppercase",
                  fontSize: c.secondarySize,
                  color: c.accentColor,
                  textShadow: "0 2px 14px rgba(0,0,0,0.9)",
                }}
              >
                {secondary}
              </p>
            )}
          </div>
        </div>
      );
    },
  },

  // ── 16. Ribbon (NEW) ──
  {
    id: "ribbon",
    name: "Ribbon",
    description: "Angled accent ribbon with a clean dark caption below. Sporty, dynamic.",
    category: "Bars",
    render: (primary, secondary, visible, c) => {
      const p = getPositionStyles(c);
      const dur = getAnimDuration(c.animSpeed);
      const txt = readableText(c.accentColor);
      const slideX = p.isRight ? "80px" : "-80px";
      return (
        <div
          style={{
            position: "absolute",
            maxWidth: 940,
            left: p.left,
            right: p.right,
            top: p.top,
            transform: `translateX(${p.translateX})`,
            opacity: visible ? 1 : 0,
            transition: `opacity ${dur}ms ${EASE}`,
            textAlign: "left",
          }}
        >
          <div
            style={{
              display: "inline-block",
              background: c.accentColor,
              padding: "16px 40px",
              clipPath: "polygon(0 0, 100% 0, calc(100% - 22px) 100%, 0 100%)",
              transform: visible ? "translateX(0)" : `translateX(${slideX})`,
              transition: `transform ${dur}ms ${EASE}`,
            }}
          >
            <p style={{ color: txt, fontWeight: 800, lineHeight: 1.1, letterSpacing: "-0.01em", fontSize: c.primarySize - 2 }}>
              {primary}
            </p>
          </div>
          {secondary && (
            <div
              style={{
                background: `rgba(0,0,0,${c.bgOpacity / 100})`,
                backdropFilter: "blur(12px)",
                WebkitBackdropFilter: "blur(12px)",
                padding: "12px 40px",
                transform: visible ? "translateX(0)" : `translateX(${slideX})`,
                transition: `transform ${dur}ms ${EASE}`,
                transitionDelay: visible ? `${Math.round(dur * 0.3)}ms` : "0ms",
              }}
            >
              <p style={{ color: "rgba(255,255,255,0.8)", fontWeight: 500, letterSpacing: "0.04em", fontSize: c.secondarySize }}>
                {secondary}
              </p>
            </div>
          )}
        </div>
      );
    },
  },

  // ── 17. Kicker Title (NEW) ──
  {
    id: "kicker",
    name: "Kicker Title",
    description: "Small accent kicker over a big, clean name. No box — pure modern type.",
    category: "Minimal",
    render: (primary, secondary, visible, c) => {
      const p = getPositionStyles(c);
      const dur = getAnimDuration(c.animSpeed);
      const slideDir = p.isTop ? "-30px" : "30px";
      return (
        <div
          style={{
            position: "absolute",
            maxWidth: 1100,
            left: p.left,
            right: p.right,
            top: p.top,
            transform: `translateX(${p.translateX}) ${visible ? "translateY(0)" : `translateY(${slideDir})`}`,
            opacity: visible ? 1 : 0,
            transition: `all ${dur}ms ${EASE}`,
            textAlign: p.textAlign,
          }}
        >
          {secondary && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 14,
                justifyContent: p.isCenter ? "center" : p.isRight ? "flex-end" : "flex-start",
                marginBottom: 12,
              }}
            >
              <span style={{ width: 34, height: 4, background: c.accentColor, borderRadius: 2 }} />
              <span style={{ color: c.accentColor, fontWeight: 700, letterSpacing: "0.2em", textTransform: "uppercase", fontSize: c.secondarySize, textShadow: "0 2px 10px rgba(0,0,0,0.8)" }}>
                {secondary}
              </span>
            </div>
          )}
          <p style={{ color: "#fff", fontWeight: 800, lineHeight: 1.05, letterSpacing: "-0.02em", fontSize: c.primarySize + 8, textShadow: "0 2px 24px rgba(0,0,0,0.92)" }}>
            {primary}
          </p>
        </div>
      );
    },
  },

  // ── 18. Twin Rules (NEW) ──
  {
    id: "double-line",
    name: "Twin Rules",
    description: "Centered text bracketed by accent rules that wipe outward. Elegant, formal.",
    category: "Broadcast",
    render: (primary, secondary, visible, c) => {
      const dur = getAnimDuration(c.animSpeed);
      return (
        <div
          style={{
            position: "absolute",
            left: `${c.posX}%`,
            top: `${c.posY}%`,
            transform: "translate(-50%, -50%)",
            textAlign: "center",
            maxWidth: 1200,
            opacity: visible ? 1 : 0,
            transition: `opacity ${dur}ms ${EASE}`,
          }}
        >
          <div style={{ height: 3, background: c.accentColor, transform: visible ? "scaleX(1)" : "scaleX(0)", transition: `transform ${dur + 150}ms ${EASE}`, marginBottom: 18 }} />
          <p style={{ color: "#fff", fontWeight: 600, lineHeight: 1.15, letterSpacing: "0.02em", fontSize: c.primarySize, textShadow: "0 2px 18px rgba(0,0,0,0.9)" }}>
            {primary}
          </p>
          {secondary && (
            <p style={{ color: "rgba(255,255,255,0.6)", fontWeight: 400, marginTop: 8, letterSpacing: "0.12em", textTransform: "uppercase", fontSize: c.secondarySize, textShadow: "0 2px 10px rgba(0,0,0,0.8)" }}>
              {secondary}
            </p>
          )}
          <div style={{ height: 3, background: c.accentColor, transform: visible ? "scaleX(1)" : "scaleX(0)", transition: `transform ${dur + 150}ms ${EASE}`, marginTop: 18 }} />
        </div>
      );
    },
  },

  // ── 19. Name & Role Chips (NEW) ──
  {
    id: "chip",
    name: "Name & Role Chips",
    description: "Name on a dark pill beside a separate accent role chip. Crisp and modern.",
    category: "Minimal",
    render: (primary, secondary, visible, c) => {
      const p = getPositionStyles(c);
      const dur = getAnimDuration(c.animSpeed);
      const slideDir = p.isTop ? "-24px" : "24px";
      return (
        <div
          style={{
            position: "absolute",
            left: p.left,
            right: p.right,
            top: p.top,
            transform: `translateX(${p.translateX}) ${visible ? "translateY(0)" : `translateY(${slideDir})`}`,
            opacity: visible ? 1 : 0,
            transition: `all ${dur}ms ${EASE}`,
            display: "flex",
            alignItems: "center",
            gap: 14,
            flexDirection: p.isRight ? "row-reverse" : "row",
          }}
        >
          <div
            style={{
              background: `rgba(0,0,0,${c.bgOpacity / 100})`,
              backdropFilter: "blur(14px)",
              WebkitBackdropFilter: "blur(14px)",
              borderRadius: 9999,
              padding: "14px 32px",
            }}
          >
            <p style={{ color: "#fff", fontWeight: 700, lineHeight: 1.1, whiteSpace: "nowrap", fontSize: c.primarySize }}>
              {primary}
            </p>
          </div>
          {secondary && (
            <div style={{ background: c.accentColor, borderRadius: 9999, padding: "10px 24px" }}>
              <p style={{ color: readableText(c.accentColor), fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", whiteSpace: "nowrap", fontSize: c.secondarySize }}>
                {secondary}
              </p>
            </div>
          )}
        </div>
      );
    },
  },

  // ── 20. Thin Frame (NEW) ──
  {
    id: "framed",
    name: "Thin Frame",
    description: "Text inside a thin accent-outlined panel with a faint fill. Refined, boutique.",
    category: "Cards",
    render: (primary, secondary, visible, c) => {
      const p = getPositionStyles(c);
      const dur = getAnimDuration(c.animSpeed);
      const slideDir = p.isTop ? "-24px" : "24px";
      return (
        <div
          style={{
            position: "absolute",
            maxWidth: 920,
            left: p.left,
            right: p.right,
            top: p.top,
            transform: `translateX(${p.translateX}) ${visible ? "translateY(0) scale(1)" : `translateY(${slideDir}) scale(0.98)`}`,
            opacity: visible ? 1 : 0,
            transition: `all ${dur + 100}ms ${EASE}`,
            textAlign: p.textAlign,
          }}
        >
          <div
            style={{
              padding: "26px 44px",
              borderRadius: 6,
              border: `2px solid ${hexToRgba(c.accentColor, 0.85)}`,
              background: `rgba(0,0,0,${(c.bgOpacity / 100) * 0.55})`,
              backdropFilter: "blur(10px)",
              WebkitBackdropFilter: "blur(10px)",
              boxShadow: `0 0 30px ${hexToRgba(c.accentColor, 0.12)}`,
            }}
          >
            <p style={{ color: "#fff", fontWeight: 700, lineHeight: 1.15, fontSize: c.primarySize }}>{primary}</p>
            {secondary && (
              <p style={{ color: hexToRgba(c.accentColor, 0.95), fontWeight: 500, marginTop: 6, letterSpacing: "0.08em", textTransform: "uppercase", fontSize: c.secondarySize }}>
                {secondary}
              </p>
            )}
          </div>
        </div>
      );
    },
  },

  // ── 21. Gradient Headline (NEW) ──
  {
    id: "gradient-text",
    name: "Gradient Headline",
    description: "Big name with an accent-to-white gradient text fill. Bold, no background.",
    category: "Minimal",
    render: (primary, secondary, visible, c) => {
      const p = getPositionStyles(c);
      const dur = getAnimDuration(c.animSpeed);
      const slideDir = p.isTop ? "-30px" : "30px";
      return (
        <div
          style={{
            position: "absolute",
            maxWidth: 1100,
            left: p.left,
            right: p.right,
            top: p.top,
            transform: `translateX(${p.translateX}) ${visible ? "translateY(0)" : `translateY(${slideDir})`}`,
            opacity: visible ? 1 : 0,
            transition: `all ${dur}ms ${EASE}`,
            textAlign: p.textAlign,
          }}
        >
          <p
            style={{
              fontWeight: 900,
              lineHeight: 1.05,
              letterSpacing: "-0.02em",
              fontSize: c.primarySize + 10,
              backgroundImage: `linear-gradient(135deg, ${c.accentColor} 0%, #ffffff 70%)`,
              WebkitBackgroundClip: "text",
              backgroundClip: "text",
              color: "transparent",
              WebkitTextFillColor: "transparent",
              filter: "drop-shadow(0 3px 18px rgba(0,0,0,0.85))",
            }}
          >
            {primary}
          </p>
          {secondary && (
            <p style={{ color: "rgba(255,255,255,0.75)", fontWeight: 600, marginTop: 8, letterSpacing: "0.1em", textTransform: "uppercase", fontSize: c.secondarySize, textShadow: "0 2px 12px rgba(0,0,0,0.85)" }}>
              {secondary}
            </p>
          )}
        </div>
      );
    },
  },

  // ── 22. Portrait Card (NEW) ──
  {
    id: "side-card",
    name: "Portrait Card",
    description: "Compact stacked card with an accent top bar. Ideal tucked in a corner for panelists.",
    category: "Cards",
    render: (primary, secondary, visible, c) => {
      const p = getPositionStyles(c);
      const dur = getAnimDuration(c.animSpeed);
      const slideDir = p.isTop ? "-24px" : "24px";
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
            transition: `all ${dur + 100}ms ${EASE}`,
            textAlign: p.textAlign,
          }}
        >
          <div style={{ borderRadius: "12px 12px 12px 12px", overflow: "hidden" }}>
            <div style={{ height: 8, background: c.accentColor }} />
            <div
              style={{
                padding: "22px 32px",
                background: `rgba(12,12,14,${Math.max(0.72, c.bgOpacity / 100)})`,
                backdropFilter: "blur(18px)",
                WebkitBackdropFilter: "blur(18px)",
                borderRadius: "0 0 12px 12px",
                border: "1px solid rgba(255,255,255,0.08)",
                borderTop: "none",
              }}
            >
              <p style={{ color: "#fff", fontWeight: 700, lineHeight: 1.12, fontSize: c.primarySize }}>{primary}</p>
              {secondary && (
                <p style={{ color: "rgba(255,255,255,0.55)", fontWeight: 500, marginTop: 6, fontSize: c.secondarySize }}>
                  {secondary}
                </p>
              )}
            </div>
          </div>
        </div>
      );
    },
  },
];

export function getTemplate(id: string | undefined): TemplateStyle {
  return TEMPLATES.find((t) => t.id === id) ?? TEMPLATES[0];
}

// ─── LtStage — scales the 1920×1080 design space to its container ──
//
// Place inside a positioned parent. The parent defines the visible
// frame (a 16:9 box in the preview, the full browser source in OBS).
// Children are authored at 1920×1080 and scaled uniformly to fit width.

export function LtStage({
  children,
  background = "transparent",
}: {
  children: React.ReactNode;
  background?: string;
}) {
  // 0 = not yet measured; content stays hidden until we know the scale so
  // the 1920-wide stage never flashes at full size before snapping down.
  const [scale, setScale] = useState(0);
  const roRef = useRef<ResizeObserver | null>(null);

  // Callback ref: runs at commit (before paint), so the first measured frame
  // is already correctly scaled — no flash, no SSR useLayoutEffect warning.
  const setRef = useCallback((node: HTMLDivElement | null) => {
    roRef.current?.disconnect();
    if (!node) return;
    const measure = () => setScale(node.clientWidth / STAGE_W);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(node);
    roRef.current = ro;
  }, []);

  return (
    <div ref={setRef} style={{ position: "absolute", inset: 0, overflow: "hidden", background }}>
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: STAGE_W,
          height: STAGE_H,
          transform: `scale(${scale})`,
          transformOrigin: "top left",
          visibility: scale ? "visible" : "hidden",
        }}
      >
        {children}
      </div>
    </div>
  );
}
