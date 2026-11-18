import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../src/app/live-show.tsx', import.meta.url), 'utf8');
for (const [label, command] of [['Pause', 'timer-pause'], ['Next', 'timer-next']]) {
  test(`${label} dispatches ${command} through the native relay`, () => {
    assert.ok(source.includes(`onPress: () => transport.sendCommand("${command}")`));
    assert.ok(source.includes('sendCommand: relay.sendCommand'));
  });
}
test('transport visibility and disabled state enforce permission and relay confirmation', () => {
  assert.ok(source.includes('workspace.canControl && transport'));
  assert.ok(source.includes('enabled: authoritative && relay.unconfirmedCount === 0'));
  assert.ok(source.includes('disabled: !transport.enabled || !transport.playing'));
  assert.ok(source.includes('disabled: !transport.enabled || !transport.currentItem'));
  assert.ok(source.includes('disabled={"disabled" in action && action.disabled}'));
});
test('OnTime workspace remains follow-only', () => {
  const ontime = source.slice(source.indexOf('function OntimeWorkspace'));
  assert.ok(!ontime.includes('sendCommand'));
});
const buildActions = new Function('workspace', 'transport', 'showId', 'MonitorPlay', 'ChevronRight', 'MessageSquareText', 'ListVideo', 'router', source.slice(source.indexOf('  const actions = ['), source.indexOf('  const { colors }', source.indexOf('function QuickActions'))) + '\nreturn actions;');
function actions(canControl, enabled = true, playing = true, currentItem = true, sendCommand = () => {}) {
  return buildActions({ canControl }, { enabled, playing, currentItem, sendCommand }, null);
}
test('Pause and Next callbacks dispatch their relay commands', () => {
  const sent = [];
  const buttons = actions(true, true, true, true, (command) => sent.push(command));
  buttons.forEach((button) => button.onPress());
  assert.deepEqual(sent, ['timer-pause', 'timer-next']);
});
test('permission hides controls; unavailable relay disables both; playback and current item gate separately', () => {
  assert.deepEqual(actions(false), []);
  assert.deepEqual(actions(true, false).map((button) => button.disabled), [true, true]);
  assert.deepEqual(actions(true).map((button) => button.disabled), [false, false]);
  assert.deepEqual(actions(true, true, false, false).map((button) => button.disabled), [true, true]);
});
