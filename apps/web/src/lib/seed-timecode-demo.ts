/**
 * Demo automation timeline for a Sunday morning service.
 * Load this via the timecode page to see SMPTE automation in action.
 *
 * Usage: import { DEMO_EVENTS } from "@/lib/seed-timecode-demo"
 *        then call addEvent() for each one.
 */
import type { AutomationEvent, TimecodeValue } from "@/types/timecode";

function tc(h: number, m: number, s: number, f: number): TimecodeValue {
  return { hours: h, minutes: m, seconds: s, frames: f };
}

type EventSeed = Omit<AutomationEvent, "id" | "fired" | "triggerFrame">;

export const DEMO_EVENTS: EventSeed[] = [
  // ── Pre-Show (00:00) ──────────────────────────────────
  {
    triggerTimecode: tc(0, 0, 0, 0),
    action: "lighting-scene",
    label: "House Lights — Pre-Show",
    payload: { scene: "Pre-Show", intensity: 80 },
    toleranceFrames: 2,
    category: "Lighting",
  },

  // ── Welcome (00:05) ───────────────────────────────────
  {
    triggerTimecode: tc(0, 5, 0, 0),
    action: "lower-third-show",
    label: 'Push "Welcome to Grace Community"',
    payload: {
      type: "freetext",
      line1: "Welcome to Grace Community",
      line2: "Sunday Morning Service",
      style: "default",
    },
    toleranceFrames: 2,
    category: "Lower Thirds",
  },
  {
    triggerTimecode: tc(0, 5, 5, 0),
    action: "lower-third-clear",
    label: "Clear welcome lower third",
    payload: {},
    toleranceFrames: 2,
    category: "Lower Thirds",
  },

  // ── Worship Set (00:05:10) ────────────────────────────
  {
    triggerTimecode: tc(0, 5, 10, 0),
    action: "lighting-scene",
    label: "Lighting — Worship Set",
    payload: { scene: "Worship", intensity: 60 },
    toleranceFrames: 2,
    category: "Lighting",
  },
  {
    triggerTimecode: tc(0, 5, 10, 0),
    action: "device-action",
    label: "ATEM → Camera 1 Wide",
    targetDeviceId: "atem-main",
    targetActionId: "set_program_input",
    payload: { input: 1 },
    toleranceFrames: 2,
    category: "Video",
  },

  // ── Song 2 Scripture (00:12:30) ───────────────────────
  {
    triggerTimecode: tc(0, 12, 30, 0),
    action: "lower-third-show",
    label: 'Push Scripture "Psalm 95:1"',
    payload: {
      type: "scripture",
      scripture: "Psalm 95:1",
      line1: "Come, let us sing for joy to the LORD",
      translation: "NIV",
      style: "scripture",
    },
    toleranceFrames: 2,
    category: "Lower Thirds",
  },
  {
    triggerTimecode: tc(0, 12, 35, 0),
    action: "lower-third-clear",
    label: "Clear scripture",
    payload: {},
    toleranceFrames: 2,
    category: "Lower Thirds",
  },

  // ── Speaker Transition (00:20) ────────────────────────
  {
    triggerTimecode: tc(0, 20, 0, 0),
    action: "lighting-scene",
    label: "Lighting — Speaker Look",
    payload: { scene: "Speaker", intensity: 70 },
    toleranceFrames: 2,
    category: "Lighting",
  },
  {
    triggerTimecode: tc(0, 20, 0, 0),
    action: "device-action",
    label: "ATEM → Camera 3 Podium",
    targetDeviceId: "atem-main",
    targetActionId: "set_program_input",
    payload: { input: 3 },
    toleranceFrames: 2,
    category: "Video",
  },
  {
    triggerTimecode: tc(0, 20, 2, 0),
    action: "lower-third-show",
    label: "Push Pastor Name",
    payload: {
      type: "person",
      name: "Pastor James Mensah",
      title: "Lead Pastor",
      style: "default",
    },
    toleranceFrames: 2,
    category: "Lower Thirds",
  },
  {
    triggerTimecode: tc(0, 20, 7, 0),
    action: "lower-third-clear",
    label: "Clear pastor name",
    payload: {},
    toleranceFrames: 2,
    category: "Lower Thirds",
  },

  // ── Offering (00:35) ──────────────────────────────────
  {
    triggerTimecode: tc(0, 35, 0, 0),
    action: "rundown-advance",
    label: "Advance Rundown → Offering",
    payload: {},
    toleranceFrames: 2,
    category: "Rundown",
  },
  {
    triggerTimecode: tc(0, 35, 0, 0),
    action: "lighting-scene",
    label: "Lighting — Offering",
    payload: { scene: "Offering", intensity: 50 },
    toleranceFrames: 2,
    category: "Lighting",
  },

  // ── Closing (00:45) ───────────────────────────────────
  {
    triggerTimecode: tc(0, 45, 0, 0),
    action: "rundown-advance",
    label: "Advance Rundown → Closing",
    payload: {},
    toleranceFrames: 2,
    category: "Rundown",
  },
  {
    triggerTimecode: tc(0, 45, 0, 0),
    action: "lighting-scene",
    label: "Lighting — Worship Reprise",
    payload: { scene: "Worship", intensity: 60 },
    toleranceFrames: 2,
    category: "Lighting",
  },

  // ── Post-Show (00:55) ─────────────────────────────────
  {
    triggerTimecode: tc(0, 55, 0, 0),
    action: "lighting-scene",
    label: "Lighting — Post-Show / House Lights",
    payload: { scene: "Post-Show", intensity: 100 },
    toleranceFrames: 2,
    category: "Lighting",
  },
  {
    triggerTimecode: tc(0, 55, 0, 0),
    action: "lower-third-show",
    label: "Push outro graphic",
    payload: {
      type: "freetext",
      line1: "Thank you for joining us!",
      line2: "See you next Sunday",
      style: "default",
    },
    toleranceFrames: 2,
    category: "Lower Thirds",
  },
];
