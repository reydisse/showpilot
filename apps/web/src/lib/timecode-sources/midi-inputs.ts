/** Observe hotplug events plus a rescan for hosts that miss a statechange. */
export function observeMidiInputs(access: MIDIAccess, onChange: (inputs: MIDIInput[]) => void): () => void {
  let previous: MIDIInput[] | null = null;
  const scan = () => {
    const inputs = [...access.inputs.values()].filter(input => input.state === "connected");
    if (previous && inputs.length === previous.length && inputs.every((input, index) => input === previous?.[index])) return;
    previous = inputs;
    onChange(inputs);
  };
  access.addEventListener("statechange", scan);
  const timer = setInterval(scan, 2_000);
  scan();
  return () => {
    clearInterval(timer);
    access.removeEventListener("statechange", scan);
  };
}

/** IDs survive normal reconnects. Only use a name fallback when unambiguous. */
export function findMidiInput(inputs: MIDIInput[], selected: Pick<MIDIInput, "id" | "name" | "manufacturer">): MIDIInput | null {
  const exact = inputs.find(input => input.id === selected.id);
  if (exact) return exact;
  if (!selected.name) return null;
  const matches = inputs.filter(input => input.name === selected.name && input.manufacturer === selected.manufacturer);
  return matches.length === 1 ? matches[0] : null;
}
