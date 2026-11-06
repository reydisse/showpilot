import { createMemoryHistory, createRootRoute, createRoute, createLazyRoute, createRouter, lazyRouteComponent, redirect, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RouteError } from '@/components/ui/RouteRecovery';
import { installRouteLoadDeadlines, runRouteLoad } from './route-load-deadlines';

beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('route load deadlines with the real router', () => {
  it('keeps Retry pending until its loader has actually expired after the parent check', async () => {
    const root = createRootRoute();
    const held = deferred<string>();
    let attempts = 0;
    const page = createRoute({
      getParentRoute: () => root, path: '/test',
      beforeLoad: async () => { if (++attempts > 1) await new Promise(done => setTimeout(done, 100)); },
      loader: () => { if (attempts === 1) throw new Error('initial failure'); return held.promise; },
      component: () => <h1>{page.useLoaderData()}</h1>,
    });
    const tree = root.addChildren([page]);
    installRouteLoadDeadlines(tree);
    const router = createRouter({ routeTree: tree, history: createMemoryHistory({ initialEntries: ['/test'] }), defaultErrorComponent: RouteError, defaultPendingMinMs: 0 });
    await router.load();
    render(<RouterProvider router={router} />);
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(12_001); });
    expect(screen.getByRole('button', { name: 'Trying again…' }).hasAttribute('disabled')).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(screen.getByRole('button', { name: 'Try again' }).hasAttribute('disabled')).toBe(false);
    await act(async () => { held.resolve('Late retry result'); });
    expect(screen.queryByRole('heading', { name: 'Late retry result' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('ends a stalled server-rendered route before rendering the error response', async () => {
    const root = createRootRoute();
    const page = createRoute({ getParentRoute: () => root, path: '/test', loader: () => new Promise(() => {}) });
    const tree = root.addChildren([page]);
    installRouteLoadDeadlines(tree, 40);
    const router = createRouter({ routeTree: tree, isServer: true, history: createMemoryHistory({ initialEntries: ['/test'] }) });
    await router.load();
    expect(router.state.matches.at(-1)?.status).toBe('error');
    expect(router.state.status).toBe('idle');
  });

  it('bounds beforeLoad and prevents a late redirect from replacing the selected page', async () => {
    const root = createRootRoute();
    const held = deferred<void>();
    let signal: AbortSignal | undefined;
    const old = createRoute({ getParentRoute: () => root, path: '/old', beforeLoad: async ({ abortController }) => {
      signal = abortController.signal;
      await held.promise;
      throw redirect({ href: '/wrong' });
    } });
    const selected = createRoute({ getParentRoute: () => root, path: '/selected', component: () => <h1>Selected page</h1> });
    const wrong = createRoute({ getParentRoute: () => root, path: '/wrong', component: () => <h1>Wrong page</h1> });
    const tree = root.addChildren([old, selected, wrong]);
    installRouteLoadDeadlines(tree, 40);
    const router = createRouter({ routeTree: tree, history: createMemoryHistory({ initialEntries: ['/old'] }), defaultPendingMinMs: 0 });
    await router.load();
    expect(router.state.matches.at(-1)?.status).toBe('error');
    expect(signal?.aborted).toBe(true);
    await router.navigate({ href: '/selected' });
    held.resolve();
    await new Promise(done => setTimeout(done, 60));
    expect(router.state.location.pathname).toBe('/selected');
    expect(router.state.matches.at(-1)?.status).toBe('success');
  });

  it('cancels pending navigation without timing out the next page or accepting old data', async () => {
    const root = createRootRoute();
    const held = deferred<string>();
    let signal: AbortSignal | undefined;
    const old = createRoute({ getParentRoute: () => root, path: '/old', loader: ({ abortController }) => {
      signal = abortController.signal;
      return held.promise;
    } });
    const selected = createRoute({ getParentRoute: () => root, path: '/selected', loader: () => 'selected' });
    const tree = root.addChildren([old, selected]);
    installRouteLoadDeadlines(tree, 100);
    const router = createRouter({ routeTree: tree, history: createMemoryHistory({ initialEntries: ['/old'] }), defaultPendingMinMs: 0 });
    const first = router.load();
    await waitFor(() => expect(signal).toBeDefined());
    await router.navigate({ href: '/selected' });
    expect(signal?.aborted).toBe(true);
    held.resolve('old');
    await first;
    await new Promise(done => setTimeout(done, 120));
    expect(router.state.matches.at(-1)?.loaderData).toBe('selected');
    expect(router.state.matches.at(-1)?.status).toBe('success');
  });

  it('preserves synchronous authorization redirects and object loader options', async () => {
    const root = createRootRoute();
    const privatePage = createRoute({ getParentRoute: () => root, path: '/private', beforeLoad: () => { throw redirect({ to: '/login' }); } });
    const login = createRoute({ getParentRoute: () => root, path: '/login', loader: { handler: () => 'login', staleReloadMode: 'blocking' } });
    const tree = root.addChildren([privatePage, login]);
    installRouteLoadDeadlines(tree, 100);
    const router = createRouter({ routeTree: tree, history: createMemoryHistory({ initialEntries: ['/private'] }), defaultPendingMinMs: 0 });
    await router.load();
    expect(router.state.location.pathname).toBe('/login');
    expect(router.state.matches.at(-1)?.loaderData).toBe('login');
    expect(typeof login.options.loader === 'object' && login.options.loader.staleReloadMode).toBe('blocking');
  });

  it('bounds lazy route definitions and their downloaded component preloads', async () => {
    const root = createRootRoute();
    const held = deferred<void>();
    let attempts = 0;
    const component = lazyRouteComponent(() => new Promise<{ default: () => React.ReactNode }>(() => {}));
    const page = createRoute({ getParentRoute: () => root, path: '/support' }).lazy(async () => {
      if (++attempts === 1) await held.promise;
      return createLazyRoute('/support')({ component });
    });
    const tree = root.addChildren([page]);
    installRouteLoadDeadlines(tree, 40);
    const router = createRouter({ routeTree: tree, history: createMemoryHistory({ initialEntries: ['/support'] }), defaultErrorComponent: RouteError, defaultPendingMinMs: 0 });
    await router.load();
    expect(router.state.matches.at(-1)?.status).toBe('error');
    // Error-boundary selection also retries lazy options. The component preload
    // must be bounded even though it was not present at initial installation.
    await router.invalidate();
    expect(router.state.matches.at(-1)?.status).toBe('error');
    held.resolve();
    await Promise.resolve();
    expect(router.state.matches.at(-1)?.status).toBe('error');
  });

  it('installs once and keeps separate requests on a shared route tree independent', async () => {
    const root = createRootRoute();
    const held = deferred<string>();
    const loader = vi.fn(() => loader.mock.calls.length === 1 ? held.promise : Promise.resolve('second'));
    const page = createRoute({ getParentRoute: () => root, path: '/test', loader });
    const tree = root.addChildren([page]);
    installRouteLoadDeadlines(tree, 40);
    const wrapped = page.options.loader;
    installRouteLoadDeadlines(tree, 40);
    expect(page.options.loader).toBe(wrapped);
    const first = createRouter({ routeTree: tree, history: createMemoryHistory({ initialEntries: ['/test'] }), defaultPendingMinMs: 0 });
    const firstLoad = first.load();
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(1));
    const second = createRouter({ routeTree: tree, history: createMemoryHistory({ initialEntries: ['/test'] }), defaultPendingMinMs: 0 });
    await second.load();
    await firstLoad;
    expect(first.state.matches.at(-1)?.status).toBe('error');
    expect(second.state.matches.at(-1)?.loaderData).toBe('second');
    expect(second.state.matches.at(-1)?.status).toBe('success');
    held.resolve('first');
  });

  it('does not start cancelled work and releases listeners and timers on success', async () => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    await expect(runRouteLoad(() => 'done', controller.signal, 40)).resolves.toBe('done');
    expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0][1]);
    controller.abort();
    const work = vi.fn();
    await expect(runRouteLoad(work, controller.signal, 40)).rejects.toMatchObject({ name: 'AbortError' });
    expect(work).not.toHaveBeenCalled();
  });

  it('ends a stalled loader, ignores its late result, and retries a fresh read', async () => {
    const root = createRootRoute();
    const held = deferred<string>();
    let attempt = 0;
    let signal: AbortSignal | undefined;
    const page = createRoute({
      getParentRoute: () => root, path: '/test',
      loader: ({ abortController }) => {
        signal = abortController.signal;
        return ++attempt === 1 ? held.promise : Promise.resolve('Fresh data');
      },
      component: () => <h1>{page.useLoaderData()}</h1>,
    });
    const tree = root.addChildren([page]);
    installRouteLoadDeadlines(tree, 40);
    const router = createRouter({ routeTree: tree, history: createMemoryHistory({ initialEntries: ['/test'] }), defaultErrorComponent: RouteError, defaultPendingMinMs: 0 });
    const load = router.load();
    await new Promise(done => setTimeout(done, 100));
    expect(router.state.matches.at(-1)?.status).toBe('error');
    await load;
    expect(signal?.aborted).toBe(true);
    render(<RouterProvider router={router} />);
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy();
    held.resolve('Obsolete data');
    await Promise.resolve();
    expect(screen.queryByRole('heading', { name: 'Obsolete data' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Fresh data' })).toBeTruthy();
    expect(attempt).toBe(2);
  });

  it('ends a stalled component download and can retry after that download recovers', async () => {
    const root = createRootRoute();
    const held = deferred<{ default: () => React.ReactNode }>();
    const page = createRoute({ getParentRoute: () => root, path: '/test', component: lazyRouteComponent(() => held.promise) });
    const tree = root.addChildren([page]);
    installRouteLoadDeadlines(tree, 40);
    const router = createRouter({ routeTree: tree, history: createMemoryHistory({ initialEntries: ['/test'] }), defaultErrorComponent: RouteError, defaultPendingMinMs: 0 });
    const load = router.load();
    await new Promise(done => setTimeout(done, 100));
    expect(router.state.matches.at(-1)?.status).toBe('error');
    await load;
    render(<RouterProvider router={router} />);
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy();
    held.resolve({ default: () => <h1>Downloaded page</h1> });
    await Promise.resolve();
    expect(screen.queryByRole('heading', { name: 'Downloaded page' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Downloaded page' })).toBeTruthy());
  });
});
