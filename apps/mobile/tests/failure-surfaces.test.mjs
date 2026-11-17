import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
const root = new URL('../src/', import.meta.url);
const read = (file) => readFileSync(new URL(`app/${file}`, root), 'utf8');
const surfaces = {
  'checkin.tsx': [['error', 'Attendance could not be updated.'], ['error', 'Crew could not load.']],
  'show-board.tsx': [['errorText', 'Crew could not load.']],
  'live-show.tsx': [['error', 'The live workspace could not load.']],
  '(app)/index.tsx': [['errorTitle', 'ShowPilot could not be opened.']],
  'checklist.tsx': [['emptyTitle', 'Checklist history unavailable'], ['error', '{query.error.message}'], ['[styles.error, styles.modalError]', '{draftQuery.error.message}']],
  'incidents.tsx': [['error', '{query.error.message}']],
  'devices.tsx': [['error', '{query.error.message}']],
  '(app)/shows.tsx': [['error', '{error.message}']],
};
for (const [file, entries] of Object.entries(surfaces)) {
  test(`${file} routes each specified failure through FailureText`, () => {
    const source = read(file);
    for (const [style, copy] of entries) {
      const value = style.startsWith('[') ? style : `styles.${style}`;
      assert.ok(source.includes(`<FailureText accessibilityRole="alert" style={${value}}>${copy}</FailureText>`), copy);
    }
    assert.doesNotMatch(source, /\{(?:query|draftQuery)\.error\.message\} · Tap to retry/);
  });
}
test('mobile source has no plain alert Text', () => {
  for (const file of readdirSync(root, { recursive: true }).filter((file) => /\.[jt]sx?$/.test(file))) {
    assert.doesNotMatch(readFileSync(new URL(file, root), 'utf8'), /<Text[^>]*accessibilityRole="alert"/, file);
  }
  assert.ok(!read('(app)/index.tsx').includes('<Text style={styles.errorTitle}>ShowPilot could not be opened.</Text>'));
});
