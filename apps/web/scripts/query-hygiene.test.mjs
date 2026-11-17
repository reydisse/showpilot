import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { scan } from './query-sites.mjs';
import allow from './query-hygiene-allowlist.json' with { type: 'json' };
const root = fileURLToPath(new URL('../', import.meta.url));
function walk(path) {
 return readdirSync(root + path, { withFileTypes: true }).flatMap(e => e.isDirectory() ? e.name === '__tests__' ? [] : walk(path + '/' + e.name) : /\.[cm]?[jt]sx?$/.test(e.name) && !e.name.includes('.test.') ? [path + '/' + e.name] : []);
}
function audit(entries, allowed) {
 const found = new Map(); const errors = [];
 for (const [path, source] of entries) {
  const result = scan(source);
  for (const expression of result.sites) {
   const key = path + ':' + expression;
   found.set(key, (found.get(key) ?? 0) + 1);
   if (!allowed[key]) errors.push('Unlisted: ' + key);
  }
  for (const sql of result.unsafe) errors.push('Unescaped LIKE: ' + path + ':' + sql);
 }
 for (const [key, entry] of Object.entries(allowed)) {
  if (found.get(key) !== entry.count) errors.push('Stale count: ' + key);
  if (!entry.reason) errors.push('Missing reason: ' + key);
 }
 return errors;
}
test('product SQL interpolations and LIKE needles remain audited', () => {
 assert.deepEqual(audit(walk('src').map(p => [p, readFileSync(root + p, 'utf8')]), allow), []);
});
test('scanner rejects unlisted interpolation, stale entries and unescaped LIKE', () => {
 assert.match(audit([['fixture.ts', 'db.prepare(`SELECT ${untrusted}`)']], {})[0], /Unlisted/);
 assert.match(audit([], { 'fixture.ts:gone': { count: 1, reason: 'fixture' } })[0], /Stale/);
 assert.match(audit([['fixture.ts', 'db.prepare("name LIKE ?")']], {})[0], /Unescaped/);
 assert.deepEqual(audit([['fixture.ts', 'db.prepare("name LIKE ? ESCAPE x")']], {}), []);
});
