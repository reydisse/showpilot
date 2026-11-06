import { isDesktopMainWindow, isDesktopRuntime } from "./desktop-runtime";
import { MidiControllerRuntime, type ControllerCallbacks, type ControllerRuntime } from "./midi-controller-runtime";

export async function connectMidiController(callbacks: ControllerCallbacks): Promise<ControllerRuntime> {
  if (isDesktopRuntime()) {
    if (!isDesktopMainWindow()) throw new Error("Connect the MIDI controller in the main ShowPilot workspace.");
    const { NativeMidiControllerRuntime } = await import("./native-midi-controller");
    return NativeMidiControllerRuntime.connect(callbacks);
  }
  if (!navigator.requestMIDIAccess) throw new Error("Use ShowPilot Desktop or a browser with Web MIDI support to connect a controller.");
  return new MidiControllerRuntime(await navigator.requestMIDIAccess(), callbacks);
}
