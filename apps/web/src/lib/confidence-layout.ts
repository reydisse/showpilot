import type { RelayPPSlide } from "@/lib/rundown-relay-payload";
import { z } from "zod";

export const CONFIDENCE_LAYOUT_KEY = "default-confidence-layout";
const color = z.string().regex(/^#[0-9a-f]{6}$/i);
const font = z.enum(["sans", "serif", "mono"]);
const textLayout = z.object({
  font,
  size: z.number().min(0.5).max(1.8),
  align: z.enum(["left", "center", "right"]),
  color,
  showNext: z.boolean(),
  nextOpacity: z.number().min(0.2).max(1),
  nextSize: z.number().min(0.5).max(1.8).default(1),
  nextColor: color.optional(),
  showReference: z.boolean(),
});

export const confidenceLayoutSchema = z.object({
  version: z.literal(1),
  contentMode: z.enum(["auto", "lyrics", "scripture"]).default("auto"),
  lyrics: textLayout,
  scripture: textLayout,
  motion: z.enum(["scroll", "none"]),
  stageMessage: z.object({ useDefault: z.boolean(), font, color }),
});
export type ConfidenceLayout = z.infer<typeof confidenceLayoutSchema>;
export type ConfidenceTextLayout = ConfidenceLayout["lyrics"];
export const DEFAULT_CONFIDENCE_LAYOUT: ConfidenceLayout = {
  version: 1,
  contentMode: "auto",
  lyrics: {
    font: "sans",
    size: 1,
    align: "center",
    color: "#ffffff",
    showNext: true,
    nextOpacity: 0.45,
    nextSize: 1,
    showReference: true,
  },
  scripture: {
    font: "serif",
    size: 1,
    align: "left",
    color: "#ffffff",
    showNext: false,
    nextOpacity: 0.4,
    nextSize: 1,
    showReference: true,
  },
  motion: "scroll",
  stageMessage: { useDefault: true, font: "sans", color: "#ffc107" },
};
export const CONFIDENCE_FONTS = {
  sans: "Inter, ui-sans-serif, system-ui, sans-serif",
  serif: 'Georgia, "Times New Roman", serif',
  mono: "ui-monospace, SFMono-Regular, Menlo, monospace",
};

/** Old/missing settings keep a usable screen; writes use the strict schema. */
export function readConfidenceLayout(
  value: string | undefined,
): ConfidenceLayout {
  try {
    const result = confidenceLayoutSchema.safeParse(
      JSON.parse(value || "null"),
    );
    return result.success ? result.data : DEFAULT_CONFIDENCE_LAYOUT;
  } catch {
    return DEFAULT_CONFIDENCE_LAYOUT;
  }
}

export type ConfidenceSlideData = RelayPPSlide;

/** Only advance the preview into place when it really became the current slide. */
export function isConfidenceAdvance(
  previous: ConfidenceSlideData,
  current: ConfidenceSlideData,
): boolean {
  if (
    !previous.nextText ||
    (previous.text === current.text && previous.slideId === current.slideId)
  )
    return false;
  if (previous.nextSlideId && current.slideId)
    return previous.nextSlideId === current.slideId;
  return previous.nextText === current.text;
}
