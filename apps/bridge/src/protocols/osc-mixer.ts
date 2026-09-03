import type { OscMessage } from "./osc.js";

export type OscMixerConsole = "x32" | "wing";

export interface OscMixerState {
  channelFader: Array<number | null>;
  channelMute: Array<boolean | null>;
  dcaFader: Array<number | null>;
  dcaMute: Array<boolean | null>;
}

export function mixerChannelCount(consoleType: OscMixerConsole): number {
  return consoleType === "wing" ? 40 : 32;
}

export function createOscMixerState(consoleType: OscMixerConsole): OscMixerState {
  return {
    channelFader: Array.from({ length: mixerChannelCount(consoleType) }, () => null),
    channelMute: Array.from({ length: mixerChannelCount(consoleType) }, () => null),
    dcaFader: Array.from({ length: 8 }, () => null),
    dcaMute: Array.from({ length: 8 }, () => null),
  };
}

export function mixerProbeAddress(consoleType: OscMixerConsole): string {
  return consoleType === "wing" ? "/ch/1/fdr" : "/xinfo";
}

export function mixerQueryAddresses(consoleType: OscMixerConsole): string[] {
  const channels = Array.from({ length: mixerChannelCount(consoleType) }, (_, index) => index + 1);
  const dcas = Array.from({ length: 8 }, (_, index) => index + 1);
  if (consoleType === "wing") {
    return [
      ...channels.flatMap((channel) => [`/ch/${channel}/fdr`, `/ch/${channel}/mute`]),
      ...dcas.flatMap((dca) => [`/dca/${dca}/fdr`, `/dca/${dca}/mute`]),
    ];
  }
  return [
    ...channels.flatMap((channel) => {
      const id = String(channel).padStart(2, "0");
      return [`/ch/${id}/mix/fader`, `/ch/${id}/mix/on`];
    }),
    ...dcas.flatMap((dca) => [`/dca/${dca}/fader`, `/dca/${dca}/on`]),
  ];
}

function numericFirstArg(message: OscMessage): number | null {
  const value = message.args[0]?.value;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function updateAt<T>(values: T[], oneBasedIndex: number, value: T): boolean {
  const index = oneBasedIndex - 1;
  if (index < 0 || index >= values.length || Object.is(values[index], value)) return false;
  values[index] = value;
  return true;
}

export function applyOscMixerMessage(
  state: OscMixerState,
  consoleType: OscMixerConsole,
  message: OscMessage,
): boolean {
  const value = numericFirstArg(message);
  if (value === null) return false;

  if (consoleType === "wing") {
    const channel = message.address.match(/^\/ch\/(\d+)\/(fdr|mute)$/);
    if (channel) {
      const index = Number(channel[1]);
      return channel[2] === "fdr"
        ? updateAt(state.channelFader, index, value)
        : updateAt(state.channelMute, index, value !== 0);
    }
    const dca = message.address.match(/^\/dca\/(\d+)\/(fdr|mute)$/);
    if (!dca) return false;
    const index = Number(dca[1]);
    return dca[2] === "fdr"
      ? updateAt(state.dcaFader, index, value)
      : updateAt(state.dcaMute, index, value !== 0);
  }

  const channel = message.address.match(/^\/ch\/(\d{2})\/mix\/(fader|on)$/);
  if (channel) {
    const index = Number(channel[1]);
    return channel[2] === "fader"
      ? updateAt(state.channelFader, index, value)
      : updateAt(state.channelMute, index, value === 0);
  }
  const dca = message.address.match(/^\/dca\/(\d+)\/(fader|on)$/);
  if (!dca) return false;
  const index = Number(dca[1]);
  return dca[2] === "fader"
    ? updateAt(state.dcaFader, index, value)
    : updateAt(state.dcaMute, index, value === 0);
}

export function oscMixerEventPayload(state: OscMixerState): string {
  return JSON.stringify({
    channelFader: state.channelFader,
    channelMute: state.channelMute,
    dcaFader: state.dcaFader,
    dcaMute: state.dcaMute,
  });
}
