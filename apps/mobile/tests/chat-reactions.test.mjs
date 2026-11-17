import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/app/(app)/chat.tsx', import.meta.url), 'utf8');
const style = (name) => {
  const match = source.match(new RegExp(`^  ${name}: \\{([^}]+)\\}`, 'm'));
  assert.ok(match, `${name} style exists`);
  return match[1];
};

test('reaction buttons have no bubble and preserve tap targets and spacing', () => {
  assert.match(source, /<Pressable[^\n]+style=\{styles\.reaction\}>/);
  assert.doesNotMatch(style('reaction'), /border\w*\s*:|backgroundColor\s*:/);
  for (const property of ['minHeight: 44', 'minWidth: 44', 'justifyContent: "center"', 'paddingHorizontal: 8']) {
    assert.ok(style('reaction').includes(property));
  }
});

test('emoji and count remain visible and selection uses amber bold text', () => {
  assert.match(source, /<Text style=\{\[styles\.reactionText, selected && styles\.reactionTextSelected\]\}>\{reaction\.emoji\} \{reaction\.userIds\.length\}<\/Text>/);
  assert.match(style('reactionTextSelected'), /color: colors\.amberText/);
  assert.match(style('reactionTextSelected'), /fontWeight: "800"/);
  assert.doesNotMatch(style('reactionTextSelected'), /border\w*\s*:|backgroundColor\s*:/);
  assert.doesNotMatch(source, /styles\.reactionSelected|^  reactionSelected:/m);
  assert.match(source, /accessibilityState=\{\{ selected, disabled: mutationPending \}\}/);
});
