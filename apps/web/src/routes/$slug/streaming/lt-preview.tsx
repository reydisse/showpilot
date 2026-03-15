import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState, useRef } from "react";
import {
  ChevronLeft,
  ChevronRight,
  RotateCcw,
  Sliders,
  Play,
  Square,
  Save,
} from "lucide-react";
import {
  addGraphicTemplate,
  setActiveGraphic,
  getActiveGraphic,
} from "@/lib/graphics";

export const Route = createFileRoute("/$slug/streaming/lt-preview")({
  loader: async ({ context }) => {
    const active = await getActiveGraphic({ data: { orgId: context.orgId } });
    return { orgId: context.orgId, activeId: active?.id ?? null };
  },
  component: TemplatePreviewPage,
});

// ─── Sample Data ─────────────────────────────────────────────

const SAMPLES = {
  person: { primary: "Pastor James Mensah", secondary: "Lead Pastor" },
  person2: { primary: "Akua Boateng", secondary: "Worship Leader" },
  scripture: {
    primary:
      "For I know the plans I have for you, declares the Lord, plans to prosper you and not to harm you, plans to give you hope and a future.",
    secondary: "Jeremiah 29:11 — NIV",
  },
  announcement: {
    primary: "Youth Conference 2026",
    secondary: "Register at the Welcome Desk",
  },
  song: { primary: "Way Maker", secondary: "Sinach" },
};

// ─── Controls ────────────────────────────────────────────────

