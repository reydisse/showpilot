export interface MobileDeviceAction {
  id: string;
  label: string;
  category: string;
  params: Array<{
    id: string;
    label: string;
    type: "number" | "boolean";
    min?: number;
    max?: number;
    step?: number;
    default?: number | boolean;
  }>;
}

const ATEM_ACTIONS: MobileDeviceAction[] = [
  { id: "set_program_input", label: "Set Program Input", category: "Switching", params: [{ id: "input", label: "Input", type: "number", min: 1, max: 20, step: 1, default: 1 }] },
  { id: "set_preview_input", label: "Set Preview Input", category: "Switching", params: [{ id: "input", label: "Input", type: "number", min: 1, max: 20, step: 1, default: 1 }] },
  { id: "cut", label: "Cut", category: "Transitions", params: [] },
  { id: "auto_transition", label: "Auto Transition", category: "Transitions", params: [] },
  { id: "fade_to_black", label: "Fade to Black", category: "Transitions", params: [] },
  { id: "run_macro", label: "Run Macro", category: "Macros", params: [{ id: "macro", label: "Macro", type: "number", min: 0, max: 99, step: 1, default: 0 }] },
  { id: "set_aux_source", label: "Set Aux Source", category: "Aux", params: [{ id: "aux", label: "Aux", type: "number", min: 1, max: 6, step: 1, default: 1 }, { id: "source", label: "Source", type: "number", min: 1, max: 20, step: 1, default: 1 }] },
  { id: "toggle_downstream_key", label: "Toggle DSK", category: "Keying", params: [{ id: "key", label: "DSK", type: "number", min: 1, max: 4, step: 1, default: 1 }] },
];

const MIXER_ACTIONS: MobileDeviceAction[] = [
  { id: "set_channel_fader", label: "Set Channel Fader", category: "Channels", params: [{ id: "channel", label: "Channel", type: "number", min: 1, max: 40, step: 1, default: 1 }, { id: "level", label: "Level", type: "number", min: 0, max: 1, step: 0.01, default: 0.75 }] },
  { id: "mute_channel", label: "Set Channel Mute", category: "Channels", params: [{ id: "channel", label: "Channel", type: "number", min: 1, max: 40, step: 1, default: 1 }, { id: "muted", label: "Muted", type: "boolean", default: true }] },
  { id: "set_dca_fader", label: "Set DCA Fader", category: "DCA", params: [{ id: "dca", label: "DCA", type: "number", min: 1, max: 8, step: 1, default: 1 }, { id: "level", label: "Level", type: "number", min: 0, max: 1, step: 0.01, default: 0.75 }] },
  { id: "mute_dca", label: "Set DCA Mute", category: "DCA", params: [{ id: "dca", label: "DCA", type: "number", min: 1, max: 8, step: 1, default: 1 }, { id: "muted", label: "Muted", type: "boolean", default: true }] },
  { id: "recall_scene", label: "Recall Scene", category: "Scenes", params: [{ id: "scene", label: "Scene", type: "number", min: 1, max: 100, step: 1, default: 1 }] },
  { id: "recall_snippet", label: "Recall Snippet", category: "Scenes", params: [{ id: "snippet", label: "Snippet", type: "number", min: 1, max: 100, step: 1, default: 1 }] },
  { id: "set_bus_send", label: "Set Bus Send", category: "Routing", params: [{ id: "channel", label: "Channel", type: "number", min: 1, max: 40, step: 1, default: 1 }, { id: "bus", label: "Bus", type: "number", min: 1, max: 16, step: 1, default: 1 }, { id: "level", label: "Level", type: "number", min: 0, max: 1, step: 0.01, default: 0.75 }] },
];

export function actionsForMobileAdapter(adapterType: string, consoleType?: "x32" | "wing"): MobileDeviceAction[] {
  if (adapterType === "atem") return ATEM_ACTIONS;
  if (adapterType === "osc-mixer") {
    if (consoleType === "wing") {
      return MIXER_ACTIONS.filter((action) => !["recall_scene", "recall_snippet", "set_bus_send"].includes(action.id));
    }
    return MIXER_ACTIONS;
  }
  return [];
}

function integer(value: unknown, name: string, min: number, max: number) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${name} must be between ${min} and ${max}.`);
  return number;
}

export function buildMobileAtemCommand(actionId: string, params: Record<string, unknown>) {
  switch (actionId) {
    case "set_program_input": return JSON.stringify({ actionId, params: { input: integer(params.input, "Input", 1, 20) } });
    case "set_preview_input": return JSON.stringify({ actionId, params: { input: integer(params.input, "Input", 1, 20) } });
    case "cut":
    case "auto_transition":
    case "fade_to_black": return JSON.stringify({ actionId, params: {} });
    case "run_macro": return JSON.stringify({ actionId, params: { macro: integer(params.macro, "Macro", 0, 99) } });
    case "set_aux_source": return JSON.stringify({ actionId, params: { aux: integer(params.aux, "Aux", 1, 6), source: integer(params.source, "Source", 1, 20) } });
    case "toggle_downstream_key": return JSON.stringify({ actionId, params: { key: integer(params.key, "DSK", 1, 4) } });
    default: throw new Error("This ATEM action is not available on mobile.");
  }
}
