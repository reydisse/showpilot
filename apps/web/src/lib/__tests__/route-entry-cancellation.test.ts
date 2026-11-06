import { beforeEach, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, isRedirect } from '@tanstack/react-router';
import { installRouteLoadDeadlines } from '../route-load-deadlines';
import { Route } from '@/routes/index';

const session = vi.hoisted(() => ({
  getRequestHost: vi.fn(), getSessionWithOrg: vi.fn(), listUserOrgs: vi.fn(),
  setActiveOrg: vi.fn(), getUserInvitations: vi.fn(),
}));
vi.mock('@/lib/session', () => session);

beforeEach(() => {
  vi.resetAllMocks();
  session.getRequestHost.mockResolvedValue('app.showpilot.tech');
  session.getSessionWithOrg.mockResolvedValue({ user: { id: 'member' }, session: {}, org: null });
  session.listUserOrgs.mockResolvedValue([{ id: 'org-id', slug: 'org' }]);
  session.setActiveOrg.mockResolvedValue(undefined);
});

function enter(abortController: AbortController, preload = false) {
  const beforeLoad = Route.options.beforeLoad;
  if (!beforeLoad) throw new Error('Entry route must resolve the session');
  return Reflect.apply(beforeLoad, undefined, [{ abortController, preload }]);
}

it('does not activate an organization after an abandoned read eventually completes', async () => {
  let release!: (value: { id: string; slug: string }[]) => void;
  session.listUserOrgs.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const controller = new AbortController();
  const result = Promise.resolve(enter(controller));
  const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(session.listUserOrgs).toHaveBeenCalledTimes(1));
  controller.abort();
  release([{ id: 'old-org', slug: 'old' }]);
  await rejected;
  expect(session.setActiveOrg).not.toHaveBeenCalled();
  expect(session.getUserInvitations).not.toHaveBeenCalled();
});

it('resolves an intent preload without changing the active organization', async () => {
  const controller = new AbortController();
  const outcome = await Promise.resolve(enter(controller, true)).catch(error => error);
  expect(isRedirect(outcome)).toBe(true);
  expect(session.setActiveOrg).not.toHaveBeenCalled();
  expect(session.listUserOrgs).toHaveBeenCalledWith({ signal: controller.signal });
});

it('activates the organization on an actual navigation with the request signal', async () => {
  const controller = new AbortController();
  const outcome = await Promise.resolve(enter(controller)).catch(error => error);
  expect(isRedirect(outcome)).toBe(true);
  expect(session.setActiveOrg).toHaveBeenCalledExactlyOnceWith({ data: 'org-id', signal: controller.signal });
});

it('still activates on click after the real router has preloaded the entry', async () => {
  const root = createRootRoute();
  const entry = createRoute({ getParentRoute: () => root, path: '/support', beforeLoad: ({ abortController, preload }) => enter(abortController, preload) });
  const organization = createRoute({ getParentRoute: () => root, path: '/$slug' });
  const tree = root.addChildren([entry, organization]);
  installRouteLoadDeadlines(tree);
  const router = createRouter({ routeTree: tree, history: createMemoryHistory(), defaultPreloadStaleTime: 30_000 });
  await router.preloadRoute({ to: '/support' });
  expect(session.setActiveOrg).not.toHaveBeenCalled();
  await router.navigate({ to: '/support' });
  expect(session.setActiveOrg).toHaveBeenCalledTimes(1);
  expect(router.state.location.pathname).toBe('/org');
});
