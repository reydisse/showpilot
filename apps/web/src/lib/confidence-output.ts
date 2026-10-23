import { z } from "zod";
import { invoke } from "@tauri-apps/api/core";

export const outputTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("monitor"), id: z.string().min(1) }),
  z.object({
    kind: z.literal("decklink"),
    id: z.string().min(1),
    mode: z.number().int().nonnegative(),
  }),
]);
export type OutputTarget = z.infer<typeof outputTargetSchema>;
const modeSchema = z.object({
  id: z.number(),
  name: z.string(),
  width: z.number().positive(),
  height: z.number().positive(),
  frameDuration: z.number().positive(),
  timeScale: z.number().positive(),
});
export const outputInventorySchema = z.object({
  monitors: z.array(
    z.object({
      id: z.string(),
      name: z.string().nullable(),
      width: z.number(),
      height: z.number(),
    }),
  ),
  decklink: z.object({
    devices: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        modes: z.array(modeSchema),
      }),
    ),
    error: z.string().nullable(),
  }),
  active: z
    .object({
      orgSlug: z.string(),
      label: z.string(),
      target: outputTargetSchema,
      ready: z.boolean(),
    })
    .nullable(),
});
export type OutputInventory = z.infer<typeof outputInventorySchema>;
const statusSchema = z.object({
  state: z.enum(["stopped", "starting", "running", "error"]),
  message: z.string(),
  droppedFrames: z.number().optional(),
  completedFrames: z.number().optional(),
  orgSlug: z.string().optional(),
});
export type OutputStatus = z.infer<typeof statusSchema>;

export function preferredDeckLinkMode(modes: z.infer<typeof modeSchema>[]) {
  return (
    modes.find(
      (mode) =>
        mode.width === 1920 &&
        mode.height === 1080 &&
        Math.abs(mode.timeScale / mode.frameDuration - 60000 / 1001) < 0.001,
    ) ?? modes[0]
  );
}
export async function getConfidenceOutputs() {
  return outputInventorySchema.parse(
    await invoke<unknown>("confidence_outputs"),
  );
}
export async function getConfidenceOutputStatus() {
  return statusSchema.parse(await invoke<unknown>("confidence_output_status"));
}
export async function startConfidenceOutput(
  orgSlug: string,
  target: OutputTarget,
) {
  await invoke("start_confidence_output", { orgSlug, target });
}
export async function stopConfidenceOutput() {
  await invoke("stop_confidence_output");
}
export async function confidenceOutputReady() {
  await invoke("confidence_output_ready");
}

export async function identifyConfidenceMonitor(id: string) {
  await invoke("identify_confidence_monitor", { id });
}

export async function closeConfidenceOutputWindow() {
  await invoke("close_confidence_output_window");
}
