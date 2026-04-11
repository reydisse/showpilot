import { BaseDeviceModule } from "../base-module";
import type { ModuleAction, ModuleFeedback, ModuleDefinition } from "../types";

const ATEM_ACTIONS: ModuleAction[] = [
  { id: "set_program_input", label: "Set Program Input", category: "switching", params: [
    { id: "input", label: "Input", type: "number", min: 1, max: 20, step: 1 },
  ]},
  { id: "set_preview_input", label: "Set Preview Input", category: "switching", params: [
    { id: "input", label: "Input", type: "number", min: 1, max: 20, step: 1 },
  ]},
  { id: "cut", label: "Cut", category: "transitions", params: [] },
  { id: "auto_transition", label: "Auto Transition", category: "transitions", params: [] },
  { id: "fade_to_black", label: "Fade to Black", category: "transitions", params: [] },
  { id: "run_macro", label: "Run Macro", category: "macros", params: [
    { id: "macro", label: "Macro Index", type: "number", min: 0, max: 99, step: 1 },
  ]},
  { id: "set_aux_source", label: "Set Aux Source", category: "aux", params: [
    { id: "aux", label: "Aux Output", type: "number", min: 1, max: 6, step: 1 },
    { id: "source", label: "Source Input", type: "number", min: 1, max: 20, step: 1 },
  ]},
  { id: "toggle_downstream_key", label: "Toggle DSK", category: "keying", params: [
    { id: "key", label: "DSK", type: "number", min: 1, max: 4, step: 1 },
  ]},
];

const ATEM_FEEDBACKS: ModuleFeedback[] = [
  { id: "program_input", label: "Program Input", type: "number", value: 0 },
  { id: "preview_input", label: "Preview Input", type: "number", value: 0 },
  { id: "transition_position", label: "Transition Position", type: "number", value: 0 },
  { id: "ftb_active", label: "Fade to Black", type: "boolean", value: false },
  { id: "tally_program", label: "Tally Program", type: "string", value: "[]" },
  { id: "tally_preview", label: "Tally Preview", type: "string", value: "[]" },
];

class ATEMModule extends BaseDeviceModule {
  protected async doConnect(): Promise<void> {
    throw new Error("Bridge agent required for ATEM connections");
  }
  protected doDisconnect(): void {}
  getActions() { return ATEM_ACTIONS; }
  async executeAction() { throw new Error("Bridge agent required"); }
  getFeedbacks() { return ATEM_FEEDBACKS; }
}

export const atemModuleDefinition: ModuleDefinition = {
  adapterType: "atem",
  displayName: "Blackmagic ATEM",
  category: "video",
  transport: "tcp",
  connectivity: "bridge-required",
  configFields: [
    { key: "host", label: "Switcher IP", placeholder: "192.168.1.240", required: true },
  ],
  icon: "Monitor",
  description: "Control Blackmagic ATEM switchers. Program/preview switching, transitions, macros, aux outputs. Requires ShowPilot Bridge.",
  createInstance: () => new ATEMModule(),
};
