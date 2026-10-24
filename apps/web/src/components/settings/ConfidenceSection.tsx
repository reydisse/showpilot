import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfidenceSlide } from "@/components/confidence/ConfidenceSlide";
import {
  CONFIDENCE_LAYOUT_KEY,
  CONFIDENCE_FONTS,
  DEFAULT_CONFIDENCE_LAYOUT,
  readConfidenceLayout,
  type ConfidenceLayout,
  type ConfidenceSlideData,
} from "@/lib/confidence-layout";
import { updateOrgSetting } from "@/lib/settings";
import { ConfidenceOutputs } from "@/components/settings/ConfidenceOutputs";

const samples: Record<"lyrics" | "scripture", ConfidenceSlideData[]> = {
  lyrics: [
    {
      text: "Amazing grace, how sweet the sound\nThat saved a wretch like me",
      notes: "",
      presentationName: "Amazing Grace",
      isScripture: false,
      slideId: "a",
      nextSlideId: "b",
      nextText: "I once was lost, but now am found\nWas blind, but now I see",
    },
    {
      text: "I once was lost, but now am found\nWas blind, but now I see",
      notes: "",
      presentationName: "Amazing Grace",
      isScripture: false,
      slideId: "b",
      nextSlideId: "c",
      nextText:
        "’Twas grace that taught my heart to fear\nAnd grace my fears relieved",
    },
  ],
  scripture: [
    {
      text: "The LORD is my shepherd;\nI shall not want.",
      notes: "Psalm 23:1 · KJV",
      presentationName: "",
      isScripture: true,
      slideId: "p1",
      nextSlideId: "p2",
      nextText:
        "He maketh me to lie down in green pastures: he leadeth me beside the still waters.",
    },
    {
      text: "He maketh me to lie down in green pastures: he leadeth me beside the still waters.",
      notes: "Psalm 23:2 · KJV",
      presentationName: "",
      isScripture: true,
      slideId: "p2",
      nextSlideId: "p3",
      nextText:
        "He restoreth my soul: he leadeth me in the paths of righteousness for his name’s sake.",
    },
  ],
};
const fieldClass =
  "h-10 w-full rounded-lg border border-board-border bg-board-bg px-3 text-sm text-board-text";

