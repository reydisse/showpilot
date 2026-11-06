// Built UI + real authentication/relay, synthetic MIDI ports at the browser boundary.
// USB hardware and permission prompts still require a venue rehearsal.
import assert from "node:assert/strict";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";

await withLocalSmokeFixture(async ({ origin, orgId, browser, operatorEmail, operatorPassword }) => {
  const click = name => browser("find", "role", "button", "click", "--name", name, "--exact");
  const read = async () => (await browser("eval", `fetch('/api/timecode/${orgId}/state?showId=smoke-show').then(response => response.json())`)).result;
  const position = frame => browser("wait", "--fn", `fetch('/api/timecode/${orgId}/state?showId=smoke-show').then(response => response.json()).then(state => state.totalFrames === ${frame})`);
  await browser("open", `${origin}/login`);
  await browser("fill", "#email", operatorEmail);
  await browser("fill", "#password", operatorPassword);
  await click("Sign in");
  await browser("wait", "--url", `**/${orgId}/**`);
  await browser("open", `${origin}/${orgId}/timecode`);
  await click("Take control");
  await browser("wait", "text=You control this show's timecode.");
  await browser("eval", `(() => {
    class Input extends EventTarget {
      constructor(id, name) { super(); this.id = id; this.name = name; this.manufacturer = 'Fixture'; this.state = 'connected'; }
      send(bytes) { const event = new Event('midimessage'); Object.defineProperty(event, 'data', {value: Uint8Array.from(bytes)}); this.dispatchEvent(event); }
    }
    const access = new EventTarget();
    const input = new Input('daw', 'DAW timecode');
    const pads = new Input('pads', 'Controller');
    access.inputs = new Map([[input.id, input], [pads.id, pads]]);
    const fixture = { access, input, pads, calls: 0, observers: 0,
      cycle(port, frame) { [frame & 15, frame >> 4, 0, 0, 0, 0, 0, 6].forEach((value, index) => port.send([0xf1, (index << 4) | value])); },
      disconnect() { this.input.state = 'disconnected'; access.inputs.delete(this.input.id); access.dispatchEvent(new Event('statechange')); },
      reconnect() { this.input = new Input('daw-new', 'DAW timecode'); access.inputs.set(this.input.id, this.input); }
    };
    input.addEventListener('midimessage', () => fixture.observers++);
    Object.defineProperty(navigator, 'requestMIDIAccess', {configurable: true, value: async () => { fixture.calls++; return access; }});
    window.midiFixture = fixture;
    return true;
  })()`);
  await click("Refresh");
  await browser("wait", "--fn", "document.querySelector('[aria-label=\"MIDI timecode input\"]')?.options.length === 3");
  await browser("select", '[aria-label="MIDI timecode input"]', "daw");
  await click("Start MTC");
  await browser("wait", "text=Stop Generator");
  await browser("eval", "midiFixture.cycle(midiFixture.input, 1)");
  await browser("wait", "--fn", `fetch('/api/timecode/${orgId}/state?showId=smoke-show').then(response => response.json()).then(state => state.totalFrames === 1)`);
  const first = await read();
  assert.equal(first.source, "mtc");
  await browser("eval", "midiFixture.cycle(midiFixture.pads, 9); midiFixture.input.send([0x90, 60, 127]); midiFixture.input.send([0xb0, 7, 127]); midiFixture.disconnect()");
  await browser("wait", "--fn", "document.querySelector('[aria-label=\"MIDI timecode input\"]')?.selectedOptions[0]?.textContent === 'DAW timecode (disconnected)'");
  await browser("wait", "text=MTC signal lost");
  const held = await read();
  assert.equal(held.totalFrames, 1);
  assert.equal(held.running, false);
  assert.equal(held.signal.lastFeedAt, first.signal.lastFeedAt, "No fabricated 10 Hz feed during USB loss");
  assert.match((await browser("get", "text", "body")).text, /Last MTC frame received \d+s ago/);
  await browser("eval", "midiFixture.reconnect()");
  await browser("wait", "--fn", "document.querySelector('[aria-label=\"MIDI timecode input\"]')?.value === 'daw-new'");
  // No statechange was emitted on reconnect; the 2s rescan must recover both listeners.
  await browser("eval", "midiFixture.cycle(midiFixture.input, 2)");
  await browser("wait", "--fn", `fetch('/api/timecode/${orgId}/state?showId=smoke-show').then(response => response.json()).then(state => state.totalFrames === 2)`);
  assert.equal((await browser("eval", "midiFixture.calls")).result, 2, "One selector request and one source request, no repeated permission requests");
  assert.equal((await browser("eval", "midiFixture.observers")).result, 10, "MTC must preserve another input listener");
  await browser("eval", "midiFixture.cycle(midiFixture.input, 3); midiFixture.input.send([0xfc]); midiFixture.cycle(midiFixture.input, 4)");
  await browser("wait", "text=MIDI transport stopped.");
  assert.equal((await read()).totalFrames, 2, "DAW Stop flushes a buffered frame before the 10 Hz feed");
  assert.equal((await read()).running, false);
  await browser("eval", "midiFixture.input.send([0xfb]); midiFixture.input.send([0xf8]); midiFixture.cycle(midiFixture.input, 5)");
  await browser("wait", "text=Waiting for MIDI position and timecode.");
  assert.equal((await read()).totalFrames, 2, "Continue must not use an unlocated position");
  await browser("eval", "midiFixture.input.send([0xf2, 0, 0]); midiFixture.input.send([0xf8]); midiFixture.cycle(midiFixture.input, 6)");
  await position(6);
  await browser("eval", "midiFixture.input.send([0xfc]); midiFixture.input.send([0xf0, 0x7f, 0x7f, 1, 1, 0x60, 0, 0, 7, 0xf7])");
  await browser("wait", "text=MIDI transport stopped.");
  assert.equal((await read()).totalFrames, 6, "Full frame locates without firing during Stop");
  await browser("eval", "midiFixture.input.send([0xfb]); midiFixture.cycle(midiFixture.input, 7)");
  await position(7);
  const lastFrame = (await read()).signal.lastFeedAt;
  await browser("eval", "window.staticMidi = setInterval(() => midiFixture.cycle(midiFixture.input, 7), 50)");
  await browser("wait", "text=MTC signal lost");
  await browser("eval", "clearInterval(window.staticMidi)");
  assert.equal((await read()).signal.lastFeedAt, lastFrame, "Repeated stationary timestamps cannot hide a halted DAW");
  await browser("eval", "midiFixture.input.send([0xfa]); midiFixture.cycle(midiFixture.input, 0)");
  await position(0);
  for (const width of [320, 768, 2560]) {
    await browser("set", "viewport", String(width), "900");
    const { result } = await browser("eval", `(() => {
      const select = document.querySelector('[aria-label="MIDI timecode input"]');
      const panel = select.closest('fieldset');
      return { panelWidth: panel.clientWidth, contentWidth: panel.scrollWidth, inputHeight: select.getBoundingClientRect().height };
    })()`);
    assert.ok(result.contentWidth <= result.panelWidth + 1, `MIDI panel overflows at ${width}px`);
    assert.ok(result.inputHeight >= 44);
  }
  await click("Stop Generator");
  await browser("wait", "text=Start Internal Generator");
  await browser("eval", "midiFixture.cycle(midiFixture.input, 3)");
  assert.equal((await read()).totalFrames, 0);
  console.log(JSON.stringify({ builtLogin: "passed", selectedPortOnly: "passed", disconnectHoldsClock: "passed", frameAge: "passed", rescanRecoversNewId: "passed", otherListenersPreserved: "passed", dawStop: "passed", continueRequiresPosition: "passed", fullFrameLocate: "passed", staticFramesNotFresh: "passed", startResync: "passed", responsiveMidiPanel: "320/768/2560 passed", physicalHardware: "not exercised" }, null, 2));
});
