import type { ModuleAction, ModuleFeedback } from "../types";

export const OBS_ACTIONS: ModuleAction[] = [
  {
    id: "set_current_program_scene",
    label: "Switch Scene (Program)",
    category: "scenes",
    params: [{ id: "sceneName", label: "Scene Name", type: "string" }],
  },
  {
    id: "set_current_preview_scene",
    label: "Set Preview Scene",
    category: "scenes",
    params: [{ id: "sceneName", label: "Scene Name", type: "string" }],
  },
  {
    id: "toggle_source_visibility",
    label: "Toggle Source Visibility",
    category: "sources",
    params: [
      { id: "sceneName", label: "Scene Name", type: "string" },
      { id: "sourceName", label: "Source Name", type: "string" },
      { id: "visible", label: "Visible", type: "boolean" },
    ],
  },
  {
    id: "start_streaming",
    label: "Start Streaming",
    category: "streaming",
    params: [],
  },
  {
    id: "stop_streaming",
    label: "Stop Streaming",
    category: "streaming",
    params: [],
  },
  {
    id: "start_recording",
    label: "Start Recording",
    category: "recording",
    params: [],
  },
  {
    id: "stop_recording",
    label: "Stop Recording",
    category: "recording",
    params: [],
  },
  {
    id: "set_source_volume",
    label: "Set Source Volume",
    category: "audio",
    params: [
      { id: "inputName", label: "Input Name", type: "string" },
      {
        id: "volumeDb",
        label: "Volume (dB)",
        type: "number",
        min: -100,
        max: 26,
        step: 0.1,
      },
    ],
  },
  {
    id: "toggle_input_mute",
    label: "Toggle Mute",
    category: "audio",
    params: [{ id: "inputName", label: "Input Name", type: "string" }],
  },
];

export const OBS_FEEDBACKS: ModuleFeedback[] = [
  {
    id: "current_program_scene",
    label: "Current Program Scene",
    type: "string",
    value: "",
  },
  {
    id: "current_preview_scene",
    label: "Current Preview Scene",
    type: "string",
    value: "",
  },
  {
    id: "streaming_active",
    label: "Streaming Active",
    type: "boolean",
    value: false,
  },
  {
    id: "recording_active",
    label: "Recording Active",
    type: "boolean",
    value: false,
  },
  {
    id: "scene_list",
    label: "Scene List",
    type: "string",
    value: "[]",
  },
];

/** Maps action IDs to OBS WebSocket v5 request types and data mappers */
export const ACTION_TO_REQUEST: Record<
  string,
  { requestType: string; mapParams: (p: Record<string, unknown>) => Record<string, unknown> }
> = {
  set_current_program_scene: {
    requestType: "SetCurrentProgramScene",
    mapParams: (p) => ({ sceneName: p.sceneName }),
  },
  set_current_preview_scene: {
    requestType: "SetCurrentPreviewScene",
    mapParams: (p) => ({ sceneName: p.sceneName }),
  },
  toggle_source_visibility: {
    requestType: "SetSceneItemEnabled",
    mapParams: (p) => ({
      sceneName: p.sceneName,
      sceneItemId: p.sourceName,
      sceneItemEnabled: p.visible,
    }),
  },
  start_streaming: {
    requestType: "StartStream",
    mapParams: () => ({}),
  },
  stop_streaming: {
    requestType: "StopStream",
    mapParams: () => ({}),
  },
  start_recording: {
    requestType: "StartRecord",
    mapParams: () => ({}),
  },
  stop_recording: {
    requestType: "StopRecord",
    mapParams: () => ({}),
  },
  set_source_volume: {
    requestType: "SetInputVolume",
    mapParams: (p) => ({ inputName: p.inputName, inputVolumeDb: p.volumeDb }),
  },
  toggle_input_mute: {
    requestType: "ToggleInputMute",
    mapParams: (p) => ({ inputName: p.inputName }),
  },
};