export function ConfidenceSection({
  orgId,
  slug,
  initialValue,
  onApplied,
}: {
  orgId: string;
  slug: string;
  initialValue: string;
  onApplied: (value: string) => void;
}) {
  const [draft, setDraft] = useState(() => readConfidenceLayout(initialValue));
  const [applied, setApplied] = useState(() =>
    JSON.stringify(readConfidenceLayout(initialValue)),
  );
  const [tab, setTab] = useState<"lyrics" | "scripture">("lyrics");
  const [sample, setSample] = useState(0);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");
  const style = draft[tab];
  const dirty = JSON.stringify(draft) !== applied;
  const change = (patch: Partial<ConfidenceLayout["lyrics"]>) =>
    setDraft((value) => ({ ...value, [tab]: { ...value[tab], ...patch } }));

  async function apply() {
    setSaving(true);
    setError("");
    setFeedback("");
    try {
      const value = JSON.stringify(draft);
      await updateOrgSetting({
        data: { orgId, key: CONFIDENCE_LAYOUT_KEY, value },
      });
      setApplied(value);
      onApplied(value);
      setFeedback("Applied. Open screens will update within a few seconds.");
    } catch {
      setError(
        "Could not apply the layout. Your preview is still here; try again.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <section
      className="mt-10 border-t border-board-border pt-8"
      aria-labelledby="confidence-heading"
    >
      <h2
        id="confidence-heading"
        className="text-lg font-semibold text-board-text"
      >
        Confidence screen
      </h2>
      <p className="mt-1 text-sm text-board-muted">
        Shape the lyrics and scripture your team sees. Preview changes here,
        then apply them to your screens.
      </p>
      <label className="mt-5 block max-w-sm text-sm text-board-muted">
        Live content layout
        <select
          className={`${fieldClass} mt-1`}
          value={draft.contentMode}
          onChange={(event) => {
            const contentMode = event.target.value;
            if (
              contentMode === "auto" ||
              contentMode === "lyrics" ||
              contentMode === "scripture"
            )
              setDraft((value) => ({ ...value, contentMode }));
          }}
        >
          <option value="auto">Automatic from ProPresenter</option>
          <option value="lyrics">Always use lyrics</option>
          <option value="scripture">Always use scripture</option>
        </select>
        <span className="mt-1 block text-xs">
          Choose a fixed layout if your slides do not include a recognizable
          scripture reference.
        </span>
      </label>
      <div className="my-5 flex flex-wrap items-center gap-2">
        {(["lyrics", "scripture"] as const).map((mode) => (
          <Button
            key={mode}
            variant={tab === mode ? "default" : "outline"}
            aria-pressed={tab === mode}
            onClick={() => {
              setTab(mode);
              setSample(0);
            }}
          >
            {mode === "lyrics" ? "Lyrics" : "Scripture"}
          </Button>
        ))}
        <span className="ml-auto text-xs text-board-muted">
          Sample content · Preview only
        </span>
      </div>
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.5fr)_minmax(240px,1fr)]">
        <div className="min-w-0">
          <div
            className="aspect-video overflow-hidden rounded-xl border border-white/10 bg-[#090a0b] p-[5%]"
            style={{ containerType: "inline-size" }}
          >
            <ConfidenceSlide
              slide={samples[tab][sample]}
              layout={{ ...draft, contentMode: "auto" }}
            />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button
              variant="outline"
              onClick={() => setSample((value) => (value === 0 ? 1 : 0))}
            >
              Preview advance
            </Button>
            <p className="text-xs text-board-muted">
              Your timer and stage-message priority stay as they are.
            </p>
          </div>
        </div>
        <div className="space-y-4">
          <label className="block text-sm text-board-muted">
            Typeface
            <select
              className={`${fieldClass} mt-1`}
              value={style.font}
              onChange={(event) => {
                const font = event.target.value;
                if (font === "sans" || font === "serif" || font === "mono")
                  change({ font });
              }}
            >
              <option value="sans">ShowPilot Sans</option>
              <option value="serif">Serif</option>
              <option value="mono">Monospace</option>
            </select>
          </label>
          <label className="block text-sm text-board-muted">
            Text size · {Math.round(style.size * 100)}%
            <input
              className="mt-2 w-full accent-amber-400"
              type="range"
              min="0.5"
              max="1.8"
              step="0.05"
              value={style.size}
              onChange={(event) => change({ size: Number(event.target.value) })}
            />
          </label>
          <label className="block text-sm text-board-muted">
            Alignment
            <select
              className={`${fieldClass} mt-1`}
              value={style.align}
              onChange={(event) => {
                const align = event.target.value;
                if (align === "left" || align === "center" || align === "right")
                  change({ align });
              }}
            >
              <option value="left">Left</option>
              <option value="center">Center</option>
              <option value="right">Right</option>
            </select>
          </label>
          <label className="flex items-center justify-between gap-3 text-sm text-board-muted">
            Text color
            <input
              aria-label="Text color"
              type="color"
              value={style.color}
              onChange={(event) => change({ color: event.target.value })}
              className="h-9 w-12 rounded border border-board-border bg-transparent"
            />
          </label>
          <label className="flex items-center gap-3 text-sm text-board-text">
            <input
              type="checkbox"
              className="size-4 accent-amber-400"
              checked={style.showNext}
              onChange={(event) => change({ showNext: event.target.checked })}
            />
            Show upcoming {tab === "lyrics" ? "lyric" : "verse"}
          </label>
          {style.showNext && (
            <label className="block text-sm text-board-muted">
              Upcoming text opacity · {Math.round(style.nextOpacity * 100)}%
              <input
                className="mt-2 w-full accent-amber-400"
                type="range"
                min="0.2"
                max="0.75"
                step="0.05"
                value={style.nextOpacity}
                onChange={(event) =>
                  change({ nextOpacity: Number(event.target.value) })
                }
              />
            </label>
          )}
          <label className="flex items-center gap-3 text-sm text-board-text">
            <input
              type="checkbox"
              className="size-4 accent-amber-400"
              checked={style.showReference}
              onChange={(event) =>
                change({ showReference: event.target.checked })
              }
            />
            Show reference and notes
          </label>
          <label className="flex items-center gap-3 text-sm text-board-text">
            <input
              type="checkbox"
              className="size-4 accent-amber-400"
              checked={draft.motion === "scroll"}
              onChange={(event) =>
                setDraft((value) => ({
                  ...value,
                  motion: event.target.checked ? "scroll" : "none",
                }))
              }
            />
            Scroll upward on advance
          </label>
        </div>
      </div>
      <details className="my-6 rounded-xl border border-board-border p-4">
        <summary className="cursor-pointer text-sm font-medium text-board-text">
          Stage message appearance
        </summary>
        <label className="mt-4 flex items-center gap-3 text-sm text-board-text">
          <input
            type="checkbox"
            className="size-4 accent-amber-400"
            checked={draft.stageMessage.useDefault}
            onChange={(event) =>
              setDraft((value) => ({
                ...value,
                stageMessage: {
                  ...value.stageMessage,
                  useDefault: event.target.checked,
                },
              }))
            }
          />
          Keep the current ShowPilot style
        </label>
        {!draft.stageMessage.useDefault && (
          <div className="mt-4 flex flex-wrap items-center gap-4">
            <label className="text-sm text-board-muted">
              Text color{" "}
              <input
                aria-label="Stage message color"
                type="color"
                value={draft.stageMessage.color}
                onChange={(event) =>
                  setDraft((value) => ({
                    ...value,
                    stageMessage: {
                      ...value.stageMessage,
                      color: event.target.value,
                    },
                  }))
                }
              />
            </label>
            <label className="text-sm text-board-muted">
              Typeface{" "}
              <select
                className={fieldClass}
                value={draft.stageMessage.font}
                onChange={(event) => {
                  const font = event.target.value;
                  if (font === "sans" || font === "serif" || font === "mono")
                    setDraft((value) => ({
                      ...value,
                      stageMessage: { ...value.stageMessage, font },
                    }));
                }}
              >
                <option value="sans">ShowPilot Sans</option>
                <option value="serif">Serif</option>
                <option value="mono">Monospace</option>
              </select>
            </label>
          </div>
        )}
        <div
          className="mt-4 border-b-2 border-amber-400/30 bg-amber-400/10 px-5 py-4 text-center text-xl font-bold"
          style={{
            color: draft.stageMessage.useDefault
              ? "#ffc107"
              : draft.stageMessage.color,
            fontFamily: draft.stageMessage.useDefault
              ? CONFIDENCE_FONTS.sans
              : CONFIDENCE_FONTS[draft.stageMessage.font],
          }}
        >
          Please have microphone 2 ready
        </div>
        <p className="mt-3 text-xs text-board-muted">
          Priority messages still take over the screen. Normal messages keep
          their existing attention period.
        </p>
      </details>
      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={!dirty || saving} onClick={() => void apply()}>
          {saving ? "Applying…" : "Apply to screens"}
        </Button>
        <Button
          variant="ghost"
          disabled={saving}
          onClick={() => setDraft(readConfidenceLayout(applied))}
        >
          Discard changes
        </Button>
        <Button
          variant="ghost"
          disabled={saving}
          onClick={() => setDraft(DEFAULT_CONFIDENCE_LAYOUT)}
        >
          Reset preview
        </Button>
      </div>
      {feedback && !dirty && (
        <p role="status" className="mt-3 text-sm text-board-muted">
          {feedback}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-red-400">
          {error}
        </p>
      )}
      <ConfidenceOutputs slug={slug} />
    </section>
  );
}
