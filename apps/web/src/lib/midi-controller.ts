import { z } from "zod";
import type { AutomationEvent, TimecodeState } from "@/types/timecode";
import { nextAutomationEvent } from "@/lib/automation-cues";
import { scheduledDispatchFrame } from "./automation-timing";

const byte = z.number().int().min(0).max(127);
export const midiPortSchema = z.object({ id: z.string().max(300), name: z.string().max(300).nullable(), manufacturer: z.string().max(300).nullable() }).strict();
export const midiActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("start") }).strict(),
  z.object({ kind: z.literal("stop") }).strict(),
  z.object({ kind: z.literal("pause") }).strict(),
  z.object({ kind: z.literal("reset") }).strict(),
  z.object({ kind: z.literal("seek"), frame: z.number().int().min(0).max(2_591_999) }).strict(),
  z.object({ kind: z.literal("fire-next") }).strict(),
  z.object({ kind: z.literal("lyrics-next") }).strict(),
  z.object({ kind: z.literal("lyrics-previous") }).strict(),
  z.object({ kind: z.literal("fire"), cueId: z.string().min(1).max(200) }).strict(),
  z.object({ kind: z.literal("skip"), cueId: z.string().min(1).max(200) }).strict(),
  z.object({ kind: z.literal("rearm"), cueId: z.string().min(1).max(200) }).strict(),
  z.object({ kind: z.literal("cue-slot"), slot: z.number().int().min(0).max(63) }).strict(),
  z.object({ kind: z.literal("bank-next") }).strict(),
  z.object({ kind: z.literal("bank-prev") }).strict(),
  z.object({ kind: z.literal("scrub"), frames: z.number().int().min(1).max(2_591_999) }).strict(),
  z.object({ kind: z.literal("offset"), frames: z.number().int().min(1).max(900) }).strict(),
  z.object({ kind: z.literal("jog"), frames: z.number().int().min(1).max(30) }).strict(),
]);
export const midiBindingSchema = z.object({
  id: z.string().min(1).max(200),
  input: z.object({ kind: z.enum(["note", "cc"]), channel: z.number().int().min(0).max(15), number: byte }).strict(),
  action: midiActionSchema,
}).strict().refine(binding => !isContinuousAction(binding.action) || binding.input.kind === "cc", "Fader actions require a CC input.");
export const midiControllerSchema = z.object({
  input: midiPortSchema.nullable(), output: midiPortSchema.nullable(),
  feedback: z.enum(["none", "apc-mini-mk2"]),
  bindings: z.array(midiBindingSchema).max(256),
}).strict().superRefine((config, ctx) => {
  const inputs = new Set<string>(); const ids = new Set<string>();
  for (const binding of config.bindings) {
    const input = midiInputKey(binding.input);
    if (inputs.has(input) || ids.has(binding.id)) ctx.addIssue({ code: "custom", message: "Each controller input and mapping ID must be unique." });
    inputs.add(input); ids.add(binding.id);
  }
});
export type MidiAction = z.infer<typeof midiActionSchema>;
export type MidiBinding = z.infer<typeof midiBindingSchema>;
export type MidiControllerConfig = z.infer<typeof midiControllerSchema>;
export type MidiPortIdentity = z.infer<typeof midiPortSchema>;
export interface MidiControllerSnapshot { revision: number; config: MidiControllerConfig }
export function emptyMidiController(): MidiControllerSnapshot {
  return { revision: 0, config: { input: null, output: null, feedback: "none", bindings: [] } };
}
export function midiInputKey(input: MidiBinding["input"]): string { return `${input.kind}:${input.channel}:${input.number}`; }
export function isContinuousAction(action: MidiAction): action is Extract<MidiAction, { kind: "scrub" | "offset" | "jog" }> {
  return action.kind === "scrub" || action.kind === "offset" || action.kind === "jog";
}
export function parseControllerMessage(data: Uint8Array | null): { input: MidiBinding["input"]; value: number } | null {
  if (!data || data.length !== 3 || data[1] > 127 || data[2] > 127) return null;
  const status = data[0] & 0xf0;
  if (status !== 0x80 && status !== 0x90 && status !== 0xb0) return null;
  return { input: { kind: status === 0xb0 ? "cc" : "note", channel: data[0] & 15, number: data[1] }, value: status === 0x80 ? 0 : data[2] };
}
export function cueBank(events: readonly AutomationEvent[], bank: number): AutomationEvent[] {
  return [...events].sort((a, b) => scheduledDispatchFrame(a) - scheduledDispatchFrame(b)).slice(bank * 64, (bank + 1) * 64);
}
export type PadState = "off" | "armed" | "next" | "fired" | "running" | "failed";
export function controllerCueView(events: readonly AutomationEvent[], frame: number, bank: number) {
  return { bank: cueBank(events, bank), byId: new Map(events.map(cue => [cue.id, cue])), next: nextAutomationEvent(events, frame) };
}
export function bindingPadState(binding: MidiBinding, events: readonly AutomationEvent[], state: TimecodeState, bank: number, view = controllerCueView(events, state.totalFrames, bank)): PadState {
  const action = binding.action;
  if (action.kind === "start") return state.running ? "running" : "armed";
  const next = view.next;
  const cue = action.kind === "cue-slot" ? view.bank[action.slot]
    : action.kind === "fire-next" ? next : "cueId" in action ? view.byId.get(action.cueId) : undefined;
  if (!cue) return "off";
  if (cue.executionStatus === "failed") return "failed";
  if (cue.fired) return "fired";
  if (!cue.enabled || cue.skipped || !state.triggersEnabled) return "off";
  if (cue.executionStatus === "dispatching") return "running";
  return cue.id === next?.id ? "next" : "armed";
}
// Akai APC mini mk2 Communications Protocol v1.0, pp. 2-6.
// https://cdn.inmusicbrands.com/akai/attachments/APC%20mini%20mk2%20-%20Communication%20Protocol%20-%20v1.0.pdf
export function apcMiniMk2Led(note: number, state: PadState): number[] | null {
  const colors: Record<PadState, number> = { off: 0, armed: 45, next: 13, fired: 21, running: 3, failed: 5 };
  if (note >= 0 && note < 64) return [0x96, note, colors[state]];
  if ((note >= 0x64 && note <= 0x6b) || (note >= 0x70 && note <= 0x77)) return [0x90, note, state === "off" ? 0 : state === "running" || state === "next" ? 2 : 1];
  return null;
}
export function apcMiniMk2CueBindings(): MidiBinding[] {
  return Array.from({ length: 64 }, (_, slot) => ({ id: `apc-pad-${slot}`, input: { kind: "note", channel: 0, number: slot }, action: { kind: "cue-slot", slot } }));
}
