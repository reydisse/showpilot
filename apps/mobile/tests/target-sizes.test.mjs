import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('incidents replyButton has a 44px target', () => {
  const source = readFileSync(new URL('../src/app/incidents.tsx', import.meta.url), 'utf8');
  const style = source.match(/^  replyButton: \{([^}]+)\}/m);
  assert.ok(style, 'replyButton style exists');
  assert.ok(Number(style[1].match(/\bminHeight: (\d+)/)?.[1]) >= 44, 'minHeight >= 44');
});

test('incidents discussionToggle has a 44px target', () => {
  const source = readFileSync(new URL('../src/app/incidents.tsx', import.meta.url), 'utf8');
  const style = source.match(/^  discussionToggle: \{([^}]+)\}/m);
  assert.ok(style, 'discussionToggle style exists');
  assert.ok(Number(style[1].match(/\bminHeight: (\d+)/)?.[1]) >= 44, 'minHeight >= 44');
});

test('incidents customReactionButton has a 44px target', () => {
  const source = readFileSync(new URL('../src/app/incidents.tsx', import.meta.url), 'utf8');
  const style = source.match(/^  customReactionButton: \{([^}]+)\}/m);
  assert.ok(style, 'customReactionButton style exists');
  assert.ok(Number(style[1].match(/\bminHeight: (\d+)/)?.[1]) >= 44, 'minHeight >= 44');
});

test('schedule dateArrow has a 44px target', () => {
  const source = readFileSync(new URL('../src/app/schedule.tsx', import.meta.url), 'utf8');
  const style = source.match(/^  dateArrow: \{([^}]+)\}/m);
  assert.ok(style, 'dateArrow style exists');
  assert.ok(Number(style[1].match(/\bwidth: (\d+)/)?.[1]) >= 44, 'width >= 44');
  assert.ok(Number(style[1].match(/\bheight: (\d+)/)?.[1]) >= 44, 'height >= 44');
});

test('schedule dateGo has a 44px target', () => {
  const source = readFileSync(new URL('../src/app/schedule.tsx', import.meta.url), 'utf8');
  const style = source.match(/^  dateGo: \{([^}]+)\}/m);
  assert.ok(style, 'dateGo style exists');
  assert.ok(Number(style[1].match(/\bminHeight: (\d+)/)?.[1]) >= 44, 'minHeight >= 44');
});

test('schedule rangeButton has a 44px target', () => {
  const source = readFileSync(new URL('../src/app/schedule.tsx', import.meta.url), 'utf8');
  const style = source.match(/^  rangeButton: \{([^}]+)\}/m);
  assert.ok(style, 'rangeButton style exists');
  assert.ok(Number(style[1].match(/\bminHeight: (\d+)/)?.[1]) >= 44, 'minHeight >= 44');
});

test('schedule emptyButton has a 44px target', () => {
  const source = readFileSync(new URL('../src/app/schedule.tsx', import.meta.url), 'utf8');
  const style = source.match(/^  emptyButton: \{([^}]+)\}/m);
  assert.ok(style, 'emptyButton style exists');
  assert.ok(Number(style[1].match(/\bminHeight: (\d+)/)?.[1]) >= 44, 'minHeight >= 44');
});

test('team-members inviteButton has a 44px target', () => {
  const source = readFileSync(new URL('../src/app/team-members.tsx', import.meta.url), 'utf8');
  const style = source.match(/^  inviteButton: \{([^}]+)\}/m);
  assert.ok(style, 'inviteButton style exists');
  assert.ok(Number(style[1].match(/\bminHeight: (\d+)/)?.[1]) >= 44, 'minHeight >= 44');
});

test('show-board checkInAction has a 44px target', () => {
  const source = readFileSync(new URL('../src/app/show-board.tsx', import.meta.url), 'utf8');
  const style = source.match(/^  checkInAction: \{([^}]+)\}/m);
  assert.ok(style, 'checkInAction style exists');
  assert.ok(Number(style[1].match(/\bminHeight: (\d+)/)?.[1]) >= 44, 'minHeight >= 44');
  assert.match(style[1], /flex: 1\b/);
});

test('scene chip edit button has a 44px target', () => {
  const source = readFileSync(new URL('../../web/src/routes/$slug/streaming/lt-preview.tsx', import.meta.url), 'utf8');
  const button = source.match(/<button\s+onClick=\{\(\) => editSceneItem\(item\)\}\s+title="Edit this lower third"[^>]*>/);
  assert.ok(button, 'scene chip edit button exists');
  assert.match(button[0], /className="[^"]*\bmin-h-11\b[^"]*"/);
});

