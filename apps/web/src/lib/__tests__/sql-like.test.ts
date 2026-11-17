import { expect, it } from 'vitest';
import { escapeLikePattern } from '../sql-like';
it.each([
 ['plain', 'plain'], ['%', '\\%'], ['_', '\\_'], ['\\', '\\\\'],
 ['a\\100%_b', 'a\\\\100\\%\\_b'], ['', ''],
])('escapes literal LIKE needle %j', (value, expected) => {
 expect(escapeLikePattern(value)).toBe(expected);
});
