import { z } from "zod";

export type Controls = z.infer<typeof graphicControlsSchema>;

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

export const graphicControlsSchema = z.object({
  accentColor: z.string().regex(/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i),
  bgOpacity: z.number().min(30).max(100),
  primarySize: z.number().min(PRIMARY_SIZE_RANGE.min).max(PRIMARY_SIZE_RANGE.max),
  secondarySize: z.number().min(SECONDARY_SIZE_RANGE.min).max(SECONDARY_SIZE_RANGE.max),
  posX: z.number().min(0).max(100),
  posY: z.number().min(0).max(100),
  animSpeed: z.enum(["fast", "normal", "slow"]),
});
