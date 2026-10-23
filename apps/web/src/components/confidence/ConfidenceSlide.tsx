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
  const isScripture =
    layout.contentMode === "scripture" ||
    (layout.contentMode === "auto" && slide.isScripture);
  const style = isScripture ? layout.scripture : layout.lyrics;
  const showNext = style.showNext && Boolean(slide.nextText?.trim());
  const areaRef = useRef<HTMLDivElement>(null);
  const currentRef = useRef<HTMLDivElement>(null);
  const nextRef = useRef<HTMLDivElement>(null);
  const previous = useRef<{
    slide: ConfidenceSlideData;
    nextTop: number | null;
    nextFont: number;
  }>({ slide, nextTop: null, nextFont: 0 });

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
      if (next) fit(next, maximum * 0.62);
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
      old.nextTop !== null &&
      isConfidenceAdvance(old.slide, slide)
    ) {
      const offset = old.nextTop - current.getBoundingClientRect().top;
      const scale =
        old.nextFont / parseFloat(getComputedStyle(current).fontSize) || 1;
      current.animate(
        [
          {
            transform: `translateY(${offset}px) scale(${scale})`,
            opacity: style.nextOpacity,
          },
          { transform: "translateY(0)", opacity: 1 },
        ],
        { duration: 380, easing: "cubic-bezier(.2,.7,.2,1)" },
      );
      next?.animate([{ opacity: 0 }, { opacity: style.nextOpacity }], {
        duration: 380,
      });
    }
    previous.current = {
      slide,
      nextTop: next?.getBoundingClientRect().top ?? null,
      nextFont: next ? parseFloat(getComputedStyle(next).fontSize) : 0,
    };
    const observer = new ResizeObserver(() => {
      fitAll();
      previous.current.nextTop = next?.getBoundingClientRect().top ?? null;
      previous.current.nextFont = next
        ? parseFloat(getComputedStyle(next).fontSize)
        : 0;
    });
    observer.observe(area);
    let active = true;
    void document.fonts?.ready.then(() => {
      if (active) fitAll();
    });
    return () => {
      active = false;
      observer.disconnect();
      current.getAnimations().forEach((a) => a.cancel());
    };
  }, [
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
            transformOrigin: `${style.align} top`,
            width: "100%",
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
            lineHeight: 1.18,
            fontWeight: 600,
          }}
        >
          {slide.text}
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
              fontWeight: 500,
              opacity: style.nextOpacity,
            }}
          >
            {slide.nextText}
          </div>
        </div>
      )}
      {style.showReference && (slide.presentationName || slide.notes) && (
        <div
          style={{
            flexShrink: 0,
            maxHeight: "18%",
            overflow: "hidden",
            overflowWrap: "anywhere",
            fontFamily: CONFIDENCE_FONTS.sans,
            fontSize: "clamp(9px, 1.8cqw, 28px)",
            opacity: 0.55,
            fontWeight: 600,
          }}
        >
          {[slide.presentationName, slide.notes].filter(Boolean).join(" · ")}
        </div>
      )}
    </div>
  );
}
