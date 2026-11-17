import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../src/app/team-members.tsx', import.meta.url), 'utf8');
const helper = source.slice(source.indexOf('  function confirmRoleChange('), source.indexOf('  function confirmRemove('));
for (const confirmed of [true, false]) {
  test(`role selection requires confirmation (${confirmed})`, () => {
    const calls = [];
    let alert;
    const code = ts.transpile(helper);
    const confirmRoleChange = new Function('Alert', 'roleMutation', 'roleLabel', `${code}; return confirmRoleChange;`)(
      { alert: (...args) => { alert = args; } },
      { mutate: input => calls.push(input) },
      () => 'Team Manager',
    );
    assert.match(source, /onPress=\{\(\) => editingMember && confirmRoleChange\(editingMember, role\)\}/);
    confirmRoleChange({ id: 'membership-id', user: { name: 'Casey Crew' } }, 'tm');
    assert.deepEqual(calls, []);
    assert.equal(alert[0], 'Change role?');
    assert.equal(alert[1], 'Casey Crew will become Team Manager. This changes what they can access and control in this organization.');
    assert.equal(alert[2][0].text, 'Keep current role');
    assert.equal(alert[2][0].style, 'cancel');
    assert.equal(alert[2][1].text, 'Change role');
    alert[2][confirmed ? 1 : 0].onPress?.();
    assert.deepEqual(calls, confirmed ? [{ memberId: 'membership-id', role: 'tm' }] : []);
  });
}