interface Controls {
  accentColor: string;
  bgOpacity: number;
  primarySize: number;
  secondarySize: number;
  posX: number; // 0–100 percentage from left
  posY: number; // 0–100 percentage from top
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

const ACCENT_PRESETS = [
  { label: "Amber", value: "#f59e0b" },
  { label: "Fire", value: "#ffc107" },
  { label: "Blue", value: "#3b82f6" },
  { label: "Emerald", value: "#10b981" },
  { label: "Purple", value: "#8b5cf6" },
  { label: "Rose", value: "#f43f5e" },
  { label: "Cyan", value: "#06b6d4" },
  { label: "White", value: "#ffffff" },
];

// 3x3 position grid presets
const POSITION_PRESETS = [
  { label: "TL", x: 5, y: 5 },
  { label: "TC", x: 50, y: 5 },
  { label: "TR", x: 95, y: 5 },
  { label: "ML", x: 5, y: 45 },
  { label: "MC", x: 50, y: 45 },
  { label: "MR", x: 95, y: 45 },
  { label: "BL", x: 5, y: 82 },
  { label: "BC", x: 50, y: 82 },
  { label: "BR", x: 95, y: 82 },
];

function getAnimDuration(speed: Controls["animSpeed"]) {
  return speed === "fast" ? 150 : speed === "slow" ? 600 : 300;
}

function hexToRgba(hex: string, alpha: number) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// Compute CSS position + alignment from X/Y percentages
function getPositionStyles(c: Controls) {
  const isLeft = c.posX < 33;
  const isCenter = c.posX >= 33 && c.posX <= 67;
  const isRight = c.posX > 67;
  const isTop = c.posY < 33;

  let left: string | number = `${c.posX}%`;
  let right: string | number = "auto";
  let top: string | number = `${c.posY}%`;
  let bottom: string | number = "auto";
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

  return { left, right, top, bottom, translateX, textAlign, isLeft, isCenter, isRight, isTop };
}

// ─── Template Definitions ────────────────────────────────────

interface TemplateStyle {
  id: string;
  name: string;
  description: string;
  fullWidth?: boolean; // full-width templates ignore horizontal position
  render: (
    primary: string,
    secondary: string,
    visible: boolean,
    c: Controls
  ) => React.ReactNode;
}

const TEMPLATES: TemplateStyle[] = [
  // ── 1. Classic Bar ──
  {
    id: "classic",
    name: "Classic Bar",
    description: "Dark translucent bar with accent border. Clean broadcast standard.",
    render: (primary, secondary, visible, c) => {
      const p = getPositionStyles(c);
      const dur = getAnimDuration(c.animSpeed);
      const slideDir = p.isTop ? "-40px" : "40px";
      return (
        <div
          className="absolute max-w-[560px]"
          style={{
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
            className="backdrop-blur-xl rounded-md px-8 py-5"
            style={{
              background: `rgba(0, 0, 0, ${c.bgOpacity / 100})`,
              borderLeft: p.isRight ? "none" : `4px solid ${c.accentColor}`,
              borderRight: p.isRight ? `4px solid ${c.accentColor}` : "none",
            }}
          >
            <p className="text-white font-bold leading-tight tracking-tight" style={{ fontSize: c.primarySize }}>
              {primary}
            </p>
            {secondary && (
              <p className="text-white/65 font-normal mt-1" style={{ fontSize: c.secondarySize }}>
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
    fullWidth: true,
    render: (primary, secondary, visible, c) => {
      const p = getPositionStyles(c);
      const dur = getAnimDuration(c.animSpeed);
      const slideDir = p.isTop ? "-100%" : "100%";
      return (
        <div
          className="absolute left-0 right-0"
          style={{
            top: p.top,
            transform: visible ? "translateY(0)" : `translateY(${slideDir})`,
            opacity: visible ? 1 : 0,
            transition: `all ${dur + 200}ms cubic-bezier(0.16, 1, 0.3, 1)`,
          }}
        >
          <div
            className="px-12 py-5"
            style={{
              background: p.isRight
                ? `linear-gradient(to left, ${hexToRgba(c.accentColor, 0.92)}, ${hexToRgba(c.accentColor, 0.5)} 50%, transparent)`
                : p.isCenter
                  ? `linear-gradient(to right, transparent, ${hexToRgba(c.accentColor, 0.85)} 25%, ${hexToRgba(c.accentColor, 0.85)} 75%, transparent)`
                  : `linear-gradient(to right, ${hexToRgba(c.accentColor, 0.92)}, ${hexToRgba(c.accentColor, 0.5)} 50%, transparent)`,
              textAlign: p.textAlign,
            }}
          >
            <p className="text-white font-extrabold leading-tight tracking-tight" style={{ fontSize: c.primarySize + 2 }}>
              {primary}
            </p>
            {secondary && (
              <p className="text-white/80 font-medium mt-1 tracking-wide uppercase" style={{ fontSize: c.secondarySize }}>
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
    description: "Frosted glass with subtle glow. Premium, modern aesthetic.",
    render: (primary, secondary, visible, c) => {
      const p = getPositionStyles(c);
      const dur = getAnimDuration(c.animSpeed);
      const slideDir = p.isTop ? "-20px" : "20px";
      return (
        <div
          className="absolute max-w-[540px]"
          style={{
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
            className="rounded-xl px-8 py-5 border border-white/10"
            style={{
              background: `rgba(15, 15, 15, ${c.bgOpacity / 130})`,
              backdropFilter: "blur(24px) saturate(1.4)",
              boxShadow: `0 0 40px ${hexToRgba(c.accentColor, 0.1)}, inset 0 1px 0 rgba(255,255,255,0.05)`,
            }}
          >
            <p className="text-white font-semibold leading-tight" style={{ fontSize: c.primarySize }}>
              {primary}
            </p>
            {secondary && (
              <p className="text-white/50 font-normal mt-1.5" style={{ fontSize: c.secondarySize }}>
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
    description: "Name in accent block, title in dark block. High contrast, unmissable.",
    render: (primary, secondary, visible, c) => {
      const p = getPositionStyles(c);
      const dur = getAnimDuration(c.animSpeed);
      const slideX = p.isRight ? "60px" : "-60px";
      return (
        <div
          className="absolute flex"
          style={{
            left: p.left,
            right: p.right,
            top: p.top,
            transform: `translateX(${p.translateX}) ${visible ? "" : `translateX(${slideX})`}`,
            opacity: visible ? 1 : 0,
            transition: `all ${dur}ms cubic-bezier(0.16, 1, 0.3, 1)`,
            flexDirection: p.isRight ? "row-reverse" : "row",
          }}
        >
          <div className="px-7 py-4 flex items-center" style={{ background: c.accentColor }}>
            <p className="text-black font-extrabold leading-tight whitespace-nowrap" style={{ fontSize: c.primarySize - 2 }}>
              {primary}
            </p>
          </div>
          {secondary && (
            <div className="px-7 py-4 flex items-center" style={{ background: `rgba(0,0,0,${c.bgOpacity / 100})` }}>
              <p className="text-white/80 font-medium whitespace-nowrap" style={{ fontSize: c.secondarySize + 1 }}>
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
    fullWidth: true,
    render: (primary, secondary, visible, c) => {
      const dur = getAnimDuration(c.animSpeed);
      return (
        <div
          className="absolute left-0 right-0"
          style={{
            top: `${c.posY}%`,
            opacity: visible ? 1 : 0,
            clipPath: visible ? "inset(0 0 0 0)" : "inset(0 50% 0 50%)",
            transition: `all ${dur + 200}ms cubic-bezier(0.16, 1, 0.3, 1)`,
          }}
        >
          <div
            className="backdrop-blur-lg px-0 py-4 text-center"
            style={{
              background: `rgba(0, 0, 0, ${c.bgOpacity / 100})`,
              borderTop: "1px solid rgba(255,255,255,0.05)",
              borderBottom: "1px solid rgba(255,255,255,0.05)",
            }}
          >
            <p className="text-white font-light tracking-[0.15em] uppercase" style={{ fontSize: c.primarySize - 4 }}>
              {primary}
              {secondary && (
                <span className="mx-4 font-normal" style={{ color: hexToRgba(c.accentColor, 0.8) }}>|</span>
              )}
              {secondary && (
                <span className="text-white/50 tracking-widest font-light" style={{ fontSize: c.secondarySize + 1 }}>
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
    description: "Minimal — just text with a thin accent underline. No background.",
    render: (primary, secondary, visible, c) => {
      const p = getPositionStyles(c);
      const dur = getAnimDuration(c.animSpeed);
      const slideDir = p.isTop ? "-30px" : "30px";
      return (
        <div
          className="absolute max-w-[480px]"
          style={{
            left: p.left,
            right: p.right,
            top: p.top,
            transform: `translateX(${p.translateX}) ${visible ? "translateY(0)" : `translateY(${slideDir})`}`,
            opacity: visible ? 1 : 0,
            transition: `all ${dur}ms cubic-bezier(0.16, 1, 0.3, 1)`,
            textAlign: p.textAlign,
          }}
        >
          <div className="pb-3" style={{ borderBottom: `2px solid ${c.accentColor}` }}>
            <p
              className="text-white font-semibold leading-tight"
              style={{ fontSize: c.primarySize, textShadow: "0 2px 12px rgba(0,0,0,0.9)" }}
            >
              {primary}
            </p>
            {secondary && (
              <p
                className="text-white/60 font-normal mt-1"
                style={{ fontSize: c.secondarySize, textShadow: "0 2px 8px rgba(0,0,0,0.8)" }}
              >
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
    description: "Centered frosted card optimized for Bible verses. Large italic text.",
    render: (primary, secondary, visible, c) => {
      const dur = getAnimDuration(c.animSpeed);
      const slideDir = c.posY < 33 ? "-30px" : "30px";
      return (
        <div
          className="absolute w-[85%] max-w-[780px]"
          style={{
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
            className="rounded-xl px-10 py-8 text-center border border-white/8"
            style={{
              background: `rgba(0, 0, 0, ${c.bgOpacity / 120})`,
              backdropFilter: "blur(20px)",
            }}
          >
            <p className="text-white font-light italic leading-relaxed" style={{ fontSize: c.primarySize + 2 }}>
              &ldquo;{primary}&rdquo;
            </p>
            {secondary && (
              <p
                className="font-semibold mt-4 tracking-[0.08em] uppercase"
                style={{ fontSize: c.secondarySize + 1, color: c.accentColor }}
              >
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
    description: "Compact badge with initials circle. Great for persistent identifiers.",
    render: (primary, secondary, visible, c) => {
      const p = getPositionStyles(c);
      const dur = getAnimDuration(c.animSpeed);
      const slideX = p.isRight ? "20px" : "-20px";
      return (
        <div
          className="absolute"
          style={{
            left: p.left,
            right: p.right,
            top: p.top,
            transform: `translateX(${p.translateX}) ${visible ? "scale(1)" : `translateX(${slideX}) scale(0.9)`}`,
            opacity: visible ? 1 : 0,
            transition: `all ${dur}ms cubic-bezier(0.16, 1, 0.3, 1)`,
          }}
        >
          <div
            className="flex items-center gap-3 rounded-full pl-1.5 pr-6 py-1.5"
            style={{
              background: `rgba(0, 0, 0, ${c.bgOpacity / 100})`,
              flexDirection: p.isRight ? "row-reverse" : "row",
            }}
          >
            <div
              className="w-10 h-10 rounded-full flex items-center justify-center"
              style={{ background: c.accentColor }}
            >
              <span className="text-black text-[14px] font-black">
                {primary.split(" ").map((w) => w[0]).join("").slice(0, 2)}
              </span>
            </div>
            <div style={{ textAlign: p.isRight ? "right" : "left" }}>
              <p className="text-white font-semibold leading-tight" style={{ fontSize: c.primarySize - 10 }}>
                {primary}
              </p>
              {secondary && (
                <p className="text-white/50 font-normal" style={{ fontSize: c.secondarySize - 3 }}>
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
    render: (primary, secondary, visible, c) => {
      const p = getPositionStyles(c);
      const dur = getAnimDuration(c.animSpeed);
      const slideDir = p.isTop ? "-50px" : "50px";
      return (
        <div
          className="absolute max-w-[520px]"
          style={{
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
            <div className="px-7 py-3.5 rounded-t-lg" style={{ background: c.accentColor }}>
              <p className="text-black font-extrabold leading-tight" style={{ fontSize: c.primarySize - 2 }}>
                {primary}
              </p>
            </div>
            {secondary && (
              <div className="px-7 py-3 rounded-b-lg" style={{ background: `rgba(0,0,0,${c.bgOpacity / 100})` }}>
                <p className="text-white/75 font-medium" style={{ fontSize: c.secondarySize }}>
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
    description: "Accent line reveals from left, text fades in after. Theatrical entrance.",
    render: (primary, secondary, visible, c) => {
      const p = getPositionStyles(c);
      const dur = getAnimDuration(c.animSpeed);
      const slideX = p.isRight ? "20px" : "-20px";
      return (
        <div
          className="absolute max-w-[520px]"
          style={{ left: p.left, right: p.right, top: p.top, textAlign: p.textAlign }}
        >
          <div
            className="h-0.75 mb-3"
            style={{
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
            <p
              className="text-white font-bold leading-tight"
              style={{ fontSize: c.primarySize, textShadow: "0 2px 16px rgba(0,0,0,0.9)" }}
            >
              {primary}
            </p>
            {secondary && (
              <p
                className="font-medium mt-1 tracking-wide uppercase"
                style={{
                  fontSize: c.secondarySize,
                  color: hexToRgba(c.accentColor, 0.7),
                  textShadow: "0 2px 8px rgba(0,0,0,0.8)",
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
];

// ─── Control Panel Component ─────────────────────────────────

function ControlPanel({
  controls,
  onChange,
  onReset,
}: {
  controls: Controls;
  onChange: (c: Controls) => void;
  onReset: () => void;
}) {
  const update = (patch: Partial<Controls>) => onChange({ ...controls, ...patch });

  return (
    <div className="space-y-5">
      {/* Accent Color */}
      <div>
        <label className="block text-[10px] font-semibold uppercase tracking-widest text-board-muted mb-2">
          Accent Color
        </label>
        <div className="flex flex-wrap gap-2">
          {ACCENT_PRESETS.map((p) => (
            <button
              key={p.value}
              onClick={() => update({ accentColor: p.value })}
              className="group relative"
              title={p.label}
            >
              <div
                className="w-7 h-7 rounded-full border-2 transition-all"
                style={{
                  background: p.value,
                  borderColor: controls.accentColor === p.value ? "white" : "transparent",
                  boxShadow: controls.accentColor === p.value ? `0 0 12px ${p.value}60` : "none",
                }}
              />
            </button>
          ))}
          <label className="relative w-7 h-7 rounded-full border-2 border-dashed border-board-muted/30 cursor-pointer overflow-hidden hover:border-board-muted/60 transition-colors">
            <input
              type="color"
              value={controls.accentColor}
              onChange={(e) => update({ accentColor: e.target.value })}
              className="absolute inset-0 opacity-0 cursor-pointer"
            />
            <span className="absolute inset-0 flex items-center justify-center text-board-muted text-[10px]">+</span>
          </label>
        </div>
      </div>

      {/* Background Opacity */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-[10px] font-semibold uppercase tracking-widest text-board-muted">
            Background Opacity
          </label>
          <span className="text-[10px] text-board-muted font-mono">{controls.bgOpacity}%</span>
        </div>
        <input
          type="range" min={30} max={100} value={controls.bgOpacity}
          onChange={(e) => update({ bgOpacity: Number(e.target.value) })}
          className="w-full h-1.5 rounded-full appearance-none bg-board-border [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:cursor-pointer"
        />
      </div>

      {/* Primary Text Size */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-[10px] font-semibold uppercase tracking-widest text-board-muted">
            Primary Text
          </label>
          <span className="text-[10px] text-board-muted font-mono">{controls.primarySize}px</span>
        </div>
        <input
          type="range" min={16} max={42} value={controls.primarySize}
          onChange={(e) => update({ primarySize: Number(e.target.value) })}
          className="w-full h-1.5 rounded-full appearance-none bg-board-border [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:cursor-pointer"
        />
      </div>

      {/* Secondary Text Size */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-[10px] font-semibold uppercase tracking-widest text-board-muted">
            Secondary Text
          </label>
          <span className="text-[10px] text-board-muted font-mono">{controls.secondarySize}px</span>
        </div>
        <input
          type="range" min={10} max={28} value={controls.secondarySize}
          onChange={(e) => update({ secondarySize: Number(e.target.value) })}
          className="w-full h-1.5 rounded-full appearance-none bg-board-border [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:cursor-pointer"
        />
      </div>

      {/* Position — 3x3 Grid + Coordinates */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-[10px] font-semibold uppercase tracking-widest text-board-muted">
            Position
          </label>
          <span className="text-[10px] text-board-muted font-mono">
            {Math.round(controls.posX)},{Math.round(controls.posY)}
          </span>
        </div>

        {/* 3x3 visual grid */}
        <div className="grid grid-cols-3 gap-1 p-2 rounded-lg bg-board-bg border border-board-border mb-2.5">
          {POSITION_PRESETS.map((preset) => {
            const isActive = Math.abs(controls.posX - preset.x) < 5 && Math.abs(controls.posY - preset.y) < 5;
            return (
              <button
                key={preset.label}
                onClick={() => update({ posX: preset.x, posY: preset.y })}
                className={`aspect-video rounded transition-all flex items-center justify-center ${
                  isActive
                    ? "bg-fire-500/25 border border-fire-500/40"
                    : "bg-board-border/30 border border-transparent hover:bg-board-border/60"
                }`}
              >
                <div className={`w-1.5 h-1.5 rounded-full ${isActive ? "bg-fire-500" : "bg-board-muted/40"}`} />
              </button>
            );
          })}
        </div>

        {/* Fine-tune sliders */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-[9px] text-board-muted w-4 shrink-0">X</span>
            <input
              type="range" min={0} max={100} value={controls.posX}
              onChange={(e) => update({ posX: Number(e.target.value) })}
              className="flex-1 h-1 rounded-full appearance-none bg-board-border [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:cursor-pointer"
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[9px] text-board-muted w-4 shrink-0">Y</span>
            <input
              type="range" min={0} max={100} value={controls.posY}
              onChange={(e) => update({ posY: Number(e.target.value) })}
              className="flex-1 h-1 rounded-full appearance-none bg-board-border [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:cursor-pointer"
            />
          </div>
        </div>

        <p className="text-[9px] text-board-muted/50 mt-1.5">
          Use the grid or coordinate fields to set position.
        </p>
      </div>

      {/* Animation Speed */}
      <div>
        <label className="block text-[10px] font-semibold uppercase tracking-widest text-board-muted mb-2">
          Animation Speed
        </label>
        <div className="grid grid-cols-3 gap-1.5">
          {(["fast", "normal", "slow"] as const).map((s) => (
            <button
              key={s}
              onClick={() => update({ animSpeed: s })}
              className={`px-2 py-1.5 rounded-lg text-[10px] font-medium capitalize transition-colors ${
                controls.animSpeed === s
                  ? "bg-fire-500/15 text-fire-500 border border-fire-500/25"
                  : "text-board-muted border border-board-border hover:border-board-muted/50"
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {/* Reset */}
      <button
        onClick={onReset}
        className="flex items-center gap-1.5 text-[10px] font-medium text-board-muted hover:text-board-text transition-colors"
      >
        <RotateCcw className="w-3 h-3" />
        Reset to defaults
      </button>
    </div>
  );
}

// ─── Preview Page ────────────────────────────────────────────

function TemplatePreviewPage() {
  const { orgId, activeId: initialActiveId } = Route.useLoaderData();
  const router = useRouter();
  const [currentIndex, setCurrentIndex] = useState(0);
  const [visible, setVisible] = useState(true);
  const [sampleKey, setSampleKey] = useState<keyof typeof SAMPLES | "custom">("person");
  const [controls, setControls] = useState<Controls>(DEFAULT_CONTROLS);
  const [showControls, setShowControls] = useState(true);
  const [customPrimary, setCustomPrimary] = useState("");
  const [customSecondary, setCustomSecondary] = useState("");
  const [activeId, setActiveId] = useState<string | null>(initialActiveId);
  const [saving, setSaving] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [savedMsg, setSavedMsg] = useState("");
  const viewportRef = useRef<HTMLDivElement>(null);

  const template = TEMPLATES[currentIndex];
  const sampleKeys = Object.keys(SAMPLES) as (keyof typeof SAMPLES)[];

  const next = () => {
    setVisible(false);
    setTimeout(() => {
      setCurrentIndex((i) => (i + 1) % TEMPLATES.length);
      setVisible(true);
    }, 400);
  };

  const prev = () => {
    setVisible(false);
    setTimeout(() => {
      setCurrentIndex((i) => (i - 1 + TEMPLATES.length) % TEMPLATES.length);
      setVisible(true);
    }, 400);
  };

  const toggle = () => {
    setVisible((v) => !v);
  };

  const getCurrentText = () => {
    if (sampleKey === "custom") {
      return { primary: customPrimary || "Preview Text", secondary: customSecondary };
    }
    return SAMPLES[sampleKey];
  };

  const handleSave = async () => {
    const text = getCurrentText();
    if (!text.primary.trim()) return;
    setSaving(true);
    await addGraphicTemplate({
      data: {
        orgId,
        name: text.primary.trim(),
        title: text.primary.trim(),
        subtitle: text.secondary?.trim() ?? "",
        style: JSON.stringify({ type: "lower-third", styleName: "default", templateId: template.id }),
      },
    });
    setSaving(false);
    setSavedMsg("Saved to library");
    setTimeout(() => setSavedMsg(""), 2000);
    router.invalidate();
  };

  const handlePushLive = async () => {
    const text = getCurrentText();
    if (!text.primary.trim()) return;
    setPushing(true);
    // Clear first so the overlay detects a change even if same text
    if (activeId) {
      await setActiveGraphic({ data: { orgId, graphicId: null } });
    }
    // Save with full controls so the overlay can render exactly what's previewed
    const created = await addGraphicTemplate({
      data: {
        orgId,
        name: text.primary.trim(),
        title: text.primary.trim(),
        subtitle: text.secondary?.trim() ?? "",
        style: JSON.stringify({
          type: "lower-third",
          templateId: template.id,
          controls,
        }),
      },
    });
    await setActiveGraphic({ data: { orgId, graphicId: created.id } });
    setActiveId(created.id);
    setPushing(false);
    router.invalidate();
  };

  const handleClearLive = async () => {
    await setActiveGraphic({ data: { orgId, graphicId: null } });
    setActiveId(null);
  };

  const sample = getCurrentText();

  return (
    <div className="h-full overflow-auto bg-board-bg">
      {/* Header */}
      <div className="sticky top-0 z-20 bg-board-bg/90 backdrop-blur-xl border-b border-board-border px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-board-text font-display">
              Lower Third Templates
            </h1>
            <p className="text-xs text-board-muted mt-0.5">
              Drag to position. Click to show/hide. Customize with controls.
            </p>
          </div>
          <button
            onClick={() => setShowControls((v) => !v)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              showControls
                ? "bg-fire-500/15 text-fire-500 border border-fire-500/25"
                : "text-board-muted hover:text-board-text border border-board-border"
            }`}
          >
            <Sliders className="w-3.5 h-3.5" />
            Controls
          </button>
        </div>
      </div>

      <div className="p-6 max-w-6xl mx-auto">
        <div className="flex gap-6">
          {/* Main content */}
          <div className="flex-1 min-w-0 space-y-5">
            {/* Top controls */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 overflow-x-auto">
                <button
                  onClick={() => setSampleKey("custom")}
                  className={`px-2.5 py-1 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
                    sampleKey === "custom"
                      ? "bg-fire-500/15 text-fire-500 border border-fire-500/25"
                      : "text-board-muted hover:text-board-text border border-transparent"
                  }`}
                >
                  Custom
                </button>
                {sampleKeys.map((key) => (
                  <button
                    key={key}
                    onClick={() => setSampleKey(key)}
                    className={`px-2.5 py-1 rounded-lg text-xs font-medium capitalize whitespace-nowrap transition-colors ${
                      sampleKey === key
                        ? "bg-fire-500/15 text-fire-500 border border-fire-500/25"
                        : "text-board-muted hover:text-board-text border border-transparent"
                    }`}
                  >
                    {key.replace("2", " 2")}
                  </button>
                ))}
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={toggle}
                  className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
                    visible
                      ? "bg-green-500/15 text-green-400 border border-green-500/25"
                      : "bg-board-bg text-board-muted border border-board-border hover:text-board-text"
                  }`}
                >
                  {visible ? "On Air" : "Off Air"}
                </button>
                <span className="text-xs text-board-muted font-mono">
                  {currentIndex + 1}/{TEMPLATES.length}
                </span>
                <button
                  onClick={prev}
                  className="p-1.5 rounded-lg text-board-muted hover:text-board-text hover:bg-board-border/50 transition-colors"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <button
                  onClick={next}
                  className="p-1.5 rounded-lg text-board-muted hover:text-board-text hover:bg-board-border/50 transition-colors"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Custom text inputs */}
            {sampleKey === "custom" && (
              <div className="flex gap-3">
                <input
                  type="text"
                  value={customPrimary}
                  onChange={(e) => setCustomPrimary(e.target.value)}
                  placeholder="Primary text (name, title, verse...)"
                  className="flex-1 px-3 py-2 rounded-lg bg-board-bg border border-board-border text-board-text placeholder:text-board-muted/50 focus:outline-none focus:border-fire-500 transition-colors text-sm"
                />
                <input
                  type="text"
                  value={customSecondary}
                  onChange={(e) => setCustomSecondary(e.target.value)}
                  placeholder="Secondary text (optional)"
                  className="flex-1 px-3 py-2 rounded-lg bg-board-bg border border-board-border text-board-text placeholder:text-board-muted/50 focus:outline-none focus:border-fire-500 transition-colors text-sm"
                />
              </div>
            )}

            {/* Action buttons */}
            <div className="flex items-center gap-2">
              <button
                onClick={handlePushLive}
                disabled={pushing || (sampleKey === "custom" && !customPrimary.trim())}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-fire-500 text-white text-xs font-medium hover:bg-fire-600 disabled:opacity-50 transition-colors"
              >
                <Play className="w-3.5 h-3.5" />
                {pushing ? "Pushing..." : "Push Live"}
              </button>
              {activeId && (
                <button
                  onClick={handleClearLive}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-red-500/20 text-red-400 text-xs font-medium hover:bg-red-500/30 transition-colors"
                >
                  <Square className="w-3.5 h-3.5" />
                  Clear
                </button>
              )}
              <button
                onClick={handleSave}
                disabled={saving || (sampleKey === "custom" && !customPrimary.trim())}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg border border-board-border text-board-muted text-xs font-medium hover:text-board-text hover:bg-board-border/50 disabled:opacity-50 transition-colors"
              >
                <Save className="w-3.5 h-3.5" />
                {saving ? "Saving..." : "Save to Library"}
              </button>
              {savedMsg && (
                <span className="text-xs text-green-400 font-medium">{savedMsg}</span>
              )}
              {activeId && (
                <div className="flex items-center gap-1.5 ml-auto">
                  <div className="w-2 h-2 rounded-full bg-fire-500 animate-pulse" />
                  <span className="text-xs font-medium text-fire-500">On Air</span>
                </div>
              )}
            </div>

            {/* Preview viewport — 16:9 OBS canvas with drag support */}
            <div
              ref={viewportRef}
              className="relative w-full rounded-xl overflow-hidden border border-board-border select-none cursor-default"
              style={{ aspectRatio: "16 / 9", background: "#111" }}
            >
              {/* Grid overlay */}
              <div
                className="absolute inset-0 opacity-[0.03] pointer-events-none"
                style={{
                  backgroundImage:
                    "linear-gradient(rgba(255,255,255,0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.1) 1px, transparent 1px)",
                  backgroundSize: "80px 80px",
                }}
              />
              {/* Center cross */}
              <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-8 h-8 pointer-events-none">
                <div className="absolute top-1/2 left-0 right-0 h-px bg-white/10" />
                <div className="absolute left-1/2 top-0 bottom-0 w-px bg-white/10" />
              </div>
              {/* Safe area */}
              <div className="absolute inset-[5%] border border-white/3 rounded pointer-events-none" />

              {/* Crosshair at current position */}
              <div
                className="absolute w-4 h-4 pointer-events-none transition-all duration-75"
                style={{
                  left: `${controls.posX}%`,
                  top: `${controls.posY}%`,
                  transform: "translate(-50%, -50%)",
                  opacity: 0.15,
                }}
              >
                <div className="absolute top-1/2 left-0 right-0 h-px bg-fire-500" />
                <div className="absolute left-1/2 top-0 bottom-0 w-px bg-fire-500" />
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-1.5 h-1.5 rounded-full bg-fire-500" />
              </div>

              {/* Template render */}
              <div className="pointer-events-none">
                {template.render(sample.primary, sample.secondary, visible, controls)}
              </div>

              {/* Status */}
              <div className="absolute top-4 right-4 flex items-center gap-2 pointer-events-none">
                {visible ? (
                  <div className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-red-500/20">
                    <div className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
                    <span className="text-[10px] text-red-400 font-mono uppercase tracking-widest">on air</span>
                  </div>
                ) : (
                  <span className="text-[10px] text-white/20 font-mono uppercase tracking-widest">off air</span>
                )}
              </div>
            </div>

            {/* Template info */}
            <div>
              <h2 className="text-base font-semibold text-board-text">{template.name}</h2>
              <p className="text-sm text-board-muted mt-0.5">{template.description}</p>
              {template.fullWidth && (
                <p className="text-[10px] text-board-muted/50 mt-1 italic">
                  Full-width template — horizontal position adjusts gradient direction, vertical position moves the strip.
                </p>
              )}
            </div>

            {/* Dot navigation */}
            <div className="flex justify-center gap-2">
              {TEMPLATES.map((t, i) => (
                <button
                  key={t.id}
                  onClick={() => {
                    setVisible(false);
                    setTimeout(() => {
                      setCurrentIndex(i);
                      setVisible(true);
                    }, 300);
                  }}
                  className={`h-2 rounded-full transition-all ${
                    i === currentIndex ? "bg-fire-500 w-6" : "bg-board-border hover:bg-board-muted w-2"
                  }`}
                />
              ))}
            </div>

            {/* Gallery grid */}
            <div className="pt-4 border-t border-board-border">
              <h3 className="text-sm font-semibold text-board-muted uppercase tracking-widest mb-4">
                All Templates
              </h3>
              <div className="grid grid-cols-2 gap-4">
                {TEMPLATES.map((t, i) => (
                  <button
                    key={t.id}
                    onClick={() => {
                      setCurrentIndex(i);
                      setVisible(true);
                      window.scrollTo({ top: 0, behavior: "smooth" });
                    }}
                    className={`text-left rounded-xl border p-3 transition-all ${
                      i === currentIndex
                        ? "border-fire-500/30 bg-fire-500/5"
                        : "border-board-border bg-board-card hover:border-board-muted/30"
                    }`}
                  >
                    <div
                      className="relative w-full rounded-lg overflow-hidden mb-2.5"
                      style={{ aspectRatio: "16 / 9", background: "#111" }}
                    >
                      <div className="absolute inset-0 [transform:scale(0.5)] [transform-origin:bottom_left]">
                        {t.render(SAMPLES.person.primary, SAMPLES.person.secondary, true, controls)}
                      </div>
                    </div>
                    <p className="text-xs font-semibold text-board-text">{t.name}</p>
                    <p className="text-[10px] text-board-muted mt-0.5 line-clamp-1">{t.description}</p>
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Controls sidebar */}
          {showControls && (
            <div className="w-64 shrink-0">
              <div className="sticky top-[73px] rounded-xl border border-board-border bg-board-card p-4">
                <h3 className="text-xs font-semibold text-board-text uppercase tracking-widest mb-4">
                  Customize
                </h3>
                <ControlPanel
                  controls={controls}
                  onChange={setControls}
                  onReset={() => setControls(DEFAULT_CONTROLS)}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
