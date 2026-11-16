import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { readFileSync } from 'node:fs';

for (const fails of [false, true]) {
  test(`settled content survives background refresh (failure=${fails})`, async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let settle;
    const data = { shows: [{ id: 'show', name: 'Service' }] };
    client.setQueryData(['workspace'], data);
    const observer = new QueryObserver(client, {
      queryKey: ['workspace'], staleTime: Infinity,
      queryFn: () => new Promise((resolve, reject) => { settle = fails ? () => reject(new Error('offline')) : () => resolve(data); }),
    });
    const snapshots = [];
    const unsubscribe = observer.subscribe(state => snapshots.push(state));
    const refresh = observer.refetch();
    assert.equal(observer.getCurrentResult().data, data);
    settle();
    await refresh;
    for (const state of snapshots) {
      assert.equal(state.data, data);
      assert.equal(state.isPending, false);
    }
    unsubscribe(); client.clear();
  });
}
for (const fails of [false, true]) {
  test(`initial loading clears on settle (failure=${fails})`, async () => {
    const client = new QueryClient();
    let settle;
    const observer = new QueryObserver(client, { queryKey: ['initial'], retry: false,
      queryFn: () => new Promise((resolve, reject) => { settle = fails ? () => reject(new Error('offline')) : () => resolve([]); }),
    });
    const unsubscribe = observer.subscribe(() => {});
    assert.equal(observer.getCurrentResult().isPending, true);
    settle(); await observer.refetch();
    assert.equal(observer.getCurrentResult().isPending, false);
    unsubscribe(); client.clear();
  });
}
test('Live Show only replaces content when no data is available', () => {
  const source = readFileSync(new URL('../src/app/live-show.tsx', import.meta.url), 'utf8');
  assert.ok(source.includes('if (!query.data)'));
  assert.ok(!source.includes('if (query.error || !query.data)'));
});

test('bootstrap list consumers suppress errors only after data settles', () => {
  const source = readFileSync(new URL('../src/hooks/use-mobile-bootstrap.ts', import.meta.url), 'utf8');
  assert.ok(source.includes('error: query.data === undefined ? query.error : null'));
});
