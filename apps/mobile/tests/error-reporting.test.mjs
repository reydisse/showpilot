import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMobileErrorReporter, safeMobileErrorName } from '../src/lib/error-reporting.ts';

const flush = () => new Promise(resolve => setImmediate(resolve));
function setup(send) {
  let time = 0;
  const reports = [];
  const reporter = createMobileErrorReporter({
    send: send ?? (async report => { reports.push(report); }),
    now: () => time,
  });
  return { reporter, reports, advance: ms => { time += ms; } };
}

test('reports only the allowed code and error name', async () => {
  const { reporter, reports } = setup();
  reporter.reportError(new TypeError('private message'));
  reporter.reportError('private text');
  reporter.reportRejection(new Error('private rejection'));
  await flush();
  assert.deepEqual(reports, [
    { code: 'browser_error', errorName: 'TypeError' },
    { code: 'browser_error', errorName: 'Unknown' },
    { code: 'browser_rejection', errorName: 'Error' },
  ]);
  const custom = new Error();
  custom.name = 'PrivateError';
  assert.equal(safeMobileErrorName(custom), 'Unknown');
});

test('suppresses identical reports within 60 seconds', async () => {
  const { reporter, reports, advance } = setup();
  reporter.reportError(new Error('first'));
  advance(59_999);
  reporter.reportError(new Error('second'));
  await flush();
  assert.equal(reports.length, 1);
  advance(1);
  reporter.reportError(new Error());
  await flush();
  assert.equal(reports.length, 2);
});

test('limits a window to five reports and resets after 60 seconds', async () => {
  const { reporter, reports, advance } = setup();
  for (const Type of [Error, TypeError, SyntaxError, RangeError, ReferenceError, URIError]) {
    reporter.reportError(new Type());
  }
  await flush();
  assert.equal(reports.length, 5);
  advance(60_000);
  reporter.reportError(new URIError());
  await flush();
  assert.equal(reports.length, 6);
});

test('swallows asynchronous and synchronous transport failures', async () => {
  for (const send of [async () => { throw new Error('offline'); }, () => { throw new Error('offline'); }]) {
    const { reporter } = setup(send);
    assert.doesNotThrow(() => reporter.reportError(new Error()));
    assert.doesNotThrow(() => reporter.reportRejection('reason'));
    await flush();
  }
});
