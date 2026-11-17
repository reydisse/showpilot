import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import vm from 'node:vm';

for (const offline of [false, true]) {
  test(`FailureText reports exact safe shape and preserves rendering (offline=${offline})`, async () => {
    const calls = [];
    const effects = [];
    const cache = {};
    const mocks = {
      react: { Children: { toArray: x => [x] }, useEffect: fn => effects.push(fn) },
      'react/jsx-runtime': { jsx: (type, props) => ({ type, props }) },
      'react-native': { Text: 'Text' },
      '@showpilot/shared/ui-feedback': { plainFailure: () => 'Please try again.' },
      '@/lib/auth-client': { authClient: { useActiveOrganization: () => ({ data: { id: 'org' } }), getCookie: () => 'session=valid' } },
      '@/lib/env': { SHOWPILOT_URL: 'https://example.test' },
      'expo/fetch': { fetch: async (...args) => { calls.push(args); if (offline) throw Error('offline'); } },
    };
    function load(name) {
      if (mocks[name]) return mocks[name];
      const path = name === '@/lib/failure-reporting' ? 'lib/failure-reporting.ts'
        : name === './error-reporting' ? 'lib/error-reporting.ts' : 'components/failure-text.tsx';
      if (cache[path]) return cache[path];
      const source = readFileSync(new URL('../src/' + path, import.meta.url), 'utf8');
      const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
      const module = { exports: {} };
      vm.runInNewContext('(function(require,module,exports){' + code + '\n})')(load, module, module.exports);
      return cache[path] = module.exports;
    }
    const { FailureText } = load('component');
    const props = { accessibilityRole: 'alert', children: 'private diagnostic', style: { color: 'red' } };
    const rendered = FailureText(props);
    assert.deepEqual(JSON.parse(JSON.stringify(rendered)), { type: 'Text', props: { accessibilityRole: 'alert', style: props.style, children: 'Please try again.' } });
    for (const effect of effects.splice(0)) assert.doesNotThrow(effect);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'https://example.test/api/operational-errors/org');
    assert.deepEqual(JSON.parse(calls[0][1].body), { code: 'browser_error', errorName: 'Unknown' });
    assert.equal(calls[0][1].credentials, 'omit');
    assert.equal(calls[0][1].headers.Cookie, 'session=valid');
    assert.equal(calls[0][1].headers['Content-Type'], 'application/json');
    assert.equal(calls[0][1].method, 'POST');
    assert.equal(JSON.stringify(FailureText(props)), JSON.stringify(rendered));
  });
}
