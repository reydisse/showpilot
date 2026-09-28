import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CockpitControlPanel } from "../CockpitControlPanel";
import { MIXER_ACTIONS } from "@/lib/device-modules/osc-mixer/osc-mixer-module";
import type { DeviceModule, ModuleAction, ModuleDefinition } from "@/lib/device-modules/types";

function device(actions: ModuleAction[], category: ModuleDefinition["category"]) {
  const executeAction = vi.fn().mockResolvedValue(undefined);
  const module: DeviceModule = {
    connect: async () => {}, disconnect: () => {}, connectionStatus: () => "connected",
    onStatusChange: () => () => {}, onFeedbackChange: () => () => {},
    getActions: () => actions, getFeedbacks: () => [], executeAction,
  };
  const definition: ModuleDefinition = {
    adapterType: "test", displayName: "Test device", category, transport: "tcp",
    connectivity: "bridge-required", configFields: [], icon: "Monitor", description: "Test device",
    createInstance: () => module,
  };
  return { module, definition, executeAction };
}

describe("device cockpit controls", () => {
  it("can unblank and unmute projectors with boolean mute commands", async () => {
    const props = device([
      { id: "power_on", label: "Power on", category: "power", params: [] },
      { id: "power_off", label: "Power off", category: "power", params: [] },
      { id: "mute_video", label: "Video mute", category: "mute", params: [{ id: "state", label: "Mute", type: "boolean" }] },
      { id: "mute_audio", label: "Audio mute", category: "mute", params: [{ id: "state", label: "Mute", type: "boolean" }] },
    ], "video");
    render(<CockpitControlPanel {...props} status="connected" feedbacks={new Map()} />);
    fireEvent.click(screen.getByRole("button", { name: "UNBLANK" }));
    await waitFor(() => expect(props.executeAction).toHaveBeenCalledWith("mute_video", { state: false }));
    fireEvent.click(screen.getByRole("button", { name: "UNMUTE" }));
    await waitFor(() => expect(props.executeAction).toHaveBeenCalledWith("mute_audio", { state: false }));
  });

  it("switches channel banks and sends the selected channel's mute command", async () => {
    const props = device(MIXER_ACTIONS, "mixer");
    render(<CockpitControlPanel {...props} status="connected" feedbacks={new Map()} />);
    expect(screen.getByRole("slider", { name: "Channel 1 fader" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Channels 9 to 16" }));
    expect(screen.queryByRole("slider", { name: "Channel 1 fader" })).toBeNull();
    expect(screen.getByRole("slider", { name: "Channel 9 fader" })).toBeDefined();
    fireEvent.click(screen.getAllByRole("button", { name: "MUTE" })[0]);
    await waitFor(() => expect(props.executeAction).toHaveBeenCalledWith("mute_channel", { channel: 9, muted: true }));
  });

  it("disables device commands while disconnected", () => {
    const props = device(MIXER_ACTIONS, "mixer");
    render(<CockpitControlPanel {...props} status="disconnected" feedbacks={new Map()} />);
    fireEvent.click(screen.getAllByRole("button", { name: "MUTE" })[0]);
    expect(props.executeAction).not.toHaveBeenCalled();
    expect(screen.getByRole("slider", { name: "Channel 1 fader" }).getAttribute("disabled")).not.toBeNull();
  });
});
