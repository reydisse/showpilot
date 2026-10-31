import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  type ReactNode,
} from "react";
import {
  CONFIDENCE_FONTS,
  DEFAULT_CONFIDENCE_LAYOUT,
  isConfidenceAdvance,
  type ConfidenceLayout,
  type ConfidenceSlideData,
} from "@/lib/confidence-layout";

import { splitScriptureText } from "@/lib/scripture-text";

const ConfidenceContext = createContext(DEFAULT_CONFIDENCE_LAYOUT);

export function ConfidenceScreen({
  layout,
  clean = false,
  children,
}: {
  layout: ConfidenceLayout;
  clean?: boolean;
  children: ReactNode;
}) {
  return (
    <ConfidenceContext.Provider value={layout}>
      <div
        className="confidence-screen"
        data-clean-output={clean || undefined}
        style={{ display: "contents" }}
      >
        {!layout.stageMessage.useDefault && (
          <style>{`.confidence-screen [data-stage-message-text] { color: ${layout.stageMessage.color} !important; font-family: ${CONFIDENCE_FONTS[layout.stageMessage.font]} !important; }`}</style>
        )}
        {clean && (
          <style>{`.confidence-screen button { display: none !important; } .confidence-screen { cursor: none; }`}</style>
        )}
        {children}
      </div>
    </ConfidenceContext.Provider>
  );
}

/** Used by both the editor preview and the actual monitor / DeckLink source. */
export function ConfidenceSlide({
  slide,
  layout: override,
}: {
  slide: ConfidenceSlideData;
  layout?: ConfidenceLayout;
}) {
  const inherited = useContext(ConfidenceContext);
  const layout = override ?? inherited;
  const scripture = splitScriptureText(slide.text, [slide.notes, slide.presentationName]);
  const isScripture =
    layout.contentMode === "scripture" ||
    (layout.contentMode === "auto" && (slide.isScripture || Boolean(scripture.reference)));
  const style = isScripture ? layout.scripture : layout.lyrics;
  const showNext = style.showNext;
  const text = isScripture ? scripture.text : slide.text;
  const upcoming = isScripture ? splitScriptureText(slide.nextText ?? "") : { text: slide.nextText ?? "", reference: "" };
  const reference = isScripture ? scripture.reference : [slide.presentationName, slide.notes].filter(Boolean).join(" · ");
  const areaRef = useRef<HTMLDivElement>(null);
  const currentRef = useRef<HTMLDivElement>(null);
  const nextRef = useRef<HTMLDivElement>(null);
  const previous = useRef(slide);

  useLayoutEffect(() => {
    const area = areaRef.current;
    const current = currentRef.current;
    const next = nextRef.current;
    if (!area || !current) return;
    const fit = (element: HTMLElement, maximum: number) => {
      const parent = element.parentElement;
      if (!parent || !parent.clientHeight) return;
      let low = 1;
      let high = maximum;
      while (high - low > 0.25) {
        const size = (low + high) / 2;
        element.style.fontSize = `${size}px`;
        if (
          element.scrollHeight <= parent.clientHeight &&
          element.scrollWidth <= parent.clientWidth
        )
          low = size;
        else high = size;
      }
      element.style.fontSize = `${low}px`;
    };
    const fitAll = () => {
      const maximum =
        Math.min(area.clientWidth * 0.09, area.clientHeight * 0.29) *
        style.size;
      fit(current, maximum);
      // Reserve a stable preview region and use a viewport-based size, independent
      // of the current verse length. Shrink only when unusually long text overflows.
      if (next) fit(next, Math.min(area.clientWidth * 0.035, area.clientHeight * 0.085) * style.nextSize);
    };
    fitAll();
    const old = previous.current;
    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    if (
      layout.motion === "scroll" &&
      !reduced &&
      style.showNext &&
      isConfidenceAdvance(old, slide)
    ) {
      // Hint at the upward advance without moving across the entire pane or
      // zooming from the smaller upcoming lyric into the current lyric.
      const offset = Math.min(14, area.clientHeight * 0.035);
      current.animate(
        [
          {
            transform: `translateY(${offset}px)`,
            opacity: 1,
          },
          { transform: "translateY(0)", opacity: 1 },
        ],
        { duration: 320, easing: "ease-out" },
      );

    }
    previous.current = slide;
    const observer = new ResizeObserver(fitAll);
    observer.observe(area);
    let active = true;
    void document.fonts?.ready.then(() => {
      if (active) fitAll();
    });
    return () => {
      active = false;
      observer.disconnect();
      current.getAnimations().forEach((a) => a.cancel());
      next?.getAnimations().forEach((a) => a.cancel());
    };
  }, [
    text,
    reference,
    upcoming.text,
    upcoming.reference,
    slide.text,
    slide.slideId,
    slide.nextText,
    slide.nextSlideId,
    slide.notes,
    slide.presentationName,
    style,
    layout.motion,
  ]);

  return (
    <div
      ref={areaRef}
      data-confidence-slide={isScripture ? "scripture" : "lyrics"}
      style={{
        width: "100%",
        height: "100%",
        minHeight: 0,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        gap: "3%",
        textAlign: style.align,
        color: style.color,
        fontFamily: CONFIDENCE_FONTS[style.font],
      }}
    >
      {style.showReference && reference && (
        <div
          data-confidence-reference
          style={{
            flexShrink: 0,
            maxHeight: "18%",
            overflow: "hidden",
            overflowWrap: "anywhere",
            fontFamily: CONFIDENCE_FONTS.sans,
            fontSize: isScripture ? "clamp(12px, 2cqw, 38px)" : "clamp(9px, 1cqw, 16px)",
            lineHeight: 1.4,
            textAlign: "left",
            textTransform: isScripture ? "none" : "uppercase",
            letterSpacing: isScripture ? "0.04em" : "0.12em",
            opacity: 0.5,
            fontWeight: 500,
          }}
        >
          {reference}
        </div>
      )}
      <div
        style={{
          flex: showNext ? "1 1 68%" : "1 1 100%",
          minHeight: 0,
          display: "flex",
          alignItems: "center",
        }}
      >
        <div
          ref={currentRef}
          data-confidence-current
          style={{
            width: "100%",
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
            lineHeight: 1.18,
            fontWeight: 600,
          }}
        >
          {text}
        </div>
      </div>
      {showNext && (
        <div
          style={{
            flex: "0 1 26%",
            minHeight: 0,
            display: "flex",
            alignItems: "center",
          }}
        >
          <div
            ref={nextRef}
            data-confidence-next
            style={{
              width: "100%",
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
              lineHeight: 1.2,
              fontWeight: 600,
              color: style.nextColor ?? style.color,
              opacity: style.nextOpacity,
            }}
          >
            {upcoming.text}
            {style.showReference && upcoming.reference && (
              <span data-confidence-next-reference style={{ display: "block", fontSize: "0.55em", marginTop: "0.4em" }}>
                {upcoming.reference}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
