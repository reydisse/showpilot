import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect, useRef, useCallback } from "react";
import { getLowerThirdState, type LowerThirdPayload } from "@/lib/lowerthirds";

export const Route = createFileRoute("/overlay/$orgSlug")({
  component: OverlayPage,
});

// ─── Overlay Styles (inline, self-contained) ──────────────────

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

  /* ── Default Style ─────────────────────────────── */

  .lt-default {
    position: absolute;
    bottom: 80px;
    left: 60px;
    max-width: 640px;
    transform: translateY(40px);
    opacity: 0;
    transition: transform 200ms cubic-bezier(0.16, 1, 0.3, 1),
                opacity 200ms cubic-bezier(0.16, 1, 0.3, 1);
  }

  .lt-default.lt-visible {
    transform: translateY(0);
    opacity: 1;
  }

  .lt-default.lt-clearing {
    transform: translateY(40px);
    opacity: 0;
    transition: transform 300ms cubic-bezier(0.7, 0, 0.84, 0),
                opacity 300ms cubic-bezier(0.7, 0, 0.84, 0);
  }

  .lt-default .lt-bar {
    background: rgba(0, 0, 0, 0.88);
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
    border-left: 4px solid #ffc107;
    border-radius: 6px;
    padding: 18px 32px;
  }

  .lt-default .lt-name {
    color: #ffffff;
    font-size: 28px;
    font-weight: 700;
    line-height: 1.2;
    letter-spacing: -0.01em;
  }

  .lt-default .lt-title {
    color: rgba(255, 255, 255, 0.7);
    font-size: 18px;
    font-weight: 400;
    line-height: 1.3;
    margin-top: 4px;
  }

  /* ── Minimal Style ─────────────────────────────── */

  .lt-minimal {
    position: absolute;
    bottom: 80px;
    left: 60px;
    max-width: 500px;
    transform: translateY(40px);
    opacity: 0;
    transition: transform 200ms cubic-bezier(0.16, 1, 0.3, 1),
                opacity 200ms cubic-bezier(0.16, 1, 0.3, 1);
  }

  .lt-minimal.lt-visible {
    transform: translateY(0);
    opacity: 1;
  }

  .lt-minimal.lt-clearing {
    transform: translateY(40px);
    opacity: 0;
    transition: transform 300ms cubic-bezier(0.7, 0, 0.84, 0),
                opacity 300ms cubic-bezier(0.7, 0, 0.84, 0);
  }

  .lt-minimal .lt-bar {
    padding: 10px 0;
    border-bottom: 2px solid #ffc107;
  }

  .lt-minimal .lt-name {
    color: #ffffff;
    font-size: 24px;
    font-weight: 600;
    line-height: 1.2;
    text-shadow: 0 2px 8px rgba(0, 0, 0, 0.8);
  }

  /* ── Scripture Style ───────────────────────────── */

  .lt-scripture {
    position: absolute;
    bottom: 100px;
    left: 50%;
    transform: translateX(-50%) translateY(40px);
    opacity: 0;
    max-width: 800px;
    width: 90%;
    text-align: center;
    transition: transform 200ms cubic-bezier(0.16, 1, 0.3, 1),
                opacity 200ms cubic-bezier(0.16, 1, 0.3, 1);
  }

  .lt-scripture.lt-visible {
    transform: translateX(-50%) translateY(0);
    opacity: 1;
  }

  .lt-scripture.lt-clearing {
    transform: translateX(-50%) translateY(40px);
    opacity: 0;
    transition: transform 300ms cubic-bezier(0.7, 0, 0.84, 0),
                opacity 300ms cubic-bezier(0.7, 0, 0.84, 0);
  }

  .lt-scripture .lt-bar {
    background: rgba(0, 0, 0, 0.85);
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
    border-radius: 8px;
    padding: 28px 40px;
  }

  .lt-scripture .lt-text {
    color: #ffffff;
    font-size: 32px;
    font-weight: 400;
    line-height: 1.5;
    font-style: italic;
    letter-spacing: 0.01em;
  }

  .lt-scripture .lt-reference {
    color: #ffc107;
    font-size: 18px;
    font-weight: 600;
    margin-top: 12px;
    font-style: normal;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
`;

// ─── Overlay Page Component ───────────────────────────────────

function OverlayPage() {
  const { orgSlug } = Route.useParams();
  const searchParams =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search)
      : new URLSearchParams();
  const styleVariant = (searchParams.get("style") ?? "default") as
    | "default"
    | "minimal"
    | "scripture";

  const [payload, setPayload] = useState<LowerThirdPayload | null>(null);
  const [displayState, setDisplayState] = useState<
    "hidden" | "visible" | "clearing"
  >("hidden");
  const prevIdRef = useRef<string | null>(null);
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const poll = useCallback(async () => {
    try {
      const result = await getLowerThirdState({
        data: { orgSlug },
      });

      if (result && result.state === "live") {
        // New or changed lower third
        if (result.id !== prevIdRef.current) {
          // If something is currently showing, clear it first
          if (displayState === "visible") {
            setDisplayState("clearing");
            if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
            clearTimerRef.current = setTimeout(() => {
              setPayload(result);
              prevIdRef.current = result.id;
              // Small delay before showing new one
              requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                  setDisplayState("visible");
                });
              });
            }, 320);
          } else {
            setPayload(result);
            prevIdRef.current = result.id;
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                setDisplayState("visible");
              });
            });
          }
        }
        // Same ID, already visible — do nothing
      } else {
        // No active LT — clear if showing
        if (prevIdRef.current !== null) {
          setDisplayState("clearing");
          prevIdRef.current = null;
          if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
          clearTimerRef.current = setTimeout(() => {
            setPayload(null);
            setDisplayState("hidden");
          }, 320);
        }
      }
    } catch {
      // Silently retry on next poll
    }
  }, [orgSlug, displayState]);

  useEffect(() => {
    // Initial poll
    poll();

    // Poll every 500ms
    const interval = setInterval(poll, 500);
    return () => {
      clearInterval(interval);
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
    };
  }, [poll]);

  // ── Render ──

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: OVERLAY_CSS }} />
      <div className="overlay-container">
        {payload && renderLowerThird(payload, styleVariant, displayState)}
      </div>
    </>
  );
}

// ─── Renderers per style variant ──────────────────────────────

function renderLowerThird(
  payload: LowerThirdPayload,
  style: "default" | "minimal" | "scripture",
  displayState: "hidden" | "visible" | "clearing"
) {
  const stateClass =
    displayState === "visible"
      ? "lt-visible"
      : displayState === "clearing"
        ? "lt-clearing"
        : "";

  switch (style) {
    case "minimal":
      return renderMinimal(payload, stateClass);
    case "scripture":
      return renderScripture(payload, stateClass);
    default:
      return renderDefault(payload, stateClass);
  }
}

function renderDefault(payload: LowerThirdPayload, stateClass: string) {
  const primaryText = getPrimaryText(payload);
  const secondaryText = getSecondaryText(payload);

  return (
    <div className={`lt-default ${stateClass}`}>
      <div className="lt-bar">
        <div className="lt-name">{primaryText}</div>
        {secondaryText && <div className="lt-title">{secondaryText}</div>}
      </div>
    </div>
  );
}

function renderMinimal(payload: LowerThirdPayload, stateClass: string) {
  const primaryText = getPrimaryText(payload);

  return (
    <div className={`lt-minimal ${stateClass}`}>
      <div className="lt-bar">
        <div className="lt-name">{primaryText}</div>
      </div>
    </div>
  );
}

function renderScripture(payload: LowerThirdPayload, stateClass: string) {
  if (payload.type === "scripture") {
    const verse = payload.line1 ?? payload.scripture ?? "";
    const reference = payload.name ?? payload.title ?? "";
    const translation = payload.translation
      ? ` (${payload.translation})`
      : "";

    return (
      <div className={`lt-scripture ${stateClass}`}>
        <div className="lt-bar">
          <div className="lt-text">{`\u201C${verse}\u201D`}</div>
          <div className="lt-reference">
            {reference}
            {translation}
          </div>
        </div>
      </div>
    );
  }

  // Fallback for non-scripture content in scripture style
  const primaryText = getPrimaryText(payload);
  const secondaryText = getSecondaryText(payload);

  return (
    <div className={`lt-scripture ${stateClass}`}>
      <div className="lt-bar">
        <div className="lt-text">{primaryText}</div>
        {secondaryText && <div className="lt-reference">{secondaryText}</div>}
      </div>
    </div>
  );
}

// ─── Text Helpers ─────────────────────────────────────────────

function getPrimaryText(payload: LowerThirdPayload): string {
  switch (payload.type) {
    case "person":
      return payload.name ?? payload.title ?? "";
    case "scripture":
      return payload.scripture ?? payload.line1 ?? "";
    case "freetext":
      return payload.line1 ?? payload.title ?? "";
    default:
      return payload.title ?? payload.name ?? payload.line1 ?? "";
  }
}

function getSecondaryText(payload: LowerThirdPayload): string | null {
  switch (payload.type) {
    case "person":
      return payload.title ?? null;
    case "scripture": {
      const ref = payload.name ?? "";
      const translation = payload.translation
        ? ` \u2014 ${payload.translation}`
        : "";
      return ref ? `${ref}${translation}` : null;
    }
    case "freetext":
      return payload.line2 ?? null;
    default:
      return null;
  }
}
